// =====================================================================
// error-recovery.test.ts -- Unit tests for stage-level error recovery
// =====================================================================
//
// Tests: classifyError (HTTP codes -> error classes),
//        executeWithRecovery (retry on transient, no retry on permanent),
//        calculateRetryDelay (backoff calculation)
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyError,
  calculateRetryDelay,
  executeWithRecovery,
  DEFAULT_RETRY_CONFIG,
  TRANSIENT_CODES,
  TRANSIENT_STATUS_CODES,
} from '../../src/pipeline/error-recovery';
import { ErrorClass } from '@shared/types';
import type { PipelineState, StageName } from '@shared/types';

// ── Mock logger and utils so we don't produce console output ─────────

vi.mock('../../src/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logErr: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock('../../src/lib/utils', () => ({
  addWarning: vi.fn(),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ──────────────────────────────────────────────────────────

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    ticket: 'AUT-1234',
    stage: 'fetch_ticket',
    data: {},
    _seq: 1,
    ...overrides,
  };
}

function makeErrorWithCode(message: string, code: string): Error {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// ═══════════════════════════════════════════════════════════════════════
// classifyError Tests
// ═══════════════════════════════════════════════════════════════════════

describe('classifyError', () => {
  // -- AUTH errors (highest priority) --

  it('classifies 401 pattern as AUTH', () => {
    const result = classifyError(new Error('HTTP 401 Unauthorized'));
    expect(result.class).toBe(ErrorClass.AUTH);
    expect(result.retryable).toBe(false);
  });

  it('classifies 403 pattern as AUTH', () => {
    const result = classifyError(new Error('Response: 403 Forbidden'));
    expect(result.class).toBe(ErrorClass.AUTH);
    expect(result.retryable).toBe(false);
  });

  it('classifies "unauthorized" as AUTH', () => {
    const result = classifyError(new Error('Request unauthorized'));
    expect(result.class).toBe(ErrorClass.AUTH);
    expect(result.retryable).toBe(false);
  });

  it('classifies "token expired" as AUTH', () => {
    const result = classifyError(new Error('token expired'));
    expect(result.class).toBe(ErrorClass.AUTH);
    expect(result.retryable).toBe(false);
  });

  it('classifies "access denied" as AUTH', () => {
    const result = classifyError(new Error('access denied'));
    expect(result.class).toBe(ErrorClass.AUTH);
    expect(result.retryable).toBe(false);
  });

  // -- Transient network error codes --

  it('classifies ECONNRESET code as TRANSIENT', () => {
    const err = makeErrorWithCode('socket hang up', 'ECONNRESET');
    const result = classifyError(err);
    expect(result.class).toBe(ErrorClass.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('classifies ECONNREFUSED code as TRANSIENT', () => {
    const err = makeErrorWithCode('connection refused', 'ECONNREFUSED');
    const result = classifyError(err);
    expect(result.class).toBe(ErrorClass.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('classifies ETIMEDOUT code as TRANSIENT', () => {
    const err = makeErrorWithCode('connection timed out', 'ETIMEDOUT');
    const result = classifyError(err);
    expect(result.class).toBe(ErrorClass.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('classifies ENOTFOUND in code as TRANSIENT (not permanent)', () => {
    // This is important: ENOTFOUND matches /not found/i but should be
    // classified as TRANSIENT because the code check happens first.
    const err = makeErrorWithCode('getaddrinfo ENOTFOUND api.example.com', 'ENOTFOUND');
    const result = classifyError(err);
    expect(result.class).toBe(ErrorClass.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('classifies transient code embedded in message as TRANSIENT', () => {
    const err = new Error('FetchError: ECONNREFUSED at some.host');
    const result = classifyError(err);
    expect(result.class).toBe(ErrorClass.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('classifies all TRANSIENT_CODES as transient', () => {
    for (const code of TRANSIENT_CODES) {
      const err = makeErrorWithCode(`error: ${code}`, code);
      const result = classifyError(err);
      expect(result.class).toBe(ErrorClass.TRANSIENT);
    }
  });

  // -- Permanent errors --

  it('classifies "not found" as PERMANENT', () => {
    const result = classifyError(new Error('Resource not found'));
    expect(result.class).toBe(ErrorClass.PERMANENT);
    expect(result.retryable).toBe(false);
  });

  it('classifies "merge conflict" as PERMANENT', () => {
    const result = classifyError(new Error('merge conflict detected'));
    expect(result.class).toBe(ErrorClass.PERMANENT);
    expect(result.retryable).toBe(false);
  });

  it('classifies "disk full" as PERMANENT', () => {
    const result = classifyError(new Error('disk full'));
    expect(result.class).toBe(ErrorClass.PERMANENT);
    expect(result.retryable).toBe(false);
  });

  it('classifies ENOSPC as PERMANENT', () => {
    const result = classifyError(new Error('ENOSPC: no space left on device'));
    expect(result.class).toBe(ErrorClass.PERMANENT);
    expect(result.retryable).toBe(false);
  });

  it('classifies "out of memory" as PERMANENT', () => {
    const result = classifyError(new Error('out of memory'));
    expect(result.class).toBe(ErrorClass.PERMANENT);
    expect(result.retryable).toBe(false);
  });

  // -- Timeout errors --

  it('classifies "timed out" as TIMEOUT', () => {
    const result = classifyError(new Error('Operation timed out'));
    expect(result.class).toBe(ErrorClass.TIMEOUT);
    expect(result.retryable).toBe(true);
  });

  it('classifies "timeout" as TIMEOUT', () => {
    const result = classifyError(new Error('Request timeout'));
    expect(result.class).toBe(ErrorClass.TIMEOUT);
    expect(result.retryable).toBe(true);
  });

  it('classifies "deadline exceeded" as TIMEOUT', () => {
    const result = classifyError(new Error('Deadline exceeded for RPC'));
    expect(result.class).toBe(ErrorClass.TIMEOUT);
    expect(result.retryable).toBe(true);
  });

  // -- HTTP status codes in message --

  it('classifies HTTP 429 in message as TRANSIENT', () => {
    const result = classifyError(new Error('HTTP 429 Too Many Requests'));
    expect(result.class).toBe(ErrorClass.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('classifies HTTP 500 in message as TRANSIENT', () => {
    const result = classifyError(new Error('HTTP 500 Internal Server Error'));
    expect(result.class).toBe(ErrorClass.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('classifies HTTP 502 in message as TRANSIENT', () => {
    const result = classifyError(new Error('status: 502'));
    expect(result.class).toBe(ErrorClass.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('classifies HTTP 503 in message as TRANSIENT', () => {
    const result = classifyError(new Error('status: 503'));
    expect(result.class).toBe(ErrorClass.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('classifies HTTP 504 in message as TIMEOUT (timeout pattern matches before status code)', () => {
    const result = classifyError(new Error('HTTP 504 Gateway Timeout'));
    // "Gateway Timeout" matches TIMEOUT_PATTERNS before TRANSIENT_STATUS_CODES
    expect(result.class).toBe(ErrorClass.TIMEOUT);
    expect(result.retryable).toBe(true);
  });

  it('classifies HTTP 404 in message as PERMANENT', () => {
    const result = classifyError(new Error('HTTP 404'));
    expect(result.class).toBe(ErrorClass.PERMANENT);
    expect(result.retryable).toBe(false);
  });

  it('classifies HTTP 422 in message as PERMANENT', () => {
    const result = classifyError(new Error('status: 422'));
    expect(result.class).toBe(ErrorClass.PERMANENT);
    expect(result.retryable).toBe(false);
  });

  it('classifies HTTP 401 in message as AUTH', () => {
    const result = classifyError(new Error('status: 401'));
    expect(result.class).toBe(ErrorClass.AUTH);
    expect(result.retryable).toBe(false);
  });

  // -- Claude CLI errors --

  it('classifies Claude CLI timeout as TIMEOUT', () => {
    const result = classifyError(new Error('Claude CLI timed out after 300s'));
    expect(result.class).toBe(ErrorClass.TIMEOUT);
    expect(result.retryable).toBe(true);
  });

  it('classifies Claude CLI error (1) as TRANSIENT', () => {
    const result = classifyError(new Error('Claude CLI exited with error (1)'));
    expect(result.class).toBe(ErrorClass.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  // -- Default fallback --

  it('defaults to PERMANENT for unrecognized errors', () => {
    const result = classifyError(new Error('something completely unexpected'));
    expect(result.class).toBe(ErrorClass.PERMANENT);
    expect(result.retryable).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  // -- Priority: AUTH > TRANSIENT > PERMANENT > TIMEOUT --

  it('AUTH takes priority over timeout pattern', () => {
    // "unauthorized" matches AUTH pattern, even though "timed out" might match TIMEOUT
    const result = classifyError(new Error('401 unauthorized'));
    expect(result.class).toBe(ErrorClass.AUTH);
  });

  // -- GitLab recoverable errors --

  it('classifies GitLab "file with this name already exists" as TRANSIENT', () => {
    const result = classifyError(new Error('A file with this name already exists'));
    expect(result.class).toBe(ErrorClass.TRANSIENT);
    expect(result.retryable).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// calculateRetryDelay Tests
// ═══════════════════════════════════════════════════════════════════════

describe('calculateRetryDelay', () => {
  beforeEach(() => {
    // Make Math.random return 0.5 for deterministic jitter testing
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns baseDelayMs for attempt 0 when jitter is neutral', () => {
    // With Math.random() = 0.5, jitter = 0 (2*0.5 - 1 = 0)
    const delay = calculateRetryDelay(0);
    // base=5000, multiplier^0=1, so delay = 5000 + 0 = 5000
    expect(delay).toBe(DEFAULT_RETRY_CONFIG.baseDelayMs);
  });

  it('applies exponential backoff for higher attempts', () => {
    const delay0 = calculateRetryDelay(0);
    const delay1 = calculateRetryDelay(1);
    const delay2 = calculateRetryDelay(2);

    // With multiplier=2: attempt 1 = 2x base, attempt 2 = 4x base
    expect(delay1).toBeGreaterThan(delay0);
    expect(delay2).toBeGreaterThan(delay1);
  });

  it('caps delay at maxDelayMs', () => {
    // Very high attempt should hit the cap
    const delay = calculateRetryDelay(20);
    expect(delay).toBeLessThanOrEqual(
      DEFAULT_RETRY_CONFIG.maxDelayMs * (1 + DEFAULT_RETRY_CONFIG.jitterFraction),
    );
  });

  it('never returns less than 1000ms', () => {
    // Use very small base delay
    const delay = calculateRetryDelay(0, { baseDelayMs: 100 });
    expect(delay).toBeGreaterThanOrEqual(1000);
  });

  it('uses custom config when provided', () => {
    const delay = calculateRetryDelay(0, {
      baseDelayMs: 10_000,
      backoffMultiplier: 3,
      maxDelayMs: 60_000,
      jitterFraction: 0,
    });
    // attempt 0: 10000 * 3^0 = 10000, no jitter
    expect(delay).toBe(10_000);
  });

  it('applies jitter within expected range', () => {
    // Math.random = 0.5 means jitter factor = 0 (neutral)
    // Let's check with explicit jitter fraction
    vi.spyOn(Math, 'random').mockReturnValue(1.0); // max jitter: factor = 1
    const delayMax = calculateRetryDelay(0, {
      baseDelayMs: 10_000,
      jitterFraction: 0.2,
      backoffMultiplier: 1,
      maxDelayMs: 120_000,
    });
    // 10000 + 10000 * 0.2 * 1 = 12000
    expect(delayMax).toBe(12_000);

    vi.spyOn(Math, 'random').mockReturnValue(0.0); // min jitter: factor = -1
    const delayMin = calculateRetryDelay(0, {
      baseDelayMs: 10_000,
      jitterFraction: 0.2,
      backoffMultiplier: 1,
      maxDelayMs: 120_000,
    });
    // 10000 + 10000 * 0.2 * (-1) = 8000
    expect(delayMin).toBe(8_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// executeWithRecovery Tests
// ═══════════════════════════════════════════════════════════════════════

describe('executeWithRecovery', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success on first attempt when handler succeeds', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const state = makeState();

    const result = await executeWithRecovery('fetch_ticket', handler, state);

    expect(result.success).toBe(true);
    expect(result.retries).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and succeeds', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(makeErrorWithCode('socket hang up', 'ECONNRESET'))
      .mockResolvedValue(undefined);
    const state = makeState();

    const result = await executeWithRecovery('fetch_ticket', handler, state, {
      maxRetries: 3,
    });

    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not retry on permanent error', async () => {
    const handler = vi
      .fn()
      .mockRejectedValue(new Error('merge conflict detected'));
    const state = makeState();

    const result = await executeWithRecovery('fetch_ticket', handler, state);

    expect(result.success).toBe(false);
    expect(result.action).toBe('HALT');
    expect(result.classification?.class).toBe(ErrorClass.PERMANENT);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not retry on auth error', async () => {
    const handler = vi
      .fn()
      .mockRejectedValue(new Error('401 unauthorized'));
    const state = makeState();

    const result = await executeWithRecovery('fetch_ticket', handler, state);

    expect(result.success).toBe(false);
    expect(result.action).toBe('AUTH_FAILED');
    expect(result.classification?.class).toBe(ErrorClass.AUTH);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on repeated transient error', async () => {
    const handler = vi
      .fn()
      .mockRejectedValue(makeErrorWithCode('refused', 'ECONNREFUSED'));
    const state = makeState();

    const result = await executeWithRecovery('fetch_ticket', handler, state, {
      maxRetries: 2,
    });

    expect(result.success).toBe(false);
    expect(result.action).toBe('RETRIES_EXHAUSTED');
    // attempt 0 + 2 retries = 3 total calls
    expect(handler).toHaveBeenCalledTimes(3);
    expect(result.retries).toBe(2);
  });

  it('retries on timeout and eventually succeeds', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('Operation timed out'))
      .mockRejectedValueOnce(new Error('Request timeout'))
      .mockResolvedValue(undefined);
    const state = makeState();

    const result = await executeWithRecovery('fetch_ticket', handler, state, {
      maxRetries: 3,
    });

    expect(result.success).toBe(true);
    expect(result.retries).toBe(2);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('returns TIMEOUT_EXHAUSTED when timeout retries run out', async () => {
    const handler = vi
      .fn()
      .mockRejectedValue(new Error('Operation timed out'));
    const state = makeState();

    const result = await executeWithRecovery('fetch_ticket', handler, state, {
      maxRetries: 1,
    });

    expect(result.success).toBe(false);
    expect(result.action).toBe('TIMEOUT_EXHAUSTED');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('records retry history for each attempt', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(makeErrorWithCode('ECONNRESET', 'ECONNRESET'))
      .mockRejectedValueOnce(makeErrorWithCode('ECONNRESET', 'ECONNRESET'))
      .mockResolvedValue(undefined);
    const state = makeState();

    const result = await executeWithRecovery('fetch_ticket', handler, state, {
      maxRetries: 3,
    });

    expect(result.success).toBe(true);
    expect(result.retryHistory).toHaveLength(2);
    expect(result.retryHistory[0].attempt).toBe(0);
    expect(result.retryHistory[1].attempt).toBe(1);
    expect(result.retryHistory[0].classification.class).toBe(ErrorClass.TRANSIENT);
  });

  it('updates state._retries on each retry', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(makeErrorWithCode('socket hang up', 'ECONNRESET'))
      .mockResolvedValue(undefined);
    const state = makeState();

    await executeWithRecovery('fetch_ticket', handler, state, { maxRetries: 3 });

    // After success, retry counter is reset to 0
    expect(state.data._retries?.fetch_ticket).toBe(0);
  });

  it('stores _lastError in state on failure', async () => {
    const handler = vi
      .fn()
      .mockRejectedValue(new Error('merge conflict detected'));
    const state = makeState();

    await executeWithRecovery('fetch_ticket', handler, state);

    expect(state.data._lastError).toBeDefined();
    expect(state.data._lastError!.stage).toBe('fetch_ticket');
    expect(state.data._lastError!.classification).toBe(ErrorClass.PERMANENT);
  });

  it('respects stage-specific maxRetries=0 (no retries)', async () => {
    const handler = vi
      .fn()
      .mockRejectedValue(makeErrorWithCode('refused', 'ECONNREFUSED'));
    const state = makeState({ stage: 'gate_code_review' });

    // gate_code_review has maxRetries: 0 in STAGE_RETRY_CONFIG
    const result = await executeWithRecovery('gate_code_review', handler, state);

    expect(result.success).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('calls saveState between retries when provided', async () => {
    const saveState = vi.fn();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(makeErrorWithCode('reset', 'ECONNRESET'))
      .mockResolvedValue(undefined);
    const state = makeState();

    await executeWithRecovery('fetch_ticket', handler, state, {
      maxRetries: 3,
      saveState,
    });

    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledWith(state);
  });

  it('handles non-Error thrown values', async () => {
    const handler = vi.fn().mockRejectedValue('string error');
    const state = makeState();

    const result = await executeWithRecovery('fetch_ticket', handler, state);

    // String error with no matching patterns defaults to PERMANENT
    expect(result.success).toBe(false);
  });
});
