import type { PipelineBudget } from '@mi/shared';
declare const DEFAULT_STAGE_TIMEOUTS: Record<string, number>;
/**
 * Get the timeout for a stage, checking env var override first.
 * Env var format: STAGE_TIMEOUT_FETCH_TICKET=600000
 */
declare function getStageTimeout(stageName: string): number;
/**
 * Get human-readable timeout string
 */
declare function formatTimeout(ms: number): string;
/**
 * Custom timeout error class for differentiation
 */
declare class StageTimeoutError extends Error {
    stageName: string;
    timeoutMs: number;
    elapsedMs: number;
    code: string;
    constructor(stageName: string, timeoutMs: number, elapsedMs?: number);
}
/**
 * Wrap a stage handler with a timeout.
 *
 * Returns a new function that runs the handler with a per-stage timeout.
 * On timeout, throws StageTimeoutError (classified as TIMEOUT by error-recovery).
 */
declare function withStageTimeout(stageName: string, handler: (state: any) => Promise<void>, _options?: any): (state: any) => Promise<void>;
/**
 * Check if remaining pipeline time is sufficient for a stage.
 */
declare function checkPipelineBudget(stageName: string, pipelineStart: number): PipelineBudget;
export { DEFAULT_STAGE_TIMEOUTS, getStageTimeout, formatTimeout, StageTimeoutError, withStageTimeout, checkPipelineBudget, };
//# sourceMappingURL=stage-timeout.d.ts.map