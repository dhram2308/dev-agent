// ===================================================================
// MI Dev Agent -- Per-Stage Timeout System
// (TypeScript port of lib/stage-timeout.js)
//
// Features:
//   - Default timeouts per stage type (configurable via env vars)
//   - Wraps stage handlers with AbortSignal-based timeout
//   - Pipeline-level budget tracking (total elapsed vs MAX_PIPELINE_DURATION)
//   - Progress logging every 5 minutes for long-running stages
//   - StageTimeoutError for clean classification by error-recovery
//
// The timeout wrapper respects the pipeline budget: if remaining
// pipeline time is less than the stage timeout, the shorter value
// is used. If no time remains at all, throws immediately.
// ===================================================================

import type {
  StageName,
  PipelineState,
  StageHandler,
  TimedStageHandler,
  PipelineBudget,
} from '@shared/types';
import { MAX_PIPELINE_DURATION_DEFAULT } from '@shared/constants';
import { logInfo } from '../lib/logger';

// ── Default timeouts per stage (milliseconds) ───────────────────────

export const DEFAULT_STAGE_TIMEOUTS: Readonly<Record<StageName, number>> = {
  fetch_ticket:          5 * 60 * 1000,       //  5 minutes
  explore_plan:          30 * 60 * 1000,      // 30 minutes
  generate_code:         60 * 60 * 1000,      // 60 minutes
  gate_code_review:      8 * 60 * 60 * 1000,  //  8 hours (approval wait)
  deploy_qa:             30 * 60 * 1000,      // 30 minutes
  test_qa:               10 * 60 * 1000,      // 10 minutes
  gate_preprod_approval: 8 * 60 * 60 * 1000,  //  8 hours
  create_preprod_mr:     30 * 60 * 1000,      // 30 minutes
  gate_dual_approval:    8 * 60 * 60 * 1000,  //  8 hours
  deploy_prod:           30 * 60 * 1000,      // 30 minutes
  done:                  60 * 1000,           //  1 minute
};

// ── Timeout helpers ─────────────────────────────────────────────────

/**
 * Get the timeout for a stage, checking env var override first.
 *
 * Env var format: STAGE_TIMEOUT_FETCH_TICKET=600000 (milliseconds)
 * Falls back to DEFAULT_STAGE_TIMEOUTS, then 30 minutes.
 */
export function getStageTimeout(stageName: StageName): number {
  const envKey = `STAGE_TIMEOUT_${stageName.toUpperCase()}`;
  const envVal = parseInt(process.env[envKey] || '', 10);
  if (!isNaN(envVal) && envVal > 0) {
    return envVal;
  }
  return DEFAULT_STAGE_TIMEOUTS[stageName] || 30 * 60 * 1000;
}

/**
 * Format a millisecond duration into a human-readable string.
 *
 * Examples: "2.5h", "15.0m", "3.2s"
 */
export function formatTimeout(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── StageTimeoutError ───────────────────────────────────────────────

/**
 * Custom error thrown when a stage exceeds its timeout.
 * Classified as TIMEOUT by the error-recovery module.
 */
export class StageTimeoutError extends Error {
  public readonly stageName: StageName;
  public readonly timeoutMs: number;
  public readonly elapsedMs: number;
  public readonly code = 'STAGE_TIMEOUT' as const;

  constructor(stageName: StageName, timeoutMs: number, elapsedMs?: number) {
    super(
      `Stage "${stageName}" timed out after ${formatTimeout(elapsedMs || timeoutMs)} ` +
      `(limit: ${formatTimeout(timeoutMs)})`,
    );
    this.name = 'StageTimeoutError';
    this.stageName = stageName;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs || timeoutMs;
  }
}

// ── Options for withStageTimeout ────────────────────────────────────

export interface StageTimeoutOptions {
  /** Override the default/env stage timeout (ms) */
  timeoutMs?: number;
  /** Override the max pipeline duration (ms) */
  maxPipelineDuration?: number;
  /** Progress log interval (ms). Default: 5 minutes. Set 0 to disable. */
  progressIntervalMs?: number;
}

// ── Core: withStageTimeout ──────────────────────────────────────────

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
export function withStageTimeout(
  stageName: StageName,
  handler: StageHandler,
  opts: StageTimeoutOptions = {},
): TimedStageHandler {
  return async function timedHandler(state: PipelineState): Promise<void> {
    const stageTimeout = opts.timeoutMs ?? getStageTimeout(stageName);
    const pipelineStart = state.data._pipeline_start || Date.now();
    const maxPipelineDuration =
      opts.maxPipelineDuration ??
      (parseInt(process.env.MAX_PIPELINE_DURATION || '', 10) || MAX_PIPELINE_DURATION_DEFAULT);
    const pipelineElapsed = Date.now() - pipelineStart;
    const pipelineRemaining = Math.max(0, maxPipelineDuration - pipelineElapsed);

    // Use the shorter of stage timeout and remaining pipeline time
    const effectiveTimeout = Math.min(stageTimeout, pipelineRemaining);

    if (effectiveTimeout <= 0) {
      throw new StageTimeoutError(stageName, stageTimeout, pipelineElapsed);
    }

    logInfo(
      `[Timeout] Stage "${stageName}" timeout: ${formatTimeout(effectiveTimeout)} ` +
      `(stage limit: ${formatTimeout(stageTimeout)}, ` +
      `pipeline remaining: ${formatTimeout(pipelineRemaining)})`,
    );

    // Store timeout info in state for UI display
    state.data._stage_timeout = {
      stage: stageName,
      timeoutMs: effectiveTimeout,
      startedAt: Date.now(),
      deadline: Date.now() + effectiveTimeout,
    };

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let progressTimer: ReturnType<typeof setInterval> | null = null;

      // -- Timeout timer --
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (progressTimer) clearInterval(progressTimer);
          const elapsed = Date.now() - (state.data._stage_timeout?.startedAt ?? Date.now());
          reject(new StageTimeoutError(stageName, stageTimeout, elapsed));
        }
      }, effectiveTimeout);

      // Unref so the timer doesn't prevent process exit during graceful shutdown
      if (typeof timer.unref === 'function') timer.unref();

      // -- Progress logging for long stages (every 5 minutes) --
      const progressInterval = opts.progressIntervalMs ?? 5 * 60 * 1000;
      if (progressInterval > 0 && effectiveTimeout > progressInterval) {
        const startedAt = Date.now();
        progressTimer = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          const remaining = effectiveTimeout - elapsed;
          if (remaining > 0) {
            logInfo(
              `[Timeout] Stage "${stageName}": ${formatTimeout(elapsed)} elapsed, ` +
              `${formatTimeout(remaining)} remaining`,
            );
          }
        }, progressInterval);
        if (typeof progressTimer.unref === 'function') progressTimer.unref();
      }

      // -- Execute the handler --
      handler(state).then(
        (result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (progressTimer) clearInterval(progressTimer);
            resolve(result);
          }
        },
        (error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (progressTimer) clearInterval(progressTimer);
            reject(error);
          }
        },
      );
    });
  };
}

// ── Pipeline budget check ───────────────────────────────────────────

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
export function checkPipelineBudget(
  stageName: StageName,
  pipelineStart?: number,
): PipelineBudget {
  const maxPipelineDuration =
    parseInt(process.env.MAX_PIPELINE_DURATION || '', 10) || MAX_PIPELINE_DURATION_DEFAULT;
  const elapsed = Date.now() - (pipelineStart || Date.now());
  const remaining = maxPipelineDuration - elapsed;
  const required = getStageTimeout(stageName);

  return {
    ok: remaining > 0,
    remainingMs: remaining,
    requiredMs: required,
    sufficientForStage: remaining >= required,
    pipelineElapsedMs: elapsed,
    pipelineMaxMs: maxPipelineDuration,
  };
}
