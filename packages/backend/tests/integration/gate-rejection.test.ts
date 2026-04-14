// =====================================================================
// Integration Test: Gate Rejection -- Rollback Behavior
// =====================================================================
// Test that rejecting at a gate rolls back to the correct stage and
// clears downstream data to prevent stale artifacts.
// =====================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Import shared types ────────────────────────────────────────────

import type { StageName, PipelineState, PipelineData } from '@mi/shared/src/types';
import { STAGE_CLEARS } from '@mi/shared/src/constants';

// ── Mock logger ────────────────────────────────────────────────────

vi.mock('../../src/lib/logger', () => ({
  logOk: vi.fn(),
  logErr: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock('../../src/lib/utils', () => ({
  addWarning: vi.fn(),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

// ── Import validation (real implementation, not mocked) ───────────

import { clearDownstreamData } from '../../src/pipeline/validation';

// ── Helpers ────────────────────────────────────────────────────────

function makeState(stage: StageName, data: Record<string, unknown> = {}): PipelineState {
  return {
    ticket: 'AUT-REJECT-1',
    stage,
    data: {
      _pipeline_start: Date.now(),
      _completedGates: [],
      _warnings: [],
      ...data,
    } as PipelineData,
    _seq: 1,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Gate Rejection -- Rollback Behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('code review gate rejection', () => {
    it('rolls back to generate_code and clears downstream data', () => {
      const state = makeState('gate_code_review', {
        // Data from fetch_ticket
        ticket: 'AUT-REJECT-1',
        ticket_summary: 'Fix button',
        // Data from explore_plan
        explore_plan: 'The plan',
        explore_plan_posted: true,
        // Data from generate_code
        codeChanges: [{ file: 'a.ts', action: 'create' }],
        code_branch: 'enterprise-ts-AUT-REJECT-1',
        code_committed: true,
        code_mr_iid: 42,
        code_mr_url: 'https://gl.test/mr/42',
        code_slack_sent: true,
        // Data from gate_code_review
        gate1_at: Date.now(),
        // QA data (should be cleared)
        qa_merged: true,
        qa_ci: 'passed',
        qa_test: { result: 'pass' },
      });

      // Simulate rejection: roll back stage and clear downstream
      state.stage = 'generate_code';
      clearDownstreamData(state, 'generate_code');

      // Upstream data should be preserved
      expect(state.data.ticket).toBe('AUT-REJECT-1');
      expect(state.data.explore_plan).toBe('The plan');

      // generate_code's downstream fields should be nullified
      const d = state.data as Record<string, unknown>;
      expect(d.codeChanges).toBeNull();
      expect(d.code_branch).toBeNull();
      expect(d.code_committed).toBeNull();
      expect(d.code_mr_iid).toBeNull();
      expect(d.code_mr_url).toBeNull();
      expect(d.code_slack_sent).toBeNull();

      // gate1_at is in generate_code's clear list
      expect(d.gate1_at).toBeNull();
      // qa_merged and qa_test are in gate_code_review/deploy_qa clear lists,
      // NOT in generate_code's, so they are NOT cleared by this call
      expect(d.qa_merged).toBe(true);
      expect(d.qa_test).toEqual({ result: 'pass' });
    });

    it('preserves ticket and plan data after code review rejection', () => {
      const state = makeState('gate_code_review', {
        ticket: 'AUT-REJECT-1',
        ticket_summary: 'Fix login',
        explore_plan: 'Detailed plan here',
        code_mr_iid: 99,
      });

      state.stage = 'generate_code';
      clearDownstreamData(state, 'generate_code');

      // These should survive (not in generate_code's STAGE_CLEARS)
      expect(state.data.ticket).toBe('AUT-REJECT-1');
      expect((state.data as Record<string, unknown>).ticket_summary).toBe('Fix login');
      // explore_plan is NOT in generate_code's clear list
      expect(state.data.explore_plan).toBe('Detailed plan here');
    });
  });

  describe('explore_plan gate rejection', () => {
    it('rolls back to explore_plan and clears plan + code + QA data', () => {
      const state = makeState('explore_plan', {
        ticket: 'AUT-REJECT-2',
        explore_plan: 'Old plan',
        explore_plan_posted: true,
        explore_plan_at: Date.now(),
        _agent_analysis: 'analysis text',
        explore_openspec: { proposal: 'md content' },
        // Code gen data that should be cleared
        codeChanges: [{ file: 'b.ts', action: 'update' }],
        code_branch: 'enterprise-ts-AUT-REJECT-2',
        code_mr_iid: 55,
      });

      // Roll back to explore_plan
      clearDownstreamData(state, 'explore_plan');

      const d = state.data as Record<string, unknown>;

      // explore_plan downstream data should be cleared
      expect(d.explore_plan).toBeNull();
      expect(d.explore_plan_posted).toBeNull();
      expect(d._agent_analysis).toBeNull();
      expect(d.explore_openspec).toBeNull();

      // generate_code downstream should also be cleared
      expect(d.codeChanges).toBeNull();
      expect(d.code_branch).toBeNull();
      expect(d.code_mr_iid).toBeNull();
    });
  });

  describe('preprod approval gate rejection', () => {
    it('rolls back to gate_preprod_approval level clearing', () => {
      const state = makeState('gate_preprod_approval', {
        qa_test: { result: 'pass' },
        gate2a_posted: true,
        gate2a_at: Date.now(),
        preprod_mr_iid: 10,
        preprod_mr_url: 'https://gl.test/mr/10',
      });

      clearDownstreamData(state, 'gate_preprod_approval');

      const d = state.data as Record<string, unknown>;
      expect(d.gate2a_posted).toBeNull();
      expect(d.gate2a_at).toBeNull();
      expect(d.preprod_mr_iid).toBeNull();
      expect(d.preprod_mr_url).toBeNull();
    });
  });

  describe('clearDownstreamData idempotency', () => {
    it('calling clearDownstreamData twice is safe (no-op on already null fields)', () => {
      const state = makeState('generate_code', {
        code_mr_iid: 42,
        code_branch: 'enterprise-ts-TEST',
      });

      clearDownstreamData(state, 'generate_code');
      clearDownstreamData(state, 'generate_code');

      const d = state.data as Record<string, unknown>;
      expect(d.code_mr_iid).toBeNull();
      expect(d.code_branch).toBeNull();
    });
  });

  describe('STAGE_CLEARS completeness', () => {
    it('every non-terminal stage has a clear list defined', () => {
      const stages: StageName[] = [
        'fetch_ticket', 'explore_plan', 'generate_code',
        'gate_code_review', 'deploy_qa', 'test_qa',
        'gate_preprod_approval', 'create_preprod_mr',
        'gate_dual_approval', 'deploy_prod', 'done',
      ];

      for (const stage of stages) {
        expect(
          STAGE_CLEARS[stage],
          `STAGE_CLEARS should have an entry for "${stage}"`
        ).toBeDefined();
        expect(Array.isArray(STAGE_CLEARS[stage])).toBe(true);
      }
    });

    it('generate_code has the most fields to clear (broadest rollback)', () => {
      const genClears = STAGE_CLEARS.generate_code;
      const otherMaxLen = Math.max(
        ...Object.entries(STAGE_CLEARS)
          .filter(([k]) => k !== 'generate_code' && k !== 'fetch_ticket')
          .map(([, v]) => v.length)
      );

      // generate_code should have more fields than any other individual stage
      // (except possibly fetch_ticket which clears everything)
      expect(genClears.length).toBeGreaterThan(otherMaxLen);
    });
  });
});
