import { type ErrorClassification, type RecoveryOptions, type RecoveryResult, type PipelineState, type StageName } from '@shared/types';
/**
 * Network/API error codes considered transient (retryable).
 */
export declare const TRANSIENT_CODES: ReadonlySet<string>;
/**
 * HTTP status codes that indicate transient failures.
 */
export declare const TRANSIENT_STATUS_CODES: ReadonlySet<number>;
/**
 * Patterns that indicate authentication failures.
 */
export declare const AUTH_PATTERNS: readonly RegExp[];
/**
 * Patterns that indicate timeout.
 */
export declare const TIMEOUT_PATTERNS: readonly RegExp[];
/**
 * Patterns that indicate permanent/unrecoverable errors.
 */
export declare const PERMANENT_PATTERNS: readonly RegExp[];
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
export declare function classifyError(error: Error): ErrorClassification;
/** Default retry configuration applied to all stages. */
export declare const DEFAULT_RETRY_CONFIG: Required<Omit<RecoveryOptions, 'saveState'>>;
/**
 * Per-stage retry overrides.
 * Gates are polling loops and should not be retried at this level.
 */
export declare const STAGE_RETRY_CONFIG: Readonly<Record<StageName, Partial<RecoveryOptions>>>;
/**
 * Calculate delay for a retry attempt using exponential backoff with jitter.
 *
 * delay = min(base * multiplier^attempt, maxDelay) +/- jitter%
 * Result is clamped to a minimum of 1000ms.
 */
export declare function calculateRetryDelay(attempt: number, config?: Partial<RecoveryOptions>): number;
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
export declare function executeWithRecovery(stageName: StageName, handler: (state: PipelineState) => Promise<void>, state: PipelineState, options?: RecoveryOptions): Promise<RecoveryResult>;
