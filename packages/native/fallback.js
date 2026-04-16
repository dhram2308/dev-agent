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
// SseEvent (JS implementation)
// ═══════════════════════════════════════════════════════════════════════
//
// Matches the Rust SseEvent napi(object) struct:
//   { id: u32, eventType: string, data: string, timestamp: f64 }
//
// In JS this is a simple class that mirrors the Rust struct fields.
// The napi(object) attribute exports Rust structs as plain JS objects,
// so this class provides the same shape with a convenient constructor.

class SseEvent {
  /**
   * @param {number} id - Monotonic event ID
   * @param {string} eventType - SSE event type (e.g., "log", "status")
   * @param {string} data - JSON-serialized event data
   * @param {number} timestamp - Timestamp in ms since epoch (Date.now())
   */
  constructor(id, eventType, data, timestamp) {
    this.id = id;
    this.eventType = eventType;
    this.data = data;
    this.timestamp = timestamp;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Typed Circular Buffer (JS implementation)
// ═══════════════════════════════════════════════════════════════════════
//
// Matches the Rust TypedCircularBuffer API:
//   - new TypedCircularBuffer(capacity)
//   - push(event: SseEvent)
//   - replay(sinceId: number) -> SseEvent[]
//   - toArray() -> SseEvent[]
//   - len() -> number
//   - clear()
//
// Stores SseEvent objects in a fixed-size ring buffer with head/tail
// pointers for O(1) push. Supports replay-from-ID for SSE reconnection.

class TypedCircularBuffer {
  /**
   * @param {number} capacity - Maximum number of events
   */
  constructor(capacity) {
    this._capacity = Math.max(1, capacity);
    this._buf = new Array(this._capacity);
    this._head = 0;
    this._tail = 0;
    this._count = 0;
  }

  /**
   * Push an SseEvent into the buffer. Overwrites oldest if full. O(1).
   * @param {{ id: number, eventType: string, data: string, timestamp: number }} event
   */
  push(event) {
    this._buf[this._tail] = event;
    this._tail = (this._tail + 1) % this._capacity;

    if (this._count < this._capacity) {
      this._count++;
    } else {
      // Full -> oldest overwritten, advance head
      this._head = (this._head + 1) % this._capacity;
    }
  }

  /**
   * Replay all events with ID strictly greater than sinceId.
   * Returns events in chronological order (oldest to newest).
   *
   * @param {number} sinceId - Replay events after this ID
   * @returns {Array<{ id: number, eventType: string, data: string, timestamp: number }>}
   */
  replay(sinceId) {
    const result = [];
    for (let i = 0; i < this._count; i++) {
      const idx = (this._head + i) % this._capacity;
      const event = this._buf[idx];
      if (event && event.id > sinceId) {
        result.push(event);
      }
    }
    return result;
  }

  /**
   * Return all events as an array, ordered oldest to newest.
   * @returns {Array<{ id: number, eventType: string, data: string, timestamp: number }>}
   */
  toArray() {
    const result = [];
    for (let i = 0; i < this._count; i++) {
      const idx = (this._head + i) % this._capacity;
      if (this._buf[idx]) {
        result.push(this._buf[idx]);
      }
    }
    return result;
  }

  /**
   * Number of events currently stored.
   * @returns {number}
   */
  len() {
    return this._count;
  }

  /**
   * Clear all events.
   */
  clear() {
    this._buf = new Array(this._capacity);
    this._head = 0;
    this._tail = 0;
    this._count = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Client Registry (JS implementation)
// ═══════════════════════════════════════════════════════════════════════
//
// Matches the Rust ClientRegistry API:
//   - new ClientRegistry()
//   - addClient(id, connectedAt, lastEventId)
//   - removeClient(id) -> boolean
//   - getClientCount() -> number
//   - getClients() -> ClientInfo[]
//   - hasClient(id) -> boolean
//   - updateLastEventId(id, lastEventId)
//   - clear()
//
// Uses a Map for O(1) add/remove/lookup by client ID.

class ClientRegistry {
  constructor() {
    /** @type {Map<string, { id: string, connectedAt: number, lastEventId: number }>} */
    this._clients = new Map();
  }

  /**
   * Register a new client. Replaces existing client with same ID.
   *
   * @param {string} id - Unique client identifier
   * @param {number} connectedAt - Connection timestamp (Date.now())
   * @param {number} lastEventId - Last event ID sent to this client
   */
  addClient(id, connectedAt, lastEventId) {
    this._clients.set(id, { id, connectedAt, lastEventId });
  }

  /**
   * Remove a client by ID.
   * @param {string} id
   * @returns {boolean} true if found and removed
   */
  removeClient(id) {
    return this._clients.delete(id);
  }

  /**
   * Get the number of connected clients.
   * @returns {number}
   */
  getClientCount() {
    return this._clients.size;
  }

  /**
   * Get all connected clients as an array.
   * @returns {Array<{ id: string, connectedAt: number, lastEventId: number }>}
   */
  getClients() {
    return Array.from(this._clients.values());
  }

  /**
   * Check if a client with the given ID is registered.
   * @param {string} id
   * @returns {boolean}
   */
  hasClient(id) {
    return this._clients.has(id);
  }

  /**
   * Update the last event ID for a client.
   * @param {string} id
   * @param {number} lastEventId
   * @returns {boolean} true if found and updated
   */
  updateLastEventId(id, lastEventId) {
    const client = this._clients.get(id);
    if (client) {
      client.lastEventId = lastEventId;
      return true;
    }
    return false;
  }

  /**
   * Clear all clients from the registry.
   */
  clear() {
    this._clients.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Atomic ID Counter (JS implementation)
// ═══════════════════════════════════════════════════════════════════════
//
// Matches the Rust next_id() / reset_id_counter() API.
// Uses a module-scoped counter. Not truly atomic (single-threaded JS),
// but matches the Rust behavior for the Node.js main thread.

let _nextIdCounter = 1;

/**
 * Get the next monotonic message ID.
 * Thread-safe in Rust (AtomicU64); single-threaded safe in JS.
 *
 * @returns {number} The next ID (wraps at 2^32 for u32 compat)
 */
function nextId() {
  const id = _nextIdCounter;
  _nextIdCounter = (_nextIdCounter + 1) >>> 0; // unsigned 32-bit wrap
  if (_nextIdCounter === 0) _nextIdCounter = 1; // skip 0 after wrap
  return id;
}

/**
 * Reset the ID counter to 1. For testing only.
 */
function resetIdCounter() {
  _nextIdCounter = 1;
}

// ═══════════════════════════════════════════════════════════════════════
// SSE Frame Formatter (JS implementation)
// ═══════════════════════════════════════════════════════════════════════
//
// Matches the Rust format_sse_frame() API.
// Returns a Buffer (like Rust returns Vec<u8> / napi Buffer).

/**
 * Format an SSE wire-protocol frame as a Buffer.
 *
 * Produces: "id: {id}\nevent: {event}\ndata: {data}\n\n"
 *
 * @param {number} id - Message ID
 * @param {string} event - SSE event name
 * @param {string} data - JSON-serialized data
 * @returns {Buffer} Formatted SSE frame as bytes
 */
function formatSseFrame(id, event, data) {
  return Buffer.from(`id: ${id}\nevent: ${event}\ndata: ${data}\n\n`);
}

// ═══════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
  // State engine
  computeHmac,
  verifyHmac,
  atomicWriteSync,
  acquireFileLock,
  releaseFileLock,

  // HTTP engine
  CircuitBreaker,

  // SSE engine — legacy
  StringCircularBuffer,

  // SSE engine — new typed exports
  SseEvent,
  TypedCircularBuffer,
  ClientRegistry,
  nextId,
  resetIdCounter,
  formatSseFrame,
};
