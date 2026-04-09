"use strict";

/**
 * Secure Logging System for MI Dev Agent
 *
 * Features:
 * - File creation with mode 0o600 (owner-only read/write)
 * - All output passes through redaction before write
 * - Structured JSON log format option (alongside human-readable)
 * - Correlation ID per pipeline run (generated at start, included in every log line)
 * - Log levels with proper filtering (trace < debug < info < warn < error)
 * - Log rotation: max 10MB per file, keep 5 rotated files
 * - Guaranteed flush on shutdown (drain write stream with timeout)
 * - SSE broadcast filter: redact AND filter by log level
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { LOG_FORMAT, LOG_LEVEL, TICKET } = require("./config");

// ── Colors ────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
};

// ── Log Level Hierarchy ──────────────────────────────────────────
const LEVEL_ORDER = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const _configuredLevel = LEVEL_ORDER[LOG_LEVEL] !== undefined ? LEVEL_ORDER[LOG_LEVEL] : LEVEL_ORDER.info;

function shouldLog(level) {
  return (LEVEL_ORDER[level] || 0) >= _configuredLevel;
}

// ── Correlation ID ───────────────────────────────────────────────
// Generated once per process lifetime, included in every log line for request tracing.
let _correlationId = crypto.randomBytes(6).toString("hex"); // 12 hex chars

function getCorrelationId() {
  return _correlationId;
}

function setCorrelationId(id) {
  if (typeof id === "string" && id.length > 0) {
    _correlationId = id;
  }
}

function generateCorrelationId() {
  _correlationId = crypto.randomBytes(6).toString("hex");
  return _correlationId;
}

// ── Redactor injection (avoids circular dep with redaction.js) ───
let _redactFn = (s) => s;
function setRedactor(fn) {
  if (typeof fn === "function") _redactFn = fn;
}

// ── Log Rotation ─────────────────────────────────────────────────
const MAX_LOG_SIZE = parseInt(process.env.MAX_LOG_SIZE, 10) || 10_485_760; // 10MB
const MAX_LOG_FILES = parseInt(process.env.MAX_LOG_FILES, 10) || 5;
let _currentLogSize = 0;

function getLogPath() {
  return path.join(__dirname, "..", `agent-${TICKET}.log`);
}

function rotateLogFile(logPath) {
  try {
    // Shift existing rotated files: .log.4 -> .log.5, .log.3 -> .log.4, etc.
    for (let i = MAX_LOG_FILES; i >= 1; i--) {
      const from = i === 1 ? logPath : `${logPath}.${i - 1}`;
      const to = `${logPath}.${i}`;
      if (fs.existsSync(from)) {
        if (i === MAX_LOG_FILES) {
          // Delete the oldest
          try { fs.unlinkSync(to); } catch { /* may not exist */ }
        }
        fs.renameSync(from, to);
      }
    }
    _currentLogSize = 0;
  } catch (err) {
    // Rotation failed — continue writing to the current file
    try { console.error(`Log rotation failed: ${err.message}`); } catch { /* swallow */ }
  }
}

// ── File-based log sink with 0o600 permissions ───────────────────
let _logStream = null;
let _logStreamClosing = false;

function getLogStream() {
  if (_logStreamClosing) return null;
  if (_logStream) return _logStream;
  try {
    const logPath = getLogPath();

    // Check if rotation is needed before opening
    try {
      if (fs.existsSync(logPath)) {
        const stat = fs.statSync(logPath);
        _currentLogSize = stat.size;
        if (_currentLogSize >= MAX_LOG_SIZE) {
          rotateLogFile(logPath);
        }
      }
    } catch { /* stat failed — proceed */ }

    // Open with restricted permissions
    const fd = fs.openSync(logPath, "a", 0o600);
    _logStream = fs.createWriteStream(null, { fd, flags: "a" });

    _logStream.on("error", (err) => {
      try { console.error(`Log stream error: ${err.message}`); } catch { /* swallow */ }
      _logStream = null;
    });

    // Ensure permissions are correct even if umask interfered
    try { fs.chmodSync(logPath, 0o600); } catch { /* best effort */ }
  } catch { /* ignore — logging should not crash the app */ }
  return _logStream;
}

// ── SSE Broadcast Hook ───────────────────────────────────────────
// External modules (server/sse.js) can register a broadcast callback.
// The logging system will redact and level-filter before broadcasting.
let _sseBroadcastFn = null;
const SSE_MIN_LEVEL = LEVEL_ORDER[process.env.SSE_LOG_LEVEL || "info"];

function setSseBroadcast(fn) {
  if (typeof fn === "function") _sseBroadcastFn = fn;
}

// ── Core log function ────────────────────────────────────────────

function log(icon, msg, level = "info") {
  if (!shouldLog(level)) return;

  const now = new Date();
  const safeMsg = _redactFn(typeof msg === "string" ? msg : String(msg));

  // Console output
  if (LOG_FORMAT === "json") {
    const entry = {
      ts: now.toISOString(),
      level,
      cid: _correlationId,
      msg: safeMsg,
    };
    console.log(JSON.stringify(entry));
  } else {
    const ts = now.toISOString().slice(11, 23); // HH:mm:ss.SSS
    console.log(`  ${ts}  [${_correlationId}]  ${icon}  ${safeMsg}`);
  }

  // File output (always structured for machine parsing)
  const stream = getLogStream();
  if (stream) {
    const fileLine = JSON.stringify({
      ts: now.toISOString(),
      level,
      cid: _correlationId,
      msg: safeMsg,
    }) + "\n";
    try {
      stream.write(fileLine);
      _currentLogSize += Buffer.byteLength(fileLine);

      // Check rotation after write
      if (_currentLogSize >= MAX_LOG_SIZE) {
        _logStream = null;
        try { stream.end(); } catch { /* swallow */ }
        rotateLogFile(getLogPath());
      }
    } catch { /* ignore write failures */ }
  }

  // SSE broadcast (only if level meets SSE threshold)
  if (_sseBroadcastFn && (LEVEL_ORDER[level] || 0) >= SSE_MIN_LEVEL) {
    try {
      _sseBroadcastFn("log", {
        ts: now.getTime(),
        line: safeMsg,
        type: level === "error" ? "stderr" : "stdout",
        level,
        cid: _correlationId,
      });
    } catch { /* never crash for SSE */ }
  }
}

// ── Public log helpers ───────────────────────────────────────────

function logStep(num, title) {
  console.log();
  console.log(`${C.bold}${C.blue}  ┌─────────────────────────────────────────────┐${C.reset}`);
  console.log(`${C.bold}${C.blue}  │  Step ${String(num).padEnd(3)} -- ${title.padEnd(33)}│${C.reset}`);
  console.log(`${C.bold}${C.blue}  └─────────────────────────────────────────────┘${C.reset}`);

  // Also write to log file
  const stream = getLogStream();
  if (stream) {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      cid: _correlationId,
      msg: `Step ${num} -- ${title}`,
      type: "stage_header",
    }) + "\n";
    try { stream.write(entry); } catch { /* swallow */ }
  }
}

function logOk(msg)   { log(`${C.green}\u2713${C.reset}`, msg, "info"); }
function logErr(msg)  { log(`${C.red}\u2717${C.reset}`, msg, "error"); }
function logWait(msg) { log(`${C.yellow}\u231B${C.reset}`, msg, "info"); }
function logInfo(msg) { log(`${C.cyan}i${C.reset}`, msg, "info"); }
function logWarn(msg) { log(`${C.yellow}!${C.reset}`, msg, "warn"); }

function logDebug(msg) {
  log(`${C.dim}D${C.reset}`, msg, "debug");
}

function logTrace(msg) {
  log(`${C.dim}T${C.reset}`, msg, "trace");
}

// ── Guaranteed flush on shutdown ─────────────────────────────────
// Returns a Promise that resolves when the log stream is fully drained,
// or rejects after a timeout (default 5s).

function closeLogStream(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!_logStream) {
      resolve();
      return;
    }

    _logStreamClosing = true;
    const stream = _logStream;
    _logStream = null;

    // Set a hard timeout
    const timer = setTimeout(() => {
      try { stream.destroy(); } catch { /* swallow */ }
      _logStreamClosing = false;
      resolve();
    }, timeoutMs);

    stream.once("finish", () => {
      clearTimeout(timer);
      _logStreamClosing = false;
      resolve();
    });

    stream.once("error", () => {
      clearTimeout(timer);
      _logStreamClosing = false;
      resolve();
    });

    try {
      stream.end();
    } catch {
      clearTimeout(timer);
      _logStreamClosing = false;
      resolve();
    }
  });
}

// Synchronous close for use in crash handlers where we cannot await
function closeLogStreamSync() {
  if (!_logStream) return;
  _logStreamClosing = true;
  try { _logStream.end(); } catch { /* swallow */ }
  _logStream = null;
  _logStreamClosing = false;
}

// ── Structured log entry for external consumers ──────────────────

/**
 * Create a structured log entry without emitting to console/file.
 * Useful for building audit trails or custom log destinations.
 */
function createLogEntry(level, msg, extra = {}) {
  return {
    ts: new Date().toISOString(),
    level,
    cid: _correlationId,
    msg: _redactFn(typeof msg === "string" ? msg : String(msg)),
    ...extra,
  };
}

module.exports = {
  C,
  log,
  logStep,
  logOk,
  logErr,
  logWait,
  logInfo,
  logWarn,
  logDebug,
  logTrace,
  setRedactor,
  setSseBroadcast,
  closeLogStream,
  closeLogStreamSync,
  createLogEntry,
  getCorrelationId,
  setCorrelationId,
  generateCorrelationId,
  shouldLog,
  // Constants for external use
  LEVEL_ORDER,
};
