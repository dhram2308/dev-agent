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

import type {
  SlackResponse,
  SlackHealth,
  WebhookValidation,
  SlackWebhookPayload,
  NotificationAuditRecord,
} from '@mi/shared';

const { cfg, JIRA_COMMENTS } = require('./config') as {
  cfg: {
    slack: { webhook: string; ownerId: string; anshitId: string };
    _currentTicket?: string;
    [key: string]: any;
  };
  JIRA_COMMENTS: boolean;
};
const { req, sleep } = require('./http-client') as {
  req: (url: string, opts?: any) => Promise<any>;
  sleep: (ms: number) => Promise<void>;
};
const { logInfo, logWarn, logErr, logDebug } = require('./logging') as {
  logInfo: (msg: string) => void;
  logWarn: (msg: string) => void;
  logErr: (msg: string) => void;
  logDebug: (msg: string) => void;
};
const { recordNotification, getConsecutiveFailures } = require('./notification-audit') as {
  recordNotification: (record: Partial<NotificationAuditRecord>) => void;
  getConsecutiveFailures: () => number;
};

// ── Constants ────────────────────────────────────────────────────
const SLACK_MAX_TEXT_LENGTH = 3900; // Leave 100 chars for overhead/formatting
const TRUNCATION_SUFFIX = "\n... [truncated]";
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 3000, 10000]; // Exponential backoff schedule
const RATE_LIMIT_INTERVAL_MS = 1100; // Slightly over 1s to respect Slack's ~1msg/sec
const BATCH_WINDOW_MS = parseInt(process.env.SLACK_BATCH_WINDOW as string, 10) || 5000;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const STARTUP_PING_TIMEOUT_MS = 10000;

// ── Internal State ───────────────────────────────────────────────

interface QueueItem {
  payload: SlackWebhookPayload;
  resolve: (value: { ok: boolean; ts?: string | null }) => void;
  reject: (error: Error) => void;
}

interface BatchItem {
  text: string;
  mentions: string[];
  threadTs: string | null;
}

let _initialized = false;
let _webhookValid = false;
let _consecutiveFailures = 0;
let _lastSendTime = 0;
let _sendQueue: QueueItem[] = [];
let _drainRunning = false;
let _batchBuffer: BatchItem[] = [];
let _batchTimer: ReturnType<typeof setTimeout> | null = null;
let _batchMode = false;
let _defaultThreadTs: string | null = null; // Default thread ts for follow-up messages

// ── Fallback Jira comment function (injected to avoid circular dep) ──
let _jiraCommentFn: ((ticket: string, text: string) => Promise<void>) | null = null;
function setJiraFallback(fn: any): void {
  if (typeof fn === "function") _jiraCommentFn = fn;
}

// ── State reference for fallback flag ────────────────────────────
let _getCurrentStateFn: (() => any) | null = null;
function setStateAccessor(fn: any): void {
  if (typeof fn === "function") _getCurrentStateFn = fn;
}

// ── Webhook URL Validation ───────────────────────────────────────

/**
 * Validates the Slack webhook URL format.
 * Must be a valid https://hooks.slack.com/* URL.
 */
function validateWebhookUrl(url: string): WebhookValidation {
  if (!url) return { valid: false, reason: "Webhook URL is not set" };
  if (typeof url !== "string") return { valid: false, reason: "Webhook URL must be a string" };

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return { valid: false, reason: `Webhook URL must use HTTPS, got ${parsed.protocol}` };
    }
    if (!parsed.hostname.endsWith("hooks.slack.com") && !parsed.hostname.endsWith("hooks.slack-gov.com")) {
      return { valid: false, reason: `Webhook URL host must be hooks.slack.com, got ${parsed.hostname}` };
    }
    if (!parsed.pathname.startsWith("/services/")) {
      return { valid: false, reason: `Webhook URL path must start with /services/, got ${parsed.pathname}` };
    }
    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: `Webhook URL is not a valid URL: ${err.message}` };
  }
}

// ── Message Truncation ───────────────────────────────────────────

/**
 * Truncate a message to Slack's safe limit, adding a truncation indicator.
 */
function truncateMessage(text: string): string {
  if (!text || typeof text !== "string") return "";
  if (text.length <= SLACK_MAX_TEXT_LENGTH) return text;
  return text.substring(0, SLACK_MAX_TEXT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

// ── Rate-Limited Send Queue ──────────────────────────────────────

/**
 * Enqueue a raw Slack payload for rate-limited delivery.
 * Returns a Promise that resolves when the message is sent or fails.
 */
function enqueuePayload(payload: SlackWebhookPayload): Promise<{ ok: boolean; ts?: string | null }> {
  return new Promise((resolve, reject) => {
    _sendQueue.push({ payload, resolve, reject });
    drainQueue();
  });
}

async function drainQueue(): Promise<void> {
  if (_drainRunning) return;
  _drainRunning = true;

  while (_sendQueue.length > 0) {
    const now = Date.now();
    const timeSinceLast = now - _lastSendTime;

    if (timeSinceLast < RATE_LIMIT_INTERVAL_MS) {
      await sleep(RATE_LIMIT_INTERVAL_MS - timeSinceLast);
    }

    const item = _sendQueue.shift();
    if (!item) break;

    try {
      const result = await sendWithRetry(item.payload);
      item.resolve(result);
    } catch (err: any) {
      item.reject(err);
    }
    _lastSendTime = Date.now();
  }

  _drainRunning = false;
}

// ── Retry Logic ──────────────────────────────────────────────────

/**
 * Send a Slack webhook payload with retry and exponential backoff.
 */
async function sendWithRetry(payload: SlackWebhookPayload): Promise<{ ok: boolean; ts?: string | null }> {
  const webhook = cfg.slack.webhook;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    try {
      const res = await req(webhook, {
        method: "POST",
        body: payload,
      });

      const latency = Date.now() - start;

      if (res.status === 200) {
        _consecutiveFailures = 0;

        // Slack webhooks return "ok" as text, or JSON with ts for some endpoints
        const ts = (typeof res.data === "object" && res.data && res.data.ts) ? res.data.ts : null;

        recordNotification({
          channel: "slack",
          message: payload.text || "",
          result: "sent",
          retryCount: attempt,
          latencyMs: latency,
          threadTs: ts,
        });

        return { ok: true, ts };
      }

      // Rate limited by Slack
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers && res.headers["retry-after"], 10);
        const waitMs = retryAfter ? retryAfter * 1000 : RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        logWarn(`Slack rate limited (429) — waiting ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        await sleep(waitMs);
        continue;
      }

      lastErr = new Error(`Slack webhook returned HTTP ${res.status}: ${typeof res.data === "string" ? res.data.substring(0, 200) : JSON.stringify(res.data).substring(0, 200)}`);
    } catch (err: any) {
      lastErr = err;
    }

    // Retry with backoff
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      logDebug(`Slack send failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastErr!.message} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }

  // All retries exhausted
  _consecutiveFailures++;

  recordNotification({
    channel: "slack",
    message: payload.text || "",
    result: "failed",
    retryCount: MAX_RETRIES,
    latencyMs: 0,
    error: lastErr ? lastErr.message : "Unknown error",
  });

  throw lastErr || new Error("Slack send failed after all retries");
}

// ── Fallback Chain ───────────────────────────────────────────────

/**
 * Execute the fallback chain when Slack fails:
 * 1. Jira comment (if enabled and function provided)
 * 2. Log file (always)
 * 3. State flag (always)
 */
async function executeFallbackChain(text: string, slackError: string): Promise<void> {
  const preview = text.substring(0, 100);

  // Fallback 1: Jira comment
  if (_jiraCommentFn && JIRA_COMMENTS) {
    try {
      const ticket = (cfg && cfg._currentTicket) || process.env.TICKET || "";
      if (ticket) {
        const jiraText = `[Auto-notification — Slack delivery failed]\n\n${text.substring(0, 2000)}`;
        await _jiraCommentFn(ticket, jiraText);
        logInfo(`Notification fallback: sent via Jira comment for ${ticket}`);
        recordNotification({
          channel: "jira",
          message: text,
          result: "fallback",
          fallbackTo: "jira",
        });
        return;
      }
    } catch (jiraErr: any) {
      logWarn(`Jira fallback also failed: ${jiraErr.message}`);
    }
  }

  // Fallback 2: Prominent log entry (always works)
  logErr(`NOTIFICATION FALLBACK (Slack failed: ${slackError}): ${preview}...`);
  recordNotification({
    channel: "log",
    message: text,
    result: "fallback",
    fallbackTo: "log",
    error: slackError,
  });

  // Fallback 3: State flag for UI banner
  if (_getCurrentStateFn) {
    try {
      const state = _getCurrentStateFn();
      if (state && state.data) {
        if (!state.data._notificationFailures) state.data._notificationFailures = [];
        state.data._notificationFailures.push({
          ts: new Date().toISOString(),
          preview,
          slackError,
        });
        // Cap to last 10 failures
        if (state.data._notificationFailures.length > 10) {
          state.data._notificationFailures = state.data._notificationFailures.slice(-10);
        }
        state.data._slackHealthy = false;
      }
    } catch { /* state access failed — already logged to file */ }
  }
}

// ── Batch Mode ───────────────────────────────────────────────────

/**
 * Enable batch mode: collect messages for BATCH_WINDOW_MS, then send as one.
 */
function enableBatchMode(): void {
  _batchMode = true;
}

function disableBatchMode(): void {
  _batchMode = false;
  flushBatch();
}

function flushBatch(): void {
  if (_batchTimer) {
    clearTimeout(_batchTimer);
    _batchTimer = null;
  }

  if (_batchBuffer.length === 0) return;

  const messages = _batchBuffer.splice(0);
  const combined = messages.map((m) => m.text).join("\n---\n");
  const mentions = [...new Set(messages.flatMap((m) => m.mentions || []))];

  // Send combined (non-blocking)
  _sendInternal(combined, mentions, messages[0].threadTs).catch((err: any) => {
    logWarn(`Batch flush failed: ${err.message}`);
  });
}

// ── Core Send Functions ──────────────────────────────────────────

/**
 * Internal send: builds payload, truncates, enqueues.
 */
async function _sendInternal(
  text: string,
  mentionIds: string[] = [],
  threadTs: string | null = null,
): Promise<SlackResponse> {
  if (!_webhookValid) {
    recordNotification({
      channel: "slack",
      message: text,
      result: "skipped",
      error: "Webhook not validated",
    });
    return { ok: false };
  }

  // Truncate body FIRST, then prepend mentions (so mentions are never cut off)
  const mentions = mentionIds.filter(Boolean).map((id) => `<@${id}>`).join(" ");
  const mentionPrefix = mentions ? `${mentions}\n` : "";
  // Reserve space for the mention prefix so total stays under the limit
  const bodyLimit = SLACK_MAX_TEXT_LENGTH - mentionPrefix.length;
  const truncatedBody = bodyLimit > 100 ? truncateMessage(text.substring(0, bodyLimit)) : truncateMessage(text);
  const fullText = mentionPrefix + truncatedBody;

  // Build payload
  const payload: SlackWebhookPayload = { text: fullText };
  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  return enqueuePayload(payload);
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Initialize the notification system.
 * Call once at startup. Validates webhook URL and optionally pings.
 */
async function initSlack(options: { skipPing?: boolean } = {}): Promise<{ ok: boolean; reason?: string }> {
  const webhook = cfg.slack.webhook;

  if (!webhook) {
    logInfo("Slack webhook not configured — notifications will be logged only");
    _initialized = true;
    _webhookValid = false;
    return { ok: false, reason: "Webhook not configured" };
  }

  // Validate URL format
  const validation = validateWebhookUrl(webhook);
  if (!validation.valid) {
    logErr(`Slack webhook URL invalid: ${validation.reason}`);
    _initialized = true;
    _webhookValid = false;
    return { ok: false, reason: validation.reason };
  }

  _webhookValid = true;

  // Startup ping test
  if (!options.skipPing) {
    try {
      logInfo("Testing Slack webhook connectivity...");
      const pingStart = Date.now();

      // Use a minimal message as ping — Slack webhooks don't have a "test" endpoint
      // We send a real message to confirm connectivity
      const pingResult: any = await Promise.race([
        req(webhook, {
          method: "POST",
          body: { text: ":white_check_mark: MI Dev Agent connected (startup ping)" },
        }),
        sleep(STARTUP_PING_TIMEOUT_MS).then(() => {
          throw new Error(`Slack ping timed out after ${STARTUP_PING_TIMEOUT_MS}ms`);
        }),
      ]);

      const pingLatency = Date.now() - pingStart;

      if (pingResult && pingResult.status === 200) {
        logInfo(`Slack webhook OK (${pingLatency}ms)`);
        recordNotification({
          channel: "slack",
          message: "Startup ping",
          result: "sent",
          latencyMs: pingLatency,
        });
      } else {
        const reason = `Startup ping returned HTTP ${pingResult?.status}`;
        logWarn(`Slack webhook ping failed: ${reason}`);
        _webhookValid = false;
        return { ok: false, reason };
      }
    } catch (err: any) {
      logWarn(`Slack webhook ping failed: ${err.message} — continuing without Slack`);
      _webhookValid = false;
      return { ok: false, reason: err.message };
    }
  }

  _initialized = true;

  // Mark state as healthy
  if (_getCurrentStateFn) {
    try {
      const state = _getCurrentStateFn();
      if (state && state.data) {
        state.data._slackHealthy = true;
      }
    } catch { /* swallow */ }
  }

  return { ok: true };
}

/**
 * Send a Slack notification with full resilience.
 */
async function slack(
  text: string,
  mentionIds: string[] = [],
  options: { threadTs?: string; batch?: boolean } = {},
): Promise<SlackResponse> {
  if (!cfg.slack.webhook) {
    logInfo("(Slack webhook not set -- skipping)");
    recordNotification({
      channel: "slack",
      message: text,
      result: "skipped",
      error: "No webhook configured",
    });
    return { ok: false };
  }

  // Auto-initialize if not done yet (backwards compatibility)
  if (!_initialized) {
    await initSlack({ skipPing: true });
  }

  const threadTs = options.threadTs || _defaultThreadTs;

  // Batch mode: buffer and return
  if (_batchMode && options.batch !== false) {
    _batchBuffer.push({ text, mentions: mentionIds, threadTs });
    if (!_batchTimer) {
      _batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);
    }
    recordNotification({
      channel: "slack",
      message: text,
      result: "queued",
    });
    return { ok: true, queued: true };
  }

  // Direct send with fallback
  try {
    const result = await _sendInternal(text, mentionIds, threadTs);

    // Check consecutive failure threshold
    if (_consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
      logErr(`ALERT: ${_consecutiveFailures} consecutive Slack failures — check webhook URL and network`);
    }

    return result;
  } catch (err: any) {
    logWarn(`Slack notification failed: ${err.message} — executing fallback chain`);
    await executeFallbackChain(text, err.message);

    // Check consecutive failure threshold
    if (_consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
      logErr(`ALERT: ${_consecutiveFailures} consecutive Slack failures — notifications are not reaching the team!`);
    }

    return { ok: false, error: err.message, fallbackExecuted: true };
  }
}

/**
 * Set the default thread ts for all subsequent messages.
 * Useful for creating a "notification thread" at pipeline start.
 */
function setDefaultThread(ts: string | null): void {
  _defaultThreadTs = ts;
}

/**
 * Get the current default thread ts.
 */
function getDefaultThread(): string | null {
  return _defaultThreadTs;
}

/**
 * Get the health status of the Slack integration.
 */
function getSlackHealth(): SlackHealth {
  return {
    initialized: _initialized,
    webhookValid: _webhookValid,
    consecutiveFailures: _consecutiveFailures,
    queueLength: _sendQueue.length,
    batchMode: _batchMode,
    batchBufferSize: _batchBuffer.length,
    defaultThread: _defaultThreadTs,
    healthy: _webhookValid && _consecutiveFailures < CONSECUTIVE_FAILURE_THRESHOLD,
  };
}

/**
 * Check if the Slack webhook URL has changed since initialization.
 * Call periodically (e.g., every stage) to detect env var changes.
 */
function checkWebhookChange(): boolean {
  const currentWebhook = process.env.SLACK_WEBHOOK;
  if (currentWebhook && currentWebhook !== cfg.slack.webhook) {
    logWarn("Slack webhook URL changed mid-pipeline — re-validating");
    cfg.slack.webhook = currentWebhook;
    const validation = validateWebhookUrl(currentWebhook);
    _webhookValid = validation.valid;
    if (!validation.valid) {
      logErr(`New Slack webhook URL is invalid: ${validation.reason}`);
    }
    _consecutiveFailures = 0;
    return true;
  }
  return false;
}

/**
 * Reset internal state (for testing).
 */
function _resetForTesting(): void {
  _initialized = false;
  _webhookValid = false;
  _consecutiveFailures = 0;
  _lastSendTime = 0;
  _sendQueue = [];
  _drainRunning = false;
  _batchBuffer = [];
  if (_batchTimer) clearTimeout(_batchTimer);
  _batchTimer = null;
  _batchMode = false;
  _defaultThreadTs = null;
}

module.exports = {
  slack,
  initSlack,
  validateWebhookUrl,
  truncateMessage,
  enableBatchMode,
  disableBatchMode,
  flushBatch,
  setDefaultThread,
  getDefaultThread,
  getSlackHealth,
  checkWebhookChange,
  setJiraFallback,
  setStateAccessor,
  // Testing
  _resetForTesting,
};
