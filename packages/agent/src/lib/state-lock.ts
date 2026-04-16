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

import fs from "fs";
import path from "path";
import os from "os";

import type { StateLock } from "@mi/shared";

// ── Defaults ───────────────────────────────────────────────────────
const DEFAULT_LOCK_TIMEOUT_MS = 5000;    // 5s max wait
const DEFAULT_RETRY_INTERVAL_MS = 50;    // 50ms between retries
const STALE_LOCK_AGE_MS = 30_000;        // 30s — lock older than this from dead PID is stale

// ── Shared exit handler for all active file locks ──────────────────
const _activeLocks = new Set<string>();
let _exitHandlerRegistered = false;

function _registerExitHandler(): void {
  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;
  process.on("exit", () => {
    for (const lockPath of _activeLocks) {
      try { fs.unlinkSync(lockPath); } catch (e: any) { console.warn("[Lock] Exit cleanup failed:", e.message); }
    }
    _activeLocks.clear();
  });
}

// ── In-Process Mutex (Promise Queue) ───────────────────────────────
// Maps stateFilePath -> { queue: Promise, count: number }
// This serializes all async operations on the same file within one process.

// MutexTimeoutError — thrown when acquire() exceeds timeout
class MutexTimeoutError extends Error {
  timeoutMs: number;
  queuePosition: number;

  constructor(timeoutMs: number, queuePosition: number) {
    super(`InProcessMutex: timeout after ${timeoutMs}ms (queue position: ${queuePosition})`);
    this.name = "MutexTimeoutError";
    this.timeoutMs = timeoutMs;
    this.queuePosition = queuePosition;
  }
}

// Cleaner in-process mutex using a true FIFO queue
class InProcessMutex {
  private _queue: Array<() => void>;
  private _locked: boolean;

  constructor() {
    this._queue = [];
    this._locked = false;
  }

  acquire(timeoutMs: number = 30_000): Promise<() => void> {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const tryAcquire = (): void => {
        if (timedOut) {
          // This entry timed out — release lock and advance queue
          this._locked = false;
          if (this._queue.length > 0) {
            const next = this._queue.shift()!;
            next();
          }
          return;
        }
        if (!this._locked) {
          this._locked = true;
          if (timer) clearTimeout(timer);
          resolve(() => {
            this._locked = false;
            if (this._queue.length > 0) {
              const next = this._queue.shift()!;
              next();
            }
          });
        } else {
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
const _fileMutexes = new Map<string, InProcessMutex>();

function getFileMutex(stateFilePath: string): InProcessMutex {
  if (!_fileMutexes.has(stateFilePath)) {
    _fileMutexes.set(stateFilePath, new InProcessMutex());
  }
  return _fileMutexes.get(stateFilePath)!;
}

// ── Lock info written into .lock file ──────────────────────────────

interface LockInfo {
  pid: number;
  ts: number;
  host: string;
}

function lockPayload(): string {
  return JSON.stringify({
    pid: process.pid,
    ts: Date.now(),
    host: os.hostname(),
  });
}

// ── Check if a PID is alive ────────────────────────────────────────
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Read lock file metadata ────────────────────────────────────────
function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Break stale lock if owner PID is dead or lock is too old ───────
function tryBreakStaleLock(lockPath: string): boolean {
  const info = readLockInfo(lockPath);
  if (!info) {
    // Corrupted lock file — remove it
    try { fs.unlinkSync(lockPath); } catch {}
    return true;
  }

  const lockAge = Date.now() - (info.ts || 0);
  const ownerAlive = isPidAlive(info.pid);

  // PID is dead — definitely stale
  if (!ownerAlive) {
    try { fs.unlinkSync(lockPath); } catch {}
    return true;
  }

  // PID is alive but lock is extremely old (>30s for a file write is abnormal)
  if (lockAge > STALE_LOCK_AGE_MS) {
    try { fs.unlinkSync(lockPath); } catch {}
    return true;
  }

  return false;
}

// ── Lock options ───────────────────────────────────────────────────
interface LockOptions {
  timeoutMs?: number;
  retryMs?: number;
}

// ── Lock handle ────────────────────────────────────────────────────
interface LockHandle extends StateLock {
  lockPath: string;
  release: () => void;
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
function acquireLockSync(stateFilePath: string, opts: LockOptions = {}): LockHandle {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const lockPath = stateFilePath + ".wlock";
  const deadline = Date.now() + timeoutMs;

  let fd = -1;
  while (true) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — fails if file exists
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(fd, lockPayload());
      fs.closeSync(fd);
      break;
    } catch (err: any) {
      if (fd >= 0) { try { fs.closeSync(fd); } catch {} fd = -1; }

      if (err.code !== "EEXIST") throw err;

      // Lock file exists — try to break stale
      if (tryBreakStaleLock(lockPath)) continue;

      // Check timeout
      if (Date.now() >= deadline) {
        const info = readLockInfo(lockPath);
        throw new Error(
          `StateLock: timeout acquiring lock after ${timeoutMs}ms. ` +
          `Held by PID ${info?.pid || "?"} since ${info?.ts ? new Date(info.ts).toISOString() : "?"}. ` +
          `Lock file: ${lockPath}`
        );
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
      if (released) return;
      released = true;
      _activeLocks.delete(lockPath);
      try { fs.unlinkSync(lockPath); } catch {}
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
async function acquireLockAsync(stateFilePath: string, opts: LockOptions = {}): Promise<LockHandle> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const lockPath = stateFilePath + ".wlock";
  const deadline = Date.now() + timeoutMs;

  // Layer 1: In-process mutex — wait for our turn
  const mutex = getFileMutex(stateFilePath);
  let mutexRelease: () => void;
  try {
    mutexRelease = await mutex.acquire(timeoutMs);
  } catch (err) {
    if (err instanceof MutexTimeoutError) {
      const ticket = path.basename(stateFilePath).replace(/^state-|\.json$/g, "");
      console.warn(`[StateLock] Mutex timeout for ${ticket} after ${timeoutMs}ms`);
      throw new Error(`StateLock: mutex timeout for ${ticket} after ${timeoutMs}ms — another operation may be stuck`);
    }
    throw err;
  }

  // Layer 2: OS file lock — protect against cross-process writes
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  try {
    while (true) {
      try {
        await fs.promises.writeFile(lockPath, lockPayload(), {
          flag: fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          mode: 0o600,
        });
        break; // acquired both layers
      } catch (err: any) {
        if (err.code !== "EEXIST") {
          mutexRelease();
          throw err;
        }

        // File lock held by another PROCESS — try to break stale
        if (tryBreakStaleLock(lockPath)) continue;

        if (Date.now() >= deadline) {
          mutexRelease();
          const info = readLockInfo(lockPath);
          throw new Error(
            `StateLock: async timeout acquiring lock after ${timeoutMs}ms. ` +
            `Held by PID ${info?.pid || "?"} since ${info?.ts ? new Date(info.ts).toISOString() : "?"}. ` +
            `Lock file: ${lockPath}`
          );
        }

        await sleep(retryMs);
      }
    }
  } catch (err) {
    throw err;
  }

  // Register in shared active locks set
  _registerExitHandler();
  _activeLocks.add(lockPath);

  let released = false;
  return {
    lockPath,
    release: () => {
      if (released) return;
      released = true;
      _activeLocks.delete(lockPath);
      try { fs.unlinkSync(lockPath); } catch {}
      mutexRelease(); // Release in-process mutex AFTER file lock
    },
  };
}

// ── Cleanup helper: remove all .wlock files for dead PIDs ──────────
function cleanStaleLocks(baseDir: string): string[] {
  const removed: string[] = [];
  try {
    const files = fs.readdirSync(baseDir).filter((f) => f.endsWith(".wlock"));
    for (const file of files) {
      const fullPath = path.join(baseDir, file);
      if (tryBreakStaleLock(fullPath)) {
        removed.push(file);
      }
    }
  } catch {}
  return removed;
}

export {
  acquireLockSync,
  acquireLockAsync,
  cleanStaleLocks,
  MutexTimeoutError,
  // Exposed for testing
  readLockInfo as _readLockInfo,
  isPidAlive as _isPidAlive,
  tryBreakStaleLock as _tryBreakStaleLock,
};
