import type { StageName, StageHandler, TimedStageHandler, PipelineBudget } from '@shared/types';
export declare const DEFAULT_STAGE_TIMEOUTS: Readonly<Record<StageName, number>>;
/**
 * Get the timeout for a stage, checking env var override first.
 *
 * Env var format: STAGE_TIMEOUT_FETCH_TICKET=600000 (milliseconds)
 * Falls back to DEFAULT_STAGE_TIMEOUTS, then 30 minutes.
 */
export declare function getStageTimeout(stageName: StageName): number;
/**
 * Format a millisecond duration into a human-readable string.
 *
 * Examples: "2.5h", "15.0m", "3.2s"
 */
export declare function formatTimeout(ms: number): string;
/**
 * Custom error thrown when a stage exceeds its timeout.
 * Classified as TIMEOUT by the error-recovery module.
 */
export declare class StageTimeoutError extends Error {
    readonly stageName: StageName;
    readonly timeoutMs: number;
    readonly elapsedMs: number;
    readonly code: "STAGE_TIMEOUT";
    constructor(stageName: StageName, timeoutMs: number, elapsedMs?: number);
}
export interface StageTimeoutOptions {
    /** Override the default/env stage timeout (ms) */
    timeoutMs?: number;
    /** Override the max pipeline duration (ms) */
    maxPipelineDuration?: number;
    /** Progress log interval (ms). Default: 5 minutes. Set 0 to disable. */
    progressIntervalMs?: number;
}
/**
 * Wrap a stage handler with a per-stage timeout.
 *
 * Returns a new async function that:
 * 1. Determines the effective timeout (min of stage timeout and remaining
 *    pipeline budget)
 * 2. Starts a timer that rejects with StageTimeoutError on expiry
 * 3. Logs progress every 5 minutes for long-running stages
 * 4. Stores timeout metadata in `state.data._stage_timeout`
 *
 * The returned handler has the same signature as the original (PipelineState => void)
 * so it can be dropped in as a replacement.
 *
 * @param stageName - Pipeline stage name (used for timeout lookup and error messages)
 * @param handler - The async stage handler to wrap
 * @param opts - Optional overrides
 * @returns A new handler with timeout enforcement
 */
export declare function withStageTimeout(stageName: StageName, handler: StageHandler, opts?: StageTimeoutOptions): TimedStageHandler;
/**
 * Check if remaining pipeline time is sufficient for a stage.
 *
 * Useful for pre-flight checks before entering a stage -- if the
 * pipeline is nearly out of time, the caller can decide to skip
 * or abort gracefully.
 *
 * @param stageName - Stage to check budget for
 * @param pipelineStart - Timestamp (ms) when the pipeline started
 * @returns Budget info including whether there is enough time
 */
export declare function checkPipelineBudget(stageName: StageName, pipelineStart?: number): PipelineBudget;
