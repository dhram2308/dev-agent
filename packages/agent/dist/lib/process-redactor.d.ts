/**
 * process-redactor.ts — Child Process Output Redaction for MI Dev Agent
 *
 * Converted from lib/process-redactor.js (zero functional changes).
 *
 * Intercepts stdout/stderr from spawned child processes and applies
 * redaction before forwarding to SSE broadcast or log storage.
 *
 * Features:
 * - Buffers partial lines (prevents redaction of tokens split across chunks)
 * - Detects binary output and skips redaction for non-text data
 * - Applies the full redaction engine to each complete line
 * - Handles backpressure gracefully
 * - Provides a Transform stream wrapper for easy integration
 */
import { Transform } from "stream";
import type { ChildProcess } from "child_process";
import type { ProcessRedactorHandle } from "@mi/shared";
declare function setProcessRedactor(fn: (s: string) => string): void;
/**
 * Check if a Buffer chunk contains binary (non-text) data.
 */
declare function isBinaryChunk(chunk: Buffer): boolean;
interface LineBuffer {
    push: (chunk: string) => void;
    flush: () => void;
}
/**
 * Creates a line buffering context for a stream.
 */
declare function createLineBuffer(onLine: (line: string) => void): LineBuffer;
interface RedactingTransformOptions {
    streamName?: string;
}
/**
 * Creates a Transform stream that buffers lines, applies redaction,
 * and outputs redacted text.
 */
declare function createRedactingTransform(options?: RedactingTransformOptions): Transform;
interface WrapProcessOptions {
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
    onBinaryDetected?: (stream: string) => void;
}
/**
 * Wrap a child process's stdout and stderr with redaction.
 */
declare function wrapProcessOutput(proc: ChildProcess, options?: WrapProcessOptions): ProcessRedactorHandle;
/**
 * Redact a single string as if it were process output.
 */
declare function redactOutput(text: any): any;
export { setProcessRedactor, isBinaryChunk, createLineBuffer, createRedactingTransform, wrapProcessOutput, redactOutput, };
//# sourceMappingURL=process-redactor.d.ts.map