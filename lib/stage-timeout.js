"use strict";

/**
 * Per-Stage Timeout System
 *
 * Solves problems #10, #15:
 * - Default timeouts per stage type
 * - Configurable via env vars (STAGE_TIMEOUT_<STAGE_NAME>)
 * - Wraps each stage handler in an AbortSignal-based timeout
 * - Integrates with pipeline-level timeout guard
 */

const { logInfo, logWarn, logErr } = require("./logging");

// ── Default timeouts per stage (in milliseconds) ────────────────────

const DEFAULT_STAGE_TIMEOUTS = {
  fetch_ticket:          5 * 60 * 1000,     //  5 minutes
  explore_plan:          30 * 60 * 1000,    // 30 minutes
  generate_code:         60 * 60 * 1000,    // 60 minutes
  gate_code_review:      8 * 60 * 60 * 1000, //  8 hours (approval wait)
  deploy_qa:             30 * 60 * 1000,    // 30 minutes
  test_qa:               10 * 60 * 1000,    // 10 minutes
  gate_preprod_approval: 8 * 60 * 60 * 1000, //  8 hours
  create_preprod_mr:     30 * 60 * 1000,    // 30 minutes
  gate_dual_approval:    8 * 60 * 60 * 1000, //  8 hours
  deploy_prod:           30 * 60 * 1000,    // 30 minutes
  done:                  60 * 1000,         //  1 minute
};

/**
 * Get the timeout for a stage, checking env var override first.
 * Env var format: STAGE_TIMEOUT_FETCH_TICKET=600000
 */
function getStageTimeout(stageName) {
  const envKey = `STAGE_TIMEOUT_${stageName.toUpperCase()}`;
  const envVal = parseInt(process.env[envKey], 10);
  if (!isNaN(envVal) && envVal > 0) {
    return envVal;
  }
  return DEFAULT_STAGE_TIMEOUTS[stageName] || 30 * 60 * 1000; // default 30min
}

/**
 * Get human-readable timeout string
 */
function formatTimeout(ms) {
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)}h`;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Custom timeout error class for differentiation
 */
class StageTimeoutError extends Error {
  constructor(stageName, timeoutMs, elapsedMs) {
    super(`Stage "${stageName}" timed out after ${formatTimeout(elapsedMs || timeoutMs)} (limit: ${formatTimeout(timeoutMs)})`);
    this.name = "StageTimeoutError";
    this.stageName = stageName;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs || timeoutMs;
    this.code = "STAGE_TIMEOUT";
  }
}

/**
 * Wrap a stage handler with a timeout.
 *
 * Returns a new function that runs the handler with a per-stage timeout.
 * On timeout, throws StageTimeoutError (classified as TIMEOUT by error-recovery).
 *
 * Remaining pipeline time is also respected: if the remaining pipeline time
 * is less than the stage timeout, the shorter value is used.
 */
function withStageTimeout(stageName, handler, options = {}) {
  return async function timedHandler(state) {
    const stageTimeout = getStageTimeout(stageName);
    const pipelineStart = state.data._pipeline_start || Date.now();
    const maxPipelineDuration = parseInt(process.env.MAX_PIPELINE_DURATION, 10) || 86_400_000;
    const pipelineElapsed = Date.now() - pipelineStart;
    const pipelineRemaining = Math.max(0, maxPipelineDuration - pipelineElapsed);

    // Use the shorter of stage timeout and remaining pipeline time
    const effectiveTimeout = Math.min(stageTimeout, pipelineRemaining);

    if (effectiveTimeout <= 0) {
      throw new StageTimeoutError(stageName, stageTimeout, pipelineElapsed);
    }

    logInfo(`[Timeout] Stage "${stageName}" timeout: ${formatTimeout(effectiveTimeout)} (stage limit: ${formatTimeout(stageTimeout)}, pipeline remaining: ${formatTimeout(pipelineRemaining)})`);

    // Store timeout info in state for UI display
    state.data._stage_timeout = {
      stage: stageName,
      timeoutMs: effectiveTimeout,
      startedAt: Date.now(),
      deadline: Date.now() + effectiveTimeout,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let progressTimer = null;

      // Timeout timer
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (progressTimer) clearInterval(progressTimer);
          const elapsed = Date.now() - state.data._stage_timeout.startedAt;
          reject(new StageTimeoutError(stageName, stageTimeout, elapsed));
        }
      }, effectiveTimeout);

      // Unref the timer so it doesn't prevent process exit during graceful shutdown
      if (timer.unref) timer.unref();

      // Progress logging for long stages (every 5 minutes)
      if (effectiveTimeout > 300_000) {
        const startedAt = Date.now();
        progressTimer = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          const remaining = effectiveTimeout - elapsed;
          if (remaining > 0) {
            logInfo(`[Timeout] Stage "${stageName}": ${formatTimeout(elapsed)} elapsed, ${formatTimeout(remaining)} remaining`);
          }
        }, 5 * 60 * 1000);
        if (progressTimer.unref) progressTimer.unref();
      }

      // Execute the handler
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

/**
 * Check if remaining pipeline time is sufficient for a stage.
 * Returns { ok: boolean, remainingMs: number, requiredMs: number }
 */
function checkPipelineBudget(stageName, pipelineStart) {
  const maxPipelineDuration = parseInt(process.env.MAX_PIPELINE_DURATION, 10) || 86_400_000;
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

module.exports = {
  DEFAULT_STAGE_TIMEOUTS,
  getStageTimeout,
  formatTimeout,
  StageTimeoutError,
  withStageTimeout,
  checkPipelineBudget,
};
