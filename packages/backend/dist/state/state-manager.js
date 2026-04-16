"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRUNE_THRESHOLD = exports.MAX_STATE_SIZE = exports.ENVELOPE_VERSION = void 0;
exports.initSecret = initSecret;
exports.stateSecret = stateSecret;
exports._setStateSecret = _setStateSecret;
exports.computeHmac = computeHmac;
exports.wrapEnvelope = wrapEnvelope;
exports.unwrapEnvelope = unwrapEnvelope;
exports.quarantineFile = quarantineFile;
exports.recoverTmpFiles = recoverTmpFiles;
exports.pruneState = pruneState;
exports.mergeUIFieldsFromDisk = mergeUIFieldsFromDisk;
exports.applyUIPatch = applyUIPatch;
exports.atomicWriteSync = atomicWriteSync;
exports.atomicWriteAsync = atomicWriteAsync;
exports.readStateFromDisk = readStateFromDisk;
exports.getCurrentState = getCurrentState;
exports.setCurrentState = setCurrentState;
exports.load = load;
exports.save = save;
exports.saveAsync = saveAsync;
exports.checkUIApproval = checkUIApproval;
exports.readForDisplay = readForDisplay;
exports.getReviewComments = getReviewComments;
exports.getStateFilePath = getStateFilePath;
exports.scanAllStates = scanAllStates;
exports.classifyPipeline = classifyPipeline;
exports.buildPipelineList = buildPipelineList;
exports.getCachedPipelineList = getCachedPipelineList;
exports.invalidatePipelineCache = invalidatePipelineCache;
exports.cleanupStaleStates = cleanupStaleStates;
exports.deletePipeline = deletePipeline;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const constants_1 = require("@shared/constants");
const state_1 = require("@shared/schema/state");
Object.defineProperty(exports, "ENVELOPE_VERSION", { enumerable: true, get: function () { return state_1.ENVELOPE_VERSION; } });
Object.defineProperty(exports, "MAX_STATE_SIZE", { enumerable: true, get: function () { return state_1.MAX_STATE_SIZE; } });
Object.defineProperty(exports, "PRUNE_THRESHOLD", { enumerable: true, get: function () { return state_1.PRUNE_THRESHOLD; } });
const logger_1 = require("../lib/logger");
// ── Configuration ─────────────────────────────────────────────────
const QUARANTINE_DIR_NAME = '.state-quarantine';
// Pruning thresholds (keep in sync with @shared/schema/state)
// MAX_METRICS_RUNS = 5, MAX_WARNINGS = 200, MAX_REJECTION_HISTORY = 20
// Used inline in pruneState() below.
// Monotonic counter for unique tmp file names (avoids Date.now() collisions)
let _tmpCounter = 0;
// ── HMAC Secret Management ────────────────────────────────────────
let _stateSecret = null;
/**
 * Read or create the .state-secret file (32 bytes crypto random, hex-encoded).
 * Secret is cached in memory for the process lifetime.
 */
function getOrCreateStateSecret(baseDir) {
    const secretPath = path.join(baseDir, '.state-secret');
    try {
        if (fs.existsSync(secretPath)) {
            return fs.readFileSync(secretPath, 'utf8').trim();
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logWarn)(`[State] Secret read failed, regenerating: ${msg}`);
    }
    (0, logger_1.logWarn)('[State] HMAC secret regenerated -- existing state files may fail verification');
    const secret = crypto.randomBytes(32).toString('hex');
    try {
        fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logWarn)(`[State] Secret write failed: ${msg}`);
    }
    return secret;
}
/**
 * Initialize and return the HMAC secret. Reads or creates .state-secret.
 * @param baseDir - Base directory for the secret file (defaults to project root)
 */
function initSecret(baseDir) {
    const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
    const secret = stateSecret(dir);
    return Buffer.from(secret, 'hex');
}
/**
 * Get the cached HMAC secret string. Creates it if not yet initialized.
 */
function stateSecret(baseDir) {
    if (!_stateSecret) {
        _stateSecret = getOrCreateStateSecret(baseDir || path.join(__dirname, '..', '..', '..', '..'));
    }
    return _stateSecret;
}
/** Allow injection of a secret for testing. */
function _setStateSecret(s) {
    _stateSecret = s;
}
// ── HMAC computation ──────────────────────────────────────────────
// Optional Rust native addon for HMAC
let _nativeHmac = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const native = require('@native/mi-agent-core');
    if (typeof native?.hmacSha256 === 'function') {
        _nativeHmac = native.hmacSha256;
        (0, logger_1.logDebug)('[State] Using Rust native HMAC addon');
    }
}
catch {
    // Rust addon not available -- fall back to Node.js crypto
}
/**
 * Compute HMAC-SHA256 over a state object.
 * Uses Rust native addon if available, falls back to Node.js crypto.
 */
function computeHmac(stateObj, secret) {
    const payload = JSON.stringify(stateObj, null, 2);
    if (_nativeHmac) {
        try {
            return _nativeHmac(payload, secret);
        }
        catch {
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
function wrapEnvelope(stateObj, secret) {
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
function unwrapEnvelope(raw, secret, label = 'unknown') {
    const parsed = JSON.parse(raw); // Let caller handle parse errors
    // v3 envelope (current format)
    if (parsed && parsed._version >= 3 && parsed._hmac && parsed.state) {
        const expected = computeHmac(parsed.state, secret);
        let valid = false;
        try {
            valid = crypto.timingSafeEqual(Buffer.from(parsed._hmac, 'hex'), Buffer.from(expected, 'hex'));
        }
        catch {
            valid = false; // Length mismatch
        }
        return {
            state: parsed.state,
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
            valid = crypto.timingSafeEqual(Buffer.from(parsed._hmac, 'hex'), Buffer.from(expected, 'hex'));
        }
        catch {
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
// ── Quarantine: move corrupt files aside ──────────────────────────
/**
 * Move a corrupt state file to quarantine directory.
 * Returns the destination path, or null if quarantine failed.
 */
function quarantineFile(filePath, baseDir) {
    const quarantineDir = path.join(baseDir, QUARANTINE_DIR_NAME);
    try {
        if (!fs.existsSync(quarantineDir)) {
            fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
        }
        const basename = path.basename(filePath);
        const dest = path.join(quarantineDir, `${basename}.${Date.now()}.quarantined`);
        fs.renameSync(filePath, dest);
        return dest;
    }
    catch {
        // If quarantine fails, just rename in place
        try {
            const dest = filePath + `.corrupted.${Date.now()}`;
            fs.renameSync(filePath, dest);
            return dest;
        }
        catch {
            return null;
        }
    }
}
// ── Crash recovery: clean orphaned .tmp files ─────────────────────
/**
 * Scan for orphaned .tmp files from crashed writes.
 * Promotes a valid orphan to main if no main file exists; otherwise removes it.
 * Files younger than 10s are left alone (possibly in-progress writes).
 */
function recoverTmpFiles(stateFilePath) {
    const dir = path.dirname(stateFilePath);
    const base = path.basename(stateFilePath);
    const recovered = [];
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
                        }
                        catch { /* not parseable, fall through to remove */ }
                    }
                    // Main file exists -- discard orphaned tmp
                    try {
                        fs.unlinkSync(tmpPath);
                    }
                    catch { /* best effort */ }
                    recovered.push({ file, action: 'removed_orphan' });
                }
                // If <10s old, might be an in-progress write -- leave it alone
            }
        }
    }
    catch { /* directory read failed, nothing to recover */ }
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
function pruneState(state) {
    if (!state || !state.data)
        return state;
    const d = state.data;
    const before = JSON.stringify(state).length;
    if (before < state_1.PRUNE_THRESHOLD)
        return state;
    // Level 1: Trim metrics runs to last 3 per stage
    const metrics = d._metrics;
    if (metrics) {
        for (const key of Object.keys(metrics)) {
            const m = metrics[key];
            if (m && m.runs && m.runs.length > 3) {
                m.runs = m.runs.slice(-3);
            }
        }
    }
    if (JSON.stringify(state).length < state_1.PRUNE_THRESHOLD)
        return state;
    // Level 2: Trim warnings to last 50
    const warnings = d._warnings;
    if (Array.isArray(warnings) && warnings.length > 50) {
        d._warnings = warnings.slice(-50);
    }
    if (JSON.stringify(state).length < state_1.PRUNE_THRESHOLD)
        return state;
    // Level 3: Trim rejection history to last 5
    const rejectionHistory = d.rejectionHistory;
    if (Array.isArray(rejectionHistory) && rejectionHistory.length > 5) {
        d.rejectionHistory = rejectionHistory.slice(-5);
    }
    if (JSON.stringify(state).length < state_1.PRUNE_THRESHOLD)
        return state;
    // Level 4: Remove large debug/trace fields
    const trimmableKeys = [
        '_agent_analysis', '_agent_requirements', '_agent_explorer',
        '_agent_risk', '_agent_suggestions', '_reviewComments',
        '_verify_evidence', '_verify_api_summary', '_verify_console_summary',
    ];
    for (const key of trimmableKeys) {
        if (d[key] && JSON.stringify(d[key]).length > 50_000) {
            d[key] = typeof d[key] === 'string'
                ? d[key].substring(0, 50_000) + '\n[...pruned...]'
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
function mergeUIFieldsFromDisk(memoryState, diskState) {
    if (!diskState?.data || !memoryState?.data)
        return;
    for (const key of Object.keys(diskState.data)) {
        if ((0, state_1.isUIField)(key) && memoryState.data[key] === undefined) {
            memoryState.data[key] =
                diskState.data[key];
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
function applyUIPatch(diskState, gate, uiFields) {
    if (!diskState.data)
        diskState.data = {};
    const data = diskState.data;
    for (const [suffix, value] of Object.entries(uiFields)) {
        const key = `${gate}${suffix}`;
        if (value === undefined || value === null) {
            delete data[key];
        }
        else {
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
function atomicWriteSync(stateFilePath, envelope) {
    const tmpFile = stateFilePath + `.tmp.${process.pid}.${Date.now()}.${++_tmpCounter}`;
    const bakFile = stateFilePath + '.bak';
    const data = JSON.stringify(envelope, null, 2);
    // Size guard -- hard reject if over limit
    if (data.length > state_1.MAX_STATE_SIZE) {
        throw new Error(`State size ${(data.length / 1_000_000).toFixed(1)}MB exceeds hard limit ` +
            `${state_1.MAX_STATE_SIZE / 1_000_000}MB. Prune state before saving.`);
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
        }
        catch { /* best effort */ }
        // Atomic rename
        fs.renameSync(tmpFile, stateFilePath);
    }
    catch (err) {
        if (fd >= 0) {
            try {
                fs.closeSync(fd);
            }
            catch { /* swallow */ }
        }
        // Clean up tmp on failure
        try {
            if (fs.existsSync(tmpFile))
                fs.unlinkSync(tmpFile);
        }
        catch { /* swallow */ }
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.code === 'ENOSPC') {
            throw new Error('DISK FULL -- cannot save state. Free disk space and restart.');
        }
        throw error;
    }
}
/**
 * Write state atomically (async): tmp -> fsync -> rename.
 * Lock MUST be held by the caller.
 */
async function atomicWriteAsync(stateFilePath, envelope) {
    const tmpFile = stateFilePath + `.tmp.${process.pid}.${Date.now()}.${++_tmpCounter}`;
    const bakFile = stateFilePath + '.bak';
    const data = JSON.stringify(envelope, null, 2);
    if (data.length > state_1.MAX_STATE_SIZE) {
        throw new Error(`State size ${(data.length / 1_000_000).toFixed(1)}MB exceeds hard limit ` +
            `${state_1.MAX_STATE_SIZE / 1_000_000}MB. Prune state before saving.`);
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
        }
        catch { /* best effort */ }
        // Atomic rename
        await fs.promises.rename(tmpFile, stateFilePath);
    }
    catch (err) {
        try {
            await fh.close();
        }
        catch { /* already closed */ }
        try {
            await fs.promises.unlink(tmpFile);
        }
        catch { /* swallow */ }
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
function readStateFromDisk(stateFilePath, opts = {}) {
    const secret = stateSecret();
    const bakFile = stateFilePath + '.bak';
    const baseDir = path.dirname(stateFilePath);
    const onWarn = opts.onWarn || (() => { });
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
            }
            else if (opts.allowUnverified) {
                // v1/v2 during migration -- allow with warning
                onWarn(`Loaded unverified v${result.version} state (migration mode)`);
                return { state: result.state, seq: result.seq, source: 'main_unverified' };
            }
            else {
                onWarn(`HMAC mismatch on v${result.version} state file -- quarantining`);
                quarantineFile(stateFilePath, baseDir);
            }
        }
        catch (err) {
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
                try {
                    fs.copyFileSync(bakFile, stateFilePath);
                }
                catch { /* best effort */ }
                return { state: result.state, seq: result.seq, source: 'backup' };
            }
            if (opts.allowUnverified && result.version <= 2) {
                onWarn(`Recovered unverified v${result.version} state from backup (migration mode)`);
                return { state: result.state, seq: result.seq, source: 'backup_unverified' };
            }
            onWarn('Backup file also has HMAC mismatch -- quarantining');
            quarantineFile(bakFile, baseDir);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            onWarn(`Backup state also corrupted: ${msg}`);
            quarantineFile(bakFile, baseDir);
        }
    }
    return null;
}
// ── In-Memory State Cache ─────────────────────────────────────────
let _currentState = null;
/**
 * Get the cached in-memory state.
 * Does NOT read from disk; use `load()` for that.
 */
function getCurrentState() {
    return _currentState;
}
/**
 * Set the cached in-memory state.
 * Does NOT write to disk; use `save()` for that.
 */
function setCurrentState(state) {
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
function load(ticket, opts) {
    const baseDir = opts?.baseDir || path.join(__dirname, '..', '..', '..', '..');
    const stateFilePath = path.join(baseDir, `state-${ticket}.json`);
    // Crash recovery: handle orphaned tmp files
    const recovered = recoverTmpFiles(stateFilePath);
    if (recovered.length > 0) {
        (0, logger_1.logInfo)(`[State] Crash recovery: ${recovered.length} tmp file(s) handled`);
    }
    const result = readStateFromDisk(stateFilePath, {
        allowUnverified: opts?.allowUnverified !== false,
        onWarn: opts?.onWarn || ((msg) => (0, logger_1.logWarn)(msg)),
    });
    if (result) {
        const state = result.state;
        if (!state._seq)
            state._seq = result.seq || 1;
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
function save(state, opts) {
    const baseDir = opts?.baseDir || path.join(__dirname, '..', '..', '..', '..');
    const stateFilePath = path.join(baseDir, `state-${state.ticket}.json`);
    const onWarn = opts?.onWarn || ((msg) => (0, logger_1.logWarn)(msg));
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
        }
        else {
            mergeUIFieldsFromDisk(state, diskResult.state);
        }
    }
    // Bump sequence number
    state._seq = (state._seq || 0) + 1;
    state.data = state.data || {};
    state.data._lastActivity = new Date().toISOString();
    // Prune if needed
    pruneState(state);
    // Write
    const secret = stateSecret();
    const envelope = wrapEnvelope(state, secret);
    atomicWriteSync(stateFilePath, envelope);
    // Sync in-memory seq with what was written to disk (wrapEnvelope bumps +1)
    state._seq = envelope._seq;
    // Update in-memory cache
    _currentState = state;
}
/**
 * Save state to disk asynchronously with HMAC envelope and atomic write.
 * Same behavior as save() but uses async I/O.
 */
async function saveAsync(state, opts) {
    const baseDir = opts?.baseDir || path.join(__dirname, '..', '..', '..', '..');
    const stateFilePath = path.join(baseDir, `state-${state.ticket}.json`);
    const onWarn = opts?.onWarn || ((msg) => (0, logger_1.logWarn)(msg));
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
        }
        else {
            mergeUIFieldsFromDisk(state, diskResult.state);
        }
    }
    // Bump sequence number
    state._seq = (state._seq || 0) + 1;
    state.data = state.data || {};
    state.data._lastActivity = new Date().toISOString();
    pruneState(state);
    const secret = stateSecret();
    const envelope = wrapEnvelope(state, secret);
    await atomicWriteAsync(stateFilePath, envelope);
    // Sync in-memory seq with what was written to disk (wrapEnvelope bumps +1)
    state._seq = envelope._seq;
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
function checkUIApproval(ticket, gatePrefix, baseDir) {
    const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
    const stateFilePath = path.join(dir, `state-${ticket}.json`);
    try {
        const diskResult = readStateFromDisk(stateFilePath, {
            allowUnverified: true,
            onWarn: () => { },
        });
        if (!diskResult)
            return null;
        const d = (diskResult.state.data || {});
        // Check refine first (takes priority)
        if (d[`${gatePrefix}_ui_refine`]) {
            return {
                approved: false,
                refine: true,
                instructions: d[`${gatePrefix}_ui_refine_instructions`] || '',
            };
        }
        // Then rejected (takes priority over approved)
        if (d[`${gatePrefix}_ui_rejected`]) {
            return {
                approved: false,
                feedback: d[`${gatePrefix}_ui_feedback`] || '',
            };
        }
        // Then approved
        if (d[`${gatePrefix}_ui_approved`]) {
            return { approved: true };
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logWarn)(`[State] checkUIApproval error: ${msg}`);
    }
    return null;
}
// ── Read for Display (read-only, no lock) ─────────────────────────
/**
 * Read state for the server (read-only, no lock needed for reads).
 * Returns unwrapped state or null.
 */
function readForDisplay(ticket, baseDir) {
    const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
    const stateFilePath = path.join(dir, `state-${ticket}.json`);
    const result = readStateFromDisk(stateFilePath, {
        allowUnverified: true,
        onWarn: () => { },
    });
    return result ? result.state : null;
}
// ── Review Comments Persistence ───────────────────────────────────
/**
 * Get review comments from the state for display.
 */
function getReviewComments(ticket, baseDir) {
    const state = readForDisplay(ticket, baseDir);
    return state?.data?._reviewComments || {};
}
// ── State File Path Helper ────────────────────────────────────────
/**
 * Get the full path to a state file for a given ticket.
 */
function getStateFilePath(ticket, baseDir) {
    const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
    return path.join(dir, `state-${ticket}.json`);
}
// Gate stages that require approval
const GATE_STAGES = new Set([
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
function scanAllStates(baseDir) {
    const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
    const results = [];
    let files;
    try {
        files = fs.readdirSync(dir);
    }
    catch {
        return results;
    }
    for (const file of files) {
        if (!file.startsWith('state-') || !file.endsWith('.json'))
            continue;
        // Skip backup, tmp, and quarantine files
        if (file.includes('.bak') || file.includes('.tmp') || file.includes('.quarantined'))
            continue;
        const ticket = file.replace('state-', '').replace('.json', '');
        if (!ticket || !/^[A-Za-z]+-\d+$/.test(ticket))
            continue;
        const filePath = path.join(dir, file);
        try {
            const result = readStateFromDisk(filePath, {
                allowUnverified: true,
                onWarn: (msg) => (0, logger_1.logWarn)(`[PipelineScan] ${ticket}: ${msg}`),
            });
            if (result) {
                results.push({ ticket, state: result.state, filePath });
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logWarn)(`[PipelineScan] Skipping corrupt state for ${ticket}: ${msg}`);
        }
    }
    return results;
}
// ── Pipeline Dashboard: Classification ────────────────────────────
/**
 * Classify a scanned state into a PipelineSummary.
 * Cross-references with agentProcs map for running status.
 */
function classifyPipeline(ticket, state, isRunning) {
    const d = (state.data || {});
    const stage = state.stage || 'fetch_ticket';
    const stageIndex = constants_1.STAGES.indexOf(stage);
    const progress = stageIndex >= 0
        ? parseFloat(((stageIndex) / (constants_1.STAGES.length - 1)).toFixed(2))
        : 0;
    // Determine last activity timestamp
    const lastActivity = d._lastActivity
        || d._written_at
        || d.startedAt
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
    let status;
    if (isRunning) {
        status = 'running';
    }
    else if (isDone) {
        status = 'done';
    }
    else if (isExpired) {
        status = 'expired';
    }
    else if (isAtGate) {
        status = 'gate_waiting';
    }
    else {
        status = 'paused';
    }
    // Resumable: not running, not done, and not expired
    const resumable = !isRunning && !isDone && !isExpired;
    const resumeCount = d._resumeCount || 0;
    return {
        ticket,
        stage,
        startedAt: d.startedAt || null,
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
function buildPipelineList(agentProcs, baseDir) {
    const scanned = scanAllStates(baseDir);
    return scanned.map(({ ticket, state }) => {
        const isRunning = ticket in agentProcs;
        return classifyPipeline(ticket, state, isRunning);
    });
}
// ── Pipeline Dashboard: Cache ─────────────────────────────────────
const PIPELINE_CACHE_TTL_MS = 10_000; // 10 seconds
let _pipelineCache = null;
let _pipelineCacheTime = 0;
/**
 * Get the cached pipeline list, rebuilding if stale.
 */
function getCachedPipelineList(agentProcs, baseDir) {
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
function invalidatePipelineCache() {
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
function cleanupStaleStates(baseDir) {
    const dir = baseDir || path.join(__dirname, '..', '..', '..', '..');
    const archiveDir = path.join(dir, ARCHIVE_DIR_NAME);
    const archived = [];
    const deleted = [];
    const now = Date.now();
    // Phase 1: Archive stale state files
    const scanned = scanAllStates(dir);
    for (const { ticket, state, filePath } of scanned) {
        const d = (state.data || {});
        const lastActivity = d._lastActivity
            || d._written_at
            || d.startedAt
            || null;
        if (!lastActivity)
            continue;
        const ageMs = now - new Date(lastActivity).getTime();
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        const isDone = state.stage === 'done';
        const shouldArchive = (isDone && ageDays > DONE_CLEANUP_DAYS) ||
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
                (0, logger_1.logInfo)(`[Cleanup] Archived ${ticket} (${isDone ? 'done' : 'expired'}, ${Math.round(ageDays)}d old)`);
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                (0, logger_1.logWarn)(`[Cleanup] Failed to archive ${ticket}: ${msg}`);
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
                        (0, logger_1.logInfo)(`[Cleanup] Permanently deleted archived file: ${file}`);
                    }
                }
                catch { /* skip unreadable files */ }
            }
        }
        catch { /* archive dir read failed */ }
    }
    if (archived.length > 0 || deleted.length > 0) {
        (0, logger_1.logInfo)(`[Cleanup] Archived ${archived.length} state(s), deleted ${deleted.length} archive file(s)`);
    }
    return { archived, deleted };
}
// ── Pipeline Dashboard: Delete Pipeline ───────────────────────────
/**
 * Delete a pipeline's state file and log file from disk.
 * Returns true if anything was deleted.
 */
function deletePipeline(ticket, baseDir) {
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
        }
        catch { /* best effort */ }
    }
    if (didDelete) {
        invalidatePipelineCache();
    }
    return didDelete;
}
//# sourceMappingURL=state-manager.js.map