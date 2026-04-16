"use strict";
// ═══════════════════════════════════════════════════════════════
// index.ts — AI Dev Agent main pipeline orchestrator
// Converted from: run-agent.js (547 lines)
//
// Jira -> Claude Code Gen -> GitLab MR -> QA -> Pre-Prod -> Production
//
// Resilience features (all integrated):
//   1. Config Snapshot & Freeze
//   2. Fresh Config Reading
//   3. Stage-Level Error Recovery
//   4. Per-Stage Timeout
//   5. Agent Restart Protection
//   6. Graceful Shutdown Chain
//   7. Notification Resilience
//   8. Claude Refusal Detection
//   9. Pipeline Health Monitor
//  10. Checkpoint & Resume
// ═══════════════════════════════════════════════════════════════
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// ── Lib modules ─────────────────────────────────────────────────
const { STAGES } = require('./lib/constants');
const { TICKET, STATE_FILE, MAX_PIPELINE_DURATION, cfg, validateConfig } = require('./lib/config');
const { C, logOk, logErr, logWarn, logInfo, logDebug, setRedactor, generateCorrelationId, getCorrelationId } = require('./lib/logging');
const { req, httpAgent, httpsAgent } = require('./lib/http-client');
const { redactSecrets, addWarning } = require('./lib/utils');
const { loadState, save, stateSecret, setCurrentState, getCurrentState } = require('./lib/state');
const { jira, resolveJiraAccountId } = require('./lib/jira');
const { gl } = require('./lib/gitlab');
const { slack, initSlack, setJiraFallback, setStateAccessor: setSlackStateAccessor, checkWebhookChange } = require('./lib/slack');
const { ensureLocalRepo, localGetTree } = require('./lib/local-repo');
// ── Resilience modules ──────────────────────────────────────────
const { captureConfigSnapshot, checkConfigOnStageEntry, getTimeout } = require('./lib/config-snapshot');
const { executeWithRecovery } = require('./lib/error-recovery');
const { withStageTimeout, checkPipelineBudget, formatTimeout } = require('./lib/stage-timeout');
const { applyRestartProtection, startStabilityMonitor } = require('./lib/restart-protection');
const { installShutdownHandlers, registerHttpAgents, registerStateFunctions, registerLockFile, onShutdown, isShuttingDown } = require('./lib/graceful-shutdown');
const { startHealthMonitor, stopHealthMonitor, recordStageChange, recordServiceSuccess, recordServiceFailure } = require('./lib/health-monitor');
const { saveCheckpoint, markStageCompleted, verifyCheckpointOnResume, applyRollback } = require('./lib/checkpoint');
// ── Optional modules (may exist from previous features) ─────────
let redactAll, detectSecrets, getPatternSummary;
try {
    const redaction = require('./lib/redaction');
    redactAll = redaction.redactAll;
    detectSecrets = redaction.detectSecrets;
    getPatternSummary = redaction.getPatternSummary;
}
catch {
    redactAll = null;
}
let setProcessRedactor;
try {
    setProcessRedactor = require('./lib/process-redactor').setProcessRedactor;
}
catch {
    setProcessRedactor = null;
}
let setAuditRedactor, loadAuditFromState, syncAuditToState;
try {
    const audit = require('./lib/notification-audit');
    setAuditRedactor = audit.setAuditRedactor;
    loadAuditFromState = audit.loadFromState;
    syncAuditToState = audit.syncToState;
}
catch {
    setAuditRedactor = null;
    loadAuditFromState = null;
    syncAuditToState = null;
}
let setNotifier, setEscalationStateAccessor, startMonitoring, stopMonitoring, evaluateRules;
try {
    const escalation = require('./lib/escalation');
    setNotifier = escalation.setNotifier;
    setEscalationStateAccessor = escalation.setStateAccessor;
    startMonitoring = escalation.startMonitoring;
    stopMonitoring = escalation.stopMonitoring;
    evaluateRules = escalation.evaluateRules;
}
catch {
    setNotifier = null;
    startMonitoring = null;
    stopMonitoring = null;
    evaluateRules = null;
}
// ── Stage handlers ──────────────────────────────────────────────
const { stageFetchTicket } = require('./stages/fetch-ticket');
const { stageExplorePlan } = require('./stages/explore-plan');
const { stageGenerateCode } = require('./stages/generate-code');
const { stageGateCodeReview } = require('./stages/gate-code-review');
const { stageDeployQA } = require('./stages/deploy-qa');
const { stageTestQA } = require('./stages/test-qa');
const { stageGatePreprodApproval } = require('./stages/gate-preprod');
const { stageCreatePreprodMR } = require('./stages/create-preprod-mr');
const { stageGateDualApproval } = require('./stages/gate-dual');
const { stageDeployProd } = require('./stages/deploy-prod');
const { stageDone } = require('./stages/done');
const { validateStageEntry, validateCompletedGates, clearDownstreamData } = require('./stages/validation');
// ── Wire up cross-module dependencies ───────────────────────────
// Redaction: use comprehensive engine if available, otherwise basic
const redactFn = redactAll || redactSecrets;
setRedactor(redactFn);
if (setProcessRedactor)
    setProcessRedactor(redactFn);
if (setAuditRedactor)
    setAuditRedactor(redactFn);
// Slack fallback chain: wire Jira comment as fallback
if (setJiraFallback)
    setJiraFallback((key, text) => jira.addComment(key, text));
if (setSlackStateAccessor)
    setSlackStateAccessor(getCurrentState);
// Escalation: wire notifier and state accessor
if (setNotifier)
    setNotifier(slack);
if (setEscalationStateAccessor)
    setEscalationStateAccessor(getCurrentState);
// [Component 6] Install graceful shutdown handlers (replaces setupErrorHandlers)
installShutdownHandlers();
registerHttpAgents([httpAgent, httpsAgent]);
registerStateFunctions(getCurrentState, save);
// ── Stage dispatch table ────────────────────────────────────────
const HANDLERS = {
    fetch_ticket: stageFetchTicket,
    explore_plan: stageExplorePlan,
    generate_code: stageGenerateCode,
    gate_code_review: stageGateCodeReview,
    deploy_qa: stageDeployQA,
    test_qa: stageTestQA,
    gate_preprod_approval: stageGatePreprodApproval,
    create_preprod_mr: stageCreatePreprodMR,
    gate_dual_approval: stageGateDualApproval,
    deploy_prod: stageDeployProd,
    done: stageDone,
};
// ── Main ────────────────────────────────────────────────────────
async function main() {
    // Handle --reset flag
    if (process.argv.includes("--reset")) {
        if (fs_1.default.existsSync(STATE_FILE))
            fs_1.default.unlinkSync(STATE_FILE);
        logOk("State reset");
    }
    // Generate a unique correlation ID for this pipeline run
    const cid = generateCorrelationId ? generateCorrelationId() : String(Date.now());
    console.log();
    console.log(`${C.bold}${C.blue}  ═══════════════════════════════════════════${C.reset}`);
    console.log(`${C.bold}${C.blue}    AI Dev Agent -- ${TICKET}  [cid:${cid}]${C.reset}`);
    console.log(`${C.bold}${C.blue}  ═══════════════════════════════════════════${C.reset}`);
    // Log redaction engine patterns for audit
    if (getPatternSummary) {
        const patterns = getPatternSummary();
        logDebug(`Redaction engine loaded: ${patterns.length} patterns (${patterns.filter((p) => p.severity === "critical").length} critical)`);
    }
    // S8: Resolve Claude CLI full path for security
    try {
        const { execSync } = require("child_process");
        const claudeVersion = execSync("claude --version", { stdio: "pipe" }).toString().trim();
        try {
            const claudeFullPath = execSync("which claude", { stdio: "pipe" }).toString().trim();
            logOk(`Claude Code CLI found at ${claudeFullPath} (${claudeVersion})`);
        }
        catch {
            logOk(`Claude Code CLI found (${claudeVersion})`);
        }
    }
    catch {
        logErr("Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code");
        process.exit(1);
    }
    // Check git CLI
    try {
        require("child_process").execSync("git --version", { stdio: "pipe" });
        logOk("Git CLI found");
    }
    catch {
        logWarn("Git CLI not found — local repo cache disabled, using GitLab API for reads");
    }
    // D5: Config validation at startup
    validateConfig(logErr, logInfo, logWarn);
    // S2: .env file permission check
    try {
        const envPath = path_1.default.resolve(__dirname, '..', '..', '..', ".env");
        if (fs_1.default.existsSync(envPath)) {
            const stat = fs_1.default.statSync(envPath);
            if (stat.mode & 0o044) {
                logWarn("S2: .env file is readable by other users! Run: chmod 600 .env");
            }
        }
    }
    catch { /* skip if stat fails */ }
    // CR5: Initialize HMAC secret for state integrity
    const secret = stateSecret();
    logDebug(`CR5: State secret loaded (${secret.substring(0, 8)}...)`);
    // X10: Validate Jira token
    try {
        logInfo("Validating Jira token...");
        const jiraTest = await req(`${cfg.jira.base}/rest/api/3/myself`, { headers: jira.h() });
        if (jiraTest.status === 200) {
            logOk(`Jira auth OK (user: ${jiraTest.data?.displayName || jiraTest.data?.emailAddress || "verified"})`);
            recordServiceSuccess("jira"); // [Component 9]
        }
        else if (jiraTest.status === 401 || jiraTest.status === 403) {
            logErr(`Jira token invalid (HTTP ${jiraTest.status}). Update JIRA_TOKEN/JIRA_EMAIL.`);
            recordServiceFailure("jira", new Error(`HTTP ${jiraTest.status}`));
            process.exit(1);
        }
        else {
            logWarn(`Jira token check returned HTTP ${jiraTest.status} — proceeding cautiously`);
        }
    }
    catch (e) {
        logWarn(`Jira token validation failed: ${e.message} — proceeding anyway`);
        recordServiceFailure("jira", e);
    }
    // X10: Validate GitLab token
    try {
        logInfo("Validating GitLab token...");
        const glTest = await req(`${cfg.gitlab.base}/api/v4/projects/${cfg.gitlab.projectId}`, { headers: gl.h() });
        if (glTest.status === 200) {
            logOk(`GitLab auth OK (project: ${glTest.data?.name || cfg.gitlab.projectId})`);
            recordServiceSuccess("gitlab"); // [Component 9]
        }
        else if (glTest.status === 401 || glTest.status === 403) {
            logErr(`GitLab token invalid (HTTP ${glTest.status}). Update GITLAB_TOKEN.`);
            recordServiceFailure("gitlab", new Error(`HTTP ${glTest.status}`));
            process.exit(1);
        }
        else {
            logWarn(`GitLab token check returned HTTP ${glTest.status} — proceeding cautiously`);
        }
    }
    catch (e) {
        logWarn(`GitLab token validation failed: ${e.message} — proceeding anyway`);
        recordServiceFailure("gitlab", e);
    }
    // S10: Warn if GitLab URL uses HTTP
    if (cfg.gitlab.base && cfg.gitlab.base.startsWith("http://")) {
        logWarn("S10: GitLab URL uses HTTP — API tokens transmitted unencrypted. Use HTTPS for production deployments.");
    }
    // Initialize Slack notification system with validation and ping
    if (initSlack) {
        const slackResult = await initSlack();
        if (slackResult.ok) {
            logOk("Slack notification system initialized and verified");
            recordServiceSuccess("slack"); // [Component 9]
        }
        else {
            logWarn(`Slack initialization: ${slackResult.reason || "not available"} -- fallback to log + Jira comments`);
            recordServiceFailure("slack", new Error(slackResult.reason || "init failed"));
        }
    }
    // E7: Dual approval same-person guard
    if (cfg.ids.owner && cfg.ids.anshit && cfg.ids.owner === cfg.ids.anshit) {
        logWarn("OWNER_JIRA_ID and ANSHIT_JIRA_ID are the same — dual approval gate will be ineffective");
    }
    if (!cfg.ids.owner && !cfg.ids.anshit) {
        const allowAny = (process.env.ALLOW_ANY_APPROVER || "false").toLowerCase() === "true";
        if (!allowAny) {
            logErr("Both OWNER_JIRA_ID and ANSHIT_JIRA_ID are empty — set ALLOW_ANY_APPROVER=true to proceed without specific approvers");
            process.exit(1);
        }
        logWarn("Both approver IDs empty but ALLOW_ANY_APPROVER=true — any Jira user can approve");
    }
    // C4: Resolve email-based Jira IDs to account IDs
    if (cfg.ids.owner) {
        cfg.ids.owner = await resolveJiraAccountId(cfg.ids.owner);
        logDebug(`C4: Owner Jira ID resolved: ${cfg.ids.owner}`);
    }
    if (cfg.ids.anshit) {
        cfg.ids.anshit = await resolveJiraAccountId(cfg.ids.anshit);
        logDebug(`C4: Anshit Jira ID resolved: ${cfg.ids.anshit}`);
    }
    // Clone/update local repo cache for fast file reads
    // If WORKTREE_PATH is set (spawned by server with per-ticket worktree), use it directly
    try {
        if (process.env.WORKTREE_PATH) {
            cfg.localRepo = process.env.WORKTREE_PATH;
            logInfo(`Using worktree path: ${cfg.localRepo}`);
            const tree = localGetTree(cfg.localRepo);
            logOk(`Local tree: ${tree.length} entries`);
        }
        else {
            cfg.localRepo = await ensureLocalRepo();
            if (cfg.localRepo) {
                const tree = localGetTree(cfg.localRepo);
                logOk(`Local tree: ${tree.length} entries`);
            }
        }
    }
    catch (e) {
        logWarn(`Local repo setup failed: ${e.message} — using GitLab API`);
        cfg.localRepo = null;
    }
    // D2: Concurrent run protection (T2.17: atomic lock with O_EXCL to fix TOCTOU race)
    const LOCK_FILE = path_1.default.resolve(__dirname, '..', '..', '..', `state-${TICKET}.lock`);
    try {
        fs_1.default.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx", mode: 0o600 });
    }
    catch (lockErr) {
        if (lockErr.code === "EEXIST") {
            // Lock file exists — check if owning process is still alive
            try {
                const lockPid = parseInt(fs_1.default.readFileSync(LOCK_FILE, "utf8").trim(), 10);
                try {
                    process.kill(lockPid, 0);
                    logErr(`Another agent running for ${TICKET} (PID ${lockPid}). Aborting.`);
                    process.exit(1);
                }
                catch {
                    // Process dead — stale lock
                    logWarn(`Stale lock file found (PID ${lockPid} not running) — removing`);
                    fs_1.default.unlinkSync(LOCK_FILE);
                    fs_1.default.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx", mode: 0o600 });
                }
            }
            catch (innerErr) {
                // Can't read lock file or re-create — try to force
                try {
                    fs_1.default.unlinkSync(LOCK_FILE);
                }
                catch { }
                fs_1.default.writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
            }
        }
        else {
            throw lockErr;
        }
    }
    registerLockFile(LOCK_FILE); // [Component 6] Register for graceful cleanup
    const state = loadState();
    // R4: Ticket mismatch validation
    if (state.ticket && state.ticket !== TICKET) {
        logErr(`State file is for ${state.ticket} but TICKET=${TICKET}. Aborting.`);
        process.exit(1);
    }
    setCurrentState(state);
    // [Component 5] Agent Restart Protection — check crash loop & apply backoff
    const restartResult = await applyRestartProtection(state, state.data._lastError ? "error_recovery" : "startup");
    if (!restartResult.proceed) {
        logErr("[Restart] Agent halted by restart protection — manual intervention required");
        save(state);
        process.exit(1);
    }
    // [Component 10] Checkpoint & Resume — verify checkpoint consistency
    const resumeCheck = verifyCheckpointOnResume(state);
    if (resumeCheck.rollback) {
        logWarn(`[Checkpoint] Applying rollback: "${state.stage}" -> "${resumeCheck.rollbackTo}"`);
        applyRollback(state, resumeCheck.rollbackTo, clearDownstreamData);
        save(state);
    }
    else if (!resumeCheck.valid) {
        logWarn(`[Checkpoint] ${resumeCheck.issues.length} issue(s) found but no rollback needed — proceeding`);
    }
    // P11: Stage validation on load
    if (state.stage && !STAGES.includes(state.stage)) {
        logWarn(`Invalid stage "${state.stage}" in state file — resetting to ${STAGES[0]}`);
        state.stage = STAGES[0];
        clearDownstreamData(state, STAGES[0]);
    }
    logInfo(`Stage: ${state.stage}`);
    logInfo(`State: ${STATE_FILE}`);
    if (getCorrelationId)
        logInfo(`Correlation ID: ${getCorrelationId()}`);
    // Load notification audit trail from state (for resumed pipelines)
    if (loadAuditFromState)
        loadAuditFromState(state);
    // P10: Pipeline start time tracking
    state.data._pipeline_start = state.data._pipeline_start || Date.now();
    // P12: Initialize warnings array
    state.data._warnings = state.data._warnings || [];
    // X2: Initialize metrics collection
    state.data._metrics = state.data._metrics || {};
    // Store correlation ID in state for tracing
    if (getCorrelationId)
        state.data._correlationId = getCorrelationId();
    // [Component 1] Capture config snapshot at first run
    if (!state.data._config_snapshot) {
        logInfo("[Config] Capturing initial config snapshot");
        state.data._config_snapshot = captureConfigSnapshot(cfg);
        save(state);
    }
    // [Component 9] Start health monitor
    const _stopHealthMonitor = startHealthMonitor(state, save);
    onShutdown("health-monitor", () => stopHealthMonitor());
    // [Component 5] Start stability monitor (resets backoff after 10min of success)
    const stopStabilityMonitorFn = startStabilityMonitor(state, save);
    onShutdown("stability-monitor", () => stopStabilityMonitorFn());
    // Start escalation monitoring (periodic check every 60s)
    if (startMonitoring)
        startMonitoring();
    // ── Main pipeline loop (resilient) ────────────────────────────
    while (state.stage !== "done") {
        // [Component 6] Check if shutdown requested
        if (isShuttingDown()) {
            logInfo("[Pipeline] Shutdown in progress — exiting loop gracefully");
            save(state);
            break;
        }
        // [Component 4] Per-stage pipeline budget check (fresh read via Component 2)
        const budget = checkPipelineBudget(state.stage, state.data._pipeline_start);
        if (!budget.ok) {
            const maxDuration = getTimeout("MAX_PIPELINE_DURATION", 86_400_000, state);
            logErr(`Pipeline exceeded maximum duration (${formatTimeout(maxDuration)})`);
            await slack(`*Pipeline Timeout -- ${TICKET}*\nPipeline exceeded ${formatTimeout(maxDuration)}. Halted at stage "${state.stage}".`, [cfg.slack.ownerId]);
            save(state);
            process.exit(1);
        }
        if (!budget.sufficientForStage) {
            logWarn(`[Budget] Remaining pipeline time (${formatTimeout(budget.remainingMs)}) is less than stage timeout (${formatTimeout(budget.requiredMs)}) for "${state.stage}" — proceeding but may timeout`);
        }
        const fn = HANDLERS[state.stage];
        if (!fn) {
            logErr(`Unknown stage: ${state.stage}`);
            process.exit(1);
        }
        // [Component 1] Check config drift on each stage entry
        checkConfigOnStageEntry(state, cfg);
        // Check if Slack webhook URL changed mid-pipeline
        if (checkWebhookChange)
            checkWebhookChange();
        // Sync notification audit trail to state before each stage
        if (syncAuditToState)
            syncAuditToState(state);
        // Evaluate escalation rules (in addition to periodic check)
        if (evaluateRules)
            evaluateRules().catch((err) => logWarn(`Escalation eval failed: ${err.message}`));
        // W1: Validate stage entry requirements
        validateStageEntry(state);
        // W2: Stage skip protection — verify all gates before prod deploy
        if (state.stage === "deploy_prod") {
            validateCompletedGates(state);
        }
        // [Component 10] Save checkpoint before stage execution
        saveCheckpoint(state, cfg);
        // [Component 9] Record stage change for progress tracking
        recordStageChange(state.stage);
        // X2: Record stage start time
        const stageStartTime = Date.now();
        const currentStageName = state.stage;
        // Write start_ts for UI live timing display
        if (!state.data._metrics[currentStageName]) {
            state.data._metrics[currentStageName] = { runs: [] };
        }
        state.data._metrics[currentStageName].start_ts = stageStartTime;
        delete state.data._metrics[currentStageName].duration_ms;
        try {
            save(state);
        }
        catch { }
        // [Component 4] Wrap handler with per-stage timeout
        const timedHandler = withStageTimeout(currentStageName, fn);
        // [Component 3] Execute with error recovery (classify + retry transient + halt permanent)
        const result = await executeWithRecovery(currentStageName, timedHandler, state, { saveState: save });
        if (result.success) {
            // W2: Track completed gates
            if (!state.data._completedGates)
                state.data._completedGates = [];
            if (!state.data._completedGates.includes(currentStageName)) {
                state.data._completedGates.push(currentStageName);
            }
            // [Component 10] Mark stage as completed for checkpoint integrity
            markStageCompleted(state, currentStageName);
            // Clear last error on success
            delete state.data._lastError;
            save(state);
        }
        else {
            // Error recovery exhausted — handle based on action
            logErr(`Stage "${currentStageName}" failed after ${result.retries} retries: ${result.error?.message}`);
            state.data._lastError = {
                stage: currentStageName,
                message: result.error?.message,
                timestamp: new Date().toISOString(),
                stack: result.error?.stack,
                classification: result.classification?.class,
                action: result.action,
                retries: result.retries,
                retryHistory: (result.retryHistory || []).map((r) => ({
                    attempt: r.attempt,
                    timestamp: r.timestamp,
                    error: r.error,
                    classification: r.classification?.class,
                })),
            };
            addWarning(state, currentStageName, `Stage failed: [${result.classification?.class}] ${result.error?.message}`);
            // [Component 7] Notify team of failure (resilient: retry + Jira fallback)
            const notifyMsg = `*Stage Failed -- ${TICKET}*\n` +
                `Stage: \`${currentStageName}\`\n` +
                `Error: ${result.error?.message}\n` +
                `Type: ${result.classification?.class}\n` +
                `Retries: ${result.retries}\n` +
                `Action: ${result.action}`;
            await slack(notifyMsg, [cfg.slack.ownerId]);
            if (result.action === "AUTH_FAILED") {
                logErr("[Recovery] Authentication failure — credentials may need updating. Halting.");
            }
            save(state);
            logInfo("Fix the issue and re-run — it will resume from this stage.");
            process.exit(1);
        }
        // CR8: Metrics — always record end time
        const stageEndTime = Date.now();
        const stageDuration = stageEndTime - stageStartTime;
        if (!state.data._metrics[currentStageName]) {
            state.data._metrics[currentStageName] = { runs: [] };
        }
        state.data._metrics[currentStageName].duration_ms = stageDuration;
        delete state.data._metrics[currentStageName].start_ts;
        state.data._metrics[currentStageName].runs.push({
            start: stageStartTime,
            end: stageEndTime,
            durationMs: stageDuration,
            durationHuman: stageDuration > 60000 ? `${(stageDuration / 60000).toFixed(1)}m` : `${(stageDuration / 1000).toFixed(1)}s`,
        });
        if (state.data._metrics[currentStageName].runs.length > 5) {
            state.data._metrics[currentStageName].runs = state.data._metrics[currentStageName].runs.slice(-5);
        }
        try {
            save(state);
        }
        catch { }
        // [Component 1] Re-snapshot config after fetch_ticket (first stage captures fresh resolved values)
        if (currentStageName === "fetch_ticket") {
            logInfo("[Config] Refreshing config snapshot after fetch_ticket");
            state.data._config_snapshot = captureConfigSnapshot(cfg);
            save(state);
        }
    }
    // Final audit trail sync before done stage
    if (syncAuditToState)
        syncAuditToState(state);
    save(state);
    // Stop monitoring
    stopHealthMonitor();
    if (stopMonitoring)
        stopMonitoring();
    await stageDone(state);
}
main().catch((e) => {
    console.error(`\n${C.red}  Fatal: ${e.message}${C.reset}`);
    console.error(e.stack);
    if (stopMonitoring)
        stopMonitoring();
    process.exit(1);
});
//# sourceMappingURL=index.js.map