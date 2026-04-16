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
export {};
//# sourceMappingURL=logging.d.ts.map