// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Notification System Type Definitions
// ═══════════════════════════════════════════════════════════════

/**
 * Notification delivery channels.
 */
export type NotificationChannel = 'slack' | 'jira' | 'ui' | 'log' | 'jira_fallback';

/**
 * An item in the notification send queue.
 */
export interface NotificationQueueItem {
  /** The Slack webhook payload to send */
  payload: {
    text: string;
    thread_ts?: string;
  };

  /** Promise resolve callback */
  resolve: (value: { ok: boolean; ts?: string | null }) => void;

  /** Promise reject callback */
  reject: (error: Error) => void;
}

/**
 * Delivery status of a notification attempt.
 */
export interface NotificationDeliveryStatus {
  /** Whether the notification was sent successfully */
  sent: boolean;

  /** Which retry attempt succeeded (1-based) */
  attempt?: number;

  /** Fallback channel used (if primary failed) */
  fallback?: 'jira' | 'log';

  /** Reason for failure */
  reason?: string;
}

/**
 * Per-gate notification channel configuration.
 */
export interface NotificationConfig {
  /** Whether Slack notifications are enabled for this gate */
  slack: boolean;

  /** Whether Jira comment notifications are enabled */
  jira: boolean;

  /** Whether Web UI notifications are enabled */
  ui: boolean;

  /** Whether the 1-hour reminder is enabled */
  reminder1h: boolean;

  /** Whether the 4-hour reminder is enabled */
  reminder4h: boolean;
}

/**
 * Full notification configuration keyed by gate name.
 */
export type NotificationConfigMap = Record<string, NotificationConfig>;

/**
 * Notification failure record stored in pipeline state.
 */
export interface NotificationFailureRecord {
  /** ISO timestamp of the failure */
  timestamp: string;

  /** Channel that failed */
  channel: NotificationChannel;

  /** Preview of the failed message */
  message: string;

  /** Error description */
  error: string;

  /** PID of the process that encountered the failure */
  pid?: number;
}

/**
 * Notification failure log entry written to notification-failures.log.
 */
export interface NotificationFailureLogEntry {
  /** ISO timestamp */
  timestamp: string;

  /** Channel that failed */
  channel: string;

  /** Truncated message content */
  message: string;

  /** Error description */
  error: string;

  /** Process ID */
  pid: number;
}

/**
 * Summary of notification failures for UI display.
 */
export interface NotificationFailureSummary {
  /** Total failure count */
  count: number;

  /** Most recent failures (up to 5) */
  recent?: readonly NotificationFailureRecord[];

  /** Timestamp of the oldest failure */
  oldestTs?: string | null;

  /** Timestamp of the newest failure */
  newestTs?: string | null;
}

/**
 * Notification audit record (recorded by notification-audit.js).
 */
export interface NotificationAuditRecord {
  /** Delivery channel */
  channel: NotificationChannel;

  /** Message text (or preview) */
  message: string;

  /** Delivery result */
  result: 'sent' | 'failed' | 'skipped' | 'queued' | 'fallback';

  /** Number of retry attempts */
  retryCount?: number;

  /** Delivery latency in milliseconds */
  latencyMs?: number;

  /** Thread timestamp (for Slack threads) */
  threadTs?: string | null;

  /** Fallback channel used */
  fallbackTo?: string;

  /** Error description (on failure) */
  error?: string;
}
