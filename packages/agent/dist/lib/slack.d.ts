/**
 * slack.ts -- Resilient Notification System for MI Dev Agent
 *
 * Converted from lib/slack.js (zero functional changes).
 * Uses shared types from @mi/shared for SlackMessage, SlackBlock, etc.
 *
 * Features:
 * 1. Webhook URL format validation on startup (must be https://hooks.slack.com/*)
 * 2. Startup ping test with timeout
 * 3. Message builder: truncate to 3900 chars, add "... [truncated]" suffix
 * 4. Retry logic: 3 attempts with 1s, 3s, 10s exponential backoff
 * 5. Rate limiter: max 1 message per second, queue excess with drain loop
 * 6. Fallback chain: Slack -> Jira comment -> log file -> state flag
 * 7. Failure tracking: count consecutive failures, alert after 3
 * 8. Batch mode: collect messages for 5s, send as single notification with dividers
 * 9. Thread support: reply in thread for follow-up messages (using ts parameter)
 * 10. Notification audit trail integration
 */
export {};
//# sourceMappingURL=slack.d.ts.map