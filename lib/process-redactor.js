"use strict";

/**
 * Child Process Output Redaction for MI Dev Agent
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

const { Transform } = require("stream");

// Redactor function reference — injected to avoid circular deps
let _redactFn = (s) => s;

function setProcessRedactor(fn) {
  if (typeof fn === "function") _redactFn = fn;
}

// ── Binary Detection ─────────────────────────────────────────────

/**
 * Check if a Buffer chunk contains binary (non-text) data.
 * Looks for null bytes or a high ratio of non-printable characters.
 *
 * @param {Buffer} chunk
 * @returns {boolean}
 */
function isBinaryChunk(chunk) {
  if (!Buffer.isBuffer(chunk)) return false;

  // Sample the first 512 bytes
  const sample = chunk.slice(0, 512);
  let nonPrintable = 0;

  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    // Null byte = definitely binary
    if (byte === 0) return true;
    // Count non-printable (excluding common whitespace: \n, \r, \t)
    if (byte < 32 && byte !== 10 && byte !== 13 && byte !== 9) {
      nonPrintable++;
    }
  }

  // If >10% of sampled bytes are non-printable, treat as binary
  return sample.length > 0 && (nonPrintable / sample.length) > 0.1;
}

// ── Line Buffer ──────────────────────────────────────────────────

/**
 * Creates a line buffering context for a stream.
 * Buffers partial lines and emits complete lines to a callback.
 *
 * @param {Function} onLine - Callback for each complete line: onLine(line: string)
 * @returns {{ push: (chunk: string) => void, flush: () => void }}
 */
function createLineBuffer(onLine) {
  let buffer = "";

  return {
    /**
     * Push a string chunk into the buffer.
     * Any complete lines (terminated by \n) are emitted immediately.
     */
    push(chunk) {
      buffer += chunk;

      // Emit complete lines
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.substring(0, newlineIdx);
        buffer = buffer.substring(newlineIdx + 1);
        if (line.length > 0 || buffer.length > 0) {
          onLine(line);
        }
      }

      // Safety: if buffer grows too large without a newline,
      // force-emit what we have (might be binary or very long line)
      if (buffer.length > 65536) {
        onLine(buffer);
        buffer = "";
      }
    },

    /**
     * Flush any remaining buffered content (on stream end).
     */
    flush() {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = "";
      }
    },
  };
}

// ── Redacting Transform Stream ───────────────────────────────────

/**
 * Creates a Transform stream that buffers lines, applies redaction,
 * and outputs redacted text.
 *
 * Usage:
 *   proc.stdout.pipe(createRedactingTransform()).on('data', (chunk) => { ... });
 *
 * @param {Object} [options]
 * @param {string} [options.streamName] - Name for logging (e.g., "stdout", "stderr")
 * @returns {Transform}
 */
function createRedactingTransform(options = {}) {
  const streamName = options.streamName || "output";
  let _binary = false;

  return new Transform({
    readableObjectMode: false,
    writableObjectMode: false,

    transform(chunk, encoding, callback) {
      // First-chunk binary detection
      if (!_binary && Buffer.isBuffer(chunk) && isBinaryChunk(chunk)) {
        _binary = true;
      }

      if (_binary) {
        // Pass binary through without redaction
        // Replace with a placeholder if we want to suppress binary entirely:
        // this.push(Buffer.from(`[binary ${streamName} data: ${chunk.length} bytes]\n`));
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
          // Last segment might be partial (no trailing newline)
          this.push(redacted);
        }
      }

      callback();
    },

    flush(callback) {
      callback();
    },
  });
}

// ── Process Wrapper ──────────────────────────────────────────────

/**
 * Wrap a child process's stdout and stderr with redaction.
 * Returns objects that emit redacted lines.
 *
 * @param {ChildProcess} proc - The spawned child process
 * @param {Object} [options]
 * @param {Function} [options.onStdoutLine] - Callback for each redacted stdout line
 * @param {Function} [options.onStderrLine] - Callback for each redacted stderr line
 * @param {Function} [options.onBinaryDetected] - Callback when binary data is detected
 * @returns {{ cleanup: () => void }}
 */
function wrapProcessOutput(proc, options = {}) {
  const { onStdoutLine, onStderrLine, onBinaryDetected } = options;

  let stdoutBinary = false;
  let stderrBinary = false;

  // Stdout handling
  const stdoutBuffer = createLineBuffer((line) => {
    const redacted = _redactFn(line);
    if (onStdoutLine) onStdoutLine(redacted);
  });

  const onStdoutData = (chunk) => {
    // Binary detection on first chunk
    if (!stdoutBinary && Buffer.isBuffer(chunk) && isBinaryChunk(chunk)) {
      stdoutBinary = true;
      if (onBinaryDetected) onBinaryDetected("stdout");
      if (onStdoutLine) onStdoutLine("[binary stdout data detected - redaction skipped]");
      return;
    }

    if (stdoutBinary) return; // Skip binary data

    stdoutBuffer.push(chunk.toString("utf8"));
  };

  // Stderr handling
  const stderrBuffer = createLineBuffer((line) => {
    const redacted = _redactFn(line);
    if (onStderrLine) onStderrLine(redacted);
  });

  const onStderrData = (chunk) => {
    if (!stderrBinary && Buffer.isBuffer(chunk) && isBinaryChunk(chunk)) {
      stderrBinary = true;
      if (onBinaryDetected) onBinaryDetected("stderr");
      if (onStderrLine) onStderrLine("[binary stderr data detected - redaction skipped]");
      return;
    }

    if (stderrBinary) return;

    stderrBuffer.push(chunk.toString("utf8"));
  };

  // Attach listeners
  if (proc.stdout) {
    proc.stdout.on("data", onStdoutData);
  }
  if (proc.stderr) {
    proc.stderr.on("data", onStderrData);
  }

  // Flush on close
  const onClose = () => {
    stdoutBuffer.flush();
    stderrBuffer.flush();
  };
  proc.on("close", onClose);

  // Cleanup function to remove listeners
  return {
    cleanup() {
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
 * Convenience function for one-off redaction of captured output.
 *
 * @param {string} text
 * @returns {string}
 */
function redactOutput(text) {
  if (typeof text !== "string") return text;
  return _redactFn(text);
}

module.exports = {
  setProcessRedactor,
  isBinaryChunk,
  createLineBuffer,
  createRedactingTransform,
  wrapProcessOutput,
  redactOutput,
};
