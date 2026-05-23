/**
 * state-unified.ts -- Unified State Manager for MI Dev Agent
 *
 * Converted from lib/state-unified.js (zero functional changes).
 *
 * Single source of truth for all state reads/writes. Replaces both
 * lib/state.js and server/state-io.js with a single module that provides:
 *
 *   1. Exclusive file locking (via state-lock.js)
 *   2. Mandatory HMAC verification with quarantine on mismatch
 *   3. Atomic write (tmp -> rename) with crash recovery
 *   4. CAS (compare-and-swap) using monotonic _seq counter
 *   5. Field-level merge: UI writes _ui_* fields, agent writes everything else
 *   6. State size management with auto-pruning
 *   7. Crash recovery: orphaned .tmp detection, corrupt JSON handling
 *   8. Backward-compatible v2 envelope format
 *
 * API:
 *   Sync  (agent):  loadSync(), saveSync(state), updateSync(mutator), checkUIApprovalSync(state, gate)
 *   Async (server):  loadAsync(), saveAsync(state), updateAsync(mutator), patchUIAsync(ticket, gate, fields)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

import type {
  PipelineState,
  IReadResult,
  UIApproval,
  StateMutator,
  StateManagerOptions,
  UnwrapResult,
  TmpRecoveryAction,
  StateLock,
} from "@mi/shared";

const { acquireLockSync, acquireLockAsync } = require("./state-lock") as {
  acquireLockSync: (stateFilePath: string) => StateLock;
  acquireLockAsync: (stateFilePath: string) => Promise<StateLock>;
};

// -- Configuration -----------------------------------------------------------
const MAX_STATE_SIZE = 10_000_000; // 10MB hard limit
const PRUNE_THRESHOLD = 8_000_000; // 8MB triggers pruning
const QUARANTINE_DIR_NAME = ".state-quarantine";
const ENVELOPE_VERSION = 3; // Bumped from 2 to signal unified writer
const MAX_METRICS_RUNS = 5;
const MAX_WARNINGS = 200;
const MAX_REJECTION_HISTORY = 20;

// Monotonic counter for unique tmp file names (avoids Date.now() collisions)
let _tmpCounter = 0;

// -- HMAC Secret Management --------------------------------------------------
let _stateSecret: string | null = null;

function getOrCreateStateSecret(baseDir: string): string {
  const secretPath = path.join(baseDir, ".state-secret");
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, "utf8").trim();
    }
  } catch (e: any) { console.warn("[State] Secret read failed, regenerating:", e.message); }
  console.warn("[State] HMAC secret regenerated -- existing state files may fail verification");
  const secret = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  } catch (e: any) { console.warn("[State] Secret write failed:", e.message); }
  return secret;
}

function stateSecret(baseDir?: string): string {
  if (!_stateSecret) {
    _stateSecret = getOrCreateStateSecret(baseDir || path.join(__dirname, "..", "..", "..", ".."));
  }
  return _stateSecret;
}

// Allow injection for testing
function _setStateSecret(s: string): void { _stateSecret = s; }

// -- HMAC computation --------------------------------------------------------
function computeHmac(stateObj: any, secret: string): string {
  const payload = JSON.stringify(stateObj, null, 2);
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// -- State envelope: wrap/unwrap ---------------------------------------------

interface StateEnvelope {
  _version: number;
  _hmac: string;
  _seq: number;
  _written_by: number;
  _written_at: string;
  state: PipelineState;
}

function wrapEnvelope(stateObj: PipelineState, secret: string): StateEnvelope {
  const hmac = computeHmac(stateObj, secret);
  return {
    _version: ENVELOPE_VERSION,
    _hmac: hmac,
    _seq: (stateObj._seq || 0) + 1,
    _written_by: process.pid,
    _written_at: new Date().toISOString(),
    state: stateObj,
  };
}

/**
 * Unwrap a state envelope. Validates HMAC strictly.
 *
 * @throws {Error} If JSON is unparseable
 */
function unwrapEnvelope(raw: string, secret: string, label = "unknown"): UnwrapResult {
  const parsed = JSON.parse(raw); // Let caller handle parse errors

  // v3 envelope (new format)
  if (parsed && parsed._version >= 3 && parsed._hmac && parsed.state) {
    const expected = computeHmac(parsed.state, secret);
    const valid = crypto.timingSafeEqual(
      Buffer.from(parsed._hmac, "hex"),
      Buffer.from(expected, "hex")
    );
    return {
      state: parsed.state,
      seq: parsed._seq || 0,
      valid,
      version: parsed._version,
    };
  }

  // v2 envelope (old format -- read backward compat)
  if (parsed && parsed._version === 2 && parsed._hmac && parsed.state) {
    // Old HMAC used JSON.stringify(state, null, 2) directly
    const stateJson = JSON.stringify(parsed.state, null, 2);
    const expected = crypto.createHmac("sha256", secret).update(stateJson).digest("hex");
    let valid = false;
    try {
      valid = crypto.timingSafeEqual(
        Buffer.from(parsed._hmac, "hex"),
        Buffer.from(expected, "hex")
      );
    } catch {
      valid = false; // Length mismatch
    }
    return {
      state: parsed.state,
      seq: parsed.state?._seq || 0,
      valid,
      version: 2,
    };
  }

  // v1 (plain state, no envelope) -- treat as unverified
  if (parsed && parsed.stage) {
    return { state: parsed, seq: 0, valid: false, version: 1 };
  }

  throw new Error(`Unrecognized state format (${label})`);
}

// -- Quarantine: move corrupt files aside ------------------------------------
function quarantineFile(filePath: string, baseDir: string): string | null {
  const quarantineDir = path.join(baseDir, QUARANTINE_DIR_NAME);
  let dest: string | null = null;
  try {
    if (!fs.existsSync(quarantineDir)) {
      fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    }
    const basename = path.basename(filePath);
    dest = path.join(quarantineDir, `${basename}.${Date.now()}.quarantined`);
    fs.renameSync(filePath, dest);
  } catch {
    // If quarantine fails, just rename in place
    try {
      dest = filePath + `.corrupted.${Date.now()}`;
      fs.renameSync(filePath, dest);
    } catch { dest = null; }
  }

  // M18: Surface the quarantine to operators. Silent quarantine = silent
  // data loss. Drop a sibling ALERT.txt and write an error-severity log
  // line so monitoring picks it up. Failures here are non-fatal — the
  // quarantine itself already happened.
  try {
    if (dest) {
      const alertPath = path.join(quarantineDir, "ALERT.txt");
      const ts = new Date().toISOString();
      const msg = `[${ts}] State file integrity failure — ${path.basename(filePath)} quarantined to ${path.basename(dest)}\n`;
      fs.appendFileSync(alertPath, msg, { mode: 0o600 });
    }
    // eslint-disable-next-line no-console
    console.error(`[STATE QUARANTINE] ${path.basename(filePath)} -> ${dest ? path.basename(dest) : "(rename failed)"}. Investigate before resuming pipelines.`);
  } catch { /* never block on telemetry */ }

  return dest;
}

// -- Crash recovery: clean orphaned .tmp files --------------------------------
function recoverTmpFiles(stateFilePath: string): TmpRecoveryAction[] {
  const dir = path.dirname(stateFilePath);
  const base = path.basename(stateFilePath);
  const recovered: TmpRecoveryAction[] = [];

  try {
    // L5: Look for a sibling lock file. If the lock is held and recent,
    // a writer is actively in flight even if .tmp looks old — don't
    // touch it. This widens the safety margin around legitimate slow
    // writes (e.g. large state pruning) without weakening crash recovery.
    let lockHeld = false;
    try {
      const lockPath = stateFilePath + ".lock";
      if (fs.existsSync(lockPath)) {
        const lockStat = fs.statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs < 30_000) lockHeld = true;
      }
    } catch { /* ignore */ }

    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith(base + ".tmp")) {
        const tmpPath = path.join(dir, file);
        const stat = fs.statSync(tmpPath);
        const ageMs = Date.now() - stat.mtimeMs;

        // Keep the 10s threshold for the "definitely crashed" branch; but
        // skip if an active lock-holder is also writing.
        if (ageMs > 10_000 && !lockHeld) {
          // Older than 10s -- orphaned from a crashed write
          // Check if it's a valid state that's newer than current
          if (!fs.existsSync(stateFilePath)) {
            // No main file -- this tmp might be our only copy
            try {
              JSON.parse(fs.readFileSync(tmpPath, "utf8")); // Parseable?
              fs.renameSync(tmpPath, stateFilePath);
              recovered.push({ file, action: "promoted_to_main" });
              continue;
            } catch { /* not parseable */ }
          }
          // Main file exists -- discard orphaned tmp
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          recovered.push({ file, action: "removed_orphan" });
        }
        // If <10s old, might be an in-progress write -- leave it alone
      }
    }
  } catch { /* ignore */ }
  return recovered;
}

// -- State Size Management ---------------------------------------------------
/**
 * Prune oversized state by trimming non-essential historical data.
 * Operates in 4 levels of increasing aggression.
 */
function pruneState(state: PipelineState): PipelineState {
  if (!state || !state.data) return state;
  const d: any = state.data;
  const before = JSON.stringify(state).length;
  if (before < PRUNE_THRESHOLD) return state;

  // Level 1: Trim metrics runs to last 3 per stage
  if (d._metrics) {
    for (const key of Object.keys(d._metrics)) {
      const m = d._metrics[key];
      if (m && m.runs && m.runs.length > 3) {
        m.runs = m.runs.slice(-3);
      }
    }
  }
  if (JSON.stringify(state).length < PRUNE_THRESHOLD) return state;

  // Level 2: Trim warnings to last 50
  if (d._warnings && d._warnings.length > 50) {
    d._warnings = d._warnings.slice(-50);
  }
  if (JSON.stringify(state).length < PRUNE_THRESHOLD) return state;

  // Level 3: Trim rejection history to last 5
  if (d.rejectionHistory && d.rejectionHistory.length > 5) {
    d.rejectionHistory = d.rejectionHistory.slice(-5);
  }
  if (JSON.stringify(state).length < PRUNE_THRESHOLD) return state;

  // Level 4: Remove large debug/trace fields
  const trimmableKeys = [
    "_agent_analysis", "_agent_requirements", "_agent_explorer",
    "_agent_risk", "_agent_suggestions", "_reviewComments",
    "_verify_evidence", "_verify_api_summary", "_verify_console_summary",
  ];
  for (const key of trimmableKeys) {
    if (d[key] && JSON.stringify(d[key]).length > 50_000) {
      d[key] = typeof d[key] === "string"
        ? d[key].substring(0, 50_000) + "\n[...pruned...]"
        : "[pruned -- exceeded 50KB]";
    }
  }

  const after = JSON.stringify(state).length;
  if (after < before) {
    d._pruned_at = new Date().toISOString();
    d._pruned_saved = before - after;
  }

  return state;
}

// -- Field-Level Merge -------------------------------------------------------
/**
 * UI fields are any key matching these patterns:
 *   *_ui_approved, *_ui_rejected, *_ui_feedback, *_ui_refine, *_ui_refine_instructions
 */
const UI_FIELD_PATTERN = /^.*_ui_(approved|rejected|feedback|refine|refine_instructions)$/;

// C1: Concurrency-managed fields owned by parallel agents via
// `withTicketStateSync`. The orchestrator's `saveSync` must NOT clobber
// disk values for these fields when its in-memory copy is stale (e.g.
// the value was changed in another process between this process's read
// and write). Preservation policy: arrays are union-merged by element
// identity; objects are key-merged with disk-wins on missing keys. Per-
// agent checkpoint keys (`_dev_group_*`, `_dev_single_result`,
// `_dev_retry_result`, `_review_*`, `_security_*`) are also preserved
// when in-memory has no entry.
const CONCURRENCY_FIELD_PATTERN = /^(?:_active_agents|_agents_history|_dev_group_\d+|_dev_single_result|_dev_retry_result|_review_result|_security_result|_fixer_result|_build_fix_result|_ac_fix_result|_browser_fix_result)$/;

function isUIField(key: string): boolean {
  return UI_FIELD_PATTERN.test(key);
}

/**
 * Merge UI fields from disk state into in-memory state.
 * Called by the agent before writing. Preserves UI fields set by the server
 * that the agent doesn't know about yet.
 */
function mergeUIFieldsFromDisk(memoryState: PipelineState, diskState: PipelineState): void {
  if (!diskState || !diskState.data || !memoryState || !memoryState.data) return;
  for (const key of Object.keys(diskState.data)) {
    if (isUIField(key) && (memoryState.data as any)[key] === undefined) {
      (memoryState.data as any)[key] = (diskState.data as any)[key];
    }
    // C1: Also preserve concurrency-managed fields that another writer
    // (parallel agent or server route) may have updated while this
    // process held a stale in-memory copy. Conservative semantics:
    // disk wins iff in-memory has no value, OR (for _agents_history
    // arrays) union by stable identity.
    if (CONCURRENCY_FIELD_PATTERN.test(key)) {
      const mem = (memoryState.data as any)[key];
      const disk = (diskState.data as any)[key];
      if (mem === undefined || mem === null) {
        (memoryState.data as any)[key] = disk;
      } else if (key === "_agents_history" && Array.isArray(mem) && Array.isArray(disk)) {
        // Union by (name, startedAt) — preserves entries either side knows about
        const seen = new Set<string>();
        const merged: any[] = [];
        for (const e of [...disk, ...mem]) {
          if (!e) continue;
          const id = `${e.name}|${e.startedAt}`;
          if (seen.has(id)) continue;
          seen.add(id);
          merged.push(e);
        }
        // Cap retained per the team's existing AGENTS_HISTORY_CAP (50)
        (memoryState.data as any)[key] = merged.slice(-50);
      }
    }
  }
}

/**
 * Apply a UI patch: only writes UI-namespaced fields, returns the full state.
 */
function applyUIPatch(diskState: PipelineState, gate: string, uiFields: Record<string, any>): PipelineState {
  if (!diskState.data) diskState.data = {} as any;
  for (const [suffix, value] of Object.entries(uiFields)) {
    const key = `${gate}${suffix}`;
    if (value === undefined || value === null) {
      delete (diskState.data as any)[key];
    } else {
      (diskState.data as any)[key] = value;
    }
  }
  return diskState;
}

// -- Core: Atomic Write ------------------------------------------------------
/**
 * Write state atomically: tmp -> fsync -> rename.
 * Lock MUST be held by the caller.
 */
function atomicWriteSync(stateFilePath: string, envelope: StateEnvelope): void {
  const tmpFile = stateFilePath + `.tmp.${process.pid}.${Date.now()}.${++_tmpCounter}`;
  const bakFile = stateFilePath + ".bak";
  const data = JSON.stringify(envelope, null, 2);

  // Size guard -- hard reject if over limit
  if (data.length > MAX_STATE_SIZE) {
    throw new Error(
      `State size ${(data.length / 1_000_000).toFixed(1)}MB exceeds hard limit ` +
      `${MAX_STATE_SIZE / 1_000_000}MB. Prune state before saving.`
    );
  }

  let fd = -1;
  try {
    // Write to tmp
    fd = fs.openSync(tmpFile, "w", 0o600);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd); // Flush to disk
    fs.closeSync(fd);
    fd = -1;

    // Backup current state (best-effort)
    try {
      if (fs.existsSync(stateFilePath)) {
        fs.copyFileSync(stateFilePath, bakFile);
      }
    } catch { /* ignore */ }

    // Atomic rename
    fs.renameSync(tmpFile, stateFilePath);
  } catch (err: any) {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } }

    // Clean up tmp on failure
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    if (err.code === "ENOSPC") {
      throw new Error("DISK FULL -- cannot save state. Free disk space and restart.");
    }
    throw err;
  }
}

async function atomicWriteAsync(stateFilePath: string, envelope: StateEnvelope): Promise<void> {
  const tmpFile = stateFilePath + `.tmp.${process.pid}.${Date.now()}.${++_tmpCounter}`;
  const bakFile = stateFilePath + ".bak";
  const data = JSON.stringify(envelope, null, 2);

  if (data.length > MAX_STATE_SIZE) {
    throw new Error(
      `State size ${(data.length / 1_000_000).toFixed(1)}MB exceeds hard limit ` +
      `${MAX_STATE_SIZE / 1_000_000}MB. Prune state before saving.`
    );
  }

  const fh = await fs.promises.open(tmpFile, "w", 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync(); // fsync
    await fh.close();

    // Backup
    try {
      await fs.promises.access(stateFilePath);
      await fs.promises.copyFile(stateFilePath, bakFile);
    } catch { /* ignore */ }

    // Atomic rename
    await fs.promises.rename(tmpFile, stateFilePath);
  } catch (err) {
    try { await fh.close(); } catch { /* ignore */ }
    try { await fs.promises.unlink(tmpFile); } catch { /* ignore */ }
    throw err;
  }
}

// -- Core: Read with HMAC enforcement ----------------------------------------
/**
 * Read state from disk with full HMAC verification.
 * If main file is corrupt, tries backup. If both are corrupt, quarantines and returns null.
 */
function readStateFromDisk(stateFilePath: string, opts: StateManagerOptions = {}): IReadResult | null {
  const secret = stateSecret();
  const bakFile = stateFilePath + ".bak";
  const baseDir = path.dirname(stateFilePath);
  const onWarn = opts.onWarn || (() => {});

  // Try main file
  if (fs.existsSync(stateFilePath)) {
    try {
      const raw = fs.readFileSync(stateFilePath, "utf8");
      const result = unwrapEnvelope(raw, secret, "main");

      if (result.valid) {
        return { state: result.state, seq: result.seq, source: "main" };
      }

      // HMAC mismatch on main file
      if (result.version >= 3) {
        // v3+ HMAC failure is FATAL -- quarantine
        onWarn(`HMAC mismatch on main state file -- quarantining`);
        quarantineFile(stateFilePath, baseDir);
        // Fall through to try backup
      } else if (opts.allowUnverified) {
        // v1/v2 during migration -- allow with warning
        onWarn(`Loaded unverified v${result.version} state (migration mode)`);
        return { state: result.state, seq: result.seq, source: "main_unverified" };
      } else {
        onWarn(`HMAC mismatch on v${result.version} state file -- quarantining`);
        quarantineFile(stateFilePath, baseDir);
      }
    } catch (err: any) {
      onWarn(`Main state file corrupted: ${err.message} -- trying backup`);
      quarantineFile(stateFilePath, baseDir);
    }
  }

  // Try backup
  if (fs.existsSync(bakFile)) {
    try {
      const raw = fs.readFileSync(bakFile, "utf8");
      const result = unwrapEnvelope(raw, secret, "backup");

      if (result.valid) {
        onWarn("Recovered state from verified backup");
        // Promote backup to main
        try { fs.copyFileSync(bakFile, stateFilePath); } catch { /* ignore */ }
        return { state: result.state, seq: result.seq, source: "backup" };
      }

      if (opts.allowUnverified && result.version <= 2) {
        onWarn(`Recovered unverified v${result.version} state from backup (migration mode)`);
        return { state: result.state, seq: result.seq, source: "backup_unverified" };
      }

      onWarn("Backup file also has HMAC mismatch -- quarantining");
      quarantineFile(bakFile, baseDir);
    } catch (err: any) {
      onWarn(`Backup state also corrupted: ${err.message}`);
      quarantineFile(bakFile, baseDir);
    }
  }

  return null;
}

// -- High-Level API: Synchronous (Agent Process) -----------------------------

interface StateDefaults {
  stage: string;
  ticket: string;
}

/**
 * Load state synchronously. Creates fresh state if no valid state exists.
 */
function loadSync(stateFilePath: string, defaults: StateDefaults, opts: StateManagerOptions = {}): PipelineState {
  // Crash recovery: handle orphaned tmp files
  recoverTmpFiles(stateFilePath);

  const result = readStateFromDisk(stateFilePath, {
    allowUnverified: opts.allowUnverified !== false,
    onWarn: opts.onWarn,
  });

  if (result) {
    const state = result.state;
    if (!state._seq) state._seq = result.seq || 1;
    return state;
  }

  // Fresh state
  return {
    stage: defaults.stage as any,
    ticket: defaults.ticket,
    data: {} as any,
    startedAt: new Date().toISOString(),
    _seq: 1,
  } as any;
}

/**
 * Save state synchronously with exclusive lock, HMAC, and atomic write.
 * Merges UI fields from disk before writing.
 */
function saveSync(stateFilePath: string, state: PipelineState, opts: StateManagerOptions = {}): void {
  const lock = acquireLockSync(stateFilePath);
  try {
    // Re-read disk to merge UI fields
    const diskResult = readStateFromDisk(stateFilePath, {
      allowUnverified: true,
      onWarn: opts.onWarn || (() => {}),
    });
    if (diskResult) {
      // CAS guard: verify disk _seq matches expected in-memory _seq
      const memSeq = state._seq || 0;
      const diskSeq = diskResult.seq || diskResult.state._seq || 0;
      if (memSeq > 0 && diskSeq > 0 && memSeq !== diskSeq) {
        const debug = opts.onDebug || console.debug.bind(console);
        const warn = opts.onWarn || (() => {});
        if (memSeq < diskSeq) {
          // H10: Disk has been updated by another writer since we read it.
          // Merge UI + concurrency-managed fields from disk so we don't
          // clobber them, and adopt disk's seq for monotonic bump.
          debug(`[State CAS] disk ahead (mem=${memSeq}, disk=${diskSeq}) — merging`);
          mergeUIFieldsFromDisk(state, diskResult.state);
          state._seq = diskSeq;
        } else {
          // H10: In-memory seq is ahead of disk. This should never happen
          // in normal flow (disk monotonically increases). Likely causes:
          // state-file rollback, restoration from backup, or a bug.
          // Refusing to silently adopt the lower disk seq prevents two
          // distinct writes from sharing the same effective sequence
          // number and confusing CAS readers downstream.
          warn(`[State CAS] in-memory seq ${memSeq} ahead of disk seq ${diskSeq} — keeping memSeq (disk likely rolled back)`);
          mergeUIFieldsFromDisk(state, diskResult.state);
          // state._seq stays at memSeq — next bump produces memSeq+1
        }
      } else {
        mergeUIFieldsFromDisk(state, diskResult.state);
      }
    }

    // Bump sequence number
    state._seq = (state._seq || 0) + 1;
    state.data = state.data || ({} as any);
    (state.data as any)._lastActivity = new Date().toISOString();

    // Prune if needed
    pruneState(state);

    // Write
    const secret = stateSecret();
    const envelope = wrapEnvelope(state, secret);
    atomicWriteSync(stateFilePath, envelope);
  } finally {
    lock.release();
  }
}

/**
 * Atomic read-modify-write (CAS pattern) synchronously.
 */
function updateSync(stateFilePath: string, mutator: (state: PipelineState) => PipelineState | void, opts: StateManagerOptions = {}): PipelineState {
  const lock = acquireLockSync(stateFilePath);
  try {
    // Read
    const diskResult = readStateFromDisk(stateFilePath, {
      allowUnverified: true,
      onWarn: opts.onWarn || (() => {}),
    });

    let state: PipelineState;
    if (diskResult) {
      state = diskResult.state;
      if (!state._seq) state._seq = diskResult.seq || 1;
    } else {
      throw new Error("Cannot update: no state file found");
    }

    // Apply mutation
    const readSeq = state._seq!;
    state = (mutator(state) as PipelineState) || state;

    // CAS check
    if (state._seq !== readSeq) {
      throw new Error(`CAS conflict: expected seq ${readSeq} but got ${state._seq}`);
    }

    // Bump seq
    state._seq = readSeq + 1;
    state.data = state.data || ({} as any);
    (state.data as any)._lastActivity = new Date().toISOString();

    pruneState(state);

    const secret = stateSecret();
    const envelope = wrapEnvelope(state, secret);
    atomicWriteSync(stateFilePath, envelope);

    return state;
  } finally {
    lock.release();
  }
}

/**
 * Serialized per-ticket mutator that funnels concurrent writers through the
 * exclusive lock so multiple agents completing in the same tick do not race
 * on _seq and trigger CAS-merge paths.
 *
 * Semantics: acquire lock -> read latest disk state -> run mutator (mutations
 * applied to the live disk state object) -> wrap + atomic write -> release.
 * UI-field merging happens inside the same lock via readStateFromDisk already.
 */
function withTicketStateSync(
  stateFilePath: string,
  mutator: (state: PipelineState) => void,
  opts: StateManagerOptions = {},
): PipelineState {
  const lock = acquireLockSync(stateFilePath);
  try {
    const diskResult = readStateFromDisk(stateFilePath, {
      allowUnverified: true,
      onWarn: opts.onWarn || (() => {}),
    });
    if (!diskResult) {
      throw new Error("Cannot update: no state file found");
    }

    const state = diskResult.state;
    if (!state._seq) state._seq = diskResult.seq || 1;

    mutator(state);

    state._seq = (state._seq || 0) + 1;
    state.data = state.data || ({} as any);
    (state.data as any)._lastActivity = new Date().toISOString();

    pruneState(state);

    const secret = stateSecret();
    const envelope = wrapEnvelope(state, secret);
    atomicWriteSync(stateFilePath, envelope);

    return state;
  } finally {
    lock.release();
  }
}

/**
 * Check UI approval fields from disk without modifying agent's in-memory state directly.
 */
function checkUIApprovalSync(stateFilePath: string, gatePrefix: string): UIApproval | null {
  try {
    const diskResult = readStateFromDisk(stateFilePath, {
      allowUnverified: true,
      onWarn: () => {},
    });
    if (!diskResult) return null;
    const d: any = diskResult.state.data || {};

    // Check refine first (takes priority)
    if (d[`${gatePrefix}_ui_refine`]) {
      return {
        approved: false,
        refine: true,
        instructions: d[`${gatePrefix}_ui_refine_instructions`] || "",
      };
    }

    // Then rejected (takes priority over approved)
    if (d[`${gatePrefix}_ui_rejected`]) {
      return {
        approved: false,
        feedback: d[`${gatePrefix}_ui_feedback`] || "",
      };
    }

    // Then approved
    if (d[`${gatePrefix}_ui_approved`]) {
      return { approved: true };
    }
  } catch (e: any) { console.warn("[State] checkUIApprovalSync error:", e.message); }
  return null;
}

// -- High-Level API: Async (Server Process) ----------------------------------

/**
 * Load state asynchronously.
 */
async function loadAsync(stateFilePath: string, defaults: StateDefaults | null, opts: StateManagerOptions = {}): Promise<PipelineState | null> {
  recoverTmpFiles(stateFilePath);

  const result = readStateFromDisk(stateFilePath, {
    allowUnverified: opts.allowUnverified !== false,
    onWarn: opts.onWarn || (() => {}),
  });

  if (result) {
    const state = result.state;
    if (!state._seq) state._seq = result.seq || 1;
    return state;
  }

  if (!defaults) return null;

  return {
    stage: defaults.stage as any,
    ticket: defaults.ticket,
    data: {} as any,
    startedAt: new Date().toISOString(),
    _seq: 1,
  } as any;
}

/**
 * Save state asynchronously with exclusive lock, HMAC, and atomic write.
 */
async function saveAsync(stateFilePath: string, state: PipelineState, opts: StateManagerOptions = {}): Promise<void> {
  const lock = await acquireLockAsync(stateFilePath);
  try {
    // Re-read disk for CAS validation
    const diskResult = readStateFromDisk(stateFilePath, {
      allowUnverified: true,
      onWarn: opts.onWarn || (() => {}),
    });

    // Merge UI fields from disk to prevent overwriting concurrent UI approvals
    if (diskResult) {
      // CAS guard
      const memSeq = state._seq || 0;
      const diskSeq = diskResult.seq || diskResult.state._seq || 0;
      if (memSeq > 0 && diskSeq > 0 && memSeq !== diskSeq) {
        const debug = opts.onDebug || console.debug.bind(console);
        debug(`[State CAS] CAS conflict: expected seq ${memSeq}, found ${diskSeq} -- merging`);
        mergeUIFieldsFromDisk(state, diskResult.state);
        state._seq = diskSeq; // Adopt disk seq for correct increment
      } else {
        mergeUIFieldsFromDisk(state, diskResult.state);
      }
    }

    // Bump seq
    state._seq = (state._seq || 0) + 1;
    state.data = state.data || ({} as any);
    (state.data as any)._lastActivity = new Date().toISOString();

    pruneState(state);

    const secret = stateSecret();
    const envelope = wrapEnvelope(state, secret);
    await atomicWriteAsync(stateFilePath, envelope);
  } finally {
    lock.release();
  }
}

/**
 * Async read-modify-write with lock.
 */
async function updateAsync(
  stateFilePath: string,
  mutator: (state: PipelineState) => Promise<PipelineState | void> | PipelineState | void,
  opts: StateManagerOptions = {},
): Promise<PipelineState> {
  const lock = await acquireLockAsync(stateFilePath);
  try {
    const diskResult = readStateFromDisk(stateFilePath, {
      allowUnverified: true,
      onWarn: opts.onWarn || (() => {}),
    });

    if (!diskResult) {
      throw new Error("Cannot update: no state file found");
    }

    let state = diskResult.state;
    if (!state._seq) state._seq = diskResult.seq || 1;
    const readSeq = state._seq!;

    state = ((await mutator(state)) as PipelineState) || state;

    state._seq = readSeq + 1;
    state.data = state.data || ({} as any);
    (state.data as any)._lastActivity = new Date().toISOString();

    pruneState(state);

    const secret = stateSecret();
    const envelope = wrapEnvelope(state, secret);
    await atomicWriteAsync(stateFilePath, envelope);

    return state;
  } finally {
    lock.release();
  }
}

/**
 * UI-specific patch: locks, reads disk, applies only UI fields, writes back.
 */
async function patchUIAsync(stateFilePath: string, gate: string, uiFields: Record<string, any>): Promise<PipelineState> {
  return updateAsync(stateFilePath, async (state) => {
    return applyUIPatch(state, gate, uiFields);
  });
}

/**
 * Read state for the server (read-only, no lock needed for reads).
 */
function readForDisplay(stateFilePath: string): PipelineState | null {
  const result = readStateFromDisk(stateFilePath, {
    allowUnverified: true,
    onWarn: () => {},
  });
  return result ? result.state : null;
}

// -- Review Comments Persistence ---------------------------------------------
async function saveReviewComments(stateFilePath: string, comments: any): Promise<boolean> {
  try {
    await updateAsync(stateFilePath, async (state) => {
      (state.data as any)._reviewComments = comments;
      return state;
    });
    return true;
  } catch { return false; }
}

function getReviewComments(stateFilePath: string): any {
  const state = readForDisplay(stateFilePath);
  return (state && state.data && (state.data as any)._reviewComments) || {};
}

// -- Exports -----------------------------------------------------------------
module.exports = {
  // Sync API (agent)
  loadSync,
  saveSync,
  updateSync,
  withTicketStateSync,
  checkUIApprovalSync,

  // Async API (server)
  loadAsync,
  saveAsync,
  updateAsync,
  patchUIAsync,
  readForDisplay,

  // Comments
  saveReviewComments,
  getReviewComments,

  // Shared
  stateSecret,
  pruneState,
  isUIField,

  // Recovery
  recoverTmpFiles,
  quarantineFile,

  // Migration helpers
  readStateFromDisk,
  wrapEnvelope,
  computeHmac,
  atomicWriteSync,
  atomicWriteAsync,

  // Internals for testing
  _setStateSecret,
  ENVELOPE_VERSION,
  mergeUIFieldsFromDisk,
  applyUIPatch,
};
