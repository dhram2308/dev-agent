/**
 * notification-config.ts -- Per-gate notification preferences
 *
 * Converted from lib/notification-config.js (zero functional changes).
 * Uses shared types from @mi/shared for NotificationConfig, NotificationConfigMap.
 *
 * Manages which notification channels (slack, jira, ui) and reminders
 * (reminder1h, reminder4h) are enabled for each pipeline gate.
 *
 * Persists to notification-config.json in the project root.
 * Atomic writes (tmp + rename) to prevent corruption.
 * Returns sensible defaults (all ON) when the file doesn't exist.
 */
export {};
//# sourceMappingURL=notification-config.d.ts.map