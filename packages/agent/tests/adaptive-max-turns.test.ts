/**
 * Unit tests for the adaptive max-turns helpers in
 * `packages/agent/src/lib/agents-team.ts` — Fix B from the AUT-8648
 * post-mortem.
 *
 * The agents-team module exports its `_*` helpers explicitly for tests
 * (see the module.exports block at the bottom of the source). These
 * tests cover the pure helpers; the integrated launch-loop behavior is
 * indirectly covered by the existing live-diff test (it exercises the
 * same .then/.catch handlers).
 */

import { describe, it, expect } from 'vitest';

const {
  _isMaxTurnsError,
  _getMaxTurnsFailures,
  _scaleMaxTurnsForRetry,
  _recordMaxTurnsFailure,
  _clearMaxTurnsFailure,
  MAX_TURNS_RETRY_MULTIPLIER,
  MAX_TURNS_HARD_CAP,
  MAX_TURNS_FAILURE_LIMIT,
} = require('../src/lib/agents-team');

describe('_isMaxTurnsError', () => {
  it('returns true for the canonical Claude CLI error message', () => {
    expect(_isMaxTurnsError(new Error('Claude CLI error (1): Error: Reached max turns (75)'))).toBe(true);
  });

  it('returns true for variants', () => {
    expect(_isMaxTurnsError(new Error('max turns exceeded after 50'))).toBe(true);
    expect(_isMaxTurnsError(new Error('Max-Turns Reached'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(_isMaxTurnsError(new Error('ECONNRESET'))).toBe(false);
    expect(_isMaxTurnsError(new Error('Agent returned empty output'))).toBe(false);
    expect(_isMaxTurnsError(new Error(''))).toBe(false);
  });

  it('is safe against null / undefined / shapeless inputs', () => {
    expect(_isMaxTurnsError(null)).toBe(false);
    expect(_isMaxTurnsError(undefined)).toBe(false);
    expect(_isMaxTurnsError({} as any)).toBe(false);
  });
});

describe('_scaleMaxTurnsForRetry', () => {
  it('returns the original value when there have been no failures', () => {
    expect(_scaleMaxTurnsForRetry(75, 0)).toBe(75);
  });

  it('multiplies by MAX_TURNS_RETRY_MULTIPLIER per prior failure (rounded up)', () => {
    expect(_scaleMaxTurnsForRetry(15, 1)).toBe(Math.ceil(15 * MAX_TURNS_RETRY_MULTIPLIER));
    expect(_scaleMaxTurnsForRetry(15, 2)).toBe(Math.ceil(15 * MAX_TURNS_RETRY_MULTIPLIER * MAX_TURNS_RETRY_MULTIPLIER));
  });

  it('caps at MAX_TURNS_HARD_CAP', () => {
    expect(_scaleMaxTurnsForRetry(150, 5)).toBe(MAX_TURNS_HARD_CAP);
    expect(_scaleMaxTurnsForRetry(75, 10)).toBe(MAX_TURNS_HARD_CAP);
  });

  it('returns the original (undefined / 0) when no original budget was set', () => {
    expect(_scaleMaxTurnsForRetry(undefined, 5)).toBeUndefined();
    expect(_scaleMaxTurnsForRetry(0, 5)).toBe(0);
  });
});

describe('_getMaxTurnsFailures', () => {
  it('returns 0 when state has no failure map', () => {
    expect(_getMaxTurnsFailures({ data: {} }, 'k')).toBe(0);
  });

  it('returns the integer count when the key is present', () => {
    expect(_getMaxTurnsFailures({ data: { _max_turns_failures: { k: 2 } } }, 'k')).toBe(2);
  });

  it('returns 0 for missing keys or non-numeric values', () => {
    expect(_getMaxTurnsFailures({ data: { _max_turns_failures: { other: 1 } } }, 'k')).toBe(0);
    expect(_getMaxTurnsFailures({ data: { _max_turns_failures: { k: 'oops' } } }, 'k')).toBe(0);
    expect(_getMaxTurnsFailures({}, 'k')).toBe(0);
    expect(_getMaxTurnsFailures(null, 'k')).toBe(0);
  });
});

describe('_recordMaxTurnsFailure', () => {
  it('initializes the failure map and increments to 1 on first failure', () => {
    const state: any = { data: {} };
    expect(_recordMaxTurnsFailure(state, 'agent-1')).toBe(1);
    expect(state.data._max_turns_failures['agent-1']).toBe(1);
  });

  it('increments an existing counter', () => {
    const state: any = { data: { _max_turns_failures: { 'agent-1': 1 } } };
    expect(_recordMaxTurnsFailure(state, 'agent-1')).toBe(2);
    expect(_recordMaxTurnsFailure(state, 'agent-1')).toBe(3);
  });

  it('keeps per-key counters independent', () => {
    const state: any = { data: {} };
    _recordMaxTurnsFailure(state, 'agent-1');
    _recordMaxTurnsFailure(state, 'agent-2');
    _recordMaxTurnsFailure(state, 'agent-1');
    expect(state.data._max_turns_failures['agent-1']).toBe(2);
    expect(state.data._max_turns_failures['agent-2']).toBe(1);
  });
});

describe('_clearMaxTurnsFailure', () => {
  it('removes the counter when present', () => {
    const state: any = { data: { _max_turns_failures: { 'agent-1': 2 } } };
    _clearMaxTurnsFailure(state, 'agent-1');
    expect(state.data._max_turns_failures['agent-1']).toBeUndefined();
  });

  it('is a no-op when the counter or map is absent', () => {
    const state: any = { data: {} };
    expect(() => _clearMaxTurnsFailure(state, 'agent-1')).not.toThrow();
    const state2: any = { data: { _max_turns_failures: {} } };
    expect(() => _clearMaxTurnsFailure(state2, 'agent-1')).not.toThrow();
  });

  it('does not throw on shapeless state', () => {
    expect(() => _clearMaxTurnsFailure(null, 'k')).not.toThrow();
    expect(() => _clearMaxTurnsFailure({}, 'k')).not.toThrow();
  });
});

describe('Fix B end-to-end semantics', () => {
  it('exposes a sane FAILURE_LIMIT default (≥ 2, ≤ 5)', () => {
    expect(MAX_TURNS_FAILURE_LIMIT).toBeGreaterThanOrEqual(2);
    expect(MAX_TURNS_FAILURE_LIMIT).toBeLessThanOrEqual(5);
  });

  it('exposes a sane multiplier (> 1)', () => {
    expect(MAX_TURNS_RETRY_MULTIPLIER).toBeGreaterThan(1);
  });

  it('caps high enough to be useful', () => {
    expect(MAX_TURNS_HARD_CAP).toBeGreaterThanOrEqual(100);
  });

  it('retry cycle: fail → record → scale → success → clear', () => {
    const state: any = { data: {} };
    const key = 'reviewer';
    const original = 15;

    // Attempt 1 fails — record.
    const after1 = _recordMaxTurnsFailure(state, key);
    expect(after1).toBe(1);
    const scaled1 = _scaleMaxTurnsForRetry(original, _getMaxTurnsFailures(state, key));
    expect(scaled1).toBeGreaterThan(original);

    // Attempt 2 fails — record again.
    const after2 = _recordMaxTurnsFailure(state, key);
    expect(after2).toBe(2);
    const scaled2 = _scaleMaxTurnsForRetry(original, _getMaxTurnsFailures(state, key));
    expect(scaled2).toBeGreaterThan(scaled1!);

    // Attempt 3 succeeds — clear.
    _clearMaxTurnsFailure(state, key);
    expect(_getMaxTurnsFailures(state, key)).toBe(0);

    // Next attempt starts at original budget.
    expect(_scaleMaxTurnsForRetry(original, _getMaxTurnsFailures(state, key))).toBe(original);
  });
});
