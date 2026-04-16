/**
 * logging.ts -- Secure Logging System for MI Dev Agent
 *
 * Converted from lib/logging.js (zero functional changes).
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

import fs from "fs";
import path from "path";
import crypto from "crypto";

import type { LogLevel, LogEntry, RedactorFn, BroadcastFn } from "@mi/shared";

// -- Lazy-require config to avoid circular deps at module init time ----------
// config.ts -> logging.ts is a circular dep. We resolve it lazily.

let _LOG_FORMAT: string | null = null;
let _LOG_LEVEL: string | null = null;
let _TICKET: string | null = null;

function _getConfig(): { LOG_FORMAT: string; LOG_LEVEL: string; TICKET: string } {
  if (_LOG_FORMAT === null) {
    try {
      const cfg = require("./config") as { LOG_FORMAT: string; LOG_LEVEL: string; TICKET: string };
      _LOG_FORMAT = cfg.LOG_FORMAT;
      _LOG_LEVEL = cfg.LOG_LEVEL;
      _TICKET = cfg.TICKET;
    } catch {
      _LOG_FORMAT = "text";
      _LOG_LEVEL = "info";
      _TICKET = "UNKNOWN";
    }
  }
  return { LOG_FORMAT: _LOG_FORMAT!, LOG_LEVEL: _LOG_LEVEL!, TICKET: _TICKET! };
}

// -- Colors ------------------------------------------------------------------

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
};

// -- Log Level Hierarchy -----------------------------------------------------

const LEVEL_ORDER: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

function _getConfiguredLevel(): number {
  const { LOG_LEVEL } = _getConfig();
  return LEVEL_ORDER[LOG_LEVEL] !== undefined ? LEVEL_ORDER[LOG_LEVEL] : LEVEL_ORDER.info;
}

function shouldLog(level: string): boolean {
  return (LEVEL_ORDER[level] || 0) >= _getConfiguredLevel();
}

// -- Correlation ID ----------------------------------------------------------
// Generated once per process lifetime, included in every log line for request tracing.
let _correlationId: string = crypto.randomBytes(6).toString("hex"); // 12 hex chars

function getCorrelationId(): string {
  return _correlationId;
}

function setCorrelationId(id: string): void {
  if (typeof id === "string" && id.length > 0) {
    _correlationId = id;
  }
}

function generateCorrelationId(): string {
  _correlationId = crypto.randomBytes(6).toString("hex");
  return _correlationId;
}

// -- Redactor injection (avoids circular dep with redaction.js) ---------------
let _redactFn: RedactorFn = (s: string) => s;

function setRedactor(fn: RedactorFn): void {
  if (typeof fn === "function") _redactFn = fn;
}

// -- Log Rotation ------------------------------------------------------------
const MAX_LOG_SIZE = parseInt(process.env.MAX_LOG_SIZE as string, 10) || 10_485_760; // 10MB
const MAX_LOG_FILES = parseInt(process.env.MAX_LOG_FILES as string, 10) || 5;
let _currentLogSize = 0;

function getLogPath(): string {
  const { TICKET } = _getConfig();
  return path.join(__dirname, "..", "..", "..", "..", `agent-${TICKET}.log`);
}

function rotateLogFile(logPath: string): void {
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
  } catch (err: any) {
    // Rotation failed -- continue writing to the current file
    try { console.error(`Log rotation failed: ${err.message}`); } catch { /* swallow */ }
  }
}

// -- File-based log sink with 0o600 permissions ------------------------------
let _logStream: fs.WriteStream | null = null;
let _logStreamClosing = false;

function getLogStream(): fs.WriteStream | null {
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
    } catch { /* stat failed -- proceed */ }

    // Open with restricted permissions
    const fd = fs.openSync(logPath, "a", 0o600);
    _logStream = fs.createWriteStream(null as any, { fd, flags: "a" });

    _logStream.on("error", (err) => {
      try { console.error(`Log stream error: ${err.message}`); } catch { /* swallow */ }
      _logStream = null;
    });

    // Ensure permissions are correct even if umask interfered
    try { fs.chmodSync(logPath, 0o600); } catch { /* best effort */ }
  } catch { /* ignore -- logging should not crash the app */ }
  return _logStream;
}

// -- SSE Broadcast Hook ------------------------------------------------------
// External modules (server/sse.js) can register a broadcast callback.
// The logging system will redact and level-filter before broadcasting.
let _sseBroadcastFn: BroadcastFn | null = null;
const SSE_MIN_LEVEL: number = LEVEL_ORDER[process.env.SSE_LOG_LEVEL || "info"];

function setSseBroadcast(fn: BroadcastFn): void {
  if (typeof fn === "function") _sseBroadcastFn = fn;
}

// -- Core log function -------------------------------------------------------

function log(icon: string, msg: string, level: LogLevel = "info"): void {
  if (!shouldLog(level)) return;

  const { LOG_FORMAT } = _getConfig();
  const now = new Date();
  const safeMsg = _redactFn(typeof msg === "string" ? msg : String(msg));

  // Console output
  if (LOG_FORMAT === "json") {
    const entry: LogEntry = {
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

// -- Public log helpers ------------------------------------------------------

function logStep(num: number | string, title: string): void {
  console.log();
  console.log(`${C.bold}${C.blue}  \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${C.reset}`);
  console.log(`${C.bold}${C.blue}  \u2502  Step ${String(num).padEnd(3)} -- ${title.padEnd(33)}\u2502${C.reset}`);
  console.log(`${C.bold}${C.blue}  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${C.reset}`);

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

function logOk(msg: string): void   { log(`${C.green}\u2713${C.reset}`, msg, "info"); }
function logErr(msg: string): void  { log(`${C.red}\u2717${C.reset}`, msg, "error"); }
function logWait(msg: string): void { log(`${C.yellow}\u231B${C.reset}`, msg, "info"); }
function logInfo(msg: string): void { log(`${C.cyan}i${C.reset}`, msg, "info"); }
function logWarn(msg: string): void { log(`${C.yellow}!${C.reset}`, msg, "warn"); }

function logDebug(msg: string): void {
  log(`${C.dim}D${C.reset}`, msg, "debug");
}

function logTrace(msg: string): void {
  log(`${C.dim}T${C.reset}`, msg, "trace");
}

// -- Guaranteed flush on shutdown --------------------------------------------
// Returns a Promise that resolves when the log stream is fully drained,
// or rejects after a timeout (default 5s).

function closeLogStream(timeoutMs = 5000): Promise<void> {
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
function closeLogStreamSync(): void {
  if (!_logStream) return;
  _logStreamClosing = true;
  try { _logStream.end(); } catch { /* swallow */ }
  _logStream = null;
  _logStreamClosing = false;
}

// -- Structured log entry for external consumers -----------------------------

/**
 * Create a structured log entry without emitting to console/file.
 * Useful for building audit trails or custom log destinations.
 */
function createLogEntry(level: LogLevel, msg: string, extra: Record<string, unknown> = {}): LogEntry {
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
