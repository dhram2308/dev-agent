/**
 * Unit tests for Gap H — cached plan validation. Fix A locks in the
 * first successful architect output, but the architect is non-
 * deterministic and can produce structurally bad plans (kitchen-sink
 * groups exceeding the Dev-Agent budget). Without this validation, a
 * bad cached plan persists across restarts forever.
 *
 * Tests cover:
 *   1. _isCachedPlanStructurallyValid as a pure helper
 *   2. _tryRestoreFromDiscoveryCache: a hard-violating cached plan is
 *      rejected and the cache entry is dropped
 *   3. A warn-level oversized plan is accepted (Fix B handles it)
 *   4. A well-sized plan is accepted normally
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  _computeDiscoveryCacheKey,
  _tryRestoreFromDiscoveryCache,
  _writeDiscoveryCache,
  _isCachedPlanStructurallyValid,
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

const WELL_SIZED_PLAN = `
## 1. Auth Context
Update src/contexts/AuthContext.tsx and src/hooks/useAuth.ts.

## 2. Login Page
Add src/pages/Login.tsx.

## 3. Routes
Update src/routes/index.tsx.
`;

const WARN_LEVEL_PLAN = `
## 1. Multi-file Setup
Touch src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts, src/g.ts.
`;

const HARD_KITCHEN_SINK_PLAN = `
## 1. Foundation
Add src/types/a.ts.

## 2. Massive Kitchen Sink Group
Touch src/auth/login.tsx, src/auth/setup.tsx, src/auth/verify.tsx,
src/components/Modal.tsx, src/components/Form.tsx, src/components/Input.tsx,
src/services/api.ts, src/services/store.ts, src/hooks/useAuth.ts,
src/utils/validate.ts, src/utils/format.ts, src/utils/i18n.ts.
`;

describe('_isCachedPlanStructurallyValid', () => {
  it('accepts a well-sized plan (3 small groups)', () => {
    const result = _isCachedPlanStructurallyValid(WELL_SIZED_PLAN);
    expect(result.ok).toBe(true);
    expect(result.hardCount).toBe(0);
  });

  it('accepts a warn-level plan (one group at warn threshold)', () => {
    const result = _isCachedPlanStructurallyValid(WARN_LEVEL_PLAN);
    expect(result.ok).toBe(true);
    expect(result.hardCount).toBe(0);
    expect(result.warnCount).toBeGreaterThan(0);
  });

  it('rejects a plan with one kitchen-sink group (>= 10 files)', () => {
    const result = _isCachedPlanStructurallyValid(HARD_KITCHEN_SINK_PLAN);
    expect(result.ok).toBe(false);
    expect(result.hardCount).toBeGreaterThanOrEqual(1);
  });

  it('rejects empty / null / whitespace plans defensively', () => {
    expect(_isCachedPlanStructurallyValid(null).ok).toBe(false);
    expect(_isCachedPlanStructurallyValid(undefined).ok).toBe(false);
    expect(_isCachedPlanStructurallyValid('').ok).toBe(false);
    expect(_isCachedPlanStructurallyValid('   \n  \n').ok).toBe(false);
  });
});

describe('_tryRestoreFromDiscoveryCache — Gap H integration', () => {
  let state: any;

  beforeEach(() => {
    state = mkState();
  });

  it('restores from cache when the cached plan is well-sized', () => {
    const key = _computeDiscoveryCacheKey(state);
    state.data._discovery_cache = {
      version: DISCOVERY_CACHE_VERSION,
      key,
      analysisResult: 'analysis',
      architectOutput: 'architect-raw',
      explore_plan: WELL_SIZED_PLAN,
      explore_openspec: { changeName: 'aut-1', tasks: WELL_SIZED_PLAN },
      pendingQuestions: [],
      suggestions: [],
      agentCheckpoints: {},
      createdAt: new Date().toISOString(),
    };
    const ok = _tryRestoreFromDiscoveryCache(state, key);
    expect(ok).toBe(true);
    expect(state.data.explore_plan).toBe(WELL_SIZED_PLAN);
  });

  it('restores when the cached plan has warn-level oversized groups (Fix B handles them)', () => {
    const key = _computeDiscoveryCacheKey(state);
    state.data._discovery_cache = {
      version: DISCOVERY_CACHE_VERSION,
      key,
      explore_plan: WARN_LEVEL_PLAN,
      explore_openspec: {},
      agentCheckpoints: {},
      createdAt: new Date().toISOString(),
    };
    const ok = _tryRestoreFromDiscoveryCache(state, key);
    expect(ok).toBe(true);
    expect(state.data.explore_plan).toBe(WARN_LEVEL_PLAN);
  });

  it('REJECTS a kitchen-sink cached plan and drops the cache entry', () => {
    const key = _computeDiscoveryCacheKey(state);
    state.data._discovery_cache = {
      version: DISCOVERY_CACHE_VERSION,
      key,
      explore_plan: HARD_KITCHEN_SINK_PLAN,
      explore_openspec: {},
      agentCheckpoints: {},
      createdAt: new Date().toISOString(),
    };
    const ok = _tryRestoreFromDiscoveryCache(state, key);
    expect(ok).toBe(false);
    // Cache entry must be cleared so subsequent restarts also re-architect
    // until a valid plan is produced.
    expect(state.data._discovery_cache).toBeNull();
    expect(state.data.explore_plan).toBeUndefined();
  });

  it('does not invalidate the cache when key mismatches (separate concern)', () => {
    const key = _computeDiscoveryCacheKey(state);
    state.data._discovery_cache = {
      version: DISCOVERY_CACHE_VERSION,
      key: 'different-key',
      explore_plan: HARD_KITCHEN_SINK_PLAN,
      explore_openspec: {},
      agentCheckpoints: {},
      createdAt: new Date().toISOString(),
    };
    const ok = _tryRestoreFromDiscoveryCache(state, key);
    expect(ok).toBe(false);
    // Cache entry survives (a future invocation with matching inputs may
    // still use it — Gap H only invalidates on structural-validity check
    // failure, not on key mismatch).
    expect(state.data._discovery_cache).not.toBeNull();
  });

  it('Fix A + Gap H end-to-end: write a kitchen-sink plan, restore rejects + clears', () => {
    state.data.explore_plan = HARD_KITCHEN_SINK_PLAN;
    state.data.explore_openspec = {};
    const key = _computeDiscoveryCacheKey(state);
    _writeDiscoveryCache(state, key, 'analysis', 'architect');

    // Verify the cache was written.
    expect(state.data._discovery_cache).toBeDefined();
    expect(state.data._discovery_cache.explore_plan).toBe(HARD_KITCHEN_SINK_PLAN);

    // Simulate a stage rollback clearing the live explore_plan.
    state.data.explore_plan = undefined;

    // Restore should reject and clear the cache.
    const ok = _tryRestoreFromDiscoveryCache(state, _computeDiscoveryCacheKey(state));
    expect(ok).toBe(false);
    expect(state.data._discovery_cache).toBeNull();
    expect(state.data.explore_plan).toBeUndefined();
  });
});
