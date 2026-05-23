/**
 * Unit tests for Fix E — `_canRetryParallelTeam` decision logic. The
 * function is a pure mapping from (taskGroups, state) → retry decision,
 * so we can verify all four cases (partial success, all-failed,
 * all-succeeded defensive, already-attempted) without spinning up
 * Claude.
 *
 * The integrated path that actually re-invokes runAgentsTeam is covered
 * indirectly by the existing agents-team-live test (which exercises the
 * Phase 1 checkpoint-reuse path that Fix E relies on).
 */

import { describe, it, expect } from 'vitest';

const { _canRetryParallelTeam } = require('../src/stages/generate-code/developer');

function mkState(devGroupCheckpoints: Record<string, any> = {}, teamRetryAttempted = false): any {
  return {
    data: {
      ...devGroupCheckpoints,
      ...(teamRetryAttempted ? { _team_retry_attempted: true } : {}),
    },
  };
}

const FIVE_GROUPS = Array.from({ length: 5 }, (_, i) => ({
  title: `Group ${i}`,
  content: '',
  files: [],
}));

describe('_canRetryParallelTeam', () => {
  it('triggers retry when some agents succeeded and some failed', () => {
    const state = mkState({
      _dev_group_0: 'output A',
      _dev_group_1: 'output B',
      // 2, 3, 4 absent = failed
    });
    const decision = _canRetryParallelTeam(FIVE_GROUPS, state);
    expect(decision.canRetry).toBe(true);
    expect(decision.succeededCount).toBe(2);
    expect(decision.failedCount).toBe(3);
    expect(decision.reason).toBeUndefined();
  });

  it('does NOT retry when every agent failed (structural plan failure)', () => {
    const state = mkState({});
    const decision = _canRetryParallelTeam(FIVE_GROUPS, state);
    expect(decision.canRetry).toBe(false);
    expect(decision.succeededCount).toBe(0);
    expect(decision.failedCount).toBe(5);
    expect(decision.reason).toBe('all-failed');
  });

  it('does NOT retry when every agent succeeded (defensive — should not reach the catch block in this state)', () => {
    const state = mkState({
      _dev_group_0: 'A',
      _dev_group_1: 'B',
      _dev_group_2: 'C',
      _dev_group_3: 'D',
      _dev_group_4: 'E',
    });
    const decision = _canRetryParallelTeam(FIVE_GROUPS, state);
    expect(decision.canRetry).toBe(false);
    expect(decision.failedCount).toBe(0);
    expect(decision.reason).toBe('all-succeeded');
  });

  it('does NOT retry when retry was already attempted this stage entry (avoids amplification)', () => {
    const state = mkState({ _dev_group_0: 'A', _dev_group_1: 'B' }, /* teamRetryAttempted= */ true);
    const decision = _canRetryParallelTeam(FIVE_GROUPS, state);
    expect(decision.canRetry).toBe(false);
    expect(decision.reason).toBe('already-attempted');
  });

  it('treats empty-string and null checkpoints as "failed"', () => {
    const state = mkState({
      _dev_group_0: 'real output',
      _dev_group_1: '',     // empty (rejected mid-cycle)
      _dev_group_2: null,   // explicitly cleared
      _dev_group_3: undefined,
    });
    const decision = _canRetryParallelTeam(FIVE_GROUPS, state);
    expect(decision.succeededCount).toBe(1);
    expect(decision.failedCount).toBe(4);
    expect(decision.canRetry).toBe(true);
  });

  it('handles a single-group team correctly (no retry — would be same as single-agent path)', () => {
    const oneGroup = [{ title: 'Only', content: '', files: [] }];
    // succeeded → all-succeeded
    expect(_canRetryParallelTeam(oneGroup, mkState({ _dev_group_0: 'x' })).reason).toBe('all-succeeded');
    // failed → all-failed (can't do "selective" retry of a set of one)
    expect(_canRetryParallelTeam(oneGroup, mkState({})).reason).toBe('all-failed');
  });

  it('counts succeeded by stringy-truthy presence (not just type)', () => {
    const state = mkState({
      _dev_group_0: '   ', // whitespace IS truthy → counts as succeeded
      _dev_group_1: 0,    // 0 IS falsy → fail
      _dev_group_2: false, // false → fail
    });
    const decision = _canRetryParallelTeam(FIVE_GROUPS, state);
    expect(decision.succeededCount).toBe(1);
    expect(decision.failedCount).toBe(4);
  });
});
