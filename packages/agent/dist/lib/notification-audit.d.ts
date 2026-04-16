/**
 * notification-audit.ts — Notification Audit Trail for MI Dev Agent
 *
 * Converted from lib/notification-audit.js (zero functional changes).
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
declare const MAX_AUDIT_ENTRIES: number;
declare function setAuditRedactor(fn: (s: string) => string): void;
interface NotificationEntry {
    channel?: string;
    message?: string | any;
    result?: string;
    retryCount?: number;
    latencyMs?: number;
    error?: string;
    threadTs?: string;
    fallbackTo?: string;
}
interface AuditRecord {
    ts: string;
    channel: string;
    preview: string;
    result: string;
    retryCount: number;
    latencyMs: number;
    error?: string;
    threadTs?: string;
    fallbackTo?: string;
}
/**
 * Record a notification attempt.
 */
declare function recordNotification(entry: NotificationEntry): AuditRecord;
/**
 * Get the current audit log (for API exposure).
 */
declare function getAuditLog(): AuditRecord[];
interface AuditSummary {
    total: number;
    byChannel: Record<string, number>;
    byResult: Record<string, number>;
    avgLatencyMs: number;
    consecutiveFailures: number;
    lastSuccess: string | null;
    lastFailure: string | null;
}
/**
 * Get summary statistics of notifications.
 */
declare function getAuditSummary(): AuditSummary;
/**
 * Sync the in-memory audit log to a pipeline state object.
 */
declare function syncToState(state: any): void;
/**
 * Load audit log from a pipeline state object (on resume).
 */
declare function loadFromState(state: any): void;
/**
 * Clear the audit log (for testing or explicit reset).
 */
declare function clearAuditLog(): void;
/**
 * Get the count of consecutive failures for a specific channel.
 */
declare function getConsecutiveFailures(channel: string): number;
export { recordNotification, getAuditLog, getAuditSummary, syncToState, loadFromState, clearAuditLog, getConsecutiveFailures, setAuditRedactor, MAX_AUDIT_ENTRIES, };
//# sourceMappingURL=notification-audit.d.ts.map