// =====================================================================
// MI Dev Agent -- Pipeline Agent Runner
// =====================================================================
// TypeScript port of run-agent.js (main pipeline loop).
//
// Exports:
//   - runPipeline(ticket, config)       -- main entry point for one ticket
//   - runMultiplePipelines(tickets, config) -- parallel multi-ticket support
//   - HANDLERS                          -- stage dispatch table
//
// Architecture:
//   - Stage machine with exhaustive switch on StageName
//   - Error recovery wraps each stage (from error-recovery.ts)
//   - Stage timeout wraps each handler (from stage-timeout.ts)
//   - Stage validation guards (from validation.ts)
//   - Checkpoint saved at each stage transition
//   - Graceful shutdown integration (from lib/graceful-shutdown.ts)
//   - Config snapshot capture + drift detection per stage
//   - Metrics collection (start_ts, duration, runs)
// =====================================================================

import type {
  StageName,
  StageHandler,
  PipelineState,
  PipelineData,
  AppConfig,
} from '@shared/types';
import { STAGES } from '@shared/constants';
import {
  logOk, logErr, logWarn, logInfo, logDebug,
  C, generateCorrelationId, getCorrelationId,
} from '../lib/logger';
import { addWarning } from '../lib/utils';
import { loadConfig, loadExtendedConfig } from '../config/loader';
import {
  captureConfigSnapshot,
  checkConfigOnStageEntry,
} from '../config/snapshot';
import {
  load as loadState,
  save as saveState,
  getCurrentState,
  setCurrentState,
  stateSecret,
} from '../state/state-manager';

// -- Existing pipeline infrastructure imports ----------------------------
import { executeWithRecovery } from './error-recovery';
import {
  withStageTimeout,
  checkPipelineBudget,
  formatTimeout,
} from './stage-timeout';
import {
  validateStageEntry,
  validateCompletedGates,
  clearDownstreamData,
} from './validation';

// -- Graceful shutdown imports -------------------------------------------
import {
  isShuttingDown,
  installShutdownHandlers,
  registerStateFunctions,
} from '../lib/graceful-shutdown';

// -- Stage handler imports -----------------------------------------------
import { stageFetchTicket } from './stages/fetch-ticket';
import { stageGenerateCode } from './stages/generate-code';

// Stages that use the factory pattern (deps injection).
import { stageExplorePlan } from './stages/explore-plan';
import { createGateCodeReviewHandler } from './stages/gate-code-review';
import { createDeployQaHandler } from './stages/deploy-qa';
import { createTestQaHandler } from './stages/test-qa';
import { createGatePreprodHandler } from './stages/gate-preprod';
import { createCreatePreprodMrHandler } from './stages/create-preprod-mr';
import { createGateDualHandler } from './stages/gate-dual';
import { createDeployProdHandler } from './stages/deploy-prod';
import { createDoneHandler } from './stages/done';

// -- State manager checkUIApproval ----------------------------------------
import { checkUIApproval } from '../state/state-manager';

// Re-export shutdown utilities for external consumers
export { isShuttingDown } from '../lib/graceful-shutdown';

// =====================================================================
// Stage handler stubs for stages that require runtime dependency
// injection (factories) or are not yet fully wired. The real handlers
// are created in createHandlerRegistry() and used in the pipeline loop.
// =====================================================================

const stageStub = (name: StageName): StageHandler =>
  async (_state: PipelineState): Promise<void> => {
    throw new Error(
      `Stage "${name}" handler is a stub -- not yet wired with dependencies. ` +
      `Pass deps to runPipeline() or use createHandlerRegistry().`
    );
  };

// =====================================================================
// Stage Handler Registry
// =====================================================================

/**
 * Static dispatch table for stages that don't need runtime dependencies.
 * Used as a fallback / reference. The pipeline loop uses the dynamically
 * created registry from createHandlerRegistry().
 */
export const HANDLERS: Readonly<Record<StageName, StageHandler>> = {
  fetch_ticket:          stageFetchTicket,
  explore_plan:          stageStub('explore_plan'),       // needs deps
  generate_code:         stageGenerateCode,
  gate_code_review:      stageStub('gate_code_review'),   // needs deps
  deploy_qa:             stageStub('deploy_qa'),           // needs deps
  test_qa:               stageStub('test_qa'),             // needs deps
  gate_preprod_approval: stageStub('gate_preprod_approval'), // needs deps
  create_preprod_mr:     stageStub('create_preprod_mr'),   // needs deps
  gate_dual_approval:    stageStub('gate_dual_approval'),  // not yet ported
  deploy_prod:           stageStub('deploy_prod'),         // not yet ported
  done:                  stageStub('done'),
} as const;

/**
 * Runtime dependencies used by stage factories.
 * Injected into the pipeline at startup via createHandlerRegistry().
 */
export interface PipelineDeps {
  gl: import('../services/gitlab').GitLabService;
  jira: import('../services/jira').JiraService;
  slack: import('../services/slack').SlackService;
  claude?: import('../services/claude').ClaudeService;
}

// =====================================================================
// Agent runners -- bridge ClaudeService to explore-plan's deps interface
// =====================================================================

/** Options for running a team of agents in parallel (from explore-plan.ts) */
interface AgentsTeamOpts {
  teamName: string;
  agents: Array<{
    name: string;
    prompt: string;
    timeout: number;
    opts: Record<string, unknown>;
    required: boolean;
    checkpointKey: string;
  }>;
  state: PipelineState;
  merge: (results: Array<{ name: string; output: string | null }>) => string;
}

/** Options for running a single agent (from explore-plan.ts) */
interface SingleAgentOpts {
  name: string;
  prompt: string;
  timeout: number;
  opts: Record<string, unknown>;
  state: PipelineState;
  checkpointKey: string;
  required: boolean;
}

/**
 * Create a runAgentsTeam function backed by ClaudeService.
 * Runs agents in parallel, checks checkpoints for cached results,
 * and merges outputs.
 */
function createAgentsTeamRunner(
  claude?: import('../services/claude').ClaudeService,
): (opts: AgentsTeamOpts) => Promise<string> {
  return async (opts: AgentsTeamOpts): Promise<string> => {
    if (!claude) throw new Error(`${opts.teamName}: ClaudeService is not available`);

    logInfo(`[${opts.teamName}] Running ${opts.agents.length} agent(s) in parallel`);
    const data = opts.state.data as Record<string, unknown>;

    const settled = await Promise.allSettled(
      opts.agents.map(async (agent) => {
        // Check checkpoint -- skip if already cached
        const cached = data[agent.checkpointKey];
        if (typeof cached === 'string' && cached.length > 0) {
          logInfo(`[${opts.teamName}] ${agent.name}: using cached result`);
          return { name: agent.name, output: cached };
        }

        try {
          logInfo(`[${opts.teamName}] ${agent.name}: starting (timeout=${agent.timeout}ms)`);
          const result = await claude.callClaude(agent.prompt, agent.timeout, {
            agentName: agent.name,
            ...agent.opts,
          });
          // Cache the result
          data[agent.checkpointKey] = result;
          saveState(opts.state);
          logOk(`[${opts.teamName}] ${agent.name}: done (${result.length} chars)`);
          return { name: agent.name, output: result };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logErr(`[${opts.teamName}] ${agent.name} failed: ${msg}`);
          if (agent.required) throw err;
          return { name: agent.name, output: null };
        }
      }),
    );

    const results: Array<{ name: string; output: string | null }> = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        // Required agent already threw; optional agents get null
        results.push({ name: opts.agents[i].name, output: null });
      }
    }

    return opts.merge(results);
  };
}

/**
 * Create a runSingleAgent function backed by ClaudeService.
 * Checks checkpoint for cached result, runs the agent if not cached.
 */
function createSingleAgentRunner(
  claude?: import('../services/claude').ClaudeService,
): (opts: SingleAgentOpts) => Promise<string> {
  return async (opts: SingleAgentOpts): Promise<string> => {
    if (!claude) throw new Error(`${opts.name}: ClaudeService is not available`);

    const data = opts.state.data as Record<string, unknown>;

    // Check checkpoint
    const cached = data[opts.checkpointKey];
    if (typeof cached === 'string' && cached.length > 0) {
      logInfo(`[${opts.name}] Using cached result`);
      return cached;
    }

    logInfo(`[${opts.name}] Starting (timeout=${opts.timeout}ms)`);
    try {
      const result = await claude.callClaude(opts.prompt, opts.timeout, {
        agentName: opts.name,
        ...opts.opts,
      });
      // Cache the result
      data[opts.checkpointKey] = result;
      saveState(opts.state);
      logOk(`[${opts.name}] Done (${result.length} chars)`);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logErr(`[${opts.name}] Failed: ${msg}`);
      if (opts.required) throw err;
      return '';
    }
  };
}

/**
 * Create a fully-wired handler registry by instantiating all factory
 * stages with their runtime dependencies.
 *
 * Stages that don't need deps (fetch_ticket, generate_code) are wired
 * directly. Factory stages (gate_code_review, deploy_qa, etc.) are
 * instantiated with the provided dependencies.
 */
export function createHandlerRegistry(deps: PipelineDeps): Record<StageName, StageHandler> {
  return {
    fetch_ticket:          stageFetchTicket,
    explore_plan:          async (state: PipelineState) => {
      // explore_plan uses (state, deps) signature -- adapt to StageHandler
      await stageExplorePlan(state, {
        projectRoot: process.cwd(),
        jira: {
          addComment: (ticket: string, body: string) => deps.jira.addComment(ticket, body),
          getComments: (ticket: string, since?: string) => deps.jira.getComments(ticket, since),
        },
        gl: {
          getTree: (p: string, branch: string, recursive: boolean) =>
            deps.gl.getTree(p, branch, recursive),
        },
        slack: async (message: string, mentions?: string[]) => {
          await deps.slack.send(message, mentions);
        },
        save: (s: PipelineState) => saveState(s),
        checkUIApproval: (s: PipelineState, key: string) => checkUIApproval(s.ticket, key),
        runAgentsTeam: createAgentsTeamRunner(deps.claude),
        runSingleAgent: createSingleAgentRunner(deps.claude),
        adfText: (body: unknown) => {
          const { adfText: adfTextFn } = require('../lib/adf-parser');
          return adfTextFn(body);
        },
        adfToMarkdown: (body: unknown) => {
          const { adfToMarkdown: adfToMdFn } = require('../lib/adf-parser');
          return adfToMdFn(body);
        },
        classifyDocUrl: (url: string) => {
          const { classifyDocUrl: fn } = require('../services/jira');
          return fn(url);
        },
        getDocPasteInstructions: () => 'Please paste the document content as text',
        assessDocCriticality: () => 'MEDIUM' as const,
        jiraUrl: (ticket: string) => `${loadConfig().jira.base}/browse/${ticket}`,
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
        cfg: {
          ticket: '',  // Set per-pipeline
          localRepo: undefined,
          branch: { ts: loadConfig().branches.source },
          slack: { ownerId: loadConfig().slack.ownerSlackId || '' },
        },
        pollInterval: loadExtendedConfig().pollInterval,
        maxApprovalTimeout: 8 * 60 * 60 * 1000,
        maxContinueWait: 2 * 60 * 60 * 1000,
        maxPlanRejections: loadExtendedConfig().maxPlanRejections,
        analysisTimeoutMs: 600_000,
        applyComplexityTimeout: (baseMs: number) => baseMs,
        monotonicMs: () => {
          const [sec, nsec] = process.hrtime();
          return sec * 1000 + Math.floor(nsec / 1_000_000);
        },
      });
    },
    generate_code:         stageGenerateCode,
    gate_code_review:      createGateCodeReviewHandler({ gl: deps.gl, slack: deps.slack }),
    deploy_qa:             createDeployQaHandler({ gl: deps.gl, slack: deps.slack }),
    test_qa:               createTestQaHandler({ jira: deps.jira, slack: deps.slack }),
    gate_preprod_approval: createGatePreprodHandler({ jira: deps.jira, slack: deps.slack }),
    create_preprod_mr:     createCreatePreprodMrHandler({ gl: deps.gl }),
    gate_dual_approval:    createGateDualHandler({ jira: deps.jira, slack: deps.slack }),
    deploy_prod:           createDeployProdHandler({ gl: deps.gl, slack: deps.slack }),
    done:                  createDoneHandler({ jira: deps.jira, slack: deps.slack }),
  };
}

// =====================================================================
// Checkpoint Management
// =====================================================================

/**
 * Save a checkpoint before stage execution.
 * Records the current stage, previous stage, elapsed time, and state hash.
 */
function saveCheckpoint(state: PipelineState, _config: AppConfig): void {
  const data = state.data as Record<string, unknown>;
  const previousCheckpoint = data._checkpoint as { stage: StageName } | undefined;

  data._checkpoint = {
    stage: state.stage,
    previousStage: previousCheckpoint?.stage ?? null,
    entryTime: new Date().toISOString(),
    pipelineElapsedMs: Date.now() - ((data._pipeline_start as number) || Date.now()),
    stateHash: '', // Computed by state-manager on save
    completedGates: (data._completedGates as string[]) || [],
    version: 1,
  };
}

/**
 * Mark a stage as completed in the checkpoint history.
 */
function markStageCompleted(state: PipelineState, stageName: StageName): void {
  const data = state.data as Record<string, unknown>;
  if (!data._stage_completions) {
    data._stage_completions = {};
  }
  const completions = data._stage_completions as Record<string, { completedAt: string; stateHash: string }>;
  completions[stageName] = {
    completedAt: new Date().toISOString(),
    stateHash: '', // Computed by state-manager on save
  };
  data._last_completed_stage = stageName;
}

// =====================================================================
// Main Pipeline Loop
// =====================================================================

/**
 * Run the full pipeline for a single ticket.
 *
 * This is the main entry point that orchestrates the stage machine:
 *   1. Loads or creates pipeline state
 *   2. Validates config, tokens, and environment
 *   3. Captures config snapshot
 *   4. Iterates through stages until "done" or shutdown
 *   5. Each stage is wrapped with timeout + error recovery
 *   6. Checkpoints are saved at every stage transition
 *
 * @param ticket - Jira ticket key (e.g., "AUT-8031")
 * @param config - Application configuration
 * @param deps - Optional runtime dependencies (services). If not provided,
 *               falls back to the static HANDLERS table.
 */
export async function runPipeline(
  ticket: string,
  config: AppConfig,
  deps?: PipelineDeps,
  handlersOverride?: Record<StageName, StageHandler>,
): Promise<void> {
  // Install graceful shutdown handlers once
  installShutdownHandlers();

  const cid = generateCorrelationId();

  console.log();
  console.log(`${C.bold}${C.blue}  =====================================================${C.reset}`);
  console.log(`${C.bold}${C.blue}    AI Dev Agent -- ${ticket}  [cid:${cid}]${C.reset}`);
  console.log(`${C.bold}${C.blue}  =====================================================${C.reset}`);

  // Initialize HMAC secret
  const secret = stateSecret();
  logDebug(`State secret loaded (${secret.substring(0, 8)}...)`);

  // Load or create state
  let state = loadState(ticket);
  if (!state) {
    logInfo('No existing state found -- creating fresh state');
    state = {
      ticket,
      stage: 'fetch_ticket' as StageName,
      data: {} as PipelineData,
      _seq: 1,
    };
  }

  // Ticket mismatch validation
  if (state.ticket && state.ticket !== ticket) {
    logErr(`State file is for ${state.ticket} but ticket=${ticket}. Aborting.`);
    throw new Error(`State ticket mismatch: state=${state.ticket}, requested=${ticket}`);
  }

  setCurrentState(state);

  // Register state functions for graceful shutdown checkpoint
  registerStateFunctions(
    () => getCurrentState() as { stage: string; data: Record<string, unknown> } | null,
    (s) => saveState(s as PipelineState),
  );

  // Validate stage name
  if (state.stage && !STAGES.includes(state.stage)) {
    logWarn(`Invalid stage "${state.stage}" in state file -- resetting to ${STAGES[0]}`);
    state.stage = STAGES[0] as StageName;
    clearDownstreamData(state, STAGES[0] as StageName);
  }

  logInfo(`Stage: ${state.stage}`);
  logInfo(`Correlation ID: ${getCorrelationId()}`);

  // Initialize pipeline tracking fields
  const data = state.data as Record<string, unknown>;
  data._pipeline_start = data._pipeline_start || Date.now();
  data._warnings = data._warnings || [];
  data._metrics = data._metrics || {};
  data._correlationId = getCorrelationId();

  // Capture config snapshot at first run
  if (!data._config_snapshot) {
    logInfo('[Config] Capturing initial config snapshot');
    data._config_snapshot = captureConfigSnapshot(config);
    saveState(state);
  }

  // Build the handler registry: use override (for testing), dynamic registry
  // if deps are provided, or fall back to the static HANDLERS table.
  const handlers: Record<StageName, StageHandler> = handlersOverride
    ?? (deps ? createHandlerRegistry(deps) : { ...HANDLERS });

  // ── Main pipeline loop ──────────────────────────────────────────

  while (state.stage !== 'done') {
    // Check shutdown
    if (isShuttingDown()) {
      logInfo('[Pipeline] Shutdown in progress -- exiting loop gracefully');
      saveState(state);
      break;
    }

    // Pipeline budget check (from stage-timeout.ts)
    const budget = checkPipelineBudget(
      state.stage,
      (data._pipeline_start as number) || Date.now(),
    );
    if (!budget.ok) {
      logErr(`Pipeline exceeded maximum duration (${formatTimeout(budget.pipelineMaxMs)})`);
      saveState(state);
      throw new Error(`Pipeline exceeded maximum duration (${formatTimeout(budget.pipelineMaxMs)})`);
    }
    if (!budget.sufficientForStage) {
      logWarn(
        `[Budget] Remaining pipeline time (${formatTimeout(budget.remainingMs)}) ` +
        `is less than stage timeout (${formatTimeout(budget.requiredMs)}) ` +
        `for "${state.stage}" -- proceeding but may timeout`,
      );
    }

    // Look up handler -- exhaustive via the handlers record
    const fn = handlers[state.stage];
    if (!fn) {
      logErr(`Unknown stage: ${state.stage}`);
      throw new Error(`Unknown stage: ${state.stage}`);
    }

    // Config drift check on each stage entry (from config/snapshot.ts)
    checkConfigOnStageEntry(state, config, { warn: logWarn, debug: logDebug });

    // Stage entry validation (from validation.ts -- soft, warns only)
    validateStageEntry(state);

    // Production deploy gate validation (from validation.ts -- hard, throws)
    if (state.stage === 'deploy_prod') {
      validateCompletedGates(state);
    }

    // Save checkpoint before execution
    saveCheckpoint(state, config);

    // Record stage start time for metrics
    const stageStartTime = Date.now();
    const currentStageName = state.stage;

    const metrics = data._metrics as Record<string, { runs?: unknown[]; start_ts?: number; duration_ms?: number }>;
    if (!metrics[currentStageName]) {
      metrics[currentStageName] = { runs: [] };
    }
    metrics[currentStageName].start_ts = stageStartTime;
    delete metrics[currentStageName].duration_ms;
    try { saveState(state); } catch { /* best effort */ }

    // Wrap handler with stage timeout (from stage-timeout.ts)
    const timedHandler = withStageTimeout(currentStageName, fn);

    // Execute with error recovery (from error-recovery.ts)
    const result = await executeWithRecovery(
      currentStageName,
      timedHandler,
      state,
      { saveState: (s: PipelineState) => saveState(s) },
    );

    if (result.success) {
      // Track completed gates
      if (!data._completedGates) data._completedGates = [];
      const completedGates = data._completedGates as string[];
      if (!completedGates.includes(currentStageName)) {
        completedGates.push(currentStageName);
      }

      // Mark stage completed
      markStageCompleted(state, currentStageName);

      // Clear last error on success
      delete data._lastError;
      saveState(state);
    } else {
      // Error recovery exhausted
      logErr(
        `Stage "${currentStageName}" failed after ${result.retries} retries: ` +
        `${result.error?.message}`,
      );

      data._lastError = {
        stage: currentStageName,
        message: result.error?.message || 'Unknown error',
        classification: result.classification?.class,
        attempt: result.retries,
        timestamp: new Date().toISOString(),
      };

      addWarning(
        state,
        currentStageName,
        `Stage failed: [${result.classification?.class}] ${result.error?.message}`,
      );

      saveState(state);
      logInfo('Fix the issue and re-run -- it will resume from this stage.');
      throw new Error(
        `Stage "${currentStageName}" failed: ${result.error?.message}`,
      );
    }

    // Record stage metrics
    const stageEndTime = Date.now();
    const stageDuration = stageEndTime - stageStartTime;
    if (!metrics[currentStageName]) {
      metrics[currentStageName] = { runs: [] };
    }
    metrics[currentStageName].duration_ms = stageDuration;
    delete metrics[currentStageName].start_ts;

    const runs = (metrics[currentStageName].runs || []) as Array<{
      start: number;
      end: number;
      durationMs: number;
      durationHuman: string;
    }>;
    runs.push({
      start: stageStartTime,
      end: stageEndTime,
      durationMs: stageDuration,
      durationHuman: stageDuration > 60_000
        ? `${(stageDuration / 60_000).toFixed(1)}m`
        : `${(stageDuration / 1000).toFixed(1)}s`,
    });
    // Keep only last 5 runs per stage
    if (runs.length > 5) {
      metrics[currentStageName].runs = runs.slice(-5);
    } else {
      metrics[currentStageName].runs = runs;
    }
    try { saveState(state); } catch { /* best effort */ }

    // Re-snapshot config after fetch_ticket (ticket data may affect config)
    if (currentStageName === 'fetch_ticket') {
      logInfo('[Config] Refreshing config snapshot after fetch_ticket');
      data._config_snapshot = captureConfigSnapshot(config);
      saveState(state);
    }
  }

  // Final save
  saveState(state);

  // Execute done stage
  if (state.stage === 'done') {
    const doneHandler = handlers.done;
    await doneHandler(state);
  }
}

// =====================================================================
// Multi-Ticket Support
// =====================================================================

/**
 * Run multiple pipelines in parallel (up to maxConcurrent).
 *
 * Each ticket gets its own isolated pipeline state and execution context.
 * Failures in one pipeline do not halt others.
 *
 * @param tickets - Array of Jira ticket keys
 * @param config - Application configuration
 * @param deps - Runtime dependencies (services)
 * @param maxConcurrent - Maximum parallel pipelines (default from config)
 */
export async function runMultiplePipelines(
  tickets: string[],
  config: AppConfig,
  deps?: PipelineDeps,
  maxConcurrent?: number,
): Promise<Map<string, { success: boolean; error?: string }>> {
  const concurrency = maxConcurrent ?? config.limits.maxConcurrentAgents;
  const results = new Map<string, { success: boolean; error?: string }>();

  logInfo(`Starting ${tickets.length} pipeline(s) with max concurrency ${concurrency}`);

  // Process tickets in batches of maxConcurrent
  for (let i = 0; i < tickets.length; i += concurrency) {
    const batch = tickets.slice(i, i + concurrency);

    const batchResults = await Promise.allSettled(
      batch.map(async (ticket) => {
        logInfo(`[Multi] Starting pipeline for ${ticket}`);
        try {
          await runPipeline(ticket, { ...config, ticket }, deps);
          return { ticket, success: true };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logErr(`[Multi] Pipeline for ${ticket} failed: ${msg}`);
          return { ticket, success: false, error: msg };
        }
      }),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.set(result.value.ticket, {
          success: result.value.success,
          error: 'error' in result.value ? result.value.error as string : undefined,
        });
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        logErr(`[Multi] Batch item rejected: ${reason}`);
      }
    }

    // Check for shutdown between batches
    if (isShuttingDown()) {
      logInfo('[Multi] Shutdown requested -- skipping remaining tickets');
      for (const remaining of tickets.slice(i + concurrency)) {
        results.set(remaining, { success: false, error: 'Skipped due to shutdown' });
      }
      break;
    }
  }

  // Summary
  const succeeded = [...results.values()].filter((r) => r.success).length;
  const failed = [...results.values()].filter((r) => !r.success).length;
  logInfo(`[Multi] Complete: ${succeeded} succeeded, ${failed} failed out of ${tickets.length}`);

  return results;
}
