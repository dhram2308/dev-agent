"use strict";
/**
 * state-lock.ts — Advisory file locking for state files
 *
 * Converted from lib/state-lock.js (zero functional changes).
 *
 * Provides exclusive locking using TWO layers:
 *   1. In-process mutex (Promise-based queue) — serializes async access
 *      within the same Node.js process (server handling concurrent requests)
 *   2. OS-level file lock (O_EXCL) — serializes access across different processes
 *      (agent process vs server process writing the same state file)
 *
 * Both layers are needed because:
 *   - OS file locks with O_EXCL can race within the same process when multiple
 *     async operations try to create the lock file concurrently
 *   - In-memory mutexes don't protect against cross-process writes
 *
 * Lock file format: JSON with pid, timestamp, hostname for diagnostics.
 *
 * Uses a shared exit handler (single process.on('exit')) to avoid
 * MaxListenersExceeded warnings when many locks are held concurrently.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MutexTimeoutError = void 0;
exports.acquireLockSync = acquireLockSync;
exports.acquireLockAsync = acquireLockAsync;
exports.cleanStaleLocks = cleanStaleLocks;
exports._readLockInfo = readLockInfo;
exports._isPidAlive = isPidAlive;
exports._tryBreakStaleLock = tryBreakStaleLock;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
// ── Defaults ───────────────────────────────────────────────────────
const DEFAULT_LOCK_TIMEOUT_MS = 5000; // 5s max wait
const DEFAULT_RETRY_INTERVAL_MS = 50; // 50ms between retries
const STALE_LOCK_AGE_MS = 30_000; // 30s — lock older than this from dead PID is stale
// ── Shared exit handler for all active file locks ──────────────────
const _activeLocks = new Set();
let _exitHandlerRegistered = false;
function _registerExitHandler() {
    if (_exitHandlerRegistered)
        return;
    _exitHandlerRegistered = true;
    process.on("exit", () => {
        for (const lockPath of _activeLocks) {
            try {
                fs_1.default.unlinkSync(lockPath);
            }
            catch (e) {
                console.warn("[Lock] Exit cleanup failed:", e.message);
            }
        }
        _activeLocks.clear();
    });
}
// ── In-Process Mutex (Promise Queue) ───────────────────────────────
// Maps stateFilePath -> { queue: Promise, count: number }
// This serializes all async operations on the same file within one process.
// MutexTimeoutError — thrown when acquire() exceeds timeout
class MutexTimeoutError extends Error {
    timeoutMs;
    queuePosition;
    constructor(timeoutMs, queuePosition) {
        super(`InProcessMutex: timeout after ${timeoutMs}ms (queue position: ${queuePosition})`);
        this.name = "MutexTimeoutError";
        this.timeoutMs = timeoutMs;
        this.queuePosition = queuePosition;
    }
}
exports.MutexTimeoutError = MutexTimeoutError;
// Cleaner in-process mutex using a true FIFO queue
class InProcessMutex {
    _queue;
    _locked;
    constructor() {
        this._queue = [];
        this._locked = false;
    }
    acquire(timeoutMs = 30_000) {
        return new Promise((resolve, reject) => {
            let timedOut = false;
            let timer = null;
            const tryAcquire = () => {
                if (timedOut) {
                    // This entry timed out — release lock and advance queue
                    this._locked = false;
                    if (this._queue.length > 0) {
                        const next = this._queue.shift();
                        next();
                    }
                    return;
                }
                if (!this._locked) {
                    this._locked = true;
                    if (timer)
                        clearTimeout(timer);
                    resolve(() => {
                        this._locked = false;
                        if (this._queue.length > 0) {
                            const next = this._queue.shift();
                            next();
                        }
                    });
                }
                else {
                    this._queue.push(tryAcquire);
                    // Start timeout only when queued (not when immediately acquired)
                    if (timeoutMs > 0 && !timer) {
                        timer = setTimeout(() => {
                            timedOut = true;
                            reject(new MutexTimeoutError(timeoutMs, this._queue.length));
                        }, timeoutMs);
                    }
                }
            };
            tryAcquire();
        });
    }
}
// Per-file mutexes
const _fileMutexes = new Map();
function getFileMutex(stateFilePath) {
    if (!_fileMutexes.has(stateFilePath)) {
        _fileMutexes.set(stateFilePath, new InProcessMutex());
    }
    return _fileMutexes.get(stateFilePath);
}
function lockPayload() {
    return JSON.stringify({
        pid: process.pid,
        ts: Date.now(),
        host: os_1.default.hostname(),
    });
}
// ── Check if a PID is alive ────────────────────────────────────────
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
// ── Read lock file metadata ────────────────────────────────────────
function readLockInfo(lockPath) {
    try {
        const raw = fs_1.default.readFileSync(lockPath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
// ── Break stale lock if owner PID is dead or lock is too old ───────
function tryBreakStaleLock(lockPath) {
    const info = readLockInfo(lockPath);
    if (!info) {
        // Corrupted lock file — remove it
        try {
            fs_1.default.unlinkSync(lockPath);
        }
        catch { }
        return true;
    }
    const lockAge = Date.now() - (info.ts || 0);
    const ownerAlive = isPidAlive(info.pid);
    // PID is dead — definitely stale
    if (!ownerAlive) {
        try {
            fs_1.default.unlinkSync(lockPath);
        }
        catch { }
        return true;
    }
    // PID is alive but lock is extremely old (>30s for a file write is abnormal)
    if (lockAge > STALE_LOCK_AGE_MS) {
        try {
            fs_1.default.unlinkSync(lockPath);
        }
        catch { }
        return true;
    }
    return false;
}
// ── Synchronous lock acquisition ───────────────────────────────────
/**
 * Acquire an exclusive lock. Blocks (spins) until acquired or timeout.
 * NOTE: Sync lock does NOT use in-process mutex (sync code cannot await).
 * This is fine because:
 *   - Agent process is single-threaded and only calls saveSync sequentially
 *   - The file-level O_EXCL protects against the server process
 *
 * @param stateFilePath - Path to the state file (lock file = stateFile + ".wlock")
 * @param opts
 * @returns Lock handle
 * @throws On timeout
 */
function acquireLockSync(stateFilePath, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const retryMs = opts.retryMs ?? DEFAULT_RETRY_INTERVAL_MS;
    const lockPath = stateFilePath + ".wlock";
    const deadline = Date.now() + timeoutMs;
    let fd = -1;
    while (true) {
        try {
            // O_CREAT | O_EXCL | O_WRONLY — fails if file exists
            fd = fs_1.default.openSync(lockPath, fs_1.default.constants.O_CREAT | fs_1.default.constants.O_EXCL | fs_1.default.constants.O_WRONLY, 0o600);
            fs_1.default.writeSync(fd, lockPayload());
            fs_1.default.closeSync(fd);
            break;
        }
        catch (err) {
            if (fd >= 0) {
                try {
                    fs_1.default.closeSync(fd);
                }
                catch { }
                fd = -1;
            }
            if (err.code !== "EEXIST")
                throw err;
            // Lock file exists — try to break stale
            if (tryBreakStaleLock(lockPath))
                continue;
            // Check timeout
            if (Date.now() >= deadline) {
                const info = readLockInfo(lockPath);
                throw new Error(`StateLock: timeout acquiring lock after ${timeoutMs}ms. ` +
                    `Held by PID ${info?.pid || "?"} since ${info?.ts ? new Date(info.ts).toISOString() : "?"}. ` +
                    `Lock file: ${lockPath}`);
            }
            // Busy-wait with minimal spin
            const waitUntil = Date.now() + retryMs;
            while (Date.now() < waitUntil) { /* spin */ }
        }
    }
    // Register in shared active locks set
    _registerExitHandler();
    _activeLocks.add(lockPath);
    let released = false;
    return {
        lockPath,
        release: () => {
            if (released)
                return;
            released = true;
            _activeLocks.delete(lockPath);
            try {
                fs_1.default.unlinkSync(lockPath);
            }
            catch { }
        },
    };
}
// ── Async lock acquisition ─────────────────────────────────────────
/**
 * Acquire an exclusive lock asynchronously.
 *
 * Two-layer locking:
 *   Layer 1: In-process Promise-based mutex (serializes concurrent async callers)
 *   Layer 2: OS-level file lock with O_EXCL (serializes cross-process access)
 *
 * @param stateFilePath
 * @param opts
 * @returns Promise resolving to lock handle
 */
async function acquireLockAsync(stateFilePath, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const retryMs = opts.retryMs ?? DEFAULT_RETRY_INTERVAL_MS;
    const lockPath = stateFilePath + ".wlock";
    const deadline = Date.now() + timeoutMs;
    // Layer 1: In-process mutex — wait for our turn
    const mutex = getFileMutex(stateFilePath);
    let mutexRelease;
    try {
        mutexRelease = await mutex.acquire(timeoutMs);
    }
    catch (err) {
        if (err instanceof MutexTimeoutError) {
            const ticket = path_1.default.basename(stateFilePath).replace(/^state-|\.json$/g, "");
            console.warn(`[StateLock] Mutex timeout for ${ticket} after ${timeoutMs}ms`);
            throw new Error(`StateLock: mutex timeout for ${ticket} after ${timeoutMs}ms — another operation may be stuck`);
        }
        throw err;
    }
    // Layer 2: OS file lock — protect against cross-process writes
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
        while (true) {
            try {
                await fs_1.default.promises.writeFile(lockPath, lockPayload(), {
                    flag: fs_1.default.constants.O_CREAT | fs_1.default.constants.O_EXCL | fs_1.default.constants.O_WRONLY,
                    mode: 0o600,
                });
                break; // acquired both layers
            }
            catch (err) {
                if (err.code !== "EEXIST") {
                    mutexRelease();
                    throw err;
                }
                // File lock held by another PROCESS — try to break stale
                if (tryBreakStaleLock(lockPath))
                    continue;
                if (Date.now() >= deadline) {
                    mutexRelease();
                    const info = readLockInfo(lockPath);
                    throw new Error(`StateLock: async timeout acquiring lock after ${timeoutMs}ms. ` +
                        `Held by PID ${info?.pid || "?"} since ${info?.ts ? new Date(info.ts).toISOString() : "?"}. ` +
                        `Lock file: ${lockPath}`);
                }
                await sleep(retryMs);
            }
        }
    }
    catch (err) {
        throw err;
    }
    // Register in shared active locks set
    _registerExitHandler();
    _activeLocks.add(lockPath);
    let released = false;
    return {
        lockPath,
        release: () => {
            if (released)
                return;
            released = true;
            _activeLocks.delete(lockPath);
            try {
                fs_1.default.unlinkSync(lockPath);
            }
            catch { }
            mutexRelease(); // Release in-process mutex AFTER file lock
        },
    };
}
// ── Cleanup helper: remove all .wlock files for dead PIDs ──────────
function cleanStaleLocks(baseDir) {
    const removed = [];
    try {
        const files = fs_1.default.readdirSync(baseDir).filter((f) => f.endsWith(".wlock"));
        for (const file of files) {
            const fullPath = path_1.default.join(baseDir, file);
            if (tryBreakStaleLock(fullPath)) {
                removed.push(file);
            }
        }
    }
    catch { }
    return removed;
}
//# sourceMappingURL=state-lock.js.map