// ===================================================================
// MI Dev Agent -- Backend Logger (TypeScript port of lib/logging.js)
//
// Zero dependencies. Uses console with ANSI color codes.
// Features:
//   - File logging with 0o600 permissions and log rotation
//   - Correlation ID per pipeline run
//   - Log levels with proper filtering (trace < debug < info < warn < error)
//   - JSON structured format option
//   - SSE broadcast hook
//   - Guaranteed flush on shutdown
//   - Redactor injection (avoids circular deps)
// ===================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LEVEL_ORDER, type LogLevel } from '@shared/constants';

// Re-export for consumers
export { LEVEL_ORDER, type LogLevel };

// -- ANSI Color codes ---------------------------------------------

export const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
} as const;

// -- Types --------------------------------------------------------

export interface LogEntry {
  ts: string;
  level: LogLevel;
  cid: string;
  msg: string;
  type?: string;
  [key: string]: unknown;
}

export interface SseBroadcastPayload {
  ts: number;
  line: string;
  type: 'stdout' | 'stderr';
  level: LogLevel;
  cid: string;
}

export type SseBroadcastFn = (event: string, payload: SseBroadcastPayload) => void;
export type RedactFn = (text: string) => string;

// -- Configuration ------------------------------------------------

/** Log level from environment. Defaults to 'info'. */
const _configuredLevelName: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) in LEVEL_ORDER
    ? (process.env.LOG_LEVEL as LogLevel)
    : 'info';

const _configuredLevel: number = LEVEL_ORDER[_configuredLevelName];

/** Log format from environment. 'json' for structured output, anything else for human-readable. */
const LOG_FORMAT: string = process.env.LOG_FORMAT || 'text';

/** Ticket ID from environment, used for log file naming. */
const TICKET: string = (process.env.TICKET || '').trim().toUpperCase();

/**
 * Returns true if the given level should be logged under the current config.
 */
export function shouldLog(level: LogLevel): boolean {
  return (LEVEL_ORDER[level] ?? 0) >= _configuredLevel;
}

// -- Correlation ID -----------------------------------------------
// Generated once per process lifetime, included in every log line.

let _correlationId: string = crypto.randomBytes(6).toString('hex');

export function getCorrelationId(): string {
  return _correlationId;
}

export function setCorrelationId(id: string): void {
  if (typeof id === 'string' && id.length > 0) {
    _correlationId = id;
  }
}

export function generateCorrelationId(): string {
  _correlationId = crypto.randomBytes(6).toString('hex');
  return _correlationId;
}

// -- Redactor injection -------------------------------------------
// Avoids circular dependency with redaction module.

let _redactFn: RedactFn = (s: string) => s;

export function setRedactor(fn: RedactFn): void {
  if (typeof fn === 'function') _redactFn = fn;
}

// -- Log Rotation -------------------------------------------------

const MAX_LOG_SIZE: number = parseInt(process.env.MAX_LOG_SIZE || '', 10) || 10_485_760; // 10MB
const MAX_LOG_FILES: number = parseInt(process.env.MAX_LOG_FILES || '', 10) || 5;
let _currentLogSize = 0;

function getLogPath(): string {
  return path.join(__dirname, '..', '..', '..', '..', `agent-${TICKET}.log`);
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    try { console.error(`Log rotation failed: ${message}`); } catch { /* swallow */ }
  }
}

// -- File-based log sink with 0o600 permissions -------------------

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
    const fd = fs.openSync(logPath, 'a', 0o600);
    _logStream = fs.createWriteStream(null as unknown as string, { fd, flags: 'a' });

    _logStream.on('error', (err: Error) => {
      try { console.error(`Log stream error: ${err.message}`); } catch { /* swallow */ }
      _logStream = null;
    });

    // Ensure permissions are correct even if umask interfered
    try { fs.chmodSync(logPath, 0o600); } catch { /* best effort */ }
  } catch { /* ignore -- logging should not crash the app */ }
  return _logStream;
}

// -- SSE Broadcast Hook -------------------------------------------
// External modules (server/sse.ts) can register a broadcast callback.
// The logging system will redact and level-filter before broadcasting.

let _sseBroadcastFn: SseBroadcastFn | null = null;
const SSE_MIN_LEVEL: number = LEVEL_ORDER[(process.env.SSE_LOG_LEVEL || 'info') as LogLevel] ?? LEVEL_ORDER.info;

export function setSseBroadcast(fn: SseBroadcastFn): void {
  if (typeof fn === 'function') _sseBroadcastFn = fn;
}

// -- Core log function --------------------------------------------

export function log(icon: string, msg: string, level: LogLevel = 'info'): void {
  if (!shouldLog(level)) return;

  const now = new Date();
  const safeMsg = _redactFn(typeof msg === 'string' ? msg : String(msg));

  // Console output
  if (LOG_FORMAT === 'json') {
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
    } satisfies LogEntry) + '\n';
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
  if (_sseBroadcastFn && (LEVEL_ORDER[level] ?? 0) >= SSE_MIN_LEVEL) {
    try {
      _sseBroadcastFn('log', {
        ts: now.getTime(),
        line: safeMsg,
        type: level === 'error' ? 'stderr' : 'stdout',
        level,
        cid: _correlationId,
      });
    } catch { /* never crash for SSE */ }
  }
}

// -- Public log helpers -------------------------------------------

/**
 * Render a stage/step header banner to the console and log file.
 * @param num - Step number (displayed left-padded to 3 chars)
 * @param title - Step title (displayed right-padded to 33 chars)
 */
export function logStep(num: number | string, title: string): void {
  console.log();
  console.log(`${C.bold}${C.blue}  \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${C.reset}`);
  console.log(`${C.bold}${C.blue}  \u2502  Step ${String(num).padEnd(3)} -- ${title.padEnd(33)}\u2502${C.reset}`);
  console.log(`${C.bold}${C.blue}  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${C.reset}`);

  // Also write to log file
  const stream = getLogStream();
  if (stream) {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info' as const,
      cid: _correlationId,
      msg: `Step ${num} -- ${title}`,
      type: 'stage_header',
    } satisfies LogEntry) + '\n';
    try { stream.write(entry); } catch { /* swallow */ }
  }
}

/** Log a success message (green checkmark). */
export function logOk(msg: string): void {
  log(`${C.green}\u2713${C.reset}`, msg, 'info');
}

/** Log an error message (red cross). */
export function logErr(msg: string): void {
  log(`${C.red}\u2717${C.reset}`, msg, 'error');
}

/** Log a wait/pending message (yellow hourglass). */
export function logWait(msg: string): void {
  log(`${C.yellow}\u231B${C.reset}`, msg, 'info');
}

/** Log an informational message (cyan 'i'). */
export function logInfo(msg: string): void {
  log(`${C.cyan}i${C.reset}`, msg, 'info');
}

/** Log a warning message (yellow '!'). */
export function logWarn(msg: string): void {
  log(`${C.yellow}!${C.reset}`, msg, 'warn');
}

/** Log a debug message (dim 'D'). Only emitted when LOG_LEVEL=debug or lower. */
export function logDebug(msg: string): void {
  log(`${C.dim}D${C.reset}`, msg, 'debug');
}

/** Log a trace message (dim 'T'). Only emitted when LOG_LEVEL=trace. */
export function logTrace(msg: string): void {
  log(`${C.dim}T${C.reset}`, msg, 'trace');
}

// -- Guaranteed flush on shutdown ---------------------------------
// Returns a Promise that resolves when the log stream is fully drained,
// or resolves after a timeout (default 5s).

export function closeLogStream(timeoutMs = 5000): Promise<void> {
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

    stream.once('finish', () => {
      clearTimeout(timer);
      _logStreamClosing = false;
      resolve();
    });

    stream.once('error', () => {
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

/** Synchronous close for use in crash handlers where we cannot await. */
export function closeLogStreamSync(): void {
  if (!_logStream) return;
  _logStreamClosing = true;
  try { _logStream.end(); } catch { /* swallow */ }
  _logStream = null;
  _logStreamClosing = false;
}

// -- Structured log entry for external consumers ------------------

/**
 * Create a structured log entry without emitting to console/file.
 * Useful for building audit trails or custom log destinations.
 */
export function createLogEntry(level: LogLevel, msg: string, extra: Record<string, unknown> = {}): LogEntry {
  return {
    ts: new Date().toISOString(),
    level,
    cid: _correlationId,
    msg: _redactFn(typeof msg === 'string' ? msg : String(msg)),
    ...extra,
  };
}
