import { LEVEL_ORDER, type LogLevel } from '@shared/constants';
export { LEVEL_ORDER, type LogLevel };
export declare const C: {
    readonly reset: "\u001B[0m";
    readonly bold: "\u001B[1m";
    readonly dim: "\u001B[2m";
    readonly red: "\u001B[31m";
    readonly green: "\u001B[32m";
    readonly yellow: "\u001B[33m";
    readonly blue: "\u001B[34m";
    readonly magenta: "\u001B[35m";
    readonly cyan: "\u001B[36m";
};
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
/**
 * Returns true if the given level should be logged under the current config.
 */
export declare function shouldLog(level: LogLevel): boolean;
export declare function getCorrelationId(): string;
export declare function setCorrelationId(id: string): void;
export declare function generateCorrelationId(): string;
export declare function setRedactor(fn: RedactFn): void;
export declare function setSseBroadcast(fn: SseBroadcastFn): void;
export declare function log(icon: string, msg: string, level?: LogLevel): void;
/**
 * Render a stage/step header banner to the console and log file.
 * @param num - Step number (displayed left-padded to 3 chars)
 * @param title - Step title (displayed right-padded to 33 chars)
 */
export declare function logStep(num: number | string, title: string): void;
/** Log a success message (green checkmark). */
export declare function logOk(msg: string): void;
/** Log an error message (red cross). */
export declare function logErr(msg: string): void;
/** Log a wait/pending message (yellow hourglass). */
export declare function logWait(msg: string): void;
/** Log an informational message (cyan 'i'). */
export declare function logInfo(msg: string): void;
/** Log a warning message (yellow '!'). */
export declare function logWarn(msg: string): void;
/** Log a debug message (dim 'D'). Only emitted when LOG_LEVEL=debug or lower. */
export declare function logDebug(msg: string): void;
/** Log a trace message (dim 'T'). Only emitted when LOG_LEVEL=trace. */
export declare function logTrace(msg: string): void;
export declare function closeLogStream(timeoutMs?: number): Promise<void>;
/** Synchronous close for use in crash handlers where we cannot await. */
export declare function closeLogStreamSync(): void;
/**
 * Create a structured log entry without emitting to console/file.
 * Useful for building audit trails or custom log destinations.
 */
export declare function createLogEntry(level: LogLevel, msg: string, extra?: Record<string, unknown>): LogEntry;
