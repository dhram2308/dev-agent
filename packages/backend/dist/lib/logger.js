"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.C = exports.LEVEL_ORDER = void 0;
exports.shouldLog = shouldLog;
exports.getCorrelationId = getCorrelationId;
exports.setCorrelationId = setCorrelationId;
exports.generateCorrelationId = generateCorrelationId;
exports.setRedactor = setRedactor;
exports.setSseBroadcast = setSseBroadcast;
exports.log = log;
exports.logStep = logStep;
exports.logOk = logOk;
exports.logErr = logErr;
exports.logWait = logWait;
exports.logInfo = logInfo;
exports.logWarn = logWarn;
exports.logDebug = logDebug;
exports.logTrace = logTrace;
exports.closeLogStream = closeLogStream;
exports.closeLogStreamSync = closeLogStreamSync;
exports.createLogEntry = createLogEntry;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const constants_1 = require("@shared/constants");
Object.defineProperty(exports, "LEVEL_ORDER", { enumerable: true, get: function () { return constants_1.LEVEL_ORDER; } });
// -- ANSI Color codes ---------------------------------------------
exports.C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
};
// -- Configuration ------------------------------------------------
/** Log level from environment. Defaults to 'info'. */
const _configuredLevelName = process.env.LOG_LEVEL in constants_1.LEVEL_ORDER
    ? process.env.LOG_LEVEL
    : 'info';
const _configuredLevel = constants_1.LEVEL_ORDER[_configuredLevelName];
/** Log format from environment. 'json' for structured output, anything else for human-readable. */
const LOG_FORMAT = process.env.LOG_FORMAT || 'text';
/** Ticket ID from environment, used for log file naming. */
const TICKET = (process.env.TICKET || '').trim().toUpperCase();
/**
 * Returns true if the given level should be logged under the current config.
 */
function shouldLog(level) {
    return (constants_1.LEVEL_ORDER[level] ?? 0) >= _configuredLevel;
}
// -- Correlation ID -----------------------------------------------
// Generated once per process lifetime, included in every log line.
let _correlationId = crypto.randomBytes(6).toString('hex');
function getCorrelationId() {
    return _correlationId;
}
function setCorrelationId(id) {
    if (typeof id === 'string' && id.length > 0) {
        _correlationId = id;
    }
}
function generateCorrelationId() {
    _correlationId = crypto.randomBytes(6).toString('hex');
    return _correlationId;
}
// -- Redactor injection -------------------------------------------
// Avoids circular dependency with redaction module.
let _redactFn = (s) => s;
function setRedactor(fn) {
    if (typeof fn === 'function')
        _redactFn = fn;
}
// -- Log Rotation -------------------------------------------------
const MAX_LOG_SIZE = parseInt(process.env.MAX_LOG_SIZE || '', 10) || 10_485_760; // 10MB
const MAX_LOG_FILES = parseInt(process.env.MAX_LOG_FILES || '', 10) || 5;
let _currentLogSize = 0;
function getLogPath() {
    return path.join(__dirname, '..', '..', '..', '..', `agent-${TICKET}.log`);
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
                    try {
                        fs.unlinkSync(to);
                    }
                    catch { /* may not exist */ }
                }
                fs.renameSync(from, to);
            }
        }
        _currentLogSize = 0;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
            console.error(`Log rotation failed: ${message}`);
        }
        catch { /* swallow */ }
    }
}
// -- File-based log sink with 0o600 permissions -------------------
let _logStream = null;
let _logStreamClosing = false;
function getLogStream() {
    if (_logStreamClosing)
        return null;
    if (_logStream)
        return _logStream;
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
        }
        catch { /* stat failed -- proceed */ }
        // Open with restricted permissions
        const fd = fs.openSync(logPath, 'a', 0o600);
        _logStream = fs.createWriteStream(null, { fd, flags: 'a' });
        _logStream.on('error', (err) => {
            try {
                console.error(`Log stream error: ${err.message}`);
            }
            catch { /* swallow */ }
            _logStream = null;
        });
        // Ensure permissions are correct even if umask interfered
        try {
            fs.chmodSync(logPath, 0o600);
        }
        catch { /* best effort */ }
    }
    catch { /* ignore -- logging should not crash the app */ }
    return _logStream;
}
// -- SSE Broadcast Hook -------------------------------------------
// External modules (server/sse.ts) can register a broadcast callback.
// The logging system will redact and level-filter before broadcasting.
let _sseBroadcastFn = null;
const SSE_MIN_LEVEL = constants_1.LEVEL_ORDER[(process.env.SSE_LOG_LEVEL || 'info')] ?? constants_1.LEVEL_ORDER.info;
function setSseBroadcast(fn) {
    if (typeof fn === 'function')
        _sseBroadcastFn = fn;
}
// -- Core log function --------------------------------------------
function log(icon, msg, level = 'info') {
    if (!shouldLog(level))
        return;
    const now = new Date();
    const safeMsg = _redactFn(typeof msg === 'string' ? msg : String(msg));
    // Console output
    if (LOG_FORMAT === 'json') {
        const entry = {
            ts: now.toISOString(),
            level,
            cid: _correlationId,
            msg: safeMsg,
        };
        console.log(JSON.stringify(entry));
    }
    else {
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
        }) + '\n';
        try {
            stream.write(fileLine);
            _currentLogSize += Buffer.byteLength(fileLine);
            // Check rotation after write
            if (_currentLogSize >= MAX_LOG_SIZE) {
                _logStream = null;
                try {
                    stream.end();
                }
                catch { /* swallow */ }
                rotateLogFile(getLogPath());
            }
        }
        catch { /* ignore write failures */ }
    }
    // SSE broadcast (only if level meets SSE threshold)
    if (_sseBroadcastFn && (constants_1.LEVEL_ORDER[level] ?? 0) >= SSE_MIN_LEVEL) {
        try {
            _sseBroadcastFn('log', {
                ts: now.getTime(),
                line: safeMsg,
                type: level === 'error' ? 'stderr' : 'stdout',
                level,
                cid: _correlationId,
            });
        }
        catch { /* never crash for SSE */ }
    }
}
// -- Public log helpers -------------------------------------------
/**
 * Render a stage/step header banner to the console and log file.
 * @param num - Step number (displayed left-padded to 3 chars)
 * @param title - Step title (displayed right-padded to 33 chars)
 */
function logStep(num, title) {
    console.log();
    console.log(`${exports.C.bold}${exports.C.blue}  \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${exports.C.reset}`);
    console.log(`${exports.C.bold}${exports.C.blue}  \u2502  Step ${String(num).padEnd(3)} -- ${title.padEnd(33)}\u2502${exports.C.reset}`);
    console.log(`${exports.C.bold}${exports.C.blue}  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${exports.C.reset}`);
    // Also write to log file
    const stream = getLogStream();
    if (stream) {
        const entry = JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            cid: _correlationId,
            msg: `Step ${num} -- ${title}`,
            type: 'stage_header',
        }) + '\n';
        try {
            stream.write(entry);
        }
        catch { /* swallow */ }
    }
}
/** Log a success message (green checkmark). */
function logOk(msg) {
    log(`${exports.C.green}\u2713${exports.C.reset}`, msg, 'info');
}
/** Log an error message (red cross). */
function logErr(msg) {
    log(`${exports.C.red}\u2717${exports.C.reset}`, msg, 'error');
}
/** Log a wait/pending message (yellow hourglass). */
function logWait(msg) {
    log(`${exports.C.yellow}\u231B${exports.C.reset}`, msg, 'info');
}
/** Log an informational message (cyan 'i'). */
function logInfo(msg) {
    log(`${exports.C.cyan}i${exports.C.reset}`, msg, 'info');
}
/** Log a warning message (yellow '!'). */
function logWarn(msg) {
    log(`${exports.C.yellow}!${exports.C.reset}`, msg, 'warn');
}
/** Log a debug message (dim 'D'). Only emitted when LOG_LEVEL=debug or lower. */
function logDebug(msg) {
    log(`${exports.C.dim}D${exports.C.reset}`, msg, 'debug');
}
/** Log a trace message (dim 'T'). Only emitted when LOG_LEVEL=trace. */
function logTrace(msg) {
    log(`${exports.C.dim}T${exports.C.reset}`, msg, 'trace');
}
// -- Guaranteed flush on shutdown ---------------------------------
// Returns a Promise that resolves when the log stream is fully drained,
// or resolves after a timeout (default 5s).
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
            try {
                stream.destroy();
            }
            catch { /* swallow */ }
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
        }
        catch {
            clearTimeout(timer);
            _logStreamClosing = false;
            resolve();
        }
    });
}
/** Synchronous close for use in crash handlers where we cannot await. */
function closeLogStreamSync() {
    if (!_logStream)
        return;
    _logStreamClosing = true;
    try {
        _logStream.end();
    }
    catch { /* swallow */ }
    _logStream = null;
    _logStreamClosing = false;
}
// -- Structured log entry for external consumers ------------------
/**
 * Create a structured log entry without emitting to console/file.
 * Useful for building audit trails or custom log destinations.
 */
function createLogEntry(level, msg, extra = {}) {
    return {
        ts: new Date().toISOString(),
        level,
        cid: _correlationId,
        msg: _redactFn(typeof msg === 'string' ? msg : String(msg)),
        ...extra,
    };
}
//# sourceMappingURL=logger.js.map