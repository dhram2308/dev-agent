"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HANDLERS = exports.isShuttingDown = void 0;
exports.createHandlerRegistry = createHandlerRegistry;
exports.runPipeline = runPipeline;
exports.runMultiplePipelines = runMultiplePipelines;
const constants_1 = require("@shared/constants");
const logger_1 = require("../lib/logger");
const utils_1 = require("../lib/utils");
const loader_1 = require("../config/loader");
const snapshot_1 = require("../config/snapshot");
const state_manager_1 = require("../state/state-manager");
// -- Existing pipeline infrastructure imports ----------------------------
const error_recovery_1 = require("./error-recovery");
const stage_timeout_1 = require("./stage-timeout");
const validation_1 = require("./validation");
// -- Graceful shutdown imports -------------------------------------------
const graceful_shutdown_1 = require("../lib/graceful-shutdown");
// -- Stage handler imports -----------------------------------------------
const fetch_ticket_1 = require("./stages/fetch-ticket");
const generate_code_1 = require("./stages/generate-code");
// Stages that use the factory pattern (deps injection).
const explore_plan_1 = require("./stages/explore-plan");
const gate_code_review_1 = require("./stages/gate-code-review");
const deploy_qa_1 = require("./stages/deploy-qa");
const test_qa_1 = require("./stages/test-qa");
const gate_preprod_1 = require("./stages/gate-preprod");
const create_preprod_mr_1 = require("./stages/create-preprod-mr");
const gate_dual_1 = require("./stages/gate-dual");
const deploy_prod_1 = require("./stages/deploy-prod");
const done_1 = require("./stages/done");
// -- State manager checkUIApproval ----------------------------------------
const state_manager_2 = require("../state/state-manager");
// Re-export shutdown utilities for external consumers
var graceful_shutdown_2 = require("../lib/graceful-shutdown");
Object.defineProperty(exports, "isShuttingDown", { enumerable: true, get: function () { return graceful_shutdown_2.isShuttingDown; } });
// =====================================================================
// Stage handler stubs for stages that require runtime dependency
// injection (factories) or are not yet fully wired. The real handlers
// are created in createHandlerRegistry() and used in the pipeline loop.
// =====================================================================
const stageStub = (name) => async (_state) => {
    (0, logger_1.logWarn)(`Stage "${name}" handler is a stub -- not yet wired with dependencies`);
};
// =====================================================================
// Stage Handler Registry
// =====================================================================
/**
 * Static dispatch table for stages that don't need runtime dependencies.
 * Used as a fallback / reference. The pipeline loop uses the dynamically
 * created registry from createHandlerRegistry().
 */
exports.HANDLERS = {
    fetch_ticket: fetch_ticket_1.stageFetchTicket,
    explore_plan: stageStub('explore_plan'), // needs deps
    generate_code: generate_code_1.stageGenerateCode,
    gate_code_review: stageStub('gate_code_review'), // needs deps
    deploy_qa: stageStub('deploy_qa'), // needs deps
    test_qa: stageStub('test_qa'), // needs deps
    gate_preprod_approval: stageStub('gate_preprod_approval'), // needs deps
    create_preprod_mr: stageStub('create_preprod_mr'), // needs deps
    gate_dual_approval: stageStub('gate_dual_approval'), // not yet ported
    deploy_prod: stageStub('deploy_prod'), // not yet ported
    done: stageStub('done'),
};
/**
 * Create a runAgentsTeam function backed by ClaudeService.
 * Runs agents in parallel, checks checkpoints for cached results,
 * and merges outputs.
 */
function createAgentsTeamRunner(claude) {
    return async (opts) => {
        if (!claude)
            throw new Error(`${opts.teamName}: ClaudeService is not available`);
        (0, logger_1.logInfo)(`[${opts.teamName}] Running ${opts.agents.length} agent(s) in parallel`);
        const data = opts.state.data;
        const settled = await Promise.allSettled(opts.agents.map(async (agent) => {
            // Check checkpoint -- skip if already cached
            const cached = data[agent.checkpointKey];
            if (typeof cached === 'string' && cached.length > 0) {
                (0, logger_1.logInfo)(`[${opts.teamName}] ${agent.name}: using cached result`);
                return { name: agent.name, output: cached };
            }
            try {
                (0, logger_1.logInfo)(`[${opts.teamName}] ${agent.name}: starting (timeout=${agent.timeout}ms)`);
                const result = await claude.callClaude(agent.prompt, agent.timeout, {
                    agentName: agent.name,
                    ...agent.opts,
                });
                // Cache the result
                data[agent.checkpointKey] = result;
                (0, state_manager_1.save)(opts.state);
                (0, logger_1.logOk)(`[${opts.teamName}] ${agent.name}: done (${result.length} chars)`);
                return { name: agent.name, output: result };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                (0, logger_1.logErr)(`[${opts.teamName}] ${agent.name} failed: ${msg}`);
                if (agent.required)
                    throw err;
                return { name: agent.name, output: null };
            }
        }));
        const results = [];
        for (let i = 0; i < settled.length; i++) {
            const s = settled[i];
            if (s.status === 'fulfilled') {
                results.push(s.value);
            }
            else {
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
function createSingleAgentRunner(claude) {
    return async (opts) => {
        if (!claude)
            throw new Error(`${opts.name}: ClaudeService is not available`);
        const data = opts.state.data;
        // Check checkpoint
        const cached = data[opts.checkpointKey];
        if (typeof cached === 'string' && cached.length > 0) {
            (0, logger_1.logInfo)(`[${opts.name}] Using cached result`);
            return cached;
        }
        (0, logger_1.logInfo)(`[${opts.name}] Starting (timeout=${opts.timeout}ms)`);
        try {
            const result = await claude.callClaude(opts.prompt, opts.timeout, {
                agentName: opts.name,
                ...opts.opts,
            });
            // Cache the result
            data[opts.checkpointKey] = result;
            (0, state_manager_1.save)(opts.state);
            (0, logger_1.logOk)(`[${opts.name}] Done (${result.length} chars)`);
            return result;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            (0, logger_1.logErr)(`[${opts.name}] Failed: ${msg}`);
            if (opts.required)
                throw err;
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
function createHandlerRegistry(deps) {
    return {
        fetch_ticket: fetch_ticket_1.stageFetchTicket,
        explore_plan: async (state) => {
            // explore_plan uses (state, deps) signature -- adapt to StageHandler
            await (0, explore_plan_1.stageExplorePlan)(state, {
                projectRoot: process.cwd(),
                jira: {
                    addComment: (ticket, body) => deps.jira.addComment(ticket, body),
                    getComments: (ticket, since) => deps.jira.getComments(ticket, since),
                },
                gl: {
                    getTree: (p, branch, recursive) => deps.gl.getTree(p, branch, recursive),
                },
                slack: async (message, mentions) => {
                    await deps.slack.send(message, mentions);
                },
                save: (s) => (0, state_manager_1.save)(s),
                checkUIApproval: (s, key) => (0, state_manager_2.checkUIApproval)(s.ticket, key),
                runAgentsTeam: createAgentsTeamRunner(deps.claude),
                runSingleAgent: createSingleAgentRunner(deps.claude),
                adfText: (body) => {
                    const { adfText: adfTextFn } = require('../lib/adf-parser');
                    return adfTextFn(body);
                },
                adfToMarkdown: (body) => {
                    const { adfToMarkdown: adfToMdFn } = require('../lib/adf-parser');
                    return adfToMdFn(body);
                },
                classifyDocUrl: (url) => {
                    const { classifyDocUrl: fn } = require('../services/jira');
                    return fn(url);
                },
                getDocPasteInstructions: () => 'Please paste the document content as text',
                assessDocCriticality: () => 'MEDIUM',
                jiraUrl: (ticket) => `${(0, loader_1.loadConfig)().jira.base}/browse/${ticket}`,
                sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
                cfg: {
                    ticket: '', // Set per-pipeline
                    localRepo: undefined,
                    branch: { ts: (0, loader_1.loadConfig)().branches.source },
                    slack: { ownerId: (0, loader_1.loadConfig)().slack.ownerSlackId || '' },
                },
                pollInterval: (0, loader_1.loadExtendedConfig)().pollInterval,
                maxApprovalTimeout: 8 * 60 * 60 * 1000,
                maxContinueWait: 2 * 60 * 60 * 1000,
                maxPlanRejections: (0, loader_1.loadExtendedConfig)().maxPlanRejections,
                analysisTimeoutMs: 600_000,
                applyComplexityTimeout: (baseMs) => baseMs,
                monotonicMs: () => {
                    const [sec, nsec] = process.hrtime();
                    return sec * 1000 + Math.floor(nsec / 1_000_000);
                },
            });
        },
        generate_code: generate_code_1.stageGenerateCode,
        gate_code_review: (0, gate_code_review_1.createGateCodeReviewHandler)({ gl: deps.gl, slack: deps.slack }),
        deploy_qa: (0, deploy_qa_1.createDeployQaHandler)({ gl: deps.gl, slack: deps.slack }),
        test_qa: (0, test_qa_1.createTestQaHandler)({ jira: deps.jira, slack: deps.slack }),
        gate_preprod_approval: (0, gate_preprod_1.createGatePreprodHandler)({ jira: deps.jira, slack: deps.slack }),
        create_preprod_mr: (0, create_preprod_mr_1.createCreatePreprodMrHandler)({ gl: deps.gl }),
        gate_dual_approval: (0, gate_dual_1.createGateDualHandler)({ jira: deps.jira, slack: deps.slack }),
        deploy_prod: (0, deploy_prod_1.createDeployProdHandler)({ gl: deps.gl, slack: deps.slack }),
        done: (0, done_1.createDoneHandler)({ jira: deps.jira, slack: deps.slack }),
    };
}
// =====================================================================
// Checkpoint Management
// =====================================================================
/**
 * Save a checkpoint before stage execution.
 * Records the current stage, previous stage, elapsed time, and state hash.
 */
function saveCheckpoint(state, _config) {
    const data = state.data;
    const previousCheckpoint = data._checkpoint;
    data._checkpoint = {
        stage: state.stage,
        previousStage: previousCheckpoint?.stage ?? null,
        entryTime: new Date().toISOString(),
        pipelineElapsedMs: Date.now() - (data._pipeline_start || Date.now()),
        stateHash: '', // Computed by state-manager on save
        completedGates: data._completedGates || [],
        version: 1,
    };
}
/**
 * Mark a stage as completed in the checkpoint history.
 */
function markStageCompleted(state, stageName) {
    const data = state.data;
    if (!data._stage_completions) {
        data._stage_completions = {};
    }
    const completions = data._stage_completions;
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
async function runPipeline(ticket, config, deps, handlersOverride) {
    // Install graceful shutdown handlers once
    (0, graceful_shutdown_1.installShutdownHandlers)();
    const cid = (0, logger_1.generateCorrelationId)();
    console.log();
    console.log(`${logger_1.C.bold}${logger_1.C.blue}  =====================================================${logger_1.C.reset}`);
    console.log(`${logger_1.C.bold}${logger_1.C.blue}    AI Dev Agent -- ${ticket}  [cid:${cid}]${logger_1.C.reset}`);
    console.log(`${logger_1.C.bold}${logger_1.C.blue}  =====================================================${logger_1.C.reset}`);
    // Initialize HMAC secret
    const secret = (0, state_manager_1.stateSecret)();
    (0, logger_1.logDebug)(`State secret loaded (${secret.substring(0, 8)}...)`);
    // Load or create state
    let state = (0, state_manager_1.load)(ticket);
    if (!state) {
        (0, logger_1.logInfo)('No existing state found -- creating fresh state');
        state = {
            ticket,
            stage: 'fetch_ticket',
            data: {},
            _seq: 1,
        };
    }
    // Ticket mismatch validation
    if (state.ticket && state.ticket !== ticket) {
        (0, logger_1.logErr)(`State file is for ${state.ticket} but ticket=${ticket}. Aborting.`);
        throw new Error(`State ticket mismatch: state=${state.ticket}, requested=${ticket}`);
    }
    (0, state_manager_1.setCurrentState)(state);
    // Register state functions for graceful shutdown checkpoint
    (0, graceful_shutdown_1.registerStateFunctions)(() => (0, state_manager_1.getCurrentState)(), (s) => (0, state_manager_1.save)(s));
    // Validate stage name
    if (state.stage && !constants_1.STAGES.includes(state.stage)) {
        (0, logger_1.logWarn)(`Invalid stage "${state.stage}" in state file -- resetting to ${constants_1.STAGES[0]}`);
        state.stage = constants_1.STAGES[0];
        (0, validation_1.clearDownstreamData)(state, constants_1.STAGES[0]);
    }
    (0, logger_1.logInfo)(`Stage: ${state.stage}`);
    (0, logger_1.logInfo)(`Correlation ID: ${(0, logger_1.getCorrelationId)()}`);
    // Initialize pipeline tracking fields
    const data = state.data;
    data._pipeline_start = data._pipeline_start || Date.now();
    data._warnings = data._warnings || [];
    data._metrics = data._metrics || {};
    data._correlationId = (0, logger_1.getCorrelationId)();
    // Capture config snapshot at first run
    if (!data._config_snapshot) {
        (0, logger_1.logInfo)('[Config] Capturing initial config snapshot');
        data._config_snapshot = (0, snapshot_1.captureConfigSnapshot)(config);
        (0, state_manager_1.save)(state);
    }
    // Build the handler registry: use override (for testing), dynamic registry
    // if deps are provided, or fall back to the static HANDLERS table.
    const handlers = handlersOverride
        ?? (deps ? createHandlerRegistry(deps) : { ...exports.HANDLERS });
    // ── Main pipeline loop ──────────────────────────────────────────
    while (state.stage !== 'done') {
        // Check shutdown
        if ((0, graceful_shutdown_1.isShuttingDown)()) {
            (0, logger_1.logInfo)('[Pipeline] Shutdown in progress -- exiting loop gracefully');
            (0, state_manager_1.save)(state);
            break;
        }
        // Pipeline budget check (from stage-timeout.ts)
        const budget = (0, stage_timeout_1.checkPipelineBudget)(state.stage, data._pipeline_start || Date.now());
        if (!budget.ok) {
            (0, logger_1.logErr)(`Pipeline exceeded maximum duration (${(0, stage_timeout_1.formatTimeout)(budget.pipelineMaxMs)})`);
            (0, state_manager_1.save)(state);
            throw new Error(`Pipeline exceeded maximum duration (${(0, stage_timeout_1.formatTimeout)(budget.pipelineMaxMs)})`);
        }
        if (!budget.sufficientForStage) {
            (0, logger_1.logWarn)(`[Budget] Remaining pipeline time (${(0, stage_timeout_1.formatTimeout)(budget.remainingMs)}) ` +
                `is less than stage timeout (${(0, stage_timeout_1.formatTimeout)(budget.requiredMs)}) ` +
                `for "${state.stage}" -- proceeding but may timeout`);
        }
        // Look up handler -- exhaustive via the handlers record
        const fn = handlers[state.stage];
        if (!fn) {
            (0, logger_1.logErr)(`Unknown stage: ${state.stage}`);
            throw new Error(`Unknown stage: ${state.stage}`);
        }
        // Config drift check on each stage entry (from config/snapshot.ts)
        (0, snapshot_1.checkConfigOnStageEntry)(state, config, { warn: logger_1.logWarn, debug: logger_1.logDebug });
        // Stage entry validation (from validation.ts -- soft, warns only)
        (0, validation_1.validateStageEntry)(state);
        // Production deploy gate validation (from validation.ts -- hard, throws)
        if (state.stage === 'deploy_prod') {
            (0, validation_1.validateCompletedGates)(state);
        }
        // Save checkpoint before execution
        saveCheckpoint(state, config);
        // Record stage start time for metrics
        const stageStartTime = Date.now();
        const currentStageName = state.stage;
        const metrics = data._metrics;
        if (!metrics[currentStageName]) {
            metrics[currentStageName] = { runs: [] };
        }
        metrics[currentStageName].start_ts = stageStartTime;
        delete metrics[currentStageName].duration_ms;
        try {
            (0, state_manager_1.save)(state);
        }
        catch { /* best effort */ }
        // Wrap handler with stage timeout (from stage-timeout.ts)
        const timedHandler = (0, stage_timeout_1.withStageTimeout)(currentStageName, fn);
        // Execute with error recovery (from error-recovery.ts)
        const result = await (0, error_recovery_1.executeWithRecovery)(currentStageName, timedHandler, state, { saveState: (s) => (0, state_manager_1.save)(s) });
        if (result.success) {
            // Track completed gates
            if (!data._completedGates)
                data._completedGates = [];
            const completedGates = data._completedGates;
            if (!completedGates.includes(currentStageName)) {
                completedGates.push(currentStageName);
            }
            // Mark stage completed
            markStageCompleted(state, currentStageName);
            // Clear last error on success
            delete data._lastError;
            (0, state_manager_1.save)(state);
        }
        else {
            // Error recovery exhausted
            (0, logger_1.logErr)(`Stage "${currentStageName}" failed after ${result.retries} retries: ` +
                `${result.error?.message}`);
            data._lastError = {
                stage: currentStageName,
                message: result.error?.message || 'Unknown error',
                classification: result.classification?.class,
                attempt: result.retries,
                timestamp: new Date().toISOString(),
            };
            (0, utils_1.addWarning)(state, currentStageName, `Stage failed: [${result.classification?.class}] ${result.error?.message}`);
            (0, state_manager_1.save)(state);
            (0, logger_1.logInfo)('Fix the issue and re-run -- it will resume from this stage.');
            throw new Error(`Stage "${currentStageName}" failed: ${result.error?.message}`);
        }
        // Record stage metrics
        const stageEndTime = Date.now();
        const stageDuration = stageEndTime - stageStartTime;
        if (!metrics[currentStageName]) {
            metrics[currentStageName] = { runs: [] };
        }
        metrics[currentStageName].duration_ms = stageDuration;
        delete metrics[currentStageName].start_ts;
        const runs = (metrics[currentStageName].runs || []);
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
        }
        else {
            metrics[currentStageName].runs = runs;
        }
        try {
            (0, state_manager_1.save)(state);
        }
        catch { /* best effort */ }
        // Re-snapshot config after fetch_ticket (ticket data may affect config)
        if (currentStageName === 'fetch_ticket') {
            (0, logger_1.logInfo)('[Config] Refreshing config snapshot after fetch_ticket');
            data._config_snapshot = (0, snapshot_1.captureConfigSnapshot)(config);
            (0, state_manager_1.save)(state);
        }
    }
    // Final save
    (0, state_manager_1.save)(state);
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
async function runMultiplePipelines(tickets, config, deps, maxConcurrent) {
    const concurrency = maxConcurrent ?? config.limits.maxConcurrentAgents;
    const results = new Map();
    (0, logger_1.logInfo)(`Starting ${tickets.length} pipeline(s) with max concurrency ${concurrency}`);
    // Process tickets in batches of maxConcurrent
    for (let i = 0; i < tickets.length; i += concurrency) {
        const batch = tickets.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(batch.map(async (ticket) => {
            (0, logger_1.logInfo)(`[Multi] Starting pipeline for ${ticket}`);
            try {
                await runPipeline(ticket, { ...config, ticket }, deps);
                return { ticket, success: true };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                (0, logger_1.logErr)(`[Multi] Pipeline for ${ticket} failed: ${msg}`);
                return { ticket, success: false, error: msg };
            }
        }));
        for (const result of batchResults) {
            if (result.status === 'fulfilled') {
                results.set(result.value.ticket, {
                    success: result.value.success,
                    error: 'error' in result.value ? result.value.error : undefined,
                });
            }
            else {
                const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
                (0, logger_1.logErr)(`[Multi] Batch item rejected: ${reason}`);
            }
        }
        // Check for shutdown between batches
        if ((0, graceful_shutdown_1.isShuttingDown)()) {
            (0, logger_1.logInfo)('[Multi] Shutdown requested -- skipping remaining tickets');
            for (const remaining of tickets.slice(i + concurrency)) {
                results.set(remaining, { success: false, error: 'Skipped due to shutdown' });
            }
            break;
        }
    }
    // Summary
    const succeeded = [...results.values()].filter((r) => r.success).length;
    const failed = [...results.values()].filter((r) => !r.success).length;
    (0, logger_1.logInfo)(`[Multi] Complete: ${succeeded} succeeded, ${failed} failed out of ${tickets.length}`);
    return results;
}
//# sourceMappingURL=agent-runner.js.map