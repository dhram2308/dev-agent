"use strict";
/**
 * error-recovery.ts -- Stage-Level Error Recovery
 *
 * Converted from lib/error-recovery.js (zero functional changes).
 * Uses shared types from @mi/shared for ErrorClass, RecoveryAction, etc.
 *
 * Solves problems #3, #11, #12:
 * - Classifies errors: TRANSIENT, AUTH, PERMANENT, TIMEOUT
 * - Auto-retry with exponential backoff for transient errors
 * - Auth re-validation on auth errors
 * - Saves state and notifies on permanent errors (no process.exit)
 * - Timeout extension if under pipeline max
 */
Object.defineProperty(exports, "__esModule", { value: true });
const { logInfo, logWarn, logErr, logDebug } = require('./logging');
const { addWarning } = require('./utils');
// ── Error classification ────────────────────────────────────────────
const ERROR_CLASS = {
    TRANSIENT: "TRANSIENT",
    AUTH: "AUTH",
    PERMANENT: "PERMANENT",
    TIMEOUT: "TIMEOUT",
};
/**
 * Network/API error codes that are transient
 */
const TRANSIENT_CODES = new Set([
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE",
    "SOCKET_TIMEOUT", "ENOTFOUND", "EHOSTUNREACH",
    "ECONNABORTED", "EAI_AGAIN", "ENETUNREACH",
]);
/**
 * HTTP status codes that indicate transient failures
 */
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
/**
 * Patterns that indicate authentication failures
 */
const AUTH_PATTERNS = [
    /\b401\b/,
    /\b403\b/,
    /unauthorized/i,
    /forbidden/i,
    /token.*(expired|invalid|revoked)/i,
    /authentication.*(failed|error)/i,
    /invalid.*(token|credential|api.?key)/i,
    /access.?denied/i,
    // Gap G: Claude-specific auth/org-permission errors observed in
    // AUT-8648 — 3 consecutive Architect runs at 09:48–09:49 all printed
    // "Your organization does not have access to Claude. Please login
    // again or contact your administrator." (exit 1, 100 chars stdout).
    // Pipeline retried indefinitely until the auth outage resolved ~3h
    // later. These patterns ensure such errors classify as AUTH (not
    // TRANSIENT) and halt fast for operator intervention.
    /does not have access to claude/i,
    /please login again/i,
    /contact your administrator/i,
    /your organization does not have access/i,
];
/**
 * Patterns that indicate timeout
 */
const TIMEOUT_PATTERNS = [
    /timed?\s*out/i,
    /timeout/i,
    /deadline.?exceeded/i,
    /exceeded.*duration/i,
    /took too long/i,
    /ETIMEDOUT/,
    /SOCKET_TIMEOUT/,
];
/**
 * Patterns that indicate permanent/unrecoverable errors
 */
const PERMANENT_PATTERNS = [
    /not found/i,
    /does not exist/i,
    /cannot be merged/i,
    /merge conflict/i,
    /pipeline.*failed/i,
    /halting pipeline/i,
    /MAX_REJECTIONS.*reached/i,
    /stage skip detected/i,
    /disk full/i,
    /ENOSPC/,
    /out of memory/i,
    /ENOMEM/,
    /permission denied/i,
    /EACCES/,
    /refused.*request/i,
];
/**
 * Classify an error into one of the four categories.
 */
function classifyError(error) {
    const msg = error.message || String(error);
    const code = error.code || "";
    // 1. Check for auth errors (highest priority)
    for (const pattern of AUTH_PATTERNS) {
        if (pattern.test(msg) || pattern.test(code)) {
            return {
                class: ERROR_CLASS.AUTH,
                confidence: 0.95,
                reason: `Auth pattern matched: ${pattern}`,
                retryable: false,
            };
        }
    }
    // 2. Check for transient network error codes BEFORE permanent patterns
    if (TRANSIENT_CODES.has(code)) {
        return {
            class: ERROR_CLASS.TRANSIENT,
            confidence: 0.95,
            reason: `Transient error code: ${code}`,
            retryable: true,
        };
    }
    // Also check for ENOTFOUND/ECONNREFUSED in message (when code is not set)
    if (/\bENOTFOUND\b/.test(msg) || /\bECONNREFUSED\b/.test(msg) || /\bETIMEDOUT\b/.test(msg) || /\bECONNRESET\b/.test(msg)) {
        const matchResult = msg.match(/\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET)\b/);
        return {
            class: ERROR_CLASS.TRANSIENT,
            confidence: 0.9,
            reason: `Transient error code in message: ${matchResult ? matchResult[0] : 'unknown'}`,
            retryable: true,
        };
    }
    // 2b. GitLab API errors that are recoverable via branch recreation or action adjustment
    const GL_RECOVERABLE = [
        /only create or edit files when you are on a branch/i,
        /a file with this name already exists/i,
    ];
    for (const pattern of GL_RECOVERABLE) {
        if (pattern.test(msg)) {
            return {
                class: ERROR_CLASS.TRANSIENT,
                confidence: 0.9,
                reason: `GL recoverable error: ${pattern}`,
                retryable: true,
            };
        }
    }
    // 3. Check for permanent errors
    for (const pattern of PERMANENT_PATTERNS) {
        if (pattern.test(msg)) {
            return {
                class: ERROR_CLASS.PERMANENT,
                confidence: 0.9,
                reason: `Permanent pattern matched: ${pattern}`,
                retryable: false,
            };
        }
    }
    // 4. Check for timeout errors
    for (const pattern of TIMEOUT_PATTERNS) {
        if (pattern.test(msg) || pattern.test(code)) {
            return {
                class: ERROR_CLASS.TIMEOUT,
                confidence: 0.9,
                reason: `Timeout pattern matched: ${pattern}`,
                retryable: true,
            };
        }
    }
    // 5. Check for HTTP status codes in message
    const statusMatch = msg.match(/\bHTTP?\s*(\d{3})\b/i) || msg.match(/status[:\s]*(\d{3})/i);
    if (statusMatch) {
        const status = parseInt(statusMatch[1], 10);
        if (status === 401 || status === 403) {
            return { class: ERROR_CLASS.AUTH, confidence: 0.9, reason: `HTTP ${status}`, retryable: false };
        }
        if (TRANSIENT_STATUS_CODES.has(status)) {
            return { class: ERROR_CLASS.TRANSIENT, confidence: 0.85, reason: `HTTP ${status}`, retryable: true };
        }
        if (status === 404 || status === 422) {
            return { class: ERROR_CLASS.PERMANENT, confidence: 0.85, reason: `HTTP ${status}`, retryable: false };
        }
    }
    // 6. Claude CLI specific errors
    if (/Claude CLI/i.test(msg)) {
        if (/timed out/i.test(msg)) {
            return { class: ERROR_CLASS.TIMEOUT, confidence: 0.95, reason: "Claude CLI timeout", retryable: true };
        }
        if (/error \(1\)/i.test(msg) || /error \(2\)/i.test(msg)) {
            return { class: ERROR_CLASS.TRANSIENT, confidence: 0.7, reason: "Claude CLI non-zero exit", retryable: true };
        }
    }
    // 7. Default: treat as permanent (safest)
    return {
        class: ERROR_CLASS.PERMANENT,
        confidence: 0.5,
        reason: "No matching pattern — defaulting to PERMANENT",
        retryable: false,
    };
}
// ── Retry with exponential backoff ──────────────────────────────────
/**
 * Configuration for stage retry behavior
 */
const DEFAULT_RETRY_CONFIG = {
    maxRetries: 3,
    baseDelayMs: 5_000, // 5s
    maxDelayMs: 120_000, // 2 min
    backoffMultiplier: 2,
    jitterFraction: 0.2, // +/- 20% jitter
};
/**
 * Per-stage retry overrides
 */
const STAGE_RETRY_CONFIG = {
    fetch_ticket: { maxRetries: 3, baseDelayMs: 5_000 },
    explore_plan: { maxRetries: 2, baseDelayMs: 10_000 },
    generate_code: { maxRetries: 2, baseDelayMs: 15_000 },
    gate_code_review: { maxRetries: 0 }, // Gates are polling loops, no retry
    deploy_qa: { maxRetries: 3, baseDelayMs: 10_000 },
    test_qa: { maxRetries: 2, baseDelayMs: 10_000 },
    gate_preprod_approval: { maxRetries: 0 },
    create_preprod_mr: { maxRetries: 3, baseDelayMs: 5_000 },
    gate_dual_approval: { maxRetries: 0 },
    deploy_prod: { maxRetries: 2, baseDelayMs: 10_000 },
    done: { maxRetries: 0 },
};
/**
 * Calculate delay for retry attempt with exponential backoff + jitter
 */
function calculateRetryDelay(attempt, config) {
    const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
    const exponentialDelay = cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt);
    const clampedDelay = Math.min(exponentialDelay, cfg.maxDelayMs);
    // Add jitter: random between -jitter% and +jitter%
    const jitter = clampedDelay * cfg.jitterFraction * (Math.random() * 2 - 1);
    return Math.max(1000, Math.round(clampedDelay + jitter));
}
/**
 * Execute a stage handler with error recovery.
 */
async function executeWithRecovery(stageName, handler, state, options = {}) {
    const stageConfig = { ...DEFAULT_RETRY_CONFIG, ...STAGE_RETRY_CONFIG[stageName], ...options };
    const saveState = options.saveState || null;
    const retryHistory = [];
    let lastError;
    let lastClassification = null;
    for (let attempt = 0; attempt <= stageConfig.maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                logInfo(`[Recovery] Retry ${attempt}/${stageConfig.maxRetries} for stage "${stageName}"`);
                // Record retry in state
                state.data._retries = state.data._retries || {};
                state.data._retries[stageName] = (state.data._retries[stageName] || 0) + 1;
                // Persist state between retries so retry counter survives crashes
                if (saveState) {
                    try {
                        saveState(state);
                    }
                    catch (e) {
                        logWarn(`[Recovery] Failed to save state between retries: ${e.message}`);
                    }
                }
            }
            await handler(state);
            // T2.15b: Success — reset retry counter to 0 so budget is not "used up" across runs
            if (state.data._retries && state.data._retries[stageName]) {
                state.data._retries[stageName] = 0;
            }
            if (attempt > 0) {
                logInfo(`[Recovery] Stage "${stageName}" succeeded on retry ${attempt}`);
            }
            return {
                success: true,
                retries: attempt,
                retryHistory,
            };
        }
        catch (error) {
            lastError = error;
            lastClassification = classifyError(error);
            retryHistory.push({
                attempt,
                timestamp: new Date().toISOString(),
                error: error.message,
                classification: lastClassification,
            });
            logWarn(`[Recovery] Stage "${stageName}" attempt ${attempt} failed: [${lastClassification.class}] ${error.message}`);
            logDebug(`[Recovery] Classification: ${JSON.stringify(lastClassification)}`);
            // Store error details in state
            state.data._lastError = {
                stage: stageName,
                message: error.message,
                timestamp: new Date().toISOString(),
                stack: error.stack,
                classification: lastClassification.class,
                attempt,
            };
            addWarning(state, stageName, `[${lastClassification.class}] ${error.message} (attempt ${attempt + 1})`);
            // Decision based on classification
            switch (lastClassification.class) {
                case ERROR_CLASS.PERMANENT:
                    logErr(`[Recovery] Permanent error in "${stageName}" — not retrying`);
                    return {
                        success: false,
                        error: lastError,
                        classification: lastClassification,
                        retries: attempt,
                        retryHistory,
                        action: "HALT",
                    };
                case ERROR_CLASS.AUTH:
                    logErr(`[Recovery] Auth error in "${stageName}" — credentials may be invalid`);
                    return {
                        success: false,
                        error: lastError,
                        classification: lastClassification,
                        retries: attempt,
                        retryHistory,
                        action: "AUTH_FAILED",
                    };
                case ERROR_CLASS.TIMEOUT:
                    if (attempt < stageConfig.maxRetries) {
                        const delay = calculateRetryDelay(attempt, stageConfig);
                        logInfo(`[Recovery] Timeout in "${stageName}" — retrying in ${(delay / 1000).toFixed(1)}s`);
                        await _sleep(delay);
                        continue;
                    }
                    return {
                        success: false,
                        error: lastError,
                        classification: lastClassification,
                        retries: attempt,
                        retryHistory,
                        action: "TIMEOUT_EXHAUSTED",
                    };
                case ERROR_CLASS.TRANSIENT:
                    if (attempt < stageConfig.maxRetries) {
                        const delay = calculateRetryDelay(attempt, stageConfig);
                        logInfo(`[Recovery] Transient error in "${stageName}" — retrying in ${(delay / 1000).toFixed(1)}s`);
                        await _sleep(delay);
                        continue;
                    }
                    return {
                        success: false,
                        error: lastError,
                        classification: lastClassification,
                        retries: attempt,
                        retryHistory,
                        action: "RETRIES_EXHAUSTED",
                    };
                default:
                    return {
                        success: false,
                        error: lastError,
                        classification: lastClassification,
                        retries: attempt,
                        retryHistory,
                        action: "HALT",
                    };
            }
        }
    }
    // Should not reach here, but safety net
    return {
        success: false,
        error: lastError,
        classification: lastClassification,
        retries: stageConfig.maxRetries,
        retryHistory,
        action: "RETRIES_EXHAUSTED",
    };
}
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
module.exports = {
    ERROR_CLASS,
    classifyError,
    calculateRetryDelay,
    executeWithRecovery,
    DEFAULT_RETRY_CONFIG,
    STAGE_RETRY_CONFIG,
    TRANSIENT_CODES,
    AUTH_PATTERNS,
    TIMEOUT_PATTERNS,
    PERMANENT_PATTERNS,
};
//# sourceMappingURL=error-recovery.js.map