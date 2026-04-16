/**
 * notification-resilience.ts -- Notification Resilience
 *
 * Converted from lib/notification-resilience.js (zero functional changes).
 * Uses shared types from @mi/shared for NotificationQueueItem, etc.
 *
 * Solves problem #13:
 * - Slack notifications must never silently fail
 * - Try Slack webhook -> if fail, retry once -> if still fail:
 *   - Log to dedicated notification-failure log
 *   - If Jira available, post comment as fallback
 *   - Set state flag _notification_failures for UI display
 * - Message truncation to 4000 chars (Slack limit)
 * - Rate limiting to prevent Slack API abuse
 */
export {};
//# sourceMappingURL=notification-resilience.d.ts.map