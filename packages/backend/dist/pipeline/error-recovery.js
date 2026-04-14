"use strict";
// ===================================================================
// MI Dev Agent -- Stage-Level Error Recovery
// (TypeScript port of lib/error-recovery.js)
//
// Classifies errors into 4 categories:
//   TRANSIENT  -- retry with exponential backoff
//   AUTH       -- credential failure, halt immediately
//   PERMANENT  -- unrecoverable, halt immediately
//   TIMEOUT    -- retry if retries remain, otherwise halt
//
// executeWithRecovery() wraps any stage handler with automatic retry
// logic, state tracking (_retries, _lastError), and per-stage config.
// ===================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.STAGE_RETRY_CONFIG = exports.DEFAULT_RETRY_CONFIG = exports.PERMANENT_PATTERNS = exports.TIMEOUT_PATTERNS = exports.AUTH_PATTERNS = exports.TRANSIENT_STATUS_CODES = exports.TRANSIENT_CODES = void 0;
exports.classifyError = classifyError;
exports.calculateRetryDelay = calculateRetryDelay;
exports.executeWithRecovery = executeWithRecovery;
const types_1 = require("@shared/types");
const logger_1 = require("../lib/logger");
const utils_1 = require("../lib/utils");
// ── Error pattern sets ──────────────────────────────────────────────
/**
 * Network/API error codes considered transient (retryable).
 */
exports.TRANSIENT_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
    'SOCKET_TIMEOUT', 'ENOTFOUND', 'EHOSTUNREACH',
    'ECONNABORTED', 'EAI_AGAIN', 'ENETUNREACH',
]);
/**
 * HTTP status codes that indicate transient failures.
 */
exports.TRANSIENT_STATUS_CODES = new Set([
    429, 500, 502, 503, 504,
]);
/**
 * Patterns that indicate authentication failures.
 */
exports.AUTH_PATTERNS = [
    /\b401\b/,
    /\b403\b/,
    /unauthorized/i,
    /forbidden/i,
    /token.*(expired|invalid|revoked)/i,
    /authentication.*(failed|error)/i,
    /invalid.*(token|credential|api.?key)/i,
    /access.?denied/i,
];
/**
 * Patterns that indicate timeout.
 */
exports.TIMEOUT_PATTERNS = [
    /timed?\s*out/i,
    /timeout/i,
    /deadline.?exceeded/i,
    /exceeded.*duration/i,
    /took too long/i,
    /ETIMEDOUT/,
    /SOCKET_TIMEOUT/,
];
/**
 * Patterns that indicate permanent/unrecoverable errors.
 */
exports.PERMANENT_PATTERNS = [
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
 * GitLab API errors that are recoverable via branch recreation or
 * action adjustment (classified as TRANSIENT).
 */
const GL_RECOVERABLE_PATTERNS = [
    /only create or edit files when you are on a branch/i,
    /a file with this name already exists/i,
];
/**
 * Regex patterns for extracting transient network error codes from
 * the error message when the code property is not set.
 */
const TRANSIENT_IN_MESSAGE_RE = /\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET)\b/;
// ── Error classification ────────────────────────────────────────────
/**
 * Classify an error into one of the four categories.
 *
 * Priority order:
 *   1. AUTH patterns (highest -- stop immediately)
 *   2. Transient network error codes (before permanent, to avoid
 *      ENOTFOUND matching /not found/i)
 *   3. PERMANENT patterns
 *   4. TIMEOUT patterns
 *   5. HTTP status codes in message
 *   6. Claude CLI specific errors
 *   7. Default to PERMANENT (safest)
 */
function classifyError(error) {
    const msg = error.message || String(error);
    const code = error.code || '';
    // 1. Auth errors (highest priority)
    for (const pattern of exports.AUTH_PATTERNS) {
        if (pattern.test(msg) || pattern.test(code)) {
            return {
                class: types_1.ErrorClass.AUTH,
                confidence: 0.95,
                reason: `Auth pattern matched: ${pattern}`,
                retryable: false,
            };
        }
    }
    // 2. Transient network error codes -- checked BEFORE permanent to
    //    prevent ENOTFOUND from matching /not found/i
    if (exports.TRANSIENT_CODES.has(code)) {
        return {
            class: types_1.ErrorClass.TRANSIENT,
            confidence: 0.95,
            reason: `Transient error code: ${code}`,
            retryable: true,
        };
    }
    // Also check for transient codes embedded in the message string
    const transientInMsg = TRANSIENT_IN_MESSAGE_RE.exec(msg);
    if (transientInMsg) {
        return {
            class: types_1.ErrorClass.TRANSIENT,
            confidence: 0.9,
            reason: `Transient error code in message: ${transientInMsg[0]}`,
            retryable: true,
        };
    }
    // 2b. GitLab recoverable errors
    for (const pattern of GL_RECOVERABLE_PATTERNS) {
        if (pattern.test(msg)) {
            return {
                class: types_1.ErrorClass.TRANSIENT,
                confidence: 0.9,
                reason: `GL recoverable error: ${pattern}`,
                retryable: true,
            };
        }
    }
    // 3. Permanent errors
    for (const pattern of exports.PERMANENT_PATTERNS) {
        if (pattern.test(msg)) {
            return {
                class: types_1.ErrorClass.PERMANENT,
                confidence: 0.9,
                reason: `Permanent pattern matched: ${pattern}`,
                retryable: false,
            };
        }
    }
    // 4. Timeout errors
    for (const pattern of exports.TIMEOUT_PATTERNS) {
        if (pattern.test(msg) || pattern.test(code)) {
            return {
                class: types_1.ErrorClass.TIMEOUT,
                confidence: 0.9,
                reason: `Timeout pattern matched: ${pattern}`,
                retryable: true,
            };
        }
    }
    // 5. HTTP status codes embedded in the message
    const statusMatch = msg.match(/\bHTTP?\s*(\d{3})\b/i) || msg.match(/status[:\s]*(\d{3})/i);
    if (statusMatch) {
        const status = parseInt(statusMatch[1], 10);
        if (status === 401 || status === 403) {
            return { class: types_1.ErrorClass.AUTH, confidence: 0.9, reason: `HTTP ${status}`, retryable: false };
        }
        if (exports.TRANSIENT_STATUS_CODES.has(status)) {
            return { class: types_1.ErrorClass.TRANSIENT, confidence: 0.85, reason: `HTTP ${status}`, retryable: true };
        }
        if (status === 404 || status === 422) {
            return { class: types_1.ErrorClass.PERMANENT, confidence: 0.85, reason: `HTTP ${status}`, retryable: false };
        }
    }
    // 6. Claude CLI specific errors
    if (/Claude CLI/i.test(msg)) {
        if (/timed out/i.test(msg)) {
            return { class: types_1.ErrorClass.TIMEOUT, confidence: 0.95, reason: 'Claude CLI timeout', retryable: true };
        }
        if (/error \(1\)/i.test(msg) || /error \(2\)/i.test(msg)) {
            return { class: types_1.ErrorClass.TRANSIENT, confidence: 0.7, reason: 'Claude CLI non-zero exit', retryable: true };
        }
    }
    // 7. Default: treat as permanent (safest -- prevents infinite retry loops)
    return {
        class: types_1.ErrorClass.PERMANENT,
        confidence: 0.5,
        reason: 'No matching pattern -- defaulting to PERMANENT',
        retryable: false,
    };
}
// ── Retry configuration ─────────────────────────────────────────────
/** Default retry configuration applied to all stages. */
exports.DEFAULT_RETRY_CONFIG = {
    maxRetries: 3,
    baseDelayMs: 5_000, // 5 seconds
    maxDelayMs: 120_000, // 2 minutes
    backoffMultiplier: 2,
    jitterFraction: 0.2, // +/- 20% jitter
};
/**
 * Per-stage retry overrides.
 * Gates are polling loops and should not be retried at this level.
 */
exports.STAGE_RETRY_CONFIG = {
    fetch_ticket: { maxRetries: 3, baseDelayMs: 5_000 },
    explore_plan: { maxRetries: 2, baseDelayMs: 10_000 },
    generate_code: { maxRetries: 2, baseDelayMs: 15_000 },
    gate_code_review: { maxRetries: 0 },
    deploy_qa: { maxRetries: 3, baseDelayMs: 10_000 },
    test_qa: { maxRetries: 2, baseDelayMs: 10_000 },
    gate_preprod_approval: { maxRetries: 0 },
    create_preprod_mr: { maxRetries: 3, baseDelayMs: 5_000 },
    gate_dual_approval: { maxRetries: 0 },
    deploy_prod: { maxRetries: 2, baseDelayMs: 10_000 },
    done: { maxRetries: 0 },
};
// ── Backoff calculation ─────────────────────────────────────────────
/**
 * Calculate delay for a retry attempt using exponential backoff with jitter.
 *
 * delay = min(base * multiplier^attempt, maxDelay) +/- jitter%
 * Result is clamped to a minimum of 1000ms.
 */
function calculateRetryDelay(attempt, config) {
    const cfg = { ...exports.DEFAULT_RETRY_CONFIG, ...config };
    const exponentialDelay = cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt);
    const clampedDelay = Math.min(exponentialDelay, cfg.maxDelayMs);
    // Jitter: random value between -jitter% and +jitter%
    const jitter = clampedDelay * cfg.jitterFraction * (Math.random() * 2 - 1);
    return Math.max(1000, Math.round(clampedDelay + jitter));
}
// ── Core: Execute with recovery ─────────────────────────────────────
/**
 * Execute a stage handler with automatic error recovery.
 *
 * Wraps the handler with retry logic based on error classification:
 * - TRANSIENT / TIMEOUT: retry with exponential backoff
 * - AUTH / PERMANENT: halt immediately (no retry)
 *
 * State tracking:
 * - `state.data._retries[stageName]` -- retry counter (reset to 0 on success)
 * - `state.data._lastError` -- last error details for diagnostics
 * - `state.data._warnings` -- accumulated warnings
 *
 * @param stageName - Name of the pipeline stage
 * @param handler - Async stage handler: (state) => Promise<void>
 * @param state - Current pipeline state
 * @param options - Override retry config, provide saveState callback
 * @returns RecoveryResult indicating success/failure, retries, classification
 */
async function executeWithRecovery(stageName, handler, state, options = {}) {
    const merged = {
        ...exports.DEFAULT_RETRY_CONFIG,
        ...exports.STAGE_RETRY_CONFIG[stageName],
        ...options,
    };
    const maxRetries = merged.maxRetries ?? exports.DEFAULT_RETRY_CONFIG.maxRetries;
    const saveState = options.saveState || null;
    const retryHistory = [];
    let lastError;
    let lastClassification;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                (0, logger_1.logInfo)(`[Recovery] Retry ${attempt}/${maxRetries} for stage "${stageName}"`);
                // Record retry in state
                if (!state.data._retries)
                    state.data._retries = {};
                state.data._retries[stageName] = (state.data._retries[stageName] || 0) + 1;
                // Persist state between retries so retry counter survives crashes
                if (saveState) {
                    try {
                        saveState(state);
                    }
                    catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        (0, logger_1.logWarn)(`[Recovery] Failed to save state between retries: ${msg}`);
                    }
                }
            }
            await handler(state);
            // Success -- reset retry counter so budget is not "used up" across runs
            if (state.data._retries?.[stageName]) {
                state.data._retries[stageName] = 0;
            }
            if (attempt > 0) {
                (0, logger_1.logInfo)(`[Recovery] Stage "${stageName}" succeeded on retry ${attempt}`);
            }
            return {
                success: true,
                retries: attempt,
                retryHistory,
            };
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            lastError = err;
            lastClassification = classifyError(err);
            retryHistory.push({
                attempt,
                timestamp: new Date().toISOString(),
                error: err.message,
                classification: lastClassification,
            });
            (0, logger_1.logWarn)(`[Recovery] Stage "${stageName}" attempt ${attempt} failed: ` +
                `[${lastClassification.class}] ${err.message}`);
            (0, logger_1.logDebug)(`[Recovery] Classification: ${JSON.stringify(lastClassification)}`);
            // Store error details in state
            state.data._lastError = {
                stage: stageName,
                message: err.message,
                timestamp: new Date().toISOString(),
                stack: err.stack,
                classification: lastClassification.class,
                attempt,
            };
            (0, utils_1.addWarning)(state, stageName, `[${lastClassification.class}] ${err.message} (attempt ${attempt + 1})`);
            // Decision based on classification
            switch (lastClassification.class) {
                case types_1.ErrorClass.PERMANENT:
                    (0, logger_1.logErr)(`[Recovery] Permanent error in "${stageName}" -- not retrying`);
                    return {
                        success: false,
                        error: lastError,
                        classification: lastClassification,
                        retries: attempt,
                        retryHistory,
                        action: 'HALT',
                    };
                case types_1.ErrorClass.AUTH:
                    (0, logger_1.logErr)(`[Recovery] Auth error in "${stageName}" -- credentials may be invalid`);
                    return {
                        success: false,
                        error: lastError,
                        classification: lastClassification,
                        retries: attempt,
                        retryHistory,
                        action: 'AUTH_FAILED',
                    };
                case types_1.ErrorClass.TIMEOUT:
                    if (attempt < maxRetries) {
                        const delay = calculateRetryDelay(attempt, merged);
                        (0, logger_1.logInfo)(`[Recovery] Timeout in "${stageName}" -- retrying in ${(delay / 1000).toFixed(1)}s`);
                        await (0, utils_1.sleep)(delay);
                        continue;
                    }
                    return {
                        success: false,
                        error: lastError,
                        classification: lastClassification,
                        retries: attempt,
                        retryHistory,
                        action: 'TIMEOUT_EXHAUSTED',
                    };
                case types_1.ErrorClass.TRANSIENT:
                    if (attempt < maxRetries) {
                        const delay = calculateRetryDelay(attempt, merged);
                        (0, logger_1.logInfo)(`[Recovery] Transient error in "${stageName}" -- retrying in ${(delay / 1000).toFixed(1)}s`);
                        await (0, utils_1.sleep)(delay);
                        continue;
                    }
                    return {
                        success: false,
                        error: lastError,
                        classification: lastClassification,
                        retries: attempt,
                        retryHistory,
                        action: 'RETRIES_EXHAUSTED',
                    };
                default:
                    return {
                        success: false,
                        error: lastError,
                        classification: lastClassification,
                        retries: attempt,
                        retryHistory,
                        action: 'HALT',
                    };
            }
        }
    }
    // Safety net -- should not reach here under normal execution
    return {
        success: false,
        error: lastError,
        classification: lastClassification,
        retries: maxRetries,
        retryHistory,
        action: 'RETRIES_EXHAUSTED',
    };
}
//# sourceMappingURL=error-recovery.js.map