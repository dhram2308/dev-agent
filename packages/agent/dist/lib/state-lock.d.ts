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
import type { StateLock } from "@mi/shared";
declare class MutexTimeoutError extends Error {
    timeoutMs: number;
    queuePosition: number;
    constructor(timeoutMs: number, queuePosition: number);
}
interface LockInfo {
    pid: number;
    ts: number;
    host: string;
}
declare function isPidAlive(pid: number): boolean;
declare function readLockInfo(lockPath: string): LockInfo | null;
declare function tryBreakStaleLock(lockPath: string): boolean;
interface LockOptions {
    timeoutMs?: number;
    retryMs?: number;
}
interface LockHandle extends StateLock {
    lockPath: string;
    release: () => void;
}
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
declare function acquireLockSync(stateFilePath: string, opts?: LockOptions): LockHandle;
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
declare function acquireLockAsync(stateFilePath: string, opts?: LockOptions): Promise<LockHandle>;
declare function cleanStaleLocks(baseDir: string): string[];
export { acquireLockSync, acquireLockAsync, cleanStaleLocks, MutexTimeoutError, readLockInfo as _readLockInfo, isPidAlive as _isPidAlive, tryBreakStaleLock as _tryBreakStaleLock, };
//# sourceMappingURL=state-lock.d.ts.map