/**
 * Unit tests for Fix F — startup-kill detection + adaptive wall-clock
 * timeout. The helpers are exposed via agents-team.ts's module.exports
 * for tests. The integration path (callClaude attaches stdoutLength /
 * isTimeout / exitCode to rejected errors; agents-team uses them) is
 * covered by manual smoke testing; this file pins the helper semantics.
 */

import { describe, it, expect } from 'vitest';

const {
  _isStartupKill,
  _getStartupKills,
  _scaleTimeoutForStartupKills,
  _recordStartupKill,
  _clearStartupKill,
  STARTUP_KILL_RETRY_MULTIPLIER,
  STARTUP_KILL_TIMEOUT_CAP,
  STARTUP_KILL_FAILURE_LIMIT,
  STARTUP_KILL_STDOUT_THRESHOLD,
} = require('../src/lib/agents-team');

describe('_isStartupKill', () => {
  it('returns true for an isTimeout error with zero stdout', () => {
    const err: any = new Error('Claude CLI timed out after 600s');
    err.isTimeout = true;
    err.stdoutLength = 0;
    err.stderrLength = 0;
    expect(_isStartupKill(err)).toBe(true);
  });

  it('returns true for an isTimeout error with sub-threshold stdout', () => {
    const err: any = new Error('Claude CLI timed out after 600s');
    err.isTimeout = true;
    err.stdoutLength = Math.max(0, STARTUP_KILL_STDOUT_THRESHOLD - 10);
    expect(_isStartupKill(err)).toBe(true);
  });

  it('returns false for an isTimeout error with substantial stdout (agent was working)', () => {
    const err: any = new Error('Claude CLI timed out after 600s');
    err.isTimeout = true;
    err.stdoutLength = STARTUP_KILL_STDOUT_THRESHOLD + 5000;
    expect(_isStartupKill(err)).toBe(false);
  });

  it('returns true for a non-zero exitCode with zero stdout (SIGTERM exit 143 path)', () => {
    const err: any = new Error('Claude CLI error (143): SIGTERM');
    err.exitCode = 143;
    err.stdoutLength = 0;
    err.stderrLength = 5;
    expect(_isStartupKill(err)).toBe(true);
  });

  it('returns false when exitCode signals a real claude error with output', () => {
    const err: any = new Error('Claude CLI error (1): Error: Reached max turns (75)');
    err.exitCode = 1;
    err.stdoutLength = 4500;
    expect(_isStartupKill(err)).toBe(false);
  });

  it('returns false for plain errors lacking diagnostic properties', () => {
    expect(_isStartupKill(new Error('ECONNRESET'))).toBe(false);
    expect(_isStartupKill(new Error('something else'))).toBe(false);
  });

  it('is safe against null/undefined inputs', () => {
    expect(_isStartupKill(null)).toBe(false);
    expect(_isStartupKill(undefined)).toBe(false);
    expect(_isStartupKill({})).toBe(false);
  });

  it('does NOT confuse max-turns failures (which have stdout) with startup kills', () => {
    const err: any = new Error('Claude CLI error (1): Error: Reached max turns (75)');
    err.exitCode = 1;
    err.stdoutLength = 12_000;
    expect(_isStartupKill(err)).toBe(false);
  });
});

describe('_scaleTimeoutForStartupKills', () => {
  it('returns the original timeout when failures = 0', () => {
    expect(_scaleTimeoutForStartupKills(600_000, 0)).toBe(600_000);
  });

  it('scales by MULTIPLIER per failure', () => {
    expect(_scaleTimeoutForStartupKills(600_000, 1)).toBe(Math.ceil(600_000 * STARTUP_KILL_RETRY_MULTIPLIER));
    expect(_scaleTimeoutForStartupKills(600_000, 2)).toBe(Math.ceil(600_000 * STARTUP_KILL_RETRY_MULTIPLIER * STARTUP_KILL_RETRY_MULTIPLIER));
  });

  it('caps at STARTUP_KILL_TIMEOUT_CAP', () => {
    expect(_scaleTimeoutForStartupKills(20 * 60_000, 5)).toBe(STARTUP_KILL_TIMEOUT_CAP);
    expect(_scaleTimeoutForStartupKills(STARTUP_KILL_TIMEOUT_CAP * 2, 0)).toBe(STARTUP_KILL_TIMEOUT_CAP * 2); // 0 failures = no scaling, so no cap applied
  });

  it('returns the original (undefined / 0) when no original budget was set', () => {
    expect(_scaleTimeoutForStartupKills(undefined, 5)).toBeUndefined();
    expect(_scaleTimeoutForStartupKills(0, 5)).toBe(0);
  });
});

describe('_getStartupKills', () => {
  it('returns 0 when no failure map exists', () => {
    expect(_getStartupKills({ data: {} }, 'k')).toBe(0);
  });

  it('returns the integer count when present', () => {
    expect(_getStartupKills({ data: { _startup_kill_failures: { k: 2 } } }, 'k')).toBe(2);
  });

  it('returns 0 for missing keys or non-numeric values', () => {
    expect(_getStartupKills({ data: { _startup_kill_failures: { other: 1 } } }, 'k')).toBe(0);
    expect(_getStartupKills({ data: { _startup_kill_failures: { k: 'oops' } } }, 'k')).toBe(0);
    expect(_getStartupKills(null, 'k')).toBe(0);
  });
});

describe('_recordStartupKill / _clearStartupKill', () => {
  it('records and accumulates per-key', () => {
    const state: any = { data: {} };
    expect(_recordStartupKill(state, 'agent-1')).toBe(1);
    expect(_recordStartupKill(state, 'agent-1')).toBe(2);
    expect(_recordStartupKill(state, 'agent-2')).toBe(1);
    expect(state.data._startup_kill_failures['agent-1']).toBe(2);
    expect(state.data._startup_kill_failures['agent-2']).toBe(1);
  });

  it('clear removes a single counter without touching others', () => {
    const state: any = { data: { _startup_kill_failures: { 'a': 1, 'b': 2 } } };
    _clearStartupKill(state, 'a');
    expect(state.data._startup_kill_failures['a']).toBeUndefined();
    expect(state.data._startup_kill_failures['b']).toBe(2);
  });

  it('clear is a no-op on missing key or shapeless state', () => {
    expect(() => _clearStartupKill({ data: {} }, 'k')).not.toThrow();
    expect(() => _clearStartupKill(null, 'k')).not.toThrow();
  });
});

describe('Fix F end-to-end retry cycle', () => {
  it('startup kill → record → scale → succeed → clear', () => {
    const state: any = { data: {} };
    const key = 'reviewer';
    const baseTimeout = 600_000;

    // First attempt fails as startup-kill.
    const after1 = _recordStartupKill(state, key);
    expect(after1).toBe(1);
    const scaled1 = _scaleTimeoutForStartupKills(baseTimeout, _getStartupKills(state, key));
    expect(scaled1).toBeGreaterThan(baseTimeout);

    // Second attempt also fails as startup-kill.
    const after2 = _recordStartupKill(state, key);
    expect(after2).toBe(2);
    const scaled2 = _scaleTimeoutForStartupKills(baseTimeout, _getStartupKills(state, key));
    expect(scaled2).toBeGreaterThan(scaled1!);

    // Third attempt succeeds — clear.
    _clearStartupKill(state, key);
    expect(_getStartupKills(state, key)).toBe(0);

    // Next attempt starts at base timeout.
    expect(_scaleTimeoutForStartupKills(baseTimeout, _getStartupKills(state, key))).toBe(baseTimeout);
  });

  it('Fix F counter is independent of Fix B counter', () => {
    const {
      _recordMaxTurnsFailure,
      _getMaxTurnsFailures,
    } = require('../src/lib/agents-team');
    const state: any = { data: {} };
    _recordStartupKill(state, 'agent');
    _recordMaxTurnsFailure(state, 'agent');
    expect(_getStartupKills(state, 'agent')).toBe(1);
    expect(_getMaxTurnsFailures(state, 'agent')).toBe(1);
    // Storage locations are different fields
    expect(state.data._startup_kill_failures.agent).toBe(1);
    expect(state.data._max_turns_failures.agent).toBe(1);
  });

  it('exposes sane defaults', () => {
    expect(STARTUP_KILL_FAILURE_LIMIT).toBeGreaterThanOrEqual(2);
    expect(STARTUP_KILL_FAILURE_LIMIT).toBeLessThanOrEqual(5);
    expect(STARTUP_KILL_RETRY_MULTIPLIER).toBeGreaterThan(1);
    expect(STARTUP_KILL_TIMEOUT_CAP).toBeGreaterThanOrEqual(10 * 60_000); // at least 10 min
    expect(STARTUP_KILL_STDOUT_THRESHOLD).toBeGreaterThanOrEqual(0);
  });
});
