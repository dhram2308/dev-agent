// ===================================================================
// MI Dev Agent -- State Manager (TypeScript port of lib/state-unified.js)
//
// Core state persistence layer. Single source of truth for all state
// reads/writes. Provides:
//
//   1. HMAC-SHA256 integrity verification with quarantine on mismatch
//   2. Atomic write (tmp -> rename) with crash recovery
//   3. CAS (compare-and-swap) using monotonic _seq counter
//   4. Field-level merge: UI writes _ui_* fields, agent writes the rest
//   5. State size management with auto-pruning
//   6. V2/V3 backward-compatible envelope format
//   7. Optional Rust native addon for HMAC (falls back to Node.js crypto)
//
// Ported from: lib/state-unified.js
// ===================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { PipelineState, PipelineData, StageName } from '@shared/types';
import { STAGES } from '@shared/constants';
import {
  ENVELOPE_VERSION,
  MAX_STATE_SIZE,
  PRUNE_THRESHOLD,
  isUIField,
} from '@shared/schema/state';
import { logWarn, logInfo, logDebug } from '../lib/logger';

// ── Re-exports for consumers ──────────────────────────────────────
export { ENVELOPE_VERSION, MAX_STATE_SIZE, PRUNE_THRESHOLD };

// ── Configuration ─────────────────────────────────────────────────
const QUARANTINE_DIR_NAME = '.state-quarantine';
// Pruning thresholds (keep in sync with @shared/schema/state)
// MAX_METRICS_RUNS = 5, MAX_WARNINGS = 200, MAX_REJECTION_HISTORY = 20
// Used inline in pruneState() below.

// Monotonic counter for unique tmp file names (avoids Date.now() collisions)
let _tmpCounter = 0;

// ── Types ─────────────────────────────────────────────────────────

/** V3 state envelope written to disk */
export interface StateEnvelopeV3 {
  _version: 3;
  _hmac: string;
  _seq: number;
  _written_by: number | string;
  _written_at: string;
  state: PipelineState;
}

/** V2 state envelope (legacy, read-only backward compat) */
export interface StateEnvelopeV2 {
  _version: 2;
  _hmac: string;
  state: PipelineState;
}

/** Result from unwrapping an on-disk envelope */
export interface UnwrapResult {
  state: PipelineState;
  seq: number;
  valid: boolean;
  version: number;
}

/** Result from reading state from disk */
export interface ReadResult {
  state: PipelineState;
  seq: number;
  source: 'main' | 'backup' | 'main_unverified' | 'backup_unverified';
}

/** Options for readStateFromDisk */
export interface ReadOpts {
  allowUnverified?: boolean;
  onWarn?: (msg: string) => void;
}

/** Options for save operations */
export interface SaveOpts {
  onWarn?: (msg: string) => void;
}

/** Defaults for creating fresh state */
export interface StateDefaults {
  stage: PipelineState['stage'];
  ticket: string;
}

/** Recovered tmp file info */
export interface RecoveredFile {
  file: string;
  action: 'promoted_to_main' | 'removed_orphan';
}

// ── HMAC Secret Management ────────────────────────────────────────

let _stateSecret: string | null = null;

/**
 * Read or create the .state-secret file (32 bytes crypto random, hex-encoded).
 * Secret is cached in memory for the process lifetime.
 */
function getOrCreateStateSecret(baseDir: string): string {
  const secretPath = path.join(baseDir, '.state-secret');
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, 'utf8').trim();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logWarn(`[State] Secret read failed, regenerating: ${msg}`);
  }
  logWarn('[State] HMAC secret regenerated -- existing state files may fail verification');
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logWarn(`[State] Secret write failed: ${msg}`);
  }
  return secret;
}

/**
 * Initialize and return the HMAC secret. Reads or creates .state-secret.
 * @param baseDir - Base directory for the secret file (defaults to project root)
 */
export function initSecret(baseDir?: string): Buffer {
  const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
  const secret = stateSecret(dir);
  return Buffer.from(secret, 'hex');
}

/**
 * Get the cached HMAC secret string. Creates it if not yet initialized.
 */
export function stateSecret(baseDir?: string): string {
  if (!_stateSecret) {
    _stateSecret = getOrCreateStateSecret(
      baseDir || path.join(__dirname, '..', '..', '..', '..')
    );
  }
  return _stateSecret;
}

/** Allow injection of a secret for testing. */
export function _setStateSecret(s: string | null): void {
  _stateSecret = s;
}

// ── HMAC computation ──────────────────────────────────────────────

// Optional Rust native addon for HMAC
let _nativeHmac: ((data: string, secret: string) => string) | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const native = require('@native/mi-agent-core');
  if (typeof native?.hmacSha256 === 'function') {
    _nativeHmac = native.hmacSha256;
    logDebug('[State] Using Rust native HMAC addon');
  }
} catch {
  // Rust addon not available -- fall back to Node.js crypto
}

/**
 * Compute HMAC-SHA256 over a state object.
 * Uses Rust native addon if available, falls back to Node.js crypto.
 */
export function computeHmac(stateObj: PipelineState, secret: string): string {
  const payload = JSON.stringify(stateObj, null, 2);
  if (_nativeHmac) {
    try {
      return _nativeHmac(payload, secret);
    } catch {
      // Fall through to Node.js crypto
    }
  }
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// ── State envelope: wrap/unwrap ───────────────────────────────────

/**
 * Wrap a state object in a V3 HMAC envelope for disk storage.
 * Increments _seq on each wrap.
 */
export function wrapEnvelope(stateObj: PipelineState, secret: string): StateEnvelopeV3 {
  const hmac = computeHmac(stateObj, secret);
  return {
    _version: 3,
    _hmac: hmac,
    _seq: (stateObj._seq || 0) + 1,
    _written_by: process.pid,
    _written_at: new Date().toISOString(),
    state: stateObj,
  };
}

/**
 * Unwrap a state envelope from raw JSON. Validates HMAC strictly.
 *
 * @param raw - Raw JSON string from disk
 * @param secret - HMAC secret
 * @param label - "main" or "backup" for diagnostics
 * @returns Unwrapped state with validity flag
 * @throws If JSON is unparseable or format is unrecognized
 */
export function unwrapEnvelope(raw: string, secret: string, label = 'unknown'): UnwrapResult {
  const parsed = JSON.parse(raw); // Let caller handle parse errors

  // v3 envelope (current format)
  if (parsed && parsed._version >= 3 && parsed._hmac && parsed.state) {
    const expected = computeHmac(parsed.state as PipelineState, secret);
    let valid = false;
    try {
      valid = crypto.timingSafeEqual(
        Buffer.from(parsed._hmac, 'hex'),
        Buffer.from(expected, 'hex')
      );
    } catch {
      valid = false; // Length mismatch
    }
    return {
      state: parsed.state as PipelineState,
      seq: parsed._seq || 0,
      valid,
      version: parsed._version,
    };
  }

  // v2 envelope (old format -- read backward compat)
  if (parsed && parsed._version === 2 && parsed._hmac && parsed.state) {
    const stateJson = JSON.stringify(parsed.state, null, 2);
    const expected = crypto.createHmac('sha256', secret).update(stateJson).digest('hex');
    let valid = false;
    try {
      valid = crypto.timingSafeEqual(
        Buffer.from(parsed._hmac, 'hex'),
        Buffer.from(expected, 'hex')
      );
    } catch {
      valid = false; // Length mismatch
    }
    return {
      state: parsed.state as PipelineState,
      seq: (parsed.state as PipelineState)?._seq || 0,
      valid,
      version: 2,
    };
  }

  // v1 (plain state, no envelope) -- treat as unverified
  if (parsed && parsed.stage) {
    return { state: parsed as PipelineState, seq: 0, valid: false, version: 1 };
  }

  throw new Error(`Unrecognized state format (${label})`);
}

// ── Quarantine: move corrupt files aside ──────────────────────────

/**
 * Move a corrupt state file to quarantine directory.
 * Returns the destination path, or null if quarantine failed.
 */
export function quarantineFile(filePath: string, baseDir: string): string | null {
  const quarantineDir = path.join(baseDir, QUARANTINE_DIR_NAME);
  try {
    if (!fs.existsSync(quarantineDir)) {
      fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    }
    const basename = path.basename(filePath);
    const dest = path.join(quarantineDir, `${basename}.${Date.now()}.quarantined`);
    fs.renameSync(filePath, dest);
    return dest;
  } catch {
    // If quarantine fails, just rename in place
    try {
      const dest = filePath + `.corrupted.${Date.now()}`;
      fs.renameSync(filePath, dest);
      return dest;
    } catch { return null; }
  }
}

// ── Crash recovery: clean orphaned .tmp files ─────────────────────

/**
 * Scan for orphaned .tmp files from crashed writes.
 * Promotes a valid orphan to main if no main file exists; otherwise removes it.
 * Files younger than 10s are left alone (possibly in-progress writes).
 */
export function recoverTmpFiles(stateFilePath: string): RecoveredFile[] {
  const dir = path.dirname(stateFilePath);
  const base = path.basename(stateFilePath);
  const recovered: RecoveredFile[] = [];

  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith(base + '.tmp')) {
        const tmpPath = path.join(dir, file);
        const stat = fs.statSync(tmpPath);
        const ageMs = Date.now() - stat.mtimeMs;

        if (ageMs > 10_000) {
          // Older than 10s -- orphaned from a crashed write
          // Check if it's a valid state that's newer than current
          if (!fs.existsSync(stateFilePath)) {
            // No main file -- this tmp might be our only copy
            try {
              JSON.parse(fs.readFileSync(tmpPath, 'utf8')); // Parseable?
              fs.renameSync(tmpPath, stateFilePath);
              recovered.push({ file, action: 'promoted_to_main' });
              continue;
            } catch { /* not parseable, fall through to remove */ }
          }
          // Main file exists -- discard orphaned tmp
          try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
          recovered.push({ file, action: 'removed_orphan' });
        }
        // If <10s old, might be an in-progress write -- leave it alone
      }
    }
  } catch { /* directory read failed, nothing to recover */ }
  return recovered;
}

// ── State Size Management ─────────────────────────────────────────

/**
 * Prune oversized state by trimming non-essential historical data.
 * Operates in 4 levels of increasing aggression:
 *   1. Trim metrics runs to last 3 per stage
 *   2. Trim warnings to last 50
 *   3. Trim rejection history to last 5
 *   4. Remove large debug/trace fields (>50KB)
 */
export function pruneState(state: PipelineState): PipelineState {
  if (!state || !state.data) return state;
  const d = state.data as Record<string, unknown>;
  const before = JSON.stringify(state).length;
  if (before < PRUNE_THRESHOLD) return state;

  // Level 1: Trim metrics runs to last 3 per stage
  const metrics = d._metrics as Record<string, { runs?: unknown[] }> | undefined;
  if (metrics) {
    for (const key of Object.keys(metrics)) {
      const m = metrics[key];
      if (m && m.runs && m.runs.length > 3) {
        m.runs = m.runs.slice(-3);
      }
    }
  }
  if (JSON.stringify(state).length < PRUNE_THRESHOLD) return state;

  // Level 2: Trim warnings to last 50
  const warnings = d._warnings as unknown[];
  if (Array.isArray(warnings) && warnings.length > 50) {
    d._warnings = warnings.slice(-50);
  }
  if (JSON.stringify(state).length < PRUNE_THRESHOLD) return state;

  // Level 3: Trim rejection history to last 5
  const rejectionHistory = d.rejectionHistory as unknown[];
  if (Array.isArray(rejectionHistory) && rejectionHistory.length > 5) {
    d.rejectionHistory = rejectionHistory.slice(-5);
  }
  if (JSON.stringify(state).length < PRUNE_THRESHOLD) return state;

  // Level 4: Remove large debug/trace fields
  const trimmableKeys = [
    '_agent_analysis', '_agent_requirements', '_agent_explorer',
    '_agent_risk', '_agent_suggestions', '_reviewComments',
    '_verify_evidence', '_verify_api_summary', '_verify_console_summary',
  ];
  for (const key of trimmableKeys) {
    if (d[key] && JSON.stringify(d[key]).length > 50_000) {
      d[key] = typeof d[key] === 'string'
        ? (d[key] as string).substring(0, 50_000) + '\n[...pruned...]'
        : '[pruned -- exceeded 50KB]';
    }
  }

  const after = JSON.stringify(state).length;
  if (after < before) {
    d._pruned_at = new Date().toISOString();
    d._pruned_saved = before - after;
  }

  return state;
}

// ── Field-Level Merge ─────────────────────────────────────────────

/**
 * Merge UI fields from disk state into in-memory state.
 * Called by the agent before writing. Preserves UI fields set by the server
 * that the agent doesn't know about yet.
 */
export function mergeUIFieldsFromDisk(
  memoryState: PipelineState,
  diskState: PipelineState
): void {
  if (!diskState?.data || !memoryState?.data) return;
  for (const key of Object.keys(diskState.data)) {
    if (isUIField(key) && (memoryState.data as Record<string, unknown>)[key] === undefined) {
      (memoryState.data as Record<string, unknown>)[key] =
        (diskState.data as Record<string, unknown>)[key];
    }
  }
}

/**
 * Apply a UI patch: only writes UI-namespaced fields, returns the full state.
 * Server route handlers use this instead of full state writes.
 *
 * @param diskState - Current state from disk
 * @param gate - Gate prefix (e.g., "gate1", "gate2b", "explore_plan")
 * @param uiFields - Fields to set/delete (e.g., { _ui_approved: true })
 * @returns Updated state
 */
export function applyUIPatch(
  diskState: PipelineState,
  gate: string,
  uiFields: Record<string, unknown>
): PipelineState {
  if (!diskState.data) diskState.data = {} as PipelineData;
  const data = diskState.data as Record<string, unknown>;
  for (const [suffix, value] of Object.entries(uiFields)) {
    const key = `${gate}${suffix}`;
    if (value === undefined || value === null) {
      delete data[key];
    } else {
      data[key] = value;
    }
  }
  return diskState;
}

// ── Core: Atomic Write ────────────────────────────────────────────

/**
 * Write state atomically (sync): tmp -> fsync -> rename.
 * Lock MUST be held by the caller.
 */
export function atomicWriteSync(stateFilePath: string, envelope: StateEnvelopeV3): void {
  const tmpFile = stateFilePath + `.tmp.${process.pid}.${Date.now()}.${++_tmpCounter}`;
  const bakFile = stateFilePath + '.bak';
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
    fd = fs.openSync(tmpFile, 'w', 0o600);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd); // Flush to disk
    fs.closeSync(fd);
    fd = -1;

    // Backup current state (best-effort)
    try {
      if (fs.existsSync(stateFilePath)) {
        fs.copyFileSync(stateFilePath, bakFile);
      }
    } catch { /* best effort */ }

    // Atomic rename
    fs.renameSync(tmpFile, stateFilePath);
  } catch (err: unknown) {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* swallow */ } }

    // Clean up tmp on failure
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* swallow */ }

    const error = err instanceof Error ? err : new Error(String(err));
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw new Error('DISK FULL -- cannot save state. Free disk space and restart.');
    }
    throw error;
  }
}

/**
 * Write state atomically (async): tmp -> fsync -> rename.
 * Lock MUST be held by the caller.
 */
export async function atomicWriteAsync(
  stateFilePath: string,
  envelope: StateEnvelopeV3
): Promise<void> {
  const tmpFile = stateFilePath + `.tmp.${process.pid}.${Date.now()}.${++_tmpCounter}`;
  const bakFile = stateFilePath + '.bak';
  const data = JSON.stringify(envelope, null, 2);

  if (data.length > MAX_STATE_SIZE) {
    throw new Error(
      `State size ${(data.length / 1_000_000).toFixed(1)}MB exceeds hard limit ` +
      `${MAX_STATE_SIZE / 1_000_000}MB. Prune state before saving.`
    );
  }

  const fh = await fs.promises.open(tmpFile, 'w', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync(); // fsync
    await fh.close();

    // Backup
    try {
      await fs.promises.access(stateFilePath);
      await fs.promises.copyFile(stateFilePath, bakFile);
    } catch { /* best effort */ }

    // Atomic rename
    await fs.promises.rename(tmpFile, stateFilePath);
  } catch (err) {
    try { await fh.close(); } catch { /* already closed */ }
    try { await fs.promises.unlink(tmpFile); } catch { /* swallow */ }
    throw err;
  }
}

// ── Core: Read with HMAC enforcement ──────────────────────────────

/**
 * Read state from disk with full HMAC verification.
 * If main file is corrupt, tries backup. If both are corrupt,
 * quarantines and returns null.
 *
 * @param stateFilePath - Path to the state-{ticket}.json file
 * @param opts - Read options
 * @returns Read result with state, seq, and source indicator, or null
 */
export function readStateFromDisk(
  stateFilePath: string,
  opts: ReadOpts = {}
): ReadResult | null {
  const secret = stateSecret();
  const bakFile = stateFilePath + '.bak';
  const baseDir = path.dirname(stateFilePath);
  const onWarn = opts.onWarn || (() => {});

  // Try main file
  if (fs.existsSync(stateFilePath)) {
    try {
      const raw = fs.readFileSync(stateFilePath, 'utf8');
      const result = unwrapEnvelope(raw, secret, 'main');

      if (result.valid) {
        return { state: result.state, seq: result.seq, source: 'main' };
      }

      // HMAC mismatch on main file
      if (result.version >= 3) {
        // v3+ HMAC failure is FATAL -- quarantine
        onWarn('HMAC mismatch on main state file -- quarantining');
        quarantineFile(stateFilePath, baseDir);
        // Fall through to try backup
      } else if (opts.allowUnverified) {
        // v1/v2 during migration -- allow with warning
        onWarn(`Loaded unverified v${result.version} state (migration mode)`);
        return { state: result.state, seq: result.seq, source: 'main_unverified' };
      } else {
        onWarn(`HMAC mismatch on v${result.version} state file -- quarantining`);
        quarantineFile(stateFilePath, baseDir);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onWarn(`Main state file corrupted: ${msg} -- trying backup`);
      quarantineFile(stateFilePath, baseDir);
    }
  }

  // Try backup
  if (fs.existsSync(bakFile)) {
    try {
      const raw = fs.readFileSync(bakFile, 'utf8');
      const result = unwrapEnvelope(raw, secret, 'backup');

      if (result.valid) {
        onWarn('Recovered state from verified backup');
        // Promote backup to main
        try { fs.copyFileSync(bakFile, stateFilePath); } catch { /* best effort */ }
        return { state: result.state, seq: result.seq, source: 'backup' };
      }

      if (opts.allowUnverified && result.version <= 2) {
        onWarn(`Recovered unverified v${result.version} state from backup (migration mode)`);
        return { state: result.state, seq: result.seq, source: 'backup_unverified' };
      }

      onWarn('Backup file also has HMAC mismatch -- quarantining');
      quarantineFile(bakFile, baseDir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onWarn(`Backup state also corrupted: ${msg}`);
      quarantineFile(bakFile, baseDir);
    }
  }

  return null;
}

// ── In-Memory State Cache ─────────────────────────────────────────

let _currentState: PipelineState | null = null;

/**
 * Get the cached in-memory state.
 * Does NOT read from disk; use `load()` for that.
 */
export function getCurrentState(): PipelineState | null {
  return _currentState;
}

/**
 * Set the cached in-memory state.
 * Does NOT write to disk; use `save()` for that.
 */
export function setCurrentState(state: PipelineState | null): void {
  _currentState = state;
}

// ── High-Level API: load/save ─────────────────────────────────────

/**
 * Load state from disk for a ticket. Handles crash recovery,
 * HMAC verification, and V2/V3 backward compatibility.
 *
 * Returns the deserialized PipelineState, or null if no valid state exists.
 *
 * @param ticket - Jira ticket ID (used to construct state file path)
 * @param opts - Read options (allowUnverified defaults to true)
 * @returns Loaded PipelineState or null
 */
export function load(ticket: string, opts?: ReadOpts & { baseDir?: string }): PipelineState | null {
  const baseDir = opts?.baseDir || path.join(__dirname, '..', '..', '..', '..');
  const stateFilePath = path.join(baseDir, `state-${ticket}.json`);

  // Crash recovery: handle orphaned tmp files
  const recovered = recoverTmpFiles(stateFilePath);
  if (recovered.length > 0) {
    logInfo(`[State] Crash recovery: ${recovered.length} tmp file(s) handled`);
  }

  const result = readStateFromDisk(stateFilePath, {
    allowUnverified: opts?.allowUnverified !== false,
    onWarn: opts?.onWarn || ((msg: string) => logWarn(msg)),
  });

  if (result) {
    const state = result.state;
    if (!state._seq) state._seq = result.seq || 1;
    _currentState = state;
    return state;
  }

  return null;
}

/**
 * Save state to disk with HMAC envelope and atomic write.
 * Merges UI fields from disk before writing, increments _seq,
 * prunes oversized state, and updates the in-memory cache.
 *
 * NOTE: This function does NOT acquire a lock. The caller is responsible
 * for holding a lock via lock.ts when concurrent access is possible.
 * For agent-side (single-threaded) use, locking may be omitted.
 *
 * @param state - The full PipelineState to save
 * @param opts - Save options
 */
export function save(
  state: PipelineState,
  opts?: SaveOpts & { baseDir?: string }
): void {
  const baseDir = opts?.baseDir || path.join(__dirname, '..', '..', '..', '..');
  const stateFilePath = path.join(baseDir, `state-${state.ticket}.json`);
  const onWarn = opts?.onWarn || ((msg: string) => logWarn(msg));

  // Re-read disk to merge UI fields and validate CAS
  const diskResult = readStateFromDisk(stateFilePath, {
    allowUnverified: true,
    onWarn,
  });

  if (diskResult) {
    // CAS guard: verify disk _seq matches expected in-memory _seq
    const memSeq = state._seq || 0;
    const diskSeq = diskResult.seq || diskResult.state._seq || 0;
    if (memSeq > 0 && diskSeq > 0 && memSeq !== diskSeq) {
      onWarn(`[State CAS] CAS conflict: expected seq ${memSeq}, found ${diskSeq} -- merging`);
      // Re-read and merge: adopt disk state's data, overlay our changes
      mergeUIFieldsFromDisk(state, diskResult.state);
      state._seq = diskSeq; // Adopt disk seq for correct increment
    } else {
      mergeUIFieldsFromDisk(state, diskResult.state);
    }
  }

  // Bump sequence number
  state._seq = (state._seq || 0) + 1;
  state.data = state.data || ({} as PipelineData);
  (state.data as Record<string, unknown>)._lastActivity = new Date().toISOString();

  // Prune if needed
  pruneState(state);

  // Write
  const secret = stateSecret();
  const envelope = wrapEnvelope(state, secret);
  atomicWriteSync(stateFilePath, envelope);

  // Update in-memory cache
  _currentState = state;
}

/**
 * Save state to disk asynchronously with HMAC envelope and atomic write.
 * Same behavior as save() but uses async I/O.
 */
export async function saveAsync(
  state: PipelineState,
  opts?: SaveOpts & { baseDir?: string }
): Promise<void> {
  const baseDir = opts?.baseDir || path.join(__dirname, '..', '..', '..', '..');
  const stateFilePath = path.join(baseDir, `state-${state.ticket}.json`);
  const onWarn = opts?.onWarn || ((msg: string) => logWarn(msg));

  // Re-read disk to merge UI fields and validate CAS
  const diskResult = readStateFromDisk(stateFilePath, {
    allowUnverified: true,
    onWarn,
  });

  if (diskResult) {
    const memSeq = state._seq || 0;
    const diskSeq = diskResult.seq || diskResult.state._seq || 0;
    if (memSeq > 0 && diskSeq > 0 && memSeq !== diskSeq) {
      onWarn(`[State CAS] CAS conflict: expected seq ${memSeq}, found ${diskSeq} -- merging`);
      mergeUIFieldsFromDisk(state, diskResult.state);
      state._seq = diskSeq;
    } else {
      mergeUIFieldsFromDisk(state, diskResult.state);
    }
  }

  // Bump sequence number
  state._seq = (state._seq || 0) + 1;
  state.data = state.data || ({} as PipelineData);
  (state.data as Record<string, unknown>)._lastActivity = new Date().toISOString();

  pruneState(state);

  const secret = stateSecret();
  const envelope = wrapEnvelope(state, secret);
  await atomicWriteAsync(stateFilePath, envelope);

  _currentState = state;
}

// ── UI Approval Check ─────────────────────────────────────────────

/**
 * Check UI approval fields from disk without modifying agent's in-memory state.
 * Returns the UI action if any, or null.
 *
 * @param ticket - Jira ticket ID
 * @param gatePrefix - Gate prefix (e.g., "gate1", "gate2b", "explore_plan")
 * @param baseDir - Optional base directory for the state file
 */
export function checkUIApproval(
  ticket: string,
  gatePrefix: string,
  baseDir?: string
): { approved: boolean; feedback?: string; refine?: boolean; instructions?: string } | null {
  const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
  const stateFilePath = path.join(dir, `state-${ticket}.json`);

  try {
    const diskResult = readStateFromDisk(stateFilePath, {
      allowUnverified: true,
      onWarn: () => {},
    });
    if (!diskResult) return null;
    const d = (diskResult.state.data || {}) as Record<string, unknown>;

    // Check refine first (takes priority)
    if (d[`${gatePrefix}_ui_refine`]) {
      return {
        approved: false,
        refine: true,
        instructions: (d[`${gatePrefix}_ui_refine_instructions`] as string) || '',
      };
    }

    // Then rejected (takes priority over approved)
    if (d[`${gatePrefix}_ui_rejected`]) {
      return {
        approved: false,
        feedback: (d[`${gatePrefix}_ui_feedback`] as string) || '',
      };
    }

    // Then approved
    if (d[`${gatePrefix}_ui_approved`]) {
      return { approved: true };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logWarn(`[State] checkUIApproval error: ${msg}`);
  }
  return null;
}

// ── Read for Display (read-only, no lock) ─────────────────────────

/**
 * Read state for the server (read-only, no lock needed for reads).
 * Returns unwrapped state or null.
 */
export function readForDisplay(ticket: string, baseDir?: string): PipelineState | null {
  const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
  const stateFilePath = path.join(dir, `state-${ticket}.json`);

  const result = readStateFromDisk(stateFilePath, {
    allowUnverified: true,
    onWarn: () => {},
  });
  return result ? result.state : null;
}

// ── Review Comments Persistence ───────────────────────────────────

/**
 * Get review comments from the state for display.
 */
export function getReviewComments(
  ticket: string,
  baseDir?: string
): Record<string, unknown> {
  const state = readForDisplay(ticket, baseDir);
  return (state?.data as Record<string, unknown>)?._reviewComments as Record<string, unknown> || {};
}

// ── State File Path Helper ────────────────────────────────────────

/**
 * Get the full path to a state file for a given ticket.
 */
export function getStateFilePath(ticket: string, baseDir?: string): string {
  const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
  return path.join(dir, `state-${ticket}.json`);
}

// ── Pipeline Dashboard: Types ─────────────────────────────────────

/** Pipeline status values */
export type PipelineStatus = 'running' | 'paused' | 'gate_waiting' | 'done' | 'expired';

/** Summary returned by scanAllStates / getPipelineList */
export interface PipelineSummary {
  ticket: string;
  stage: string;
  startedAt: string | null;
  lastActivity: string | null;
  running: boolean;
  resumable: boolean;
  daysRemaining: number;
  needsApproval: boolean;
  gateStage: string | null;
  progress: number;
  status: PipelineStatus;
  resumeCount: number;
}

// Gate stages that require approval
const GATE_STAGES = new Set<string>([
  'gate_code_review',
  'gate_preprod_approval',
  'gate_dual_approval',
]);

/** 7-day resume window in milliseconds */
const RESUME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ── Pipeline Dashboard: Scan ──────────────────────────────────────

/**
 * Scan all state-*.json files from disk.
 * Reads each with HMAC validation, skips corrupt files.
 * Returns raw state data for classification.
 */
export function scanAllStates(baseDir?: string): Array<{
  ticket: string;
  state: PipelineState;
  filePath: string;
}> {
  const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
  const results: Array<{ ticket: string; state: PipelineState; filePath: string }> = [];

  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return results;
  }

  for (const file of files) {
    if (!file.startsWith('state-') || !file.endsWith('.json')) continue;
    // Skip backup, tmp, and quarantine files
    if (file.includes('.bak') || file.includes('.tmp') || file.includes('.quarantined')) continue;

    const ticket = file.replace('state-', '').replace('.json', '');
    if (!ticket || !/^[A-Za-z]+-\d+$/.test(ticket)) continue;

    const filePath = path.join(dir, file);
    try {
      const result = readStateFromDisk(filePath, {
        allowUnverified: true,
        onWarn: (msg: string) => logWarn(`[PipelineScan] ${ticket}: ${msg}`),
      });
      if (result) {
        results.push({ ticket, state: result.state, filePath });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn(`[PipelineScan] Skipping corrupt state for ${ticket}: ${msg}`);
    }
  }

  return results;
}

// ── Pipeline Dashboard: Classification ────────────────────────────

/**
 * Classify a scanned state into a PipelineSummary.
 * Cross-references with agentProcs map for running status.
 */
export function classifyPipeline(
  ticket: string,
  state: PipelineState,
  isRunning: boolean,
): PipelineSummary {
  const d = (state.data || {}) as Record<string, unknown>;
  const stage = state.stage || 'fetch_ticket';
  const stageIndex = (STAGES as readonly string[]).indexOf(stage);
  const progress = stageIndex >= 0
    ? parseFloat(((stageIndex) / (STAGES.length - 1)).toFixed(2))
    : 0;

  // Determine last activity timestamp
  const lastActivity = (d._lastActivity as string)
    || (d._written_at as string)
    || (d.startedAt as string)
    || null;

  const lastActivityMs = lastActivity ? new Date(lastActivity).getTime() : 0;
  const ageMs = lastActivityMs ? Date.now() - lastActivityMs : Infinity;
  const daysRemaining = lastActivityMs
    ? Math.max(0, Math.round((RESUME_WINDOW_MS - ageMs) / (24 * 60 * 60 * 1000) * 10) / 10)
    : 0;
  const isExpired = ageMs > RESUME_WINDOW_MS;
  const isDone = stage === 'done';
  const isAtGate = GATE_STAGES.has(stage);
  const needsApproval = isAtGate;

  // Determine status
  let status: PipelineStatus;
  if (isRunning) {
    status = 'running';
  } else if (isDone) {
    status = 'done';
  } else if (isExpired) {
    status = 'expired';
  } else if (isAtGate) {
    status = 'gate_waiting';
  } else {
    status = 'paused';
  }

  // Resumable: not running, not done, and not expired
  const resumable = !isRunning && !isDone && !isExpired;

  const resumeCount = (d._resumeCount as number) || 0;

  return {
    ticket,
    stage,
    startedAt: (d.startedAt as string) || null,
    lastActivity,
    running: isRunning,
    resumable,
    daysRemaining,
    needsApproval,
    gateStage: isAtGate ? stage : null,
    progress,
    status,
    resumeCount,
  };
}

/**
 * Build the full pipeline list: scan disk + classify with running status.
 *
 * @param agentProcs - Map of running agent processes (ticket → process)
 * @param baseDir - Base directory for state files
 */
export function buildPipelineList(
  agentProcs: Record<string, unknown>,
  baseDir?: string,
): PipelineSummary[] {
  const scanned = scanAllStates(baseDir);
  return scanned.map(({ ticket, state }) => {
    const isRunning = ticket in agentProcs;
    return classifyPipeline(ticket, state, isRunning);
  });
}

// ── Pipeline Dashboard: Cache ─────────────────────────────────────

const PIPELINE_CACHE_TTL_MS = 10_000; // 10 seconds

let _pipelineCache: PipelineSummary[] | null = null;
let _pipelineCacheTime = 0;

/**
 * Get the cached pipeline list, rebuilding if stale.
 */
export function getCachedPipelineList(
  agentProcs: Record<string, unknown>,
  baseDir?: string,
): PipelineSummary[] {
  const now = Date.now();
  if (_pipelineCache && (now - _pipelineCacheTime) < PIPELINE_CACHE_TTL_MS) {
    return _pipelineCache;
  }
  _pipelineCache = buildPipelineList(agentProcs, baseDir);
  _pipelineCacheTime = now;
  return _pipelineCache;
}

/**
 * Invalidate the pipeline list cache.
 * Call on agent start/stop, state writes, and pipeline deletes.
 */
export function invalidatePipelineCache(): void {
  _pipelineCache = null;
  _pipelineCacheTime = 0;
}

// ── Pipeline Dashboard: Auto-Cleanup ──────────────────────────────

const ARCHIVE_DIR_NAME = '.state-archive';
const DONE_CLEANUP_DAYS = 30;
const EXPIRED_CLEANUP_DAYS = 14;
const ARCHIVE_RETENTION_DAYS = 7;

/**
 * Clean up stale state files on server startup.
 * Archives done > 30 days and expired > 14 days.
 * Deletes archived files > 7 days old.
 */
export function cleanupStaleStates(baseDir?: string): { archived: string[]; deleted: string[] } {
  const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
  const archiveDir = path.join(dir, ARCHIVE_DIR_NAME);
  const archived: string[] = [];
  const deleted: string[] = [];
  const now = Date.now();

  // Phase 1: Archive stale state files
  const scanned = scanAllStates(dir);
  for (const { ticket, state, filePath } of scanned) {
    const d = (state.data || {}) as Record<string, unknown>;
    const lastActivity = (d._lastActivity as string)
      || (d._written_at as string)
      || (d.startedAt as string)
      || null;
    if (!lastActivity) continue;

    const ageMs = now - new Date(lastActivity).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const isDone = state.stage === 'done';

    const shouldArchive =
      (isDone && ageDays > DONE_CLEANUP_DAYS) ||
      (!isDone && ageDays > (RESUME_WINDOW_MS / (24 * 60 * 60 * 1000)) && ageDays > EXPIRED_CLEANUP_DAYS);

    if (shouldArchive) {
      try {
        if (!fs.existsSync(archiveDir)) {
          fs.mkdirSync(archiveDir, { recursive: true });
        }
        // Move state file
        const destState = path.join(archiveDir, path.basename(filePath));
        fs.renameSync(filePath, destState);
        archived.push(ticket);

        // Move log file if exists
        const logFile = path.join(dir, `agent-${ticket}.log`);
        if (fs.existsSync(logFile)) {
          fs.renameSync(logFile, path.join(archiveDir, `agent-${ticket}.log`));
        }

        // Move backup file if exists
        const bakFile = filePath + '.bak';
        if (fs.existsSync(bakFile)) {
          fs.renameSync(bakFile, path.join(archiveDir, path.basename(bakFile)));
        }

        logInfo(`[Cleanup] Archived ${ticket} (${isDone ? 'done' : 'expired'}, ${Math.round(ageDays)}d old)`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logWarn(`[Cleanup] Failed to archive ${ticket}: ${msg}`);
      }
    }
  }

  // Phase 2: Delete old archived files (> 7 days in archive)
  if (fs.existsSync(archiveDir)) {
    try {
      const archiveFiles = fs.readdirSync(archiveDir);
      for (const file of archiveFiles) {
        const archivePath = path.join(archiveDir, file);
        try {
          const stat = fs.statSync(archivePath);
          const archiveAgeMs = now - stat.mtimeMs;
          if (archiveAgeMs > ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
            fs.unlinkSync(archivePath);
            deleted.push(file);
            logInfo(`[Cleanup] Permanently deleted archived file: ${file}`);
          }
        } catch { /* skip unreadable files */ }
      }
    } catch { /* archive dir read failed */ }
  }

  if (archived.length > 0 || deleted.length > 0) {
    logInfo(`[Cleanup] Archived ${archived.length} state(s), deleted ${deleted.length} archive file(s)`);
  }

  return { archived, deleted };
}

// ── Pipeline Dashboard: Delete Pipeline ───────────────────────────

/**
 * Delete a pipeline's state file and log file from disk.
 * Returns true if anything was deleted.
 */
export function deletePipeline(ticket: string, baseDir?: string): boolean {
  const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
  let didDelete = false;

  const stateFile = path.join(dir, `state-${ticket}.json`);
  const bakFile = stateFile + '.bak';
  const logFile = path.join(dir, `agent-${ticket}.log`);

  for (const file of [stateFile, bakFile, logFile]) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        didDelete = true;
      }
    } catch { /* best effort */ }
  }

  if (didDelete) {
    invalidatePipelineCache();
  }

  return didDelete;
}
