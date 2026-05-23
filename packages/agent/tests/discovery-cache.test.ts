/**
 * Unit tests for the discovery-cache helpers in
 * `packages/agent/src/stages/explore-plan.ts` — Fix A from the AUT-8648
 * post-mortem.
 *
 * These tests cover the pure, side-effect-free portions of the cache:
 *   - key derivation reacts to every input the architect actually reads
 *   - restore is a no-op on missing/empty/version-mismatched cache
 *   - restore on a key match populates all the fields the existing
 *     `if (!state.data.explore_plan)` guard checks
 *   - write captures everything required by a subsequent restore
 */

import { describe, it, expect, beforeEach } from 'vitest';

// explore-plan.ts uses CommonJS-style `require` for its internal deps; the
// setup file (tests/setup.ts) registers tsx's CJS hook so this resolves.
const {
  _computeDiscoveryCacheKey,
  _tryRestoreFromDiscoveryCache,
  _writeDiscoveryCache,
  DISCOVERY_CACHE_VERSION,
} = require('../src/stages/explore-plan');

function mkState(overrides: any = {}): any {
  return {
    data: {
      ticket: {
        summary: 'Add 2FA at login',
        description: 'A 2FA setup screen at first login',
        ac: 'AC1: 2FA prompt shown at first login',
        supplementaryDocs: '',
        planFeedback: '',
        ...(overrides.ticket || {}),
      },
      _refine_instructions: overrides._refine_instructions || '',
      ...overrides.data,
    },
  };
}

describe('_computeDiscoveryCacheKey', () => {
  it('produces a stable hex hash for the same state', () => {
    const a = _computeDiscoveryCacheKey(mkState());
    const b = _computeDiscoveryCacheKey(mkState());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when ticket.summary changes', () => {
    const a = _computeDiscoveryCacheKey(mkState());
    const b = _computeDiscoveryCacheKey(mkState({ ticket: { summary: 'Different' } }));
    expect(a).not.toBe(b);
  });

  it('changes when planFeedback is set (refine path)', () => {
    const a = _computeDiscoveryCacheKey(mkState());
    const b = _computeDiscoveryCacheKey(mkState({ ticket: { planFeedback: 'Make AC2 stronger' } }));
    expect(a).not.toBe(b);
  });

  it('changes when _refine_instructions is set (refine path)', () => {
    const a = _computeDiscoveryCacheKey(mkState());
    const b = _computeDiscoveryCacheKey(mkState({ _refine_instructions: 'Use modal not page' }));
    expect(a).not.toBe(b);
  });

  it('changes when supplementaryDocs change', () => {
    const a = _computeDiscoveryCacheKey(mkState());
    const b = _computeDiscoveryCacheKey(mkState({ ticket: { supplementaryDocs: 'extra design notes' } }));
    expect(a).not.toBe(b);
  });

  it('does NOT change when irrelevant state fields differ', () => {
    const a = _computeDiscoveryCacheKey(mkState());
    const stateB = mkState();
    (stateB.data as any)._unrelated_flag = 'true';
    (stateB.data as any)._metrics = { foo: 'bar' };
    const b = _computeDiscoveryCacheKey(stateB);
    expect(a).toBe(b);
  });
});

describe('_tryRestoreFromDiscoveryCache', () => {
  let state: any;

  beforeEach(() => {
    state = mkState();
  });

  it('is a no-op when no cache exists', () => {
    const key = _computeDiscoveryCacheKey(state);
    const ok = _tryRestoreFromDiscoveryCache(state, key);
    expect(ok).toBe(false);
    expect(state.data.explore_plan).toBeUndefined();
  });

  it('is a no-op when cache key does not match', () => {
    state.data._discovery_cache = {
      version: DISCOVERY_CACHE_VERSION,
      key: 'wrong-key',
      explore_plan: 'should-not-be-restored',
      createdAt: new Date().toISOString(),
    };
    const key = _computeDiscoveryCacheKey(state);
    const ok = _tryRestoreFromDiscoveryCache(state, key);
    expect(ok).toBe(false);
    expect(state.data.explore_plan).toBeUndefined();
  });

  it('is a no-op on schema version mismatch', () => {
    const key = _computeDiscoveryCacheKey(state);
    state.data._discovery_cache = {
      version: DISCOVERY_CACHE_VERSION + 99,
      key,
      explore_plan: 'should-not-be-restored',
      createdAt: new Date().toISOString(),
    };
    const ok = _tryRestoreFromDiscoveryCache(state, key);
    expect(ok).toBe(false);
    expect(state.data.explore_plan).toBeUndefined();
  });

  it('is a no-op when cached explore_plan is falsy (defensive against partial writes)', () => {
    const key = _computeDiscoveryCacheKey(state);
    state.data._discovery_cache = {
      version: DISCOVERY_CACHE_VERSION,
      key,
      explore_plan: '',
      createdAt: new Date().toISOString(),
    };
    const ok = _tryRestoreFromDiscoveryCache(state, key);
    expect(ok).toBe(false);
  });

  it('restores all architect outputs when key matches', () => {
    const key = _computeDiscoveryCacheKey(state);
    state.data._discovery_cache = {
      version: DISCOVERY_CACHE_VERSION,
      key,
      analysisResult: 'analysis-output',
      architectOutput: 'architect-raw-output',
      explore_plan: '- task 1\n- task 2',
      explore_openspec: { changeName: 'aut-1', tasks: '- task 1' },
      explore_agents: { analysis: 'analysis-output' },
      pendingQuestions: [{ id: 'q1', text: '?', options: ['a', 'b'], recommend: 0, reason: 'r' }],
      suggestions: ['[GAP] something'],
      agentCheckpoints: {
        _agent_requirements: 'req-output',
        _agent_explorer: 'expl-output',
        _agent_risk: 'risk-output',
      },
      createdAt: new Date().toISOString(),
    };
    const ok = _tryRestoreFromDiscoveryCache(state, key);
    expect(ok).toBe(true);
    expect(state.data.explore_plan).toBe('- task 1\n- task 2');
    expect(state.data._architect_result).toBe('architect-raw-output');
    expect(state.data._agent_analysis).toBe('analysis-output');
    expect(state.data._agent_requirements).toBe('req-output');
    expect(state.data._agent_explorer).toBe('expl-output');
    expect(state.data._agent_risk).toBe('risk-output');
    expect(state.data._pending_questions).toHaveLength(1);
    expect(state.data._agent_suggestions).toEqual(['[GAP] something']);
    expect(state.data.explore_openspec.changeName).toBe('aut-1');
  });
});

describe('_writeDiscoveryCache', () => {
  it('captures everything required by a subsequent restore', () => {
    const state = mkState();
    state.data.explore_plan = '- final task 1';
    state.data.explore_openspec = { changeName: 'aut-1', tasks: '- final task 1' };
    state.data.explore_agents = { analysis: 'a' };
    state.data._pending_questions = [];
    state.data._agent_suggestions = [];
    state.data._agent_requirements = 'r';
    state.data._agent_explorer = 'e';
    state.data._agent_risk = 'rk';

    const key = _computeDiscoveryCacheKey(state);
    _writeDiscoveryCache(state, key, 'analysis-blob', 'architect-blob');

    expect(state.data._discovery_cache).toBeDefined();
    expect(state.data._discovery_cache.key).toBe(key);
    expect(state.data._discovery_cache.version).toBe(DISCOVERY_CACHE_VERSION);
    expect(state.data._discovery_cache.analysisResult).toBe('analysis-blob');
    expect(state.data._discovery_cache.architectOutput).toBe('architect-blob');
    expect(state.data._discovery_cache.explore_plan).toBe('- final task 1');
    expect(state.data._discovery_cache.agentCheckpoints._agent_requirements).toBe('r');
    expect(typeof state.data._discovery_cache.createdAt).toBe('string');
  });

  it('round-trips: write then restore produces a populated state on a fresh state copy', () => {
    const state = mkState();
    state.data.explore_plan = '- task A';
    state.data.explore_openspec = { changeName: 'aut-1', tasks: '- task A' };
    state.data.explore_agents = { analysis: 'A' };
    state.data._pending_questions = [];
    state.data._agent_suggestions = [];
    state.data._agent_requirements = 'r';
    state.data._agent_explorer = 'e';
    state.data._agent_risk = 'rk';

    const key = _computeDiscoveryCacheKey(state);
    _writeDiscoveryCache(state, key, 'analysis', 'architect');

    // Simulate STAGE_CLEARS firing on rollback — clear the agent outputs
    // but leave the cache (per the design — _discovery_cache is NOT in
    // any STAGE_CLEARS entry).
    state.data.explore_plan = undefined;
    state.data.explore_openspec = undefined;
    state.data._agent_analysis = undefined;
    state.data._architect_result = undefined;
    state.data._agent_requirements = undefined;
    state.data._agent_explorer = undefined;
    state.data._agent_risk = undefined;

    const ok = _tryRestoreFromDiscoveryCache(state, _computeDiscoveryCacheKey(state));
    expect(ok).toBe(true);
    expect(state.data.explore_plan).toBe('- task A');
    expect(state.data._architect_result).toBe('architect');
    expect(state.data._agent_analysis).toBe('analysis');
    expect(state.data._agent_requirements).toBe('r');
  });

  it('refine path invalidates: same write, then user adds planFeedback → restore misses', () => {
    const state = mkState();
    state.data.explore_plan = '- task A';
    state.data.explore_openspec = { changeName: 'aut-1', tasks: '- task A' };

    const key = _computeDiscoveryCacheKey(state);
    _writeDiscoveryCache(state, key, 'analysis', 'architect');

    // User refines — planFeedback is now set.
    (state.data.ticket as any).planFeedback = 'Make AC2 stronger';

    // STAGE_CLEARS would also fire; simulate it.
    state.data.explore_plan = undefined;

    const ok = _tryRestoreFromDiscoveryCache(state, _computeDiscoveryCacheKey(state));
    expect(ok).toBe(false);
    expect(state.data.explore_plan).toBeUndefined();
  });
});
