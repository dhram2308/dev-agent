// =====================================================================
// stage-timeout.test.ts -- Unit tests for per-stage timeout system
// =====================================================================
//
// Tests: withStageTimeout (success, timeout), checkPipelineBudget,
//        StageTimeoutError, formatTimeout, getStageTimeout
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withStageTimeout,
  checkPipelineBudget,
  getStageTimeout,
  formatTimeout,
  StageTimeoutError,
  DEFAULT_STAGE_TIMEOUTS,
} from '../../src/pipeline/stage-timeout';
import type { PipelineState, StageName } from '@shared/types';

// ── Mock logger ──────────────────────────────────────────────────────

vi.mock('../../src/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    ticket: 'AUT-1234',
    stage: 'fetch_ticket',
    data: {
      _pipeline_start: Date.now(),
    },
    _seq: 1,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// StageTimeoutError Tests
// ═══════════════════════════════════════════════════════════════════════

describe('StageTimeoutError', () => {
  it('sets name, stageName, timeoutMs, and code', () => {
    const err = new StageTimeoutError('fetch_ticket', 300_000);

    expect(err.name).toBe('StageTimeoutError');
    expect(err.stageName).toBe('fetch_ticket');
    expect(err.timeoutMs).toBe(300_000);
    expect(err.code).toBe('STAGE_TIMEOUT');
    expect(err.message).toContain('fetch_ticket');
    expect(err.message).toContain('timed out');
  });

  it('includes elapsed time when provided', () => {
    const err = new StageTimeoutError('generate_code', 600_000, 550_000);

    expect(err.elapsedMs).toBe(550_000);
    expect(err.message).toContain('9.2m'); // 550000ms formatted
  });

  it('defaults elapsedMs to timeoutMs when not provided', () => {
    const err = new StageTimeoutError('deploy_qa', 120_000);

    expect(err.elapsedMs).toBe(120_000);
  });

  it('is an instance of Error', () => {
    const err = new StageTimeoutError('test_qa', 60_000);
    expect(err).toBeInstanceOf(Error);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// formatTimeout Tests
// ═══════════════════════════════════════════════════════════════════════

describe('formatTimeout', () => {
  it('formats hours', () => {
    expect(formatTimeout(3_600_000)).toBe('1.0h');
    expect(formatTimeout(7_200_000)).toBe('2.0h');
    expect(formatTimeout(5_400_000)).toBe('1.5h');
  });

  it('formats minutes', () => {
    expect(formatTimeout(60_000)).toBe('1.0m');
    expect(formatTimeout(300_000)).toBe('5.0m');
    expect(formatTimeout(90_000)).toBe('1.5m');
  });

  it('formats seconds', () => {
    expect(formatTimeout(1_000)).toBe('1.0s');
    expect(formatTimeout(30_000)).toBe('30.0s');
    expect(formatTimeout(500)).toBe('0.5s');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getStageTimeout Tests
// ═══════════════════════════════════════════════════════════════════════

describe('getStageTimeout', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default timeout for fetch_ticket', () => {
    const timeout = getStageTimeout('fetch_ticket');
    expect(timeout).toBe(DEFAULT_STAGE_TIMEOUTS.fetch_ticket);
  });

  it('returns default timeout for generate_code', () => {
    const timeout = getStageTimeout('generate_code');
    expect(timeout).toBe(60 * 60 * 1000); // 60 minutes
  });

  it('uses env var override when set', () => {
    process.env.STAGE_TIMEOUT_FETCH_TICKET = '999000';
    const timeout = getStageTimeout('fetch_ticket');
    expect(timeout).toBe(999_000);
  });

  it('falls back to default when env var is invalid', () => {
    process.env.STAGE_TIMEOUT_FETCH_TICKET = 'not-a-number';
    const timeout = getStageTimeout('fetch_ticket');
    expect(timeout).toBe(DEFAULT_STAGE_TIMEOUTS.fetch_ticket);
  });

  it('falls back to default when env var is 0', () => {
    process.env.STAGE_TIMEOUT_FETCH_TICKET = '0';
    const timeout = getStageTimeout('fetch_ticket');
    expect(timeout).toBe(DEFAULT_STAGE_TIMEOUTS.fetch_ticket);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// withStageTimeout Tests
// ═══════════════════════════════════════════════════════════════════════

describe('withStageTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when handler completes within timeout', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const state = makeState();
    const timedHandler = withStageTimeout('fetch_ticket', handler, {
      timeoutMs: 10_000,
      progressIntervalMs: 0,
    });

    const promise = timedHandler(state);
    await vi.advanceTimersByTimeAsync(0); // Flush microtasks

    await expect(promise).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledWith(state);
  });

  it('rejects with StageTimeoutError when handler exceeds timeout', async () => {
    // Handler that never resolves
    const handler = vi.fn().mockReturnValue(new Promise(() => {}));
    const state = makeState();
    const timedHandler = withStageTimeout('fetch_ticket', handler, {
      timeoutMs: 5_000,
      progressIntervalMs: 0,
    });

    const promise = timedHandler(state);
    // Attach catch to prevent unhandled rejection noise
    promise.catch(() => {});

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(promise).rejects.toThrow(StageTimeoutError);
  });

  it('propagates handler errors (not timeout) when handler fails quickly', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('handler failure'));
    const state = makeState();
    const timedHandler = withStageTimeout('fetch_ticket', handler, {
      timeoutMs: 10_000,
      progressIntervalMs: 0,
    });

    const promise = timedHandler(state);
    // Attach catch to prevent unhandled rejection noise
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).rejects.toThrow('handler failure');
  });

  it('throws immediately when pipeline budget is exhausted', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const state = makeState();
    // Set pipeline start far in the past so budget is exhausted
    state.data._pipeline_start = Date.now() - 100_000_000;

    const timedHandler = withStageTimeout('fetch_ticket', handler, {
      timeoutMs: 10_000,
      maxPipelineDuration: 1_000, // Very short pipeline duration
      progressIntervalMs: 0,
    });

    await expect(timedHandler(state)).rejects.toThrow(StageTimeoutError);
    // Handler should not have been called since there's no budget
    expect(handler).not.toHaveBeenCalled();
  });

  it('stores timeout metadata in state.data._stage_timeout', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const state = makeState();
    const timedHandler = withStageTimeout('fetch_ticket', handler, {
      timeoutMs: 30_000,
      progressIntervalMs: 0,
    });

    const promise = timedHandler(state);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(state.data._stage_timeout).toBeDefined();
    expect(state.data._stage_timeout!.stage).toBe('fetch_ticket');
    expect(state.data._stage_timeout!.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(state.data._stage_timeout!.startedAt).toBeGreaterThan(0);
    expect(state.data._stage_timeout!.deadline).toBeGreaterThan(state.data._stage_timeout!.startedAt);
  });

  it('uses effective timeout as min(stageTimeout, pipelineRemaining)', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const state = makeState();
    // Pipeline started 10 seconds ago, max duration 20 seconds
    state.data._pipeline_start = Date.now() - 10_000;

    const timedHandler = withStageTimeout('fetch_ticket', handler, {
      timeoutMs: 60_000, // Stage wants 60s
      maxPipelineDuration: 20_000, // But only ~10s remaining
      progressIntervalMs: 0,
    });

    const promise = timedHandler(state);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // Effective timeout should be ~10s (pipeline remaining), not 60s
    expect(state.data._stage_timeout!.timeoutMs).toBeLessThanOrEqual(20_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// checkPipelineBudget Tests
// ═══════════════════════════════════════════════════════════════════════

describe('checkPipelineBudget', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns ok=true when pipeline has time remaining', () => {
    const startedJustNow = Date.now();
    const budget = checkPipelineBudget('fetch_ticket', startedJustNow);

    expect(budget.ok).toBe(true);
    expect(budget.remainingMs).toBeGreaterThan(0);
  });

  it('returns ok=false when pipeline has exceeded max duration', () => {
    process.env.MAX_PIPELINE_DURATION = '1000'; // 1 second max
    const startedLongAgo = Date.now() - 60_000; // Started 60s ago

    const budget = checkPipelineBudget('fetch_ticket', startedLongAgo);

    expect(budget.ok).toBe(false);
    expect(budget.remainingMs).toBeLessThan(0);
  });

  it('reports sufficientForStage=true when remaining > required', () => {
    const startedJustNow = Date.now();
    const budget = checkPipelineBudget('fetch_ticket', startedJustNow);

    // fetch_ticket default timeout is 5 minutes, pipeline default is 4 hours
    expect(budget.sufficientForStage).toBe(true);
    expect(budget.requiredMs).toBe(DEFAULT_STAGE_TIMEOUTS.fetch_ticket);
  });

  it('reports sufficientForStage=false when remaining < required', () => {
    process.env.MAX_PIPELINE_DURATION = '10000'; // 10 second pipeline
    const startedRecently = Date.now() - 8_000; // 8s elapsed, 2s remaining

    const budget = checkPipelineBudget('generate_code', startedRecently);

    // generate_code requires 60 minutes, only 2s remain
    expect(budget.sufficientForStage).toBe(false);
  });

  it('includes pipeline elapsed and max in the result', () => {
    const start = Date.now() - 5_000;
    const budget = checkPipelineBudget('fetch_ticket', start);

    expect(budget.pipelineElapsedMs).toBeGreaterThanOrEqual(4_900);
    expect(budget.pipelineElapsedMs).toBeLessThanOrEqual(6_000);
    expect(budget.pipelineMaxMs).toBeGreaterThan(0);
  });

  it('uses MAX_PIPELINE_DURATION env var when set', () => {
    process.env.MAX_PIPELINE_DURATION = '7200000'; // 2 hours
    const start = Date.now();

    const budget = checkPipelineBudget('fetch_ticket', start);

    expect(budget.pipelineMaxMs).toBe(7_200_000);
  });

  it('handles undefined pipelineStart gracefully', () => {
    const budget = checkPipelineBudget('fetch_ticket', undefined);

    // When start is undefined, elapsed is Date.now() - Date.now() ~= 0
    expect(budget.ok).toBe(true);
    expect(budget.pipelineElapsedMs).toBeLessThanOrEqual(100); // Near zero
  });
});
