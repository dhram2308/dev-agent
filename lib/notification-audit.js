"use strict";

/**
 * Notification Audit Trail for MI Dev Agent
 *
 * Tracks every notification attempt with:
 * - Timestamp
 * - Channel (slack/jira/log/state)
 * - Message preview (first 100 chars, redacted)
 * - Result (sent/failed/queued/fallback)
 * - Retry count
 * - Latency in ms
 * - Error message on failure
 *
 * Stored in state.data._notifications array (capped at configurable max entries).
 * Exposes methods for the API layer to display in the UI.
 */

const MAX_AUDIT_ENTRIES = parseInt(process.env.MAX_NOTIFICATION_AUDIT, 10) || 50;
const PREVIEW_LENGTH = 100;

// In-memory ring buffer (persisted to state on save)
let _auditLog = [];

// Redactor reference — injected to avoid circular deps
let _redactFn = (s) => s;

function setAuditRedactor(fn) {
  if (typeof fn === "function") _redactFn = fn;
}

/**
 * Record a notification attempt.
 *
 * @param {Object} entry
 * @param {string} entry.channel      - "slack" | "jira" | "log" | "state"
 * @param {string} entry.message      - Full message text (will be truncated & redacted for preview)
 * @param {string} entry.result       - "sent" | "failed" | "queued" | "fallback" | "skipped"
 * @param {number} [entry.retryCount] - Number of retries attempted (0 = first try)
 * @param {number} [entry.latencyMs]  - Time taken for the attempt in ms
 * @param {string} [entry.error]      - Error message if failed
 * @param {string} [entry.threadTs]   - Slack thread ts if applicable
 * @param {string} [entry.fallbackTo] - Which channel it fell back to
 */
function recordNotification(entry) {
  const record = {
    ts: new Date().toISOString(),
    channel: entry.channel || "unknown",
    preview: _redactFn(
      typeof entry.message === "string"
        ? entry.message.substring(0, PREVIEW_LENGTH).replace(/\n/g, " ")
        : String(entry.message || "").substring(0, PREVIEW_LENGTH)
    ),
    result: entry.result || "unknown",
    retryCount: entry.retryCount || 0,
    latencyMs: entry.latencyMs || 0,
  };

  if (entry.error) {
    record.error = _redactFn(String(entry.error).substring(0, 200));
  }
  if (entry.threadTs) {
    record.threadTs = entry.threadTs;
  }
  if (entry.fallbackTo) {
    record.fallbackTo = entry.fallbackTo;
  }

  _auditLog.push(record);

  // Cap the buffer
  if (_auditLog.length > MAX_AUDIT_ENTRIES) {
    _auditLog = _auditLog.slice(-MAX_AUDIT_ENTRIES);
  }

  return record;
}

/**
 * Get the current audit log (for API exposure).
 * @returns {Array<Object>}
 */
function getAuditLog() {
  return [..._auditLog];
}

/**
 * Get summary statistics of notifications.
 * @returns {Object}
 */
function getAuditSummary() {
  const summary = {
    total: _auditLog.length,
    byChannel: {},
    byResult: {},
    avgLatencyMs: 0,
    consecutiveFailures: 0,
    lastSuccess: null,
    lastFailure: null,
  };

  let totalLatency = 0;
  let latencyCount = 0;

  for (const entry of _auditLog) {
    // By channel
    summary.byChannel[entry.channel] = (summary.byChannel[entry.channel] || 0) + 1;
    // By result
    summary.byResult[entry.result] = (summary.byResult[entry.result] || 0) + 1;
    // Latency
    if (entry.latencyMs > 0) {
      totalLatency += entry.latencyMs;
      latencyCount++;
    }
    // Track last success/failure
    if (entry.result === "sent") {
      summary.lastSuccess = entry.ts;
    } else if (entry.result === "failed") {
      summary.lastFailure = entry.ts;
    }
  }

  summary.avgLatencyMs = latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0;

  // Count consecutive failures from the end
  for (let i = _auditLog.length - 1; i >= 0; i--) {
    if (_auditLog[i].result === "failed") {
      summary.consecutiveFailures++;
    } else {
      break;
    }
  }

  return summary;
}

/**
 * Sync the in-memory audit log to a pipeline state object.
 * Call this before state.save() to persist the audit trail.
 *
 * @param {Object} state - The pipeline state object (state.data will be modified)
 */
function syncToState(state) {
  if (!state || !state.data) return;
  state.data._notifications = _auditLog.slice(-MAX_AUDIT_ENTRIES);
}

/**
 * Load audit log from a pipeline state object (on resume).
 *
 * @param {Object} state - The pipeline state object
 */
function loadFromState(state) {
  if (state && state.data && Array.isArray(state.data._notifications)) {
    _auditLog = state.data._notifications.slice(-MAX_AUDIT_ENTRIES);
  }
}

/**
 * Clear the audit log (for testing or explicit reset).
 */
function clearAuditLog() {
  _auditLog = [];
}

/**
 * Get the count of consecutive failures for a specific channel.
 * @param {string} channel
 * @returns {number}
 */
function getConsecutiveFailures(channel) {
  let count = 0;
  for (let i = _auditLog.length - 1; i >= 0; i--) {
    if (_auditLog[i].channel !== channel) continue;
    if (_auditLog[i].result === "failed") {
      count++;
    } else {
      break;
    }
  }
  return count;
}

module.exports = {
  recordNotification,
  getAuditLog,
  getAuditSummary,
  syncToState,
  loadFromState,
  clearAuditLog,
  getConsecutiveFailures,
  setAuditRedactor,
  MAX_AUDIT_ENTRIES,
};
