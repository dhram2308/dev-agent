interface LockInfo {
    pid: number;
    ts: number;
    host: string;
}
interface LockHandle {
    lockPath: string;
    release: () => void;
}
/**
 * Thrown when lock acquisition exceeds the configured timeout.
 * Includes the ticket ID and timeout duration for diagnostics.
 */
export declare class MutexTimeoutError extends Error {
    readonly timeoutMs: number;
    readonly ticket: string;
    readonly queuePosition: number;
    constructor(ticket: string, timeoutMs: number, queuePosition?: number);
}
/**
 * Promise-based FIFO mutex for serializing async operations on the same
 * state file within a single Node.js process.
 *
 * acquire() returns a release function that MUST be called when done.
 * Timed-out entries are automatically skipped in the dequeue path.
 */
export declare class InProcessMutex {
    private _locked;
    private _queue;
    constructor();
    /**
     * Acquire the mutex. Returns a release function.
     * Rejects with MutexTimeoutError if not acquired within timeoutMs.
     *
     * @param timeoutMs - Maximum time to wait for lock acquisition
     * @param ticket - Ticket ID for error diagnostics
     * @returns Release function that must be called when done
     */
    acquire(timeoutMs?: number, ticket?: string): Promise<() => void>;
    /**
     * Dequeue and invoke the next non-timed-out entry.
     * Skips timed-out entries to prevent queue stalls.
     */
    private _dequeueNext;
    /** Current queue depth (for diagnostics). */
    get queueDepth(): number;
    /** Whether the mutex is currently held. */
    get isLocked(): boolean;
}
/**
 * Get (or create) the in-process mutex for a given state file path.
 * Each unique file path gets its own mutex instance.
 */
declare function getFileMutex(stateFilePath: string): InProcessMutex;
/** Check if a PID is still alive. */
declare function isPidAlive(pid: number): boolean;
/** Read and parse lock file metadata. Returns null on failure. */
declare function readLockInfo(lockPath: string): LockInfo | null;
/**
 * Try to break a stale lock if the owner PID is dead or the lock is too old.
 * Returns true if the lock was broken (or was already invalid).
 */
declare function tryBreakStaleLock(lockPath: string): boolean;
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
export declare function acquireLockAsync(lockPath: string, timeoutMs?: number): Promise<() => void>;
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
export declare function acquireLockSync(lockPath: string, timeoutMs?: number): LockHandle;
/**
 * Remove all .wlock files for dead PIDs in a directory.
 * Useful for cleaning up after crashes.
 *
 * @param baseDir - Directory to scan
 * @returns Array of removed lock file names
 */
export declare function cleanStaleLocks(baseDir: string): string[];
export declare const _internals: {
    readonly readLockInfo: typeof readLockInfo;
    readonly isPidAlive: typeof isPidAlive;
    readonly tryBreakStaleLock: typeof tryBreakStaleLock;
    readonly getFileMutex: typeof getFileMutex;
    readonly _fileMutexes: Map<string, InProcessMutex>;
    readonly _activeLocks: Set<string>;
};
export {};
