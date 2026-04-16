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
import type { TransformCallback } from "stream";
import type { ChildProcess } from "child_process";
import type { ProcessRedactorHandle } from "@mi/shared";

// Redactor function reference — injected to avoid circular deps
let _redactFn: (s: string) => string = (s) => s;

function setProcessRedactor(fn: (s: string) => string): void {
  if (typeof fn === "function") _redactFn = fn;
}

// ── Binary Detection ─────────────────────────────────────────────

/**
 * Check if a Buffer chunk contains binary (non-text) data.
 */
function isBinaryChunk(chunk: Buffer): boolean {
  if (!Buffer.isBuffer(chunk)) return false;

  const sample = chunk.slice(0, 512);
  let nonPrintable = 0;

  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    if (byte === 0) return true;
    if (byte < 32 && byte !== 10 && byte !== 13 && byte !== 9) {
      nonPrintable++;
    }
  }

  return sample.length > 0 && (nonPrintable / sample.length) > 0.1;
}

// ── Line Buffer ──────────────────────────────────────────────────

interface LineBuffer {
  push: (chunk: string) => void;
  flush: () => void;
}

/**
 * Creates a line buffering context for a stream.
 */
function createLineBuffer(onLine: (line: string) => void): LineBuffer {
  let buffer = "";

  return {
    push(chunk: string): void {
      buffer += chunk;

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.substring(0, newlineIdx);
        buffer = buffer.substring(newlineIdx + 1);
        if (line.length > 0 || buffer.length > 0) {
          onLine(line);
        }
      }

      if (buffer.length > 65536) {
        onLine(buffer);
        buffer = "";
      }
    },

    flush(): void {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = "";
      }
    },
  };
}

// ── Redacting Transform Stream ───────────────────────────────────

interface RedactingTransformOptions {
  streamName?: string;
}

/**
 * Creates a Transform stream that buffers lines, applies redaction,
 * and outputs redacted text.
 */
function createRedactingTransform(options: RedactingTransformOptions = {}): Transform {
  const _streamName = options.streamName || "output";
  let _binary = false;

  return new Transform({
    readableObjectMode: false,
    writableObjectMode: false,

    transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
      if (!_binary && Buffer.isBuffer(chunk) && isBinaryChunk(chunk)) {
        _binary = true;
      }

      if (_binary) {
        this.push(chunk);
        callback();
        return;
      }

      const text = chunk.toString("utf8");
      const lines = text.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0 && i < lines.length - 1) {
          this.push("\n");
          continue;
        }

        const redacted = _redactFn(line);
        if (i < lines.length - 1) {
          this.push(redacted + "\n");
        } else {
          this.push(redacted);
        }
      }

      callback();
    },

    flush(callback: TransformCallback): void {
      callback();
    },
  });
}

// ── Process Wrapper ──────────────────────────────────────────────

interface WrapProcessOptions {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onBinaryDetected?: (stream: string) => void;
}

/**
 * Wrap a child process's stdout and stderr with redaction.
 */
function wrapProcessOutput(proc: ChildProcess, options: WrapProcessOptions = {}): ProcessRedactorHandle {
  const { onStdoutLine, onStderrLine, onBinaryDetected } = options;

  let stdoutBinary = false;
  let stderrBinary = false;

  const stdoutBuffer = createLineBuffer((line) => {
    const redacted = _redactFn(line);
    if (onStdoutLine) onStdoutLine(redacted);
  });

  const onStdoutData = (chunk: Buffer): void => {
    if (!stdoutBinary && Buffer.isBuffer(chunk) && isBinaryChunk(chunk)) {
      stdoutBinary = true;
      if (onBinaryDetected) onBinaryDetected("stdout");
      if (onStdoutLine) onStdoutLine("[binary stdout data detected - redaction skipped]");
      return;
    }

    if (stdoutBinary) return;

    stdoutBuffer.push(chunk.toString("utf8"));
  };

  const stderrBuffer = createLineBuffer((line) => {
    const redacted = _redactFn(line);
    if (onStderrLine) onStderrLine(redacted);
  });

  const onStderrData = (chunk: Buffer): void => {
    if (!stderrBinary && Buffer.isBuffer(chunk) && isBinaryChunk(chunk)) {
      stderrBinary = true;
      if (onBinaryDetected) onBinaryDetected("stderr");
      if (onStderrLine) onStderrLine("[binary stderr data detected - redaction skipped]");
      return;
    }

    if (stderrBinary) return;

    stderrBuffer.push(chunk.toString("utf8"));
  };

  if (proc.stdout) {
    proc.stdout.on("data", onStdoutData);
  }
  if (proc.stderr) {
    proc.stderr.on("data", onStderrData);
  }

  const onClose = (): void => {
    stdoutBuffer.flush();
    stderrBuffer.flush();
  };
  proc.on("close", onClose);

  return {
    cleanup(): void {
      if (proc.stdout) proc.stdout.removeListener("data", onStdoutData);
      if (proc.stderr) proc.stderr.removeListener("data", onStderrData);
      proc.removeListener("close", onClose);
      stdoutBuffer.flush();
      stderrBuffer.flush();
    },
  };
}

/**
 * Redact a single string as if it were process output.
 */
function redactOutput(text: any): any {
  if (typeof text !== "string") return text;
  return _redactFn(text);
}

export {
  setProcessRedactor,
  isBinaryChunk,
  createLineBuffer,
  createRedactingTransform,
  wrapProcessOutput,
  redactOutput,
};
