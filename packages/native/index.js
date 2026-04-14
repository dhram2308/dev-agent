"use strict";

// ═══════════════════════════════════════════════════════════════════════
// Native Addon Loader — Rust with JS Fallback
// ═══════════════════════════════════════════════════════════════════════
//
// Attempts to load the Rust native addons (compiled via napi-rs).
// If any fail to load (wrong platform, missing build, etc.), falls
// back to pure-JS implementations that match the same API surface.
//
// This ensures the agent works on any platform without requiring
// a Rust toolchain at runtime.
// ═══════════════════════════════════════════════════════════════════════

const fallback = require("./fallback");

// ── State Engine (HMAC, file lock, atomic write) ────────────────────

let stateEngine;
try {
  stateEngine = require("./state-engine/native");
} catch (e) {
  console.warn("[native] state-engine Rust addon not available, using JS fallback:", e.message);
  stateEngine = null;
}

// ── HTTP Engine (circuit breaker) ───────────────────────────────────

let httpEngine;
try {
  httpEngine = require("./http-engine/native");
} catch (e) {
  console.warn("[native] http-engine Rust addon not available, using JS fallback:", e.message);
  httpEngine = null;
}

// ── SSE Engine (circular buffer) ────────────────────────────────────

let sseEngine;
try {
  sseEngine = require("./sse-engine/native");
} catch (e) {
  console.warn("[native] sse-engine Rust addon not available, using JS fallback:", e.message);
  sseEngine = null;
}

// ── Unified export ──────────────────────────────────────────────────
//
// For each function/class, use the native Rust version if available,
// otherwise use the JS fallback.

module.exports = {
  // State engine
  computeHmac:      stateEngine?.computeHmac      ?? fallback.computeHmac,
  verifyHmac:       stateEngine?.verifyHmac        ?? fallback.verifyHmac,
  atomicWriteSync:  stateEngine?.atomicWriteSync   ?? fallback.atomicWriteSync,
  acquireFileLock:  stateEngine?.acquireFileLock    ?? fallback.acquireFileLock,
  releaseFileLock:  stateEngine?.releaseFileLock    ?? fallback.releaseFileLock,

  // HTTP engine
  CircuitBreaker:   httpEngine?.CircuitBreaker      ?? fallback.CircuitBreaker,

  // SSE engine
  StringCircularBuffer: sseEngine?.StringCircularBuffer ?? fallback.StringCircularBuffer,

  // Metadata
  isNative: {
    stateEngine:  !!stateEngine,
    httpEngine:   !!httpEngine,
    sseEngine:    !!sseEngine,
  },
};
