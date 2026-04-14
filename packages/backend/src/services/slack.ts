// =====================================================================
// MI Dev Agent -- Slack Notification Service
// =====================================================================
// TypeScript port of lib/slack.js with full 6-layer resilience.
//
// Layers:
//   1. Message validation and sanitization
//   2. Rate limiting (1 msg/sec per channel)
//   3. Retry with exponential backoff (3 retries)
//   4. Circuit breaker (via HTTP client)
//   5. Fallback to Jira comment on Slack failure
//   6. Audit trail (log all notification attempts)
//
// Features:
//   - Thread reply support (thread_ts)
//   - Mention formatting (<@SLACK_ID>)
//   - Message truncation (Slack 4000 char limit)
//   - Block Kit support (blocks parameter)
//   - Batch mode (collect messages, send as one)
//   - Webhook URL validation
//   - Startup ping test
//   - Health status reporting
// =====================================================================

import { logInfo, logWarn, logErr, logDebug } from '../lib/logger';
import { sleep } from '../lib/utils';
import type { NotificationFailure, PipelineState } from '@shared/types';

// ── Types ────────────────────────────────────────────────────────────

export interface SlackOptions {
  /** Reply in this Slack thread */
  channel?: string;
  /** Thread timestamp for reply */
  threadTs?: string;
  /** Whether to unfurl links (default true) */
  unfurlLinks?: boolean;
  /** Block Kit blocks to send instead of text */
  blocks?: unknown[];
  /** If true and batch mode is on, buffer the message */
  batch?: boolean;
}

export interface SlackSendResult {
  ok: boolean;
  ts?: string | null;
  error?: string;
  fallbackExecuted?: boolean;
  queued?: boolean;
}

export interface SlackHealth {
  initialized: boolean;
  webhookValid: boolean;
  consecutiveFailures: number;
  queueLength: number;
  batchMode: boolean;
  batchBufferSize: number;
  defaultThread: string | null;
  healthy: boolean;
}

interface SlackPayload {
  text: string;
  thread_ts?: string;
  unfurl_links?: boolean;
  blocks?: unknown[];
}

interface QueueItem {
  payload: SlackPayload;
  resolve: (result: SlackSendResult) => void;
  reject: (error: Error) => void;
}

interface BatchItem {
  text: string;
  mentions: string[];
  threadTs: string | null;
}

export interface NotificationRecord {
  channel: 'slack' | 'jira' | 'log';
  message: string;
  result: 'sent' | 'failed' | 'skipped' | 'fallback' | 'queued';
  retryCount?: number;
  latencyMs?: number;
  threadTs?: string | null;
  fallbackTo?: string;
  error?: string;
}

/**
 * HTTP request function type -- will be provided by http/client.ts.
 * Using a type alias so we can wire the real implementation at init.
 */
type ReqFn = (url: string, opts: {
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}) => Promise<{ status: number; data: unknown; headers?: Record<string, string> }>;

type JiraCommentFn = (ticket: string, comment: string) => Promise<void>;
type StateAccessorFn = () => PipelineState | null;

// ── Constants ────────────────────────────────────────────────────────

const SLACK_MAX_TEXT_LENGTH = 3900; // Leave 100 chars for overhead/formatting
const TRUNCATION_SUFFIX = '\n... [truncated]';
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 10000]; // Exponential backoff schedule
const RATE_LIMIT_INTERVAL_MS = 1100; // Slightly over 1s to respect Slack's ~1msg/sec
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const STARTUP_PING_TIMEOUT_MS = 10000;

// ── SlackService Class ───────────────────────────────────────────────

export class SlackService {
  // Internal state
  private initialized = false;
  private webhookValid = false;
  private consecutiveFailures = 0;
  private lastSendTime = 0;
  private sendQueue: QueueItem[] = [];
  private drainRunning = false;
  private batchBuffer: BatchItem[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchModeEnabled = false;
  private defaultThreadTs: string | null = null;
  private batchWindowMs: number;

  // Injected dependencies
  private webhookUrl: string;
  private req: ReqFn;
  private jiraCommentFn: JiraCommentFn | null = null;
  private stateAccessorFn: StateAccessorFn | null = null;
  private jiraCommentsEnabled = true;
  private currentTicket = '';

  // Audit trail
  private auditLog: NotificationRecord[] = [];
  private maxAuditEntries = 500;

  constructor(
    webhookUrl: string,
    req: ReqFn,
    options?: {
      batchWindowMs?: number;
      jiraCommentsEnabled?: boolean;
      currentTicket?: string;
    },
  ) {
    this.webhookUrl = webhookUrl;
    this.req = req;
    this.batchWindowMs = options?.batchWindowMs
      ?? (parseInt(process.env.SLACK_BATCH_WINDOW || '', 10) || 5000);
    this.jiraCommentsEnabled = options?.jiraCommentsEnabled ?? true;
    this.currentTicket = options?.currentTicket ?? '';
  }

  // ── Dependency Injection ─────────────────────────────────────────

  /** Set a Jira comment function for fallback notifications. */
  setJiraFallback(fn: JiraCommentFn): void {
    if (typeof fn === 'function') this.jiraCommentFn = fn;
  }

  /** Set a state accessor function for health flag updates. */
  setStateAccessor(fn: StateAccessorFn): void {
    if (typeof fn === 'function') this.stateAccessorFn = fn;
  }

  /** Update the current ticket for Jira fallback. */
  setCurrentTicket(ticket: string): void {
    this.currentTicket = ticket;
  }

  // ── Layer 1: Message Validation & Sanitization ───────────────────

  /**
   * Validates the Slack webhook URL format.
   * Must be a valid https://hooks.slack.com/* URL.
   */
  static validateWebhookUrl(url: string): { valid: boolean; reason?: string } {
    if (!url) return { valid: false, reason: 'Webhook URL is not set' };
    if (typeof url !== 'string') return { valid: false, reason: 'Webhook URL must be a string' };

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return { valid: false, reason: `Webhook URL must use HTTPS, got ${parsed.protocol}` };
      }
      if (
        !parsed.hostname.endsWith('hooks.slack.com') &&
        !parsed.hostname.endsWith('hooks.slack-gov.com')
      ) {
        return { valid: false, reason: `Webhook URL host must be hooks.slack.com, got ${parsed.hostname}` };
      }
      if (!parsed.pathname.startsWith('/services/')) {
        return { valid: false, reason: `Webhook URL path must start with /services/, got ${parsed.pathname}` };
      }
      return { valid: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, reason: `Webhook URL is not a valid URL: ${message}` };
    }
  }

  /**
   * Truncate a message to Slack's safe limit, adding a truncation indicator.
   */
  static truncateMessage(text: string): string {
    if (!text || typeof text !== 'string') return '';
    if (text.length <= SLACK_MAX_TEXT_LENGTH) return text;
    return text.substring(0, SLACK_MAX_TEXT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
  }

  // ── Layer 6: Audit Trail ──────────────────────────────────────────

  private recordNotification(record: NotificationRecord): void {
    this.auditLog.push(record);
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog = this.auditLog.slice(-this.maxAuditEntries);
    }
  }

  /** Get a copy of the notification audit log. */
  getAuditLog(): readonly NotificationRecord[] {
    return [...this.auditLog];
  }

  /** Get count of consecutive failures from the audit log. */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  // ── Layer 2: Rate-Limited Send Queue ──────────────────────────────

  private enqueuePayload(payload: SlackPayload): Promise<SlackSendResult> {
    return new Promise((resolve, reject) => {
      this.sendQueue.push({ payload, resolve, reject });
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.drainRunning) return;
    this.drainRunning = true;

    while (this.sendQueue.length > 0) {
      const now = Date.now();
      const timeSinceLast = now - this.lastSendTime;

      if (timeSinceLast < RATE_LIMIT_INTERVAL_MS) {
        await sleep(RATE_LIMIT_INTERVAL_MS - timeSinceLast);
      }

      const item = this.sendQueue.shift();
      if (!item) break;

      try {
        const result = await this.sendWithRetry(item.payload);
        item.resolve(result);
      } catch (err: unknown) {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.lastSendTime = Date.now();
    }

    this.drainRunning = false;
  }

  // ── Layer 3: Retry with Exponential Backoff ───────────────────────

  /**
   * Send a Slack webhook payload with retry and exponential backoff.
   */
  private async sendWithRetry(payload: SlackPayload): Promise<SlackSendResult> {
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const start = Date.now();
      try {
        const res = await this.req(this.webhookUrl, {
          method: 'POST',
          body: payload,
        });

        const latency = Date.now() - start;

        if (res.status === 200) {
          this.consecutiveFailures = 0;

          // Slack webhooks return "ok" as text, or JSON with ts for some endpoints
          const ts = (typeof res.data === 'object' && res.data && (res.data as Record<string, unknown>).ts)
            ? String((res.data as Record<string, unknown>).ts)
            : null;

          this.recordNotification({
            channel: 'slack',
            message: payload.text || '',
            result: 'sent',
            retryCount: attempt,
            latencyMs: latency,
            threadTs: ts,
          });

          return { ok: true, ts };
        }

        // Rate limited by Slack
        if (res.status === 429) {
          const retryAfterHeader = res.headers?.['retry-after'];
          const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
          const waitMs = !isNaN(retryAfter)
            ? retryAfter * 1000
            : RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
          logWarn(`Slack rate limited (429) -- waiting ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
          await sleep(waitMs);
          continue;
        }

        const dataPreview = typeof res.data === 'string'
          ? res.data.substring(0, 200)
          : JSON.stringify(res.data).substring(0, 200);
        lastErr = new Error(`Slack webhook returned HTTP ${res.status}: ${dataPreview}`);
      } catch (err: unknown) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }

      // Retry with backoff
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        logDebug(`Slack send failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastErr?.message} -- retrying in ${delay}ms`);
        await sleep(delay);
      }
    }

    // All retries exhausted
    this.consecutiveFailures++;

    this.recordNotification({
      channel: 'slack',
      message: payload.text || '',
      result: 'failed',
      retryCount: MAX_RETRIES,
      latencyMs: 0,
      error: lastErr ? lastErr.message : 'Unknown error',
    });

    throw lastErr || new Error('Slack send failed after all retries');
  }

  // ── Layer 5: Fallback Chain ────────────────────────────────────────

  /**
   * Execute the fallback chain when Slack fails:
   *   1. Jira comment (if enabled and function provided)
   *   2. Log file (always)
   *   3. State flag (always)
   */
  private async executeFallbackChain(text: string, slackError: string): Promise<void> {
    const preview = text.substring(0, 100);

    // Fallback 1: Jira comment
    if (this.jiraCommentFn && this.jiraCommentsEnabled) {
      try {
        const ticket = this.currentTicket || process.env.TICKET || '';
        if (ticket) {
          const jiraText = `[Auto-notification -- Slack delivery failed]\n\n${text.substring(0, 2000)}`;
          await this.jiraCommentFn(ticket, jiraText);
          logInfo(`Notification fallback: sent via Jira comment for ${ticket}`);
          this.recordNotification({
            channel: 'jira',
            message: text,
            result: 'fallback',
            fallbackTo: 'jira',
          });
          return;
        }
      } catch (jiraErr: unknown) {
        const msg = jiraErr instanceof Error ? jiraErr.message : String(jiraErr);
        logWarn(`Jira fallback also failed: ${msg}`);
      }
    }

    // Fallback 2: Prominent log entry (always works)
    logErr(`NOTIFICATION FALLBACK (Slack failed: ${slackError}): ${preview}...`);
    this.recordNotification({
      channel: 'log',
      message: text,
      result: 'fallback',
      fallbackTo: 'log',
      error: slackError,
    });

    // Fallback 3: State flag for UI banner
    if (this.stateAccessorFn) {
      try {
        const state = this.stateAccessorFn();
        if (state?.data) {
          if (!state.data._notification_failures) {
            state.data._notification_failures = [];
          }
          const failures = state.data._notification_failures as NotificationFailure[];
          failures.push({
            channel: 'slack',
            message: preview,
            error: slackError,
            timestamp: new Date().toISOString(),
          });
          // Cap to last 10 failures
          if (failures.length > 10) {
            state.data._notification_failures = failures.slice(-10);
          }
          state.data._health = {
            ...(state.data._health || {} as NonNullable<typeof state.data._health>),
            services: {
              ...(state.data._health?.services || {}),
              slack: {
                status: 'unhealthy',
                consecutiveFailures: this.consecutiveFailures,
                lastFailure: new Date().toISOString(),
                lastError: slackError,
              },
            },
          } as typeof state.data._health;
        }
      } catch {
        /* state access failed -- already logged to file */
      }
    }
  }

  // ── Batch Mode ────────────────────────────────────────────────────

  /** Enable batch mode: collect messages for batchWindowMs, then send as one. */
  enableBatchMode(): void {
    this.batchModeEnabled = true;
  }

  /** Disable batch mode and flush any pending messages. */
  disableBatchMode(): void {
    this.batchModeEnabled = false;
    this.flushBatch();
  }

  /** Immediately send all buffered batch messages. */
  flushBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.batchBuffer.length === 0) return;

    const messages = this.batchBuffer.splice(0);
    const combined = messages.map((m) => m.text).join('\n---\n');
    const mentions = [...new Set(messages.flatMap((m) => m.mentions || []))];

    // Send combined (non-blocking)
    void this.sendInternal(combined, mentions, messages[0].threadTs).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`Batch flush failed: ${msg}`);
    });
  }

  // ── Core Send ──────────────────────────────────────────────────────

  /**
   * Internal send: builds payload, truncates, enqueues.
   */
  private async sendInternal(
    text: string,
    mentionIds: string[] = [],
    threadTs: string | null = null,
    slackOpts?: SlackOptions,
  ): Promise<SlackSendResult> {
    if (!this.webhookValid) {
      this.recordNotification({
        channel: 'slack',
        message: text,
        result: 'skipped',
        error: 'Webhook not validated',
      });
      return { ok: false };
    }

    // Truncate body FIRST, then prepend mentions (so mentions are never cut off)
    const mentions = mentionIds.filter(Boolean).map((id) => `<@${id}>`).join(' ');
    const mentionPrefix = mentions ? `${mentions}\n` : '';
    // Reserve space for the mention prefix so total stays under the limit
    const bodyLimit = SLACK_MAX_TEXT_LENGTH - mentionPrefix.length;
    const truncatedBody = bodyLimit > 100
      ? SlackService.truncateMessage(text.substring(0, bodyLimit))
      : SlackService.truncateMessage(text);
    const fullText = mentionPrefix + truncatedBody;

    // Build payload
    const payload: SlackPayload = { text: fullText };
    if (threadTs) {
      payload.thread_ts = threadTs;
    }
    if (slackOpts?.unfurlLinks === false) {
      payload.unfurl_links = false;
    }
    if (slackOpts?.blocks && Array.isArray(slackOpts.blocks) && slackOpts.blocks.length > 0) {
      payload.blocks = slackOpts.blocks;
    }

    return this.enqueuePayload(payload);
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Initialize the notification system.
   * Call once at startup. Validates webhook URL and optionally pings.
   */
  async init(options: { skipPing?: boolean } = {}): Promise<{ ok: boolean; reason?: string }> {
    if (!this.webhookUrl) {
      logInfo('Slack webhook not configured -- notifications will be logged only');
      this.initialized = true;
      this.webhookValid = false;
      return { ok: false, reason: 'Webhook not configured' };
    }

    // Validate URL format
    const validation = SlackService.validateWebhookUrl(this.webhookUrl);
    if (!validation.valid) {
      logErr(`Slack webhook URL invalid: ${validation.reason}`);
      this.initialized = true;
      this.webhookValid = false;
      return { ok: false, reason: validation.reason };
    }

    this.webhookValid = true;

    // Startup ping test
    if (!options.skipPing) {
      try {
        logInfo('Testing Slack webhook connectivity...');
        const pingStart = Date.now();

        const pingResult = await Promise.race([
          this.req(this.webhookUrl, {
            method: 'POST',
            body: { text: ':white_check_mark: MI Dev Agent connected (startup ping)' },
          }),
          sleep(STARTUP_PING_TIMEOUT_MS).then(() => {
            throw new Error(`Slack ping timed out after ${STARTUP_PING_TIMEOUT_MS}ms`);
          }),
        ]);

        const pingLatency = Date.now() - pingStart;

        if (pingResult && pingResult.status === 200) {
          logInfo(`Slack webhook OK (${pingLatency}ms)`);
          this.recordNotification({
            channel: 'slack',
            message: 'Startup ping',
            result: 'sent',
            latencyMs: pingLatency,
          });
        } else {
          const reason = `Startup ping returned HTTP ${pingResult?.status}`;
          logWarn(`Slack webhook ping failed: ${reason}`);
          this.webhookValid = false;
          return { ok: false, reason };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(`Slack webhook ping failed: ${msg} -- continuing without Slack`);
        this.webhookValid = false;
        return { ok: false, reason: msg };
      }
    }

    this.initialized = true;

    // Mark state as healthy
    if (this.stateAccessorFn) {
      try {
        const state = this.stateAccessorFn();
        if (state?.data?._health?.services) {
          state.data._health.services.slack = {
            status: 'healthy',
            consecutiveFailures: 0,
            lastSuccess: new Date().toISOString(),
          };
        }
      } catch {
        /* swallow */
      }
    }

    return { ok: true };
  }

  /**
   * Send a Slack notification with full resilience (6 layers).
   *
   * @param message - The message to send
   * @param mentions - Slack user IDs to mention (e.g., ['U12345', 'U67890'])
   * @param opts - Additional options (threadTs, batch, blocks, etc.)
   * @returns Result with ok status and optional thread timestamp
   */
  async send(
    message: string,
    mentions: string[] = [],
    opts: SlackOptions = {},
  ): Promise<SlackSendResult> {
    if (!this.webhookUrl) {
      logInfo('(Slack webhook not set -- skipping)');
      this.recordNotification({
        channel: 'slack',
        message,
        result: 'skipped',
        error: 'No webhook configured',
      });
      return { ok: false };
    }

    // Auto-initialize if not done yet (backwards compatibility)
    if (!this.initialized) {
      await this.init({ skipPing: true });
    }

    const threadTs = opts.threadTs || this.defaultThreadTs;

    // Batch mode: buffer and return
    if (this.batchModeEnabled && opts.batch !== false) {
      this.batchBuffer.push({ text: message, mentions, threadTs });
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.flushBatch(), this.batchWindowMs);
      }
      this.recordNotification({
        channel: 'slack',
        message,
        result: 'queued',
      });
      return { ok: true, queued: true };
    }

    // Direct send with fallback
    try {
      const result = await this.sendInternal(message, mentions, threadTs, opts);

      // Check consecutive failure threshold
      if (this.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
        logErr(
          `ALERT: ${this.consecutiveFailures} consecutive Slack failures -- check webhook URL and network`,
        );
      }

      return result;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logWarn(`Slack notification failed: ${errMsg} -- executing fallback chain`);
      await this.executeFallbackChain(message, errMsg);

      // Check consecutive failure threshold
      if (this.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
        logErr(
          `ALERT: ${this.consecutiveFailures} consecutive Slack failures -- notifications are not reaching the team!`,
        );
      }

      return { ok: false, error: errMsg, fallbackExecuted: true };
    }
  }

  // ── Thread Management ──────────────────────────────────────────────

  /**
   * Set the default thread ts for all subsequent messages.
   * Useful for creating a "notification thread" at pipeline start.
   */
  setDefaultThread(ts: string | null): void {
    this.defaultThreadTs = ts;
  }

  /** Get the current default thread ts. */
  getDefaultThread(): string | null {
    return this.defaultThreadTs;
  }

  // ── Health Reporting ───────────────────────────────────────────────

  /** Get the health status of the Slack integration. */
  getHealth(): SlackHealth {
    return {
      initialized: this.initialized,
      webhookValid: this.webhookValid,
      consecutiveFailures: this.consecutiveFailures,
      queueLength: this.sendQueue.length,
      batchMode: this.batchModeEnabled,
      batchBufferSize: this.batchBuffer.length,
      defaultThread: this.defaultThreadTs,
      healthy: this.webhookValid && this.consecutiveFailures < CONSECUTIVE_FAILURE_THRESHOLD,
    };
  }

  // ── Webhook Change Detection ───────────────────────────────────────

  /**
   * Check if the Slack webhook URL has changed and re-validate.
   * Call periodically (e.g., every stage) to detect env var changes.
   *
   * @returns true if the webhook changed and was re-validated
   */
  checkWebhookChange(newUrl?: string): boolean {
    const currentWebhook = newUrl || process.env.SLACK_WEBHOOK || '';
    if (currentWebhook && currentWebhook !== this.webhookUrl) {
      logWarn('Slack webhook URL changed mid-pipeline -- re-validating');
      this.webhookUrl = currentWebhook;
      const validation = SlackService.validateWebhookUrl(currentWebhook);
      this.webhookValid = validation.valid;
      if (!validation.valid) {
        logErr(`New Slack webhook URL is invalid: ${validation.reason}`);
      }
      this.consecutiveFailures = 0;
      return true;
    }
    return false;
  }

  // ── Testing Support ────────────────────────────────────────────────

  /** Reset internal state (for testing). */
  _resetForTesting(): void {
    this.initialized = false;
    this.webhookValid = false;
    this.consecutiveFailures = 0;
    this.lastSendTime = 0;
    this.sendQueue = [];
    this.drainRunning = false;
    this.batchBuffer = [];
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.batchModeEnabled = false;
    this.defaultThreadTs = null;
    this.auditLog = [];
  }
}

// ── Module-level convenience function ─────────────────────────────────

/**
 * Standalone slack() function matching the original lib/slack.js API.
 *
 * Usage:
 *   const { createSlackSender } = require('./services/slack');
 *   const slack = createSlackSender(webhookUrl, reqFn);
 *   await slack('Hello world', ['U12345']);
 */
export function createSlackSender(
  webhookUrl: string,
  req: ReqFn,
  options?: {
    batchWindowMs?: number;
    jiraCommentsEnabled?: boolean;
    currentTicket?: string;
  },
): {
  slack: (message: string, mentions?: string[], opts?: SlackOptions) => Promise<SlackSendResult>;
  service: SlackService;
} {
  const service = new SlackService(webhookUrl, req, options);
  return {
    slack: (message: string, mentions?: string[], opts?: SlackOptions) =>
      service.send(message, mentions ?? [], opts ?? {}),
    service,
  };
}
