"use strict";

// ═══════════════════════════════════════════════════════════════════════
// Pure-JS Fallback Implementations
// ═══════════════════════════════════════════════════════════════════════
//
// These match the API surface of the Rust native addons exactly.
// Used when the Rust addon cannot be loaded (no Rust toolchain,
// wrong platform, missing build, etc.).
//
// All implementations use Node.js built-ins only (crypto, fs, path).
// ═══════════════════════════════════════════════════════════════════════

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ═══════════════════════════════════════════════════════════════════════
// HMAC Functions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute HMAC-SHA256 of data using the given secret.
 *
 * @param {Buffer|string} secret - HMAC key
 * @param {string} data - Data to sign
 * @returns {Buffer} HMAC digest
 */
function computeHmac(secret, data) {
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);
  return crypto.createHmac("sha256", key).update(data).digest();
}

/**
 * Verify HMAC-SHA256 using constant-time comparison.
 *
 * @param {Buffer|string} secret - HMAC key
 * @param {string} data - Original data
 * @param {Buffer|string} expected - Expected HMAC digest to compare against
 * @returns {boolean} Whether the HMAC matches
 */
function verifyHmac(secret, data, expected) {
  const actual = computeHmac(secret, data);
  const expectedBuf = Buffer.isBuffer(expected)
    ? expected
    : Buffer.from(expected, "hex");

  if (actual.length !== expectedBuf.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(actual, expectedBuf);
  } catch {
    // timingSafeEqual throws if lengths differ (shouldn't happen after
    // the check above, but defensive)
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Atomic Write
// ═══════════════════════════════════════════════════════════════════════

/**
 * Atomically write data to a file using tmp + fsync + rename.
 *
 * Writes to a temporary file in the same directory, fsyncs it, then
 * renames it over the target. This ensures the file is never partially
 * written (crash-safe).
 *
 * @param {string} filePath - Target file path
 * @param {string} data - Data to write
 */
function atomicWriteSync(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.tmp`
  );

  let fd = -1;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1; // Mark as closed so the catch block does not double-close

    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up fd if still open
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed or invalid */
      }
    }
    // Clean up tmp file
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* may not exist */
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// File Lock (O_EXCL based)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Acquire an exclusive file lock using O_EXCL (create-if-not-exists).
 *
 * Writes the current PID to the lock file. If the lock file already
 * exists, checks whether the PID inside is still alive (stale lock
 * detection). Retries with backoff until the timeout is reached.
 *
 * @param {string} lockPath - Path to the lock file
 * @param {number} [timeoutMs=30000] - Max time to wait for the lock
 * @returns {{ lockPath: string, release: () => void }} Lock handle
 * @throws {Error} If the lock cannot be acquired within the timeout
 */
function acquireFileLock(lockPath, timeoutMs = 30000) {
  const start = Date.now();
  const pid = String(process.pid);
  const retryIntervalMs = 50;

  while (true) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — fails if file already exists
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, pid);
      fs.closeSync(fd);
      return {
        lockPath,
        release: () => releaseFileLock(lockPath),
      };
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }

      // Lock file exists — check for stale lock
      try {
        const existingPid = fs.readFileSync(lockPath, "utf8").trim();
        if (existingPid && !isProcessAlive(parseInt(existingPid, 10))) {
          // Stale lock — remove it and retry
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* race: another process may have removed it */
          }
          continue;
        }
      } catch {
        // Lock file might have been removed between our check and read
        continue;
      }

      // Check timeout
      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `Failed to acquire lock "${lockPath}" within ${timeoutMs}ms (held by another process)`
        );
      }

      // Busy-wait with small sleep (sync context)
      busySleepMs(retryIntervalMs);
    }
  }
}

/**
 * Release a file lock by removing the lock file.
 *
 * @param {string} lockPath - Path to the lock file
 */
function releaseFileLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already removed — no-op
  }
}

/**
 * Check whether a process with the given PID is still alive.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (!pid || isNaN(pid) || pid <= 0) return false;
  try {
    // Signal 0 does not kill the process, just checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous busy-wait sleep (for lock retry in sync context).
 * @param {number} ms
 */
function busySleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait — this is intentionally blocking.
    // In a sync context (like lock acquisition), we can't use
    // setTimeout/setImmediate.
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Circuit Breaker (JS implementation)
// ═══════════════════════════════════════════════════════════════════════
//
// Matches the Rust CircuitBreaker API exactly:
//   - new CircuitBreaker(failureThreshold, windowMs, openTimeoutMs, halfOpenMax)
//   - allowRequest() -> boolean
//   - recordSuccess()
//   - recordFailure()
//   - getState() -> "closed" | "open" | "half_open"
//   - getMetrics() -> { failureCount, state, timeInStateMs, totalTrips }
//   - reset()
//
// Key design rule: prune failures only on record_failure, NOT on
// recordSuccess in CLOSED state.

const CB_STATE = Object.freeze({
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half_open",
});

class CircuitBreaker {
  /**
   * @param {number} failureThreshold - Failures in window to trip the circuit
   * @param {number} windowMs - Rolling window duration (ms)
   * @param {number} openTimeoutMs - Cooldown before probing (ms)
   * @param {number} halfOpenMax - Successful probes needed to close
   */
  constructor(failureThreshold, windowMs, openTimeoutMs, halfOpenMax) {
    this._failureThreshold = failureThreshold;
    this._windowMs = windowMs;
    this._openTimeoutMs = openTimeoutMs;
    this._halfOpenMax = halfOpenMax;

    // State
    this._state = CB_STATE.CLOSED;
    this._failures = [];         // timestamps of recent failures (CLOSED)
    this._openedAt = 0;          // when circuit was opened (OPEN)
    this._halfOpenSuccesses = 0; // consecutive successes (HALF_OPEN)
    this._halfOpenTestCount = 0; // test requests allowed (HALF_OPEN)
    this._stateEnteredAt = Date.now();
    this._totalTrips = 0;
  }

  /**
   * Check if a request is allowed.
   * @returns {boolean}
   */
  allowRequest() {
    switch (this._state) {
      case CB_STATE.CLOSED:
        return true;

      case CB_STATE.OPEN: {
        const elapsed = Date.now() - this._openedAt;
        if (elapsed >= this._openTimeoutMs) {
          // Transition to HALF_OPEN
          this._state = CB_STATE.HALF_OPEN;
          this._halfOpenSuccesses = 0;
          this._halfOpenTestCount = 1; // This request counts as test #1
          this._stateEnteredAt = Date.now();
          return true;
        }
        return false;
      }

      case CB_STATE.HALF_OPEN: {
        if (this._halfOpenTestCount < this._halfOpenMax) {
          this._halfOpenTestCount++;
          return true;
        }
        return false;
      }

      default:
        return true;
    }
  }

  /**
   * Record a successful request.
   *
   * - CLOSED: no-op (no pruning per design rule).
   * - HALF_OPEN: count success, close when enough.
   */
  recordSuccess() {
    if (this._state === CB_STATE.HALF_OPEN) {
      this._halfOpenSuccesses++;
      if (this._halfOpenSuccesses >= this._halfOpenMax) {
        // Enough probes succeeded -> close
        this._state = CB_STATE.CLOSED;
        this._failures = [];
        this._stateEnteredAt = Date.now();
      }
    }
    // CLOSED: no-op (design rule: don't prune failures on success)
  }

  /**
   * Record a failed request.
   *
   * - CLOSED: track failure, prune old, trip if threshold.
   * - HALF_OPEN: immediately back to OPEN.
   */
  recordFailure() {
    if (this._state === CB_STATE.HALF_OPEN) {
      // Probe failed -> re-open
      this._state = CB_STATE.OPEN;
      this._openedAt = Date.now();
      this._stateEnteredAt = Date.now();
      this._totalTrips++;
      return;
    }

    if (this._state === CB_STATE.CLOSED) {
      const now = Date.now();
      this._failures.push(now);

      // Prune failures outside the rolling window
      const cutoff = now - this._windowMs;
      this._failures = this._failures.filter((t) => t >= cutoff);

      if (this._failures.length >= this._failureThreshold) {
        this._state = CB_STATE.OPEN;
        this._openedAt = now;
        this._stateEnteredAt = now;
        this._totalTrips++;
      }
    }
  }

  /**
   * Get the current state.
   * @returns {"closed"|"open"|"half_open"}
   */
  getState() {
    return this._state;
  }

  /**
   * Get metrics snapshot.
   * @returns {{ failureCount: number, state: string, timeInStateMs: number, totalTrips: number }}
   */
  getMetrics() {
    return {
      failureCount:
        this._state === CB_STATE.CLOSED ? this._failures.length : 0,
      state: this._state,
      timeInStateMs: Date.now() - this._stateEnteredAt,
      totalTrips: this._totalTrips,
    };
  }

  /**
   * Manually reset the circuit to CLOSED.
   */
  reset() {
    this._state = CB_STATE.CLOSED;
    this._failures = [];
    this._openedAt = 0;
    this._halfOpenSuccesses = 0;
    this._halfOpenTestCount = 0;
    this._stateEnteredAt = Date.now();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// String Circular Buffer (JS implementation)
// ═══════════════════════════════════════════════════════════════════════
//
// Matches the Rust StringCircularBuffer API:
//   - new StringCircularBuffer(capacity)
//   - push(item: string)
//   - toArray() -> string[]
//   - len() -> number
//   - clear()
//
// Uses a fixed-size array with head/tail pointers for O(1) push.

class StringCircularBuffer {
  /**
   * @param {number} capacity - Maximum number of items
   */
  constructor(capacity) {
    this._capacity = Math.max(1, capacity);
    this._buf = new Array(this._capacity);
    this._head = 0;
    this._tail = 0;
    this._count = 0;
  }

  /**
   * Push a string into the buffer. Overwrites oldest if full.
   * @param {string} item
   */
  push(item) {
    this._buf[this._tail] = item;
    this._tail = (this._tail + 1) % this._capacity;

    if (this._count < this._capacity) {
      this._count++;
    } else {
      // Full -> oldest overwritten, advance head
      this._head = (this._head + 1) % this._capacity;
    }
  }

  /**
   * Return all items as an array, ordered oldest to newest.
   * @returns {string[]}
   */
  toArray() {
    const result = [];
    for (let i = 0; i < this._count; i++) {
      const idx = (this._head + i) % this._capacity;
      result.push(this._buf[idx]);
    }
    return result;
  }

  /**
   * Number of items currently stored.
   * @returns {number}
   */
  len() {
    return this._count;
  }

  /**
   * Clear all items.
   */
  clear() {
    this._buf = new Array(this._capacity);
    this._head = 0;
    this._tail = 0;
    this._count = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
  computeHmac,
  verifyHmac,
  atomicWriteSync,
  acquireFileLock,
  releaseFileLock,
  CircuitBreaker,
  StringCircularBuffer,
};
