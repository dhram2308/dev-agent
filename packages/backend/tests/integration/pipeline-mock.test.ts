// =====================================================================
// Integration Test: Pipeline Mock -- Full Stage Progression
// =====================================================================
// Step through stages from fetch_ticket to done with all services mocked.
// Verify state transitions and data accumulation at each stage.
// =====================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineState, StageName, StageHandler, AppConfig } from '@shared/types';

// ── Mock all heavy infrastructure before importing pipeline ──────

vi.mock('../../src/lib/logger', () => ({
  logStep: vi.fn(), logOk: vi.fn(), logErr: vi.fn(), logWarn: vi.fn(),
  logInfo: vi.fn(), logDebug: vi.fn(), logWait: vi.fn(), logTrace: vi.fn(),
  log: vi.fn(), setRedactor: vi.fn(), setSseBroadcast: vi.fn(), setCorrelationId: vi.fn(),
  closeLogStream: vi.fn().mockResolvedValue(undefined), closeLogStreamSync: vi.fn(),
  createLogEntry: vi.fn(), shouldLog: vi.fn(() => true),
  C: { bold: '', blue: '', reset: '', green: '', red: '', yellow: '', dim: '', cyan: '', magenta: '', white: '' },
  generateCorrelationId: vi.fn(() => 'test-cid-001'),
  getCorrelationId: vi.fn(() => 'test-cid-001'),
}));

vi.mock('../../src/lib/utils', () => ({
  addWarning: vi.fn(), sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/config/loader', () => ({
  loadConfig: vi.fn(() => ({
    jira: { base: 'https://jira.test', token: 'tok', email: 'a@b.com' },
    gitlab: { base: 'https://gl.test', token: 'tok', projectId: 1 },
    slack: { token: 'tok', channel: '#test', ownerSlackId: 'U123' },
    branches: { source: 'enterprise-ts', qa: 'enterprise-qa', preprod: 'enterprise-pre-pro', prod: 'enterprise-master' },
    owner: { gitlabId: 123, jiraId: 'owner-1' },
    timeouts: { maxPipelineDuration: 14400000, stageTimeouts: {}, claudeTimeout: 600000 },
    flags: { runBuildCheck: false, runRuntimeTests: false, browserVerify: false, runACVerification: false },
    limits: { maxRejections: 3, maxConcurrentAgents: 2 },
  })),
  loadExtendedConfig: vi.fn(() => ({ pollInterval: 5000, maxPlanRejections: 3 })),
}));

vi.mock('../../src/config/snapshot', () => ({
  captureConfigSnapshot: vi.fn(() => ({ hash: 'snap-123' })),
  checkConfigOnStageEntry: vi.fn(),
}));

const stateStore = new Map<string, Record<string, unknown>>();

vi.mock('../../src/state/state-manager', () => ({
  load: vi.fn((ticket: string) => stateStore.get(ticket) ?? null),
  save: vi.fn((state: Record<string, unknown>) => {
    stateStore.set(state.ticket as string, JSON.parse(JSON.stringify(state)));
  }),
  getCurrentState: vi.fn(() => null),
  setCurrentState: vi.fn(),
  stateSecret: vi.fn(() => 'test-secret-hex'),
  checkUIApproval: vi.fn(() => null),
  getStateFilePath: vi.fn(() => '/tmp/test-state.json'),
}));

let mockShutdown = false;
vi.mock('../../src/lib/graceful-shutdown', () => ({
  isShuttingDown: vi.fn(() => mockShutdown),
  installShutdownHandlers: vi.fn(),
  registerStateFunctions: vi.fn(),
}));

vi.mock('../../src/pipeline/error-recovery', () => ({
  executeWithRecovery: vi.fn(async (
    _stageName: string,
    handler: (s: Record<string, unknown>) => Promise<void>,
    state: Record<string, unknown>,
  ) => {
    try {
      await handler(state);
      return { success: true, retries: 0, retryHistory: [] };
    } catch (error) {
      return { success: false, retries: 1, error, classification: { class: 'PERMANENT' }, retryHistory: [] };
    }
  }),
}));

vi.mock('../../src/pipeline/stage-timeout', () => ({
  withStageTimeout: vi.fn((_stageName: string, handler: unknown) => handler),
  checkPipelineBudget: vi.fn(() => ({
    ok: true, remainingMs: 1_000_000, requiredMs: 60_000,
    sufficientForStage: true, pipelineElapsedMs: 10_000, pipelineMaxMs: 14_400_000,
  })),
  formatTimeout: vi.fn((ms: number) => `${ms}ms`),
}));

vi.mock('../../src/pipeline/validation', () => ({
  validateStageEntry: vi.fn(), validateCompletedGates: vi.fn(), clearDownstreamData: vi.fn(),
}));

// Mock all stage handlers to prevent transitive imports
vi.mock('../../src/pipeline/stages/fetch-ticket', () => ({ stageFetchTicket: vi.fn() }));
vi.mock('../../src/pipeline/stages/generate-code', () => ({ stageGenerateCode: vi.fn() }));
vi.mock('../../src/pipeline/stages/explore-plan', () => ({ stageExplorePlan: vi.fn() }));
vi.mock('../../src/pipeline/stages/gate-code-review', () => ({ createGateCodeReviewHandler: vi.fn(() => vi.fn()) }));
vi.mock('../../src/pipeline/stages/deploy-qa', () => ({ createDeployQaHandler: vi.fn(() => vi.fn()) }));
vi.mock('../../src/pipeline/stages/test-qa', () => ({ createTestQaHandler: vi.fn(() => vi.fn()) }));
vi.mock('../../src/pipeline/stages/gate-preprod', () => ({ createGatePreprodHandler: vi.fn(() => vi.fn()) }));
vi.mock('../../src/pipeline/stages/create-preprod-mr', () => ({ createCreatePreprodMrHandler: vi.fn(() => vi.fn()) }));
vi.mock('../../src/pipeline/stages/gate-dual', () => ({ createGateDualHandler: vi.fn(() => vi.fn()) }));
vi.mock('../../src/pipeline/stages/deploy-prod', () => ({ createDeployProdHandler: vi.fn(() => vi.fn()) }));
vi.mock('../../src/pipeline/stages/done', () => ({ createDoneHandler: vi.fn(() => vi.fn()) }));

// ── Import pipeline runner after all mocks are set ──────────────

import { runPipeline } from '../../src/pipeline/agent-runner';

// ── Helpers ────────────────────────────────────────────────────────

const ORDERED_STAGES: StageName[] = [
  'fetch_ticket', 'explore_plan', 'generate_code',
  'gate_code_review', 'deploy_qa', 'test_qa',
  'gate_preprod_approval', 'create_preprod_mr',
  'gate_dual_approval', 'deploy_prod', 'done',
];

function makeAdvancingHandler(stage: StageName): StageHandler {
  return async (state: PipelineState) => {
    const idx = ORDERED_STAGES.indexOf(stage);
    const nextStage = ORDERED_STAGES[idx + 1];
    if (nextStage) state.stage = nextStage;
    (state.data as Record<string, unknown>)[`_visited_${stage}`] = true;
  };
}

function makeTestHandlers(): Record<StageName, StageHandler> {
  const handlers: Partial<Record<StageName, StageHandler>> = {};
  for (const stage of ORDERED_STAGES) {
    if (stage === 'done') {
      handlers[stage] = async (state: PipelineState) => {
        (state.data as Record<string, unknown>)._visited_done = true;
      };
    } else {
      handlers[stage] = makeAdvancingHandler(stage);
    }
  }
  return handlers as Record<StageName, StageHandler>;
}

function makeConfig(ticket: string): AppConfig {
  return {
    ticket,
    jira: { base: 'https://jira.test', token: 'tok', email: 'a@b.com' },
    gitlab: { base: 'https://gl.test', token: 'tok', projectId: 1 },
    slack: { token: 'tok', channel: '#test', ownerSlackId: 'U123' },
    branches: { source: 'enterprise-ts', qa: 'enterprise-qa', preprod: 'enterprise-pre-pro', prod: 'enterprise-master' },
    owner: { gitlabId: 123 },
    timeouts: { maxPipelineDuration: 14400000, stageTimeouts: {}, claudeTimeout: 600000 },
    flags: { runBuildCheck: false, runRuntimeTests: false, browserVerify: false, runACVerification: false },
    limits: { maxRejections: 3, maxConcurrentAgents: 2 },
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Pipeline Mock Integration', () => {
  beforeEach(() => {
    stateStore.clear();
    mockShutdown = false;
    vi.clearAllMocks();
  });

  it('progresses through all stages from fetch_ticket to done', async () => {
    const ticket = 'AUT-MOCK-1';
    const handlers = makeTestHandlers();

    // Use handlersOverride (4th arg) to inject test handlers
    await runPipeline(ticket, makeConfig(ticket), undefined, handlers);

    const savedState = stateStore.get(ticket) as PipelineState | undefined;
    expect(savedState).toBeDefined();
    expect(savedState!.stage).toBe('done');

    for (const stage of ORDERED_STAGES.filter(s => s !== 'done')) {
      expect(
        (savedState!.data as Record<string, unknown>)[`_visited_${stage}`],
        `Expected stage "${stage}" to have been visited`,
      ).toBe(true);
    }
  });

  it('accumulates data across stages', async () => {
    const ticket = 'AUT-MOCK-2';
    const handlers = makeTestHandlers();

    const originalFetch = handlers.fetch_ticket;
    handlers.fetch_ticket = async (state: PipelineState) => {
      (state.data as Record<string, unknown>).ticket_summary = 'Fix the login button';
      await originalFetch(state);
    };

    const originalGen = handlers.generate_code;
    handlers.generate_code = async (state: PipelineState) => {
      (state.data as Record<string, unknown>).code_branch = 'enterprise-ts-AUT-MOCK-2';
      (state.data as Record<string, unknown>).code_mr_iid = 42;
      await originalGen(state);
    };

    await runPipeline(ticket, makeConfig(ticket), undefined, handlers);

    const savedState = stateStore.get(ticket) as PipelineState;
    const data = savedState.data as Record<string, unknown>;

    expect(data.ticket_summary).toBe('Fix the login button');
    expect(data.code_branch).toBe('enterprise-ts-AUT-MOCK-2');
    expect(data.code_mr_iid).toBe(42);
  });

  it('saves state multiple times during pipeline execution', async () => {
    const { save: saveMock } = await import('../../src/state/state-manager');
    const ticket = 'AUT-MOCK-3';
    const handlers = makeTestHandlers();

    await runPipeline(ticket, makeConfig(ticket), undefined, handlers);

    const saveFn = saveMock as ReturnType<typeof vi.fn>;
    expect(saveFn.mock.calls.length).toBeGreaterThanOrEqual(ORDERED_STAGES.length - 1);
  });

  it('stops pipeline loop on graceful shutdown', async () => {
    const ticket = 'AUT-MOCK-4';
    const handlers = makeTestHandlers();

    const origHandler = handlers.generate_code;
    handlers.generate_code = async (state: PipelineState) => {
      mockShutdown = true;
      await origHandler(state);
    };

    await runPipeline(ticket, makeConfig(ticket), undefined, handlers);

    const savedState = stateStore.get(ticket) as PipelineState;
    expect(savedState.stage).not.toBe('done');
  });
});
