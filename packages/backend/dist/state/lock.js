"use strict";
// ===================================================================
// MI Dev Agent -- Lock Wrapper (TypeScript port of lib/state-lock.js)
//
// Two-layer advisory file locking for state files:
//
//   Layer 1: In-process mutex (Promise-based FIFO queue)
//     Serializes async access within the same Node.js process
//     (server handling concurrent requests).
//
//   Layer 2: OS-level file lock (O_EXCL)
//     Serializes access across different processes
//     (agent process vs server process writing the same state file).
//
// Both layers are needed because:
//   - OS file locks with O_EXCL can race within the same process when
//     multiple async operations try to create the lock file concurrently
//   - In-memory mutexes don't protect against cross-process writes
//
// Lock file format: JSON with pid, timestamp, hostname for diagnostics.
//
// Optional Rust native addon for file locking (O_EXCL) with fallback
// to Node.js fs operations.
//
// Ported from: lib/state-lock.js
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
exports._internals = exports.InProcessMutex = exports.MutexTimeoutError = void 0;
exports.acquireLockAsync = acquireLockAsync;
exports.acquireLockSync = acquireLockSync;
exports.cleanStaleLocks = cleanStaleLocks;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// ── Defaults ──────────────────────────────────────────────────────
const DEFAULT_LOCK_TIMEOUT_MS = 30_000; // 30s max wait (increased from 5s for async ops)
const DEFAULT_RETRY_INTERVAL_MS = 50; // 50ms between retries
const STALE_LOCK_AGE_MS = 30_000; // 30s -- lock older than this from dead PID is stale
// ── MutexTimeoutError ─────────────────────────────────────────────
/**
 * Thrown when lock acquisition exceeds the configured timeout.
 * Includes the ticket ID and timeout duration for diagnostics.
 */
class MutexTimeoutError extends Error {
    timeoutMs;
    ticket;
    queuePosition;
    constructor(ticket, timeoutMs, queuePosition = 0) {
        super(`InProcessMutex: timeout after ${timeoutMs}ms for ticket "${ticket}" ` +
            `(queue position: ${queuePosition})`);
        this.name = 'MutexTimeoutError';
        this.timeoutMs = timeoutMs;
        this.ticket = ticket;
        this.queuePosition = queuePosition;
    }
}
exports.MutexTimeoutError = MutexTimeoutError;
// ── In-Process Mutex (Promise-based FIFO queue) ───────────────────
/**
 * Promise-based FIFO mutex for serializing async operations on the same
 * state file within a single Node.js process.
 *
 * acquire() returns a release function that MUST be called when done.
 * Timed-out entries are automatically skipped in the dequeue path.
 */
class InProcessMutex {
    _locked;
    _queue;
    constructor() {
        this._locked = false;
        this._queue = [];
    }
    /**
     * Acquire the mutex. Returns a release function.
     * Rejects with MutexTimeoutError if not acquired within timeoutMs.
     *
     * @param timeoutMs - Maximum time to wait for lock acquisition
     * @param ticket - Ticket ID for error diagnostics
     * @returns Release function that must be called when done
     */
    acquire(timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, ticket = '') {
        return new Promise((resolve, reject) => {
            let timedOut = false;
            let timer = null;
            const entry = {
                resolve,
                reject,
                timedOut: false,
            };
            const tryAcquire = () => {
                if (timedOut || entry.timedOut) {
                    // This entry timed out -- release lock and advance queue
                    this._locked = false;
                    this._dequeueNext();
                    return;
                }
                if (!this._locked) {
                    this._locked = true;
                    if (timer)
                        clearTimeout(timer);
                    resolve(() => {
                        this._locked = false;
                        this._dequeueNext();
                    });
                }
                else {
                    this._queue.push({
                        resolve: (releaseFn) => {
                            if (timer)
                                clearTimeout(timer);
                            resolve(releaseFn);
                        },
                        reject,
                        timedOut: false,
                    });
                    // Start timeout only when queued (not when immediately acquired)
                    if (timeoutMs > 0 && !timer) {
                        timer = setTimeout(() => {
                            timedOut = true;
                            entry.timedOut = true;
                            // Mark all our queue entries as timed out
                            for (const q of this._queue) {
                                if (q.reject === reject) {
                                    q.timedOut = true;
                                }
                            }
                            reject(new MutexTimeoutError(ticket, timeoutMs, this._queue.length));
                        }, timeoutMs);
                    }
                }
            };
            tryAcquire();
        });
    }
    /**
     * Dequeue and invoke the next non-timed-out entry.
     * Skips timed-out entries to prevent queue stalls.
     */
    _dequeueNext() {
        while (this._queue.length > 0) {
            const next = this._queue.shift();
            if (next.timedOut) {
                // Skip timed-out entries -- they already rejected
                continue;
            }
            // Grant the lock to this entry
            this._locked = true;
            next.resolve(() => {
                this._locked = false;
                this._dequeueNext();
            });
            return;
        }
    }
    /** Current queue depth (for diagnostics). */
    get queueDepth() {
        return this._queue.length;
    }
    /** Whether the mutex is currently held. */
    get isLocked() {
        return this._locked;
    }
}
exports.InProcessMutex = InProcessMutex;
// ── Per-file mutex registry ───────────────────────────────────────
const _fileMutexes = new Map();
/**
 * Get (or create) the in-process mutex for a given state file path.
 * Each unique file path gets its own mutex instance.
 */
function getFileMutex(stateFilePath) {
    if (!_fileMutexes.has(stateFilePath)) {
        _fileMutexes.set(stateFilePath, new InProcessMutex());
    }
    return _fileMutexes.get(stateFilePath);
}
// ── Shared exit handler for all active file locks ─────────────────
const _activeLocks = new Set();
let _exitHandlerRegistered = false;
function _registerExitHandler() {
    if (_exitHandlerRegistered)
        return;
    _exitHandlerRegistered = true;
    process.on('exit', () => {
        for (const lockPath of _activeLocks) {
            try {
                fs.unlinkSync(lockPath);
            }
            catch { /* swallow */ }
        }
        _activeLocks.clear();
    });
}
// ── Lock file utilities ───────────────────────────────────────────
/** Generate the JSON payload for a lock file. */
function lockPayload() {
    return JSON.stringify({
        pid: process.pid,
        ts: Date.now(),
        host: os.hostname(),
    });
}
/** Check if a PID is still alive. */
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/** Read and parse lock file metadata. Returns null on failure. */
function readLockInfo(lockPath) {
    try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Try to break a stale lock if the owner PID is dead or the lock is too old.
 * Returns true if the lock was broken (or was already invalid).
 */
function tryBreakStaleLock(lockPath) {
    const info = readLockInfo(lockPath);
    if (!info) {
        // Corrupted lock file -- remove it
        try {
            fs.unlinkSync(lockPath);
        }
        catch { /* swallow */ }
        return true;
    }
    const lockAge = Date.now() - (info.ts || 0);
    const ownerAlive = isPidAlive(info.pid);
    // PID is dead -- definitely stale
    if (!ownerAlive) {
        try {
            fs.unlinkSync(lockPath);
        }
        catch { /* swallow */ }
        return true;
    }
    // PID is alive but lock is extremely old (>30s for a file write is abnormal)
    if (lockAge > STALE_LOCK_AGE_MS) {
        try {
            fs.unlinkSync(lockPath);
        }
        catch { /* swallow */ }
        return true;
    }
    return false;
}
// ── Optional Rust native addon ────────────────────────────────────
let _nativeFileLock = null;
let _nativeFileUnlock = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const native = require('@native/mi-agent-core');
    if (typeof native?.fileLockExcl === 'function') {
        _nativeFileLock = native.fileLockExcl;
        _nativeFileUnlock = native.fileUnlock;
    }
}
catch {
    // Rust addon not available -- fall back to Node.js fs
}
// ── Async lock acquisition (two-layer) ────────────────────────────
/**
 * Acquire an exclusive lock asynchronously using two-layer locking:
 *
 *   Layer 1: In-process Promise-based mutex (serializes concurrent async callers)
 *   Layer 2: OS-level file lock with O_EXCL (serializes cross-process access)
 *
 * Returns a release function that cleans up both layers.
 *
 * @param lockPath - Path to the state file (lock file = stateFile + ".wlock")
 * @param timeoutMs - Maximum time to wait for lock acquisition
 * @returns Release function that must be called when done
 * @throws MutexTimeoutError on timeout
 */
async function acquireLockAsync(lockPath, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
    const retryMs = DEFAULT_RETRY_INTERVAL_MS;
    const wlockPath = lockPath + '.wlock';
    const deadline = Date.now() + timeoutMs;
    // Extract ticket from path for diagnostics
    const ticket = path.basename(lockPath).replace(/^state-|\.json$/g, '');
    // Layer 1: In-process mutex -- wait for our turn
    const mutex = getFileMutex(lockPath);
    let mutexRelease = null;
    try {
        mutexRelease = await mutex.acquire(timeoutMs, ticket);
    }
    catch (err) {
        if (err instanceof MutexTimeoutError) {
            throw new MutexTimeoutError(ticket, timeoutMs, mutex.queueDepth);
        }
        throw err;
    }
    // Layer 2: OS file lock -- protect against cross-process writes
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
        while (true) {
            try {
                // Try Rust native addon first
                if (_nativeFileLock) {
                    const acquired = _nativeFileLock(wlockPath, lockPayload());
                    if (acquired)
                        break;
                    // Native lock failed (file exists) -- fall through to stale check
                    throw Object.assign(new Error('Lock file exists'), { code: 'EEXIST' });
                }
                // Fallback: Node.js O_CREAT | O_EXCL
                await fs.promises.writeFile(wlockPath, lockPayload(), {
                    flag: fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
                    mode: 0o600,
                });
                break; // acquired both layers
            }
            catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                if (error.code !== 'EEXIST') {
                    mutexRelease();
                    throw error;
                }
                // File lock held by another PROCESS -- try to break stale
                if (tryBreakStaleLock(wlockPath))
                    continue;
                if (Date.now() >= deadline) {
                    mutexRelease();
                    const info = readLockInfo(wlockPath);
                    throw new Error(`StateLock: async timeout acquiring lock after ${timeoutMs}ms. ` +
                        `Held by PID ${info?.pid || '?'} since ${info?.ts ? new Date(info.ts).toISOString() : '?'}. ` +
                        `Lock file: ${wlockPath}`);
                }
                await sleep(retryMs);
            }
        }
    }
    catch (err) {
        // If we haven't released the mutex yet in the inner catch paths, don't double-release
        throw err;
    }
    // Register in shared active locks set
    _registerExitHandler();
    _activeLocks.add(wlockPath);
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        _activeLocks.delete(wlockPath);
        // Release OS file lock
        if (_nativeFileUnlock) {
            try {
                _nativeFileUnlock(wlockPath);
            }
            catch { /* swallow */ }
        }
        else {
            try {
                fs.unlinkSync(wlockPath);
            }
            catch { /* swallow */ }
        }
        // Release in-process mutex AFTER file lock
        mutexRelease();
    };
}
/**
 * Acquire an exclusive lock synchronously.
 * Blocks (spins) until acquired or timeout.
 *
 * NOTE: Sync lock does NOT use in-process mutex (sync code cannot await).
 * This is fine because:
 *   - Agent process is single-threaded and only calls save() sequentially
 *   - The file-level O_EXCL protects against the server process
 *
 * @param lockPath - Path to the state file (lock file = stateFile + ".wlock")
 * @param timeoutMs - Maximum time to wait for lock acquisition
 * @returns Lock handle with release function
 * @throws Error on timeout
 */
function acquireLockSync(lockPath, timeoutMs = 5000) {
    const retryMs = DEFAULT_RETRY_INTERVAL_MS;
    const wlockPath = lockPath + '.wlock';
    const deadline = Date.now() + timeoutMs;
    let fd = -1;
    while (true) {
        try {
            // O_CREAT | O_EXCL | O_WRONLY -- fails if file exists
            fd = fs.openSync(wlockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
            fs.writeSync(fd, lockPayload());
            fs.closeSync(fd);
            break;
        }
        catch (err) {
            if (fd >= 0) {
                try {
                    fs.closeSync(fd);
                }
                catch { /* swallow */ }
                fd = -1;
            }
            const error = err instanceof Error ? err : new Error(String(err));
            if (error.code !== 'EEXIST')
                throw error;
            // Lock file exists -- try to break stale
            if (tryBreakStaleLock(wlockPath))
                continue;
            // Check timeout
            if (Date.now() >= deadline) {
                const info = readLockInfo(wlockPath);
                throw new Error(`StateLock: timeout acquiring lock after ${timeoutMs}ms. ` +
                    `Held by PID ${info?.pid || '?'} since ${info?.ts ? new Date(info.ts).toISOString() : '?'}. ` +
                    `Lock file: ${wlockPath}`);
            }
            // Busy-wait with minimal spin
            const waitUntil = Date.now() + retryMs;
            while (Date.now() < waitUntil) { /* spin */ }
        }
    }
    // Register in shared active locks set
    _registerExitHandler();
    _activeLocks.add(wlockPath);
    let released = false;
    return {
        lockPath: wlockPath,
        release: () => {
            if (released)
                return;
            released = true;
            _activeLocks.delete(wlockPath);
            try {
                fs.unlinkSync(wlockPath);
            }
            catch { /* swallow */ }
        },
    };
}
// ── Cleanup helper ────────────────────────────────────────────────
/**
 * Remove all .wlock files for dead PIDs in a directory.
 * Useful for cleaning up after crashes.
 *
 * @param baseDir - Directory to scan
 * @returns Array of removed lock file names
 */
function cleanStaleLocks(baseDir) {
    const removed = [];
    try {
        const files = fs.readdirSync(baseDir).filter((f) => f.endsWith('.wlock'));
        for (const file of files) {
            const fullPath = path.join(baseDir, file);
            if (tryBreakStaleLock(fullPath)) {
                removed.push(file);
            }
        }
    }
    catch { /* directory read failed */ }
    return removed;
}
// ── Testing exports ───────────────────────────────────────────────
exports._internals = {
    readLockInfo,
    isPidAlive,
    tryBreakStaleLock,
    getFileMutex,
    _fileMutexes,
    _activeLocks,
};
//# sourceMappingURL=lock.js.map