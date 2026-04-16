import type { LogLevel } from '../constants';
/**
 * Numeric ordering of log levels for filtering comparisons.
 */
export type LogLevelOrder = Record<LogLevel, number>;
/**
 * A structured log entry (JSON format written to log files).
 */
export interface LogEntry {
    /** ISO 8601 timestamp */
    ts: string;
    /** Log level */
    level: LogLevel;
    /** Correlation ID for request tracing */
    cid: string;
    /** Log message (already redacted) */
    msg: string;
    /** Entry type for special entries (e.g. "stage_header") */
    type?: string;
    /** Additional metadata fields */
    [key: string]: unknown;
}
/**
 * Configuration for the logging system.
 */
export interface LogConfig {
    /** Log format: "json" for structured, "text" for human-readable */
    format: 'json' | 'text';
    /** Minimum log level to emit */
    level: LogLevel;
    /** Maximum log file size before rotation (bytes) */
    maxLogSize: number;
    /** Number of rotated log files to keep */
    maxLogFiles: number;
    /** Minimum SSE broadcast level */
    sseBroadcastLevel: LogLevel;
}
/**
 * Redactor function signature — transforms a string by removing/masking secrets.
 */
export type RedactorFn = (input: string) => string;
/**
 * SSE broadcast function signature — sends a log event to all connected clients.
 */
export type BroadcastFn = (event: string, data: unknown) => void;
//# sourceMappingURL=logging.d.ts.map