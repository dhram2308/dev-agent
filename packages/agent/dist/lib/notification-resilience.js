"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const { logInfo, logWarn, logErr, logDebug } = require('./logging');
const SLACK_MAX_LENGTH = 4000; // Slack message limit
const SLACK_RETRY_DELAY_MS = 3000; // 3s before retry
const NOTIFICATION_LOG_FILE = "notification-failures.log";
// Rate limiting: max 20 messages per minute
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const _messageTimes = [];
// ── Message truncation ──────────────────────────────────────────────
function truncateSlackMessage(text) {
    if (!text || text.length <= SLACK_MAX_LENGTH)
        return text;
    const truncated = text.substring(0, SLACK_MAX_LENGTH - 100);
    const lastNewline = truncated.lastIndexOf("\n");
    const cutPoint = lastNewline > SLACK_MAX_LENGTH * 0.5 ? lastNewline : truncated.length;
    return truncated.substring(0, cutPoint) + `\n\n_[...truncated — ${text.length} chars total]_`;
}
// ── Rate limiting ───────────────────────────────────────────────────
function checkRateLimit() {
    const now = Date.now();
    // Remove expired entries
    while (_messageTimes.length > 0 && _messageTimes[0] < now - RATE_LIMIT_WINDOW_MS) {
        _messageTimes.shift();
    }
    if (_messageTimes.length >= RATE_LIMIT_MAX) {
        return false; // Rate limited
    }
    _messageTimes.push(now);
    return true;
}
// ── Failure logging ─────────────────────────────────────────────────
function logNotificationFailure(channel, message, error, baseDir) {
    const logPath = path_1.default.join(baseDir || path_1.default.join(__dirname, ".."), NOTIFICATION_LOG_FILE);
    const entry = {
        timestamp: new Date().toISOString(),
        channel,
        message: message.substring(0, 500),
        error: error.message || String(error),
        pid: process.pid,
    };
    try {
        fs_1.default.appendFileSync(logPath, JSON.stringify(entry) + "\n");
    }
    catch (e) {
        // Last resort: stderr
        console.error(`[NOTIFICATION FAILURE] Cannot even log failure: ${e.message}`);
        console.error(`[NOTIFICATION FAILURE] Original: channel=${channel}, error=${error.message}`);
    }
}
// ── Record failure in state ─────────────────────────────────────────
function recordNotificationFailure(state, channel, message, error) {
    if (!state || !state.data)
        return;
    if (!state.data._notification_failures) {
        state.data._notification_failures = [];
    }
    state.data._notification_failures.push({
        timestamp: new Date().toISOString(),
        channel,
        message: message.substring(0, 200),
        error: error.message || String(error),
    });
    // Keep only last 50 failures
    if (state.data._notification_failures.length > 50) {
        state.data._notification_failures = state.data._notification_failures.slice(-50);
    }
}
/**
 * Send a Slack notification with full resilience.
 */
async function sendSlackResilient(httpReq, webhookUrl, text, mentionIds = [], options = {}) {
    const { state, jiraFallback, ticket, baseDir } = options;
    if (!webhookUrl) {
        logDebug("(Slack webhook not set - skipping notification)");
        return { sent: false, reason: "no_webhook" };
    }
    // Rate limit check
    if (!checkRateLimit()) {
        logWarn("[Notify] Slack rate limit reached (20/min) - queuing message");
        // Still log the failure but don't retry
        logNotificationFailure("slack", text, new Error("Rate limited"), baseDir);
        if (state)
            recordNotificationFailure(state, "slack", text, new Error("Rate limited"));
        return { sent: false, reason: "rate_limited" };
    }
    // Truncate message
    const truncatedText = truncateSlackMessage(text);
    const mentions = (mentionIds || []).filter(Boolean).map((id) => `<@${id}>`).join(" ");
    const payload = {
        text: mentions ? `${mentions}\n${truncatedText}` : truncatedText,
    };
    // Attempt 1
    try {
        const r = await httpReq(webhookUrl, { method: "POST", body: payload });
        if (r.status >= 200 && r.status < 300) {
            return { sent: true, attempt: 1 };
        }
        throw new Error(`Slack webhook returned HTTP ${r.status}`);
    }
    catch (firstError) {
        logWarn(`[Notify] Slack attempt 1 failed: ${firstError.message}`);
        // Attempt 2 (retry after delay)
        await _sleep(SLACK_RETRY_DELAY_MS);
        try {
            const r = await httpReq(webhookUrl, { method: "POST", body: payload });
            if (r.status >= 200 && r.status < 300) {
                logInfo("[Notify] Slack succeeded on retry");
                return { sent: true, attempt: 2 };
            }
            throw new Error(`Slack webhook returned HTTP ${r.status} on retry`);
        }
        catch (secondError) {
            logErr(`[Notify] Slack failed after retry: ${secondError.message}`);
            // Log to dedicated failure log
            logNotificationFailure("slack", text, secondError, baseDir);
            // Record in state for UI
            if (state) {
                recordNotificationFailure(state, "slack", text, secondError);
            }
            // Jira fallback
            if (jiraFallback && ticket) {
                try {
                    logInfo(`[Notify] Attempting Jira comment fallback for ${ticket}`);
                    const jiraText = `[Slack notification failed]\n\n${truncatedText.substring(0, 5000)}`;
                    await jiraFallback.addComment(ticket, jiraText);
                    logInfo("[Notify] Jira fallback comment posted successfully");
                    return { sent: false, fallback: "jira", reason: secondError.message };
                }
                catch (jiraError) {
                    logErr(`[Notify] Jira fallback also failed: ${jiraError.message}`);
                    logNotificationFailure("jira_fallback", text, jiraError, baseDir);
                    if (state) {
                        recordNotificationFailure(state, "jira_fallback", text, jiraError);
                    }
                }
            }
            return { sent: false, reason: secondError.message };
        }
    }
}
/**
 * Create a resilient slack() function that wraps the raw sender.
 * Drop-in replacement for the existing slack() in lib/slack.js.
 */
function createResilientNotifier(httpReq, cfgParam, state, jiraModule = null) {
    return async function resilientSlack(text, mentionIds = []) {
        return sendSlackResilient(httpReq, cfgParam.slack.webhook, text, mentionIds, {
            state,
            jiraFallback: jiraModule,
            ticket: state && state.ticket,
        });
    };
}
/**
 * Get notification failure summary for UI display.
 */
function getNotificationFailureSummary(state) {
    if (!state || !state.data || !state.data._notification_failures) {
        return { count: 0 };
    }
    const failures = state.data._notification_failures;
    return {
        count: failures.length,
        recent: failures.slice(-5),
        oldestTs: failures.length > 0 ? failures[0].timestamp : null,
        newestTs: failures.length > 0 ? failures[failures.length - 1].timestamp : null,
    };
}
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
module.exports = {
    SLACK_MAX_LENGTH,
    truncateSlackMessage,
    checkRateLimit,
    logNotificationFailure,
    recordNotificationFailure,
    sendSlackResilient,
    createResilientNotifier,
    getNotificationFailureSummary,
};
//# sourceMappingURL=notification-resilience.js.map