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

import fs from 'fs';
import path from 'path';

// ── Lib modules ─────────────────────────────────────────────────
const { STAGES } = require('./lib/constants') as { STAGES: readonly string[] };
const { TICKET, STATE_FILE, MAX_PIPELINE_DURATION, cfg, validateConfig } = require('./lib/config') as {
  TICKET: string;
  STATE_FILE: string;
  MAX_PIPELINE_DURATION: number;
  cfg: any;
  validateConfig: (logErr: any, logInfo: any, logWarn: any) => void;
};
const { C, logOk, logErr, logWarn, logInfo, logDebug, setRedactor, generateCorrelationId, getCorrelationId } = require('./lib/logging') as {
  C: any;
  logOk: (msg: string) => void;
  logErr: (msg: string) => void;
  logWarn: (msg: string) => void;
  logInfo: (msg: string) => void;
  logDebug: (msg: string) => void;
  setRedactor: (fn: any) => void;
  generateCorrelationId: (() => string) | null;
  getCorrelationId: (() => string) | null;
};
const { req, httpAgent, httpsAgent } = require('./lib/http-client') as {
  req: (url: string, opts?: any) => Promise<any>;
  httpAgent: any;
  httpsAgent: any;
};
const { redactSecrets, addWarning } = require('./lib/utils') as {
  redactSecrets: (s: string) => string;
  addWarning: (state: any, stage: string, message: string) => void;
};
const { loadState, save, stateSecret, setCurrentState, getCurrentState } = require('./lib/state') as {
  loadState: () => any;
  save: (state: any) => void;
  stateSecret: () => string;
  setCurrentState: (state: any) => void;
  getCurrentState: () => any;
};
const { jira, resolveJiraAccountId } = require('./lib/jira') as {
  jira: any;
  resolveJiraAccountId: (id: string) => Promise<string>;
};
const { gl } = require('./lib/gitlab') as { gl: any };
const { slack, initSlack, setJiraFallback, setStateAccessor: setSlackStateAccessor, checkWebhookChange } = require('./lib/slack') as {
  slack: (msg: string, mentions?: string[]) => Promise<void>;
  initSlack: (() => Promise<{ ok: boolean; reason?: string }>) | null;
  setJiraFallback: ((fn: (key: string, text: string) => Promise<void>) => void) | null;
  setStateAccessor: ((fn: () => any) => void) | null;
  checkWebhookChange: (() => void) | null;
};
const { ensureLocalRepo, localGetTree } = require('./lib/local-repo') as {
  ensureLocalRepo: () => Promise<string | null>;
  localGetTree: (repoPath: string) => any[];
};

// ── Resilience modules ──────────────────────────────────────────
const { captureConfigSnapshot, checkConfigOnStageEntry, getTimeout } = require('./lib/config-snapshot') as {
  captureConfigSnapshot: (cfg: any) => any;
  checkConfigOnStageEntry: (state: any, cfg: any) => void;
  getTimeout: (key: string, fallback: number, state: any) => number;
};
const { executeWithRecovery } = require('./lib/error-recovery') as {
  executeWithRecovery: (stage: string, fn: any, state: any, opts: any) => Promise<any>;
};
const { withStageTimeout, checkPipelineBudget, formatTimeout } = require('./lib/stage-timeout') as {
  withStageTimeout: (stage: string, fn: any) => any;
  checkPipelineBudget: (stage: string, startTime: number) => any;
  formatTimeout: (ms: number) => string;
};
const { applyRestartProtection, startStabilityMonitor } = require('./lib/restart-protection') as {
  applyRestartProtection: (state: any, reason: string) => Promise<{ proceed: boolean }>;
  startStabilityMonitor: (state: any, save: any) => () => void;
};
const { installShutdownHandlers, registerHttpAgents, registerStateFunctions, registerLockFile, onShutdown, isShuttingDown } = require('./lib/graceful-shutdown') as {
  installShutdownHandlers: () => void;
  registerHttpAgents: (agents: any[]) => void;
  registerStateFunctions: (getState: any, save: any) => void;
  registerLockFile: (lockFile: string) => void;
  onShutdown: (name: string, fn: () => void) => void;
  isShuttingDown: () => boolean;
};
const { startHealthMonitor, stopHealthMonitor, recordStageChange, recordServiceSuccess, recordServiceFailure } = require('./lib/health-monitor') as {
  startHealthMonitor: (state: any, save: any) => () => void;
  stopHealthMonitor: () => void;
  recordStageChange: (stage: string) => void;
  recordServiceSuccess: (service: string) => void;
  recordServiceFailure: (service: string, err: Error) => void;
};
const { saveCheckpoint, markStageCompleted, verifyCheckpointOnResume, applyRollback } = require('./lib/checkpoint') as {
  saveCheckpoint: (state: any, cfg: any) => void;
  markStageCompleted: (state: any, stage: string) => void;
  verifyCheckpointOnResume: (state: any) => any;
  applyRollback: (state: any, rollbackTo: string, clearFn: any) => void;
};

// ── Optional modules (may exist from previous features) ─────────
let redactAll: ((s: string) => string) | null, detectSecrets: any, getPatternSummary: (() => any[]) | null;
try {
  const redaction = require('./lib/redaction');
  redactAll = redaction.redactAll;
  detectSecrets = redaction.detectSecrets;
  getPatternSummary = redaction.getPatternSummary;
} catch { redactAll = null; }

let setProcessRedactor: ((fn: any) => void) | null;
try { setProcessRedactor = require('./lib/process-redactor').setProcessRedactor; } catch { setProcessRedactor = null; }

let setAuditRedactor: any, loadAuditFromState: any, syncAuditToState: any;
try {
  const audit = require('./lib/notification-audit');
  setAuditRedactor = audit.setAuditRedactor;
  loadAuditFromState = audit.loadFromState;
  syncAuditToState = audit.syncToState;
} catch { setAuditRedactor = null; loadAuditFromState = null; syncAuditToState = null; }

let setNotifier: any, setEscalationStateAccessor: any, startMonitoring: (() => void) | null, stopMonitoring: (() => void) | null, evaluateRules: (() => Promise<void>) | null;
try {
  const escalation = require('./lib/escalation');
  setNotifier = escalation.setNotifier;
  setEscalationStateAccessor = escalation.setStateAccessor;
  startMonitoring = escalation.startMonitoring;
  stopMonitoring = escalation.stopMonitoring;
  evaluateRules = escalation.evaluateRules;
} catch { setNotifier = null; startMonitoring = null; stopMonitoring = null; evaluateRules = null; }

// ── Stage handlers ──────────────────────────────────────────────
const { stageFetchTicket } = require('./stages/fetch-ticket') as { stageFetchTicket: (state: any) => Promise<void> };
const { stageExplorePlan } = require('./stages/explore-plan') as { stageExplorePlan: (state: any) => Promise<void> };
const { stageGenerateCode } = require('./stages/generate-code') as { stageGenerateCode: (state: any) => Promise<void> };
const { stageGateCodeReview } = require('./stages/gate-code-review') as { stageGateCodeReview: (state: any) => Promise<void> };
const { stageDeployQA } = require('./stages/deploy-qa') as { stageDeployQA: (state: any) => Promise<void> };
const { stageTestQA } = require('./stages/test-qa') as { stageTestQA: (state: any) => Promise<void> };
const { stageGatePreprodApproval } = require('./stages/gate-preprod') as { stageGatePreprodApproval: (state: any) => Promise<void> };
const { stageCreatePreprodMR } = require('./stages/create-preprod-mr') as { stageCreatePreprodMR: (state: any) => Promise<void> };
const { stageGateDualApproval } = require('./stages/gate-dual') as { stageGateDualApproval: (state: any) => Promise<void> };
const { stageDeployProd } = require('./stages/deploy-prod') as { stageDeployProd: (state: any) => Promise<void> };
const { stageDone } = require('./stages/done') as { stageDone: (state: any) => Promise<void> };
const { validateStageEntry, validateCompletedGates, clearDownstreamData } = require('./stages/validation') as {
  validateStageEntry: (state: any) => void;
  validateCompletedGates: (state: any) => void;
  clearDownstreamData: (state: any, stage: string) => void;
};

// ── Wire up cross-module dependencies ───────────────────────────
// Redaction: use comprehensive engine if available, otherwise basic
const redactFn = redactAll || redactSecrets;
setRedactor(redactFn);
if (setProcessRedactor) setProcessRedactor(redactFn);
if (setAuditRedactor) setAuditRedactor(redactFn);

// Slack fallback chain: wire Jira comment as fallback
if (setJiraFallback) setJiraFallback((key: string, text: string) => jira.addComment(key, text));
if (setSlackStateAccessor) setSlackStateAccessor(getCurrentState);

// Escalation: wire notifier and state accessor
if (setNotifier) setNotifier(slack);
if (setEscalationStateAccessor) setEscalationStateAccessor(getCurrentState);

// [Component 6] Install graceful shutdown handlers (replaces setupErrorHandlers)
installShutdownHandlers();
registerHttpAgents([httpAgent, httpsAgent]);
registerStateFunctions(getCurrentState, save);

// ── Stage dispatch table ────────────────────────────────────────
const HANDLERS: Record<string, (state: any) => Promise<void>> = {
  fetch_ticket:          stageFetchTicket,
  explore_plan:          stageExplorePlan,
  generate_code:         stageGenerateCode,
  gate_code_review:      stageGateCodeReview,
  deploy_qa:             stageDeployQA,
  test_qa:               stageTestQA,
  gate_preprod_approval: stageGatePreprodApproval,
  create_preprod_mr:     stageCreatePreprodMR,
  gate_dual_approval:    stageGateDualApproval,
  deploy_prod:           stageDeployProd,
  done:                  stageDone,
};

// ── Main ────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Handle --reset flag
  if (process.argv.includes("--reset")) {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
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
    logDebug(`Redaction engine loaded: ${patterns.length} patterns (${patterns.filter((p: any) => p.severity === "critical").length} critical)`);
  }

  // S8: Resolve Claude CLI full path for security
  try {
    const { execSync } = require("child_process");
    const claudeVersion = execSync("claude --version", { stdio: "pipe" }).toString().trim();
    try {
      const claudeFullPath = execSync("which claude", { stdio: "pipe" }).toString().trim();
      logOk(`Claude Code CLI found at ${claudeFullPath} (${claudeVersion})`);
    } catch {
      logOk(`Claude Code CLI found (${claudeVersion})`);
    }
  } catch {
    logErr("Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  // Check git CLI
  try {
    require("child_process").execSync("git --version", { stdio: "pipe" });
    logOk("Git CLI found");
  } catch {
    logWarn("Git CLI not found — local repo cache disabled, using GitLab API for reads");
  }

  // D5: Config validation at startup
  validateConfig(logErr, logInfo, logWarn);

  // S2: .env file permission check
  try {
    const envPath = path.resolve(__dirname, '..', '..', '..', ".env");
    if (fs.existsSync(envPath)) {
      const stat = fs.statSync(envPath);
      if ((stat.mode as number) & 0o044) {
        logWarn("S2: .env file is readable by other users! Run: chmod 600 .env");
      }
    }
  } catch { /* skip if stat fails */ }

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
    } else if (jiraTest.status === 401 || jiraTest.status === 403) {
      logErr(`Jira token invalid (HTTP ${jiraTest.status}). Update JIRA_TOKEN/JIRA_EMAIL.`);
      recordServiceFailure("jira", new Error(`HTTP ${jiraTest.status}`));
      process.exit(1);
    } else {
      logWarn(`Jira token check returned HTTP ${jiraTest.status} — proceeding cautiously`);
    }
  } catch (e: any) {
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
    } else if (glTest.status === 401 || glTest.status === 403) {
      logErr(`GitLab token invalid (HTTP ${glTest.status}). Update GITLAB_TOKEN.`);
      recordServiceFailure("gitlab", new Error(`HTTP ${glTest.status}`));
      process.exit(1);
    } else {
      logWarn(`GitLab token check returned HTTP ${glTest.status} — proceeding cautiously`);
    }
  } catch (e: any) {
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
    } else {
      logWarn(`Slack initialization: ${slackResult.reason || "not available"} -- fallback to log + Jira comments`);
      recordServiceFailure("slack", new Error(slackResult.reason || "init failed"));
    }
  }

  // E7: Dual approval same-person guard
  if (cfg.ids.owner && cfg.ids.qa && cfg.ids.owner === cfg.ids.qa) {
    logWarn("OWNER_JIRA_ID and QA_JIRA_ID are the same — dual approval gate will be ineffective");
  }
  if (!cfg.ids.owner && !cfg.ids.qa) {
    const allowAny = (process.env.ALLOW_ANY_APPROVER || "false").toLowerCase() === "true";
    if (!allowAny) {
      logErr("Both OWNER_JIRA_ID and QA_JIRA_ID are empty — set ALLOW_ANY_APPROVER=true to proceed without specific approvers");
      process.exit(1);
    }
    logWarn("Both approver IDs empty but ALLOW_ANY_APPROVER=true — any Jira user can approve");
  }

  // C4: Resolve email-based Jira IDs to account IDs
  if (cfg.ids.owner) {
    cfg.ids.owner = await resolveJiraAccountId(cfg.ids.owner);
    logDebug(`C4: Owner Jira ID resolved: ${cfg.ids.owner}`);
  }
  if (cfg.ids.qa) {
    cfg.ids.qa = await resolveJiraAccountId(cfg.ids.qa);
    logDebug(`C4: QA Jira ID resolved: ${cfg.ids.qa}`);
  }

  // Clone/update local repo cache for fast file reads
  // If WORKTREE_PATH is set (spawned by server with per-ticket worktree), use it directly
  try {
    if (process.env.WORKTREE_PATH) {
      cfg.localRepo = process.env.WORKTREE_PATH;
      logInfo(`Using worktree path: ${cfg.localRepo}`);
      const tree = localGetTree(cfg.localRepo);
      logOk(`Local tree: ${tree.length} entries`);
    } else {
      cfg.localRepo = await ensureLocalRepo();
      if (cfg.localRepo) {
        const tree = localGetTree(cfg.localRepo);
        logOk(`Local tree: ${tree.length} entries`);
      }
    }
  } catch (e: any) {
    logWarn(`Local repo setup failed: ${e.message} — using GitLab API`);
    cfg.localRepo = null;
  }

  // D2: Concurrent run protection (T2.17: atomic lock with O_EXCL to fix TOCTOU race)
  const LOCK_FILE = path.resolve(__dirname, '..', '..', '..', `state-${TICKET}.lock`);
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (lockErr: any) {
    if (lockErr.code === "EEXIST") {
      // Lock file exists — check if owning process is still alive.
      // C6: PID is not enough — the kernel reuses PIDs, so process.kill(pid,0)
      // succeeding can mean "an unrelated process now has that PID". Combine
      // with a lock-file mtime check: if the lock is older than LOCK_STALE_MS
      // and no process exists with that PID running our binary, treat as stale.
      const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes — longer than any healthy heartbeat cadence
      try {
        const lockPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
        let lockMtimeMs = 0;
        try { lockMtimeMs = fs.statSync(LOCK_FILE).mtimeMs; } catch {}
        const lockAgeMs = lockMtimeMs > 0 ? Date.now() - lockMtimeMs : Infinity;
        let pidAlive = false;
        try { process.kill(lockPid, 0); pidAlive = true; } catch { pidAlive = false; }

        if (pidAlive && lockAgeMs <= LOCK_STALE_MS) {
          logErr(`Another agent running for ${TICKET} (PID ${lockPid}, lock age ${Math.round(lockAgeMs / 1000)}s). Aborting.`);
          process.exit(1);
        }
        if (pidAlive && lockAgeMs > LOCK_STALE_MS) {
          // PID alive but lock is ancient — almost certainly a recycled PID
          // belonging to another process. Treat as stale.
          logWarn(`Lock file held by PID ${lockPid} but ${Math.round(lockAgeMs / 1000)}s old — assuming recycled PID, removing`);
        } else {
          logWarn(`Stale lock file found (PID ${lockPid} not running) — removing`);
        }
        fs.unlinkSync(LOCK_FILE);
        fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx", mode: 0o600 });
      } catch (innerErr: any) {
        // Can't read lock file or re-create — try to force
        try { fs.unlinkSync(LOCK_FILE); } catch {}
        fs.writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
      }
    } else {
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

  // C7: Reap ghost _active_agents from a prior crashed run. Any entry here
  // was owned by a Node process that no longer exists (this is `main()` —
  // we've just acquired the lock, so no parallel run is in flight). Leaving
  // ghost entries would corrupt the UI's live-agents view and confuse the
  // checkpoint/resume snapshot.
  if (Array.isArray(state.data._active_agents) && state.data._active_agents.length > 0) {
    const ghostNames = state.data._active_agents.map((a: any) => (a && a.name) || String(a)).join(", ");
    logWarn(`[Resume] Clearing ${state.data._active_agents.length} ghost active agent(s) from prior run: ${ghostNames}`);
    state.data._active_agents = [];
    try { save(state); } catch {}
  }

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
  } else if (!resumeCheck.valid) {
    logWarn(`[Checkpoint] ${resumeCheck.issues.length} issue(s) found but no rollback needed — proceeding`);
  }

  // P11: Stage validation on load
  if (state.stage && !(STAGES as readonly string[]).includes(state.stage)) {
    logWarn(`Invalid stage "${state.stage}" in state file — resetting to ${STAGES[0]}`);
    state.stage = STAGES[0];
    clearDownstreamData(state, STAGES[0] as string);
  }

  logInfo(`Stage: ${state.stage}`);
  logInfo(`State: ${STATE_FILE}`);
  if (getCorrelationId) logInfo(`Correlation ID: ${getCorrelationId()}`);

  // Load notification audit trail from state (for resumed pipelines)
  if (loadAuditFromState) loadAuditFromState(state);

  // P10: Pipeline start time tracking
  state.data._pipeline_start = state.data._pipeline_start || Date.now();
  // P12: Initialize warnings array
  state.data._warnings = state.data._warnings || [];
  // X2: Initialize metrics collection
  state.data._metrics = state.data._metrics || {};
  // Store correlation ID in state for tracing
  if (getCorrelationId) state.data._correlationId = getCorrelationId();

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
  if (startMonitoring) startMonitoring();

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
    if (!fn) { logErr(`Unknown stage: ${state.stage}`); process.exit(1); }

    // [Component 1] Check config drift on each stage entry
    checkConfigOnStageEntry(state, cfg);

    // Check if Slack webhook URL changed mid-pipeline
    if (checkWebhookChange) checkWebhookChange();

    // Sync notification audit trail to state before each stage
    if (syncAuditToState) syncAuditToState(state);

    // Evaluate escalation rules (in addition to periodic check)
    if (evaluateRules) evaluateRules().catch((err: any) => logWarn(`Escalation eval failed: ${err.message}`));

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
    try { save(state); } catch {}

    // [Component 4] Wrap handler with per-stage timeout
    const timedHandler = withStageTimeout(currentStageName, fn);

    // [Component 3] Execute with error recovery (classify + retry transient + halt permanent)
    const result = await executeWithRecovery(currentStageName, timedHandler, state, { saveState: save });

    if (result.success) {
      // W2: Track completed gates
      if (!state.data._completedGates) state.data._completedGates = [];
      if (!state.data._completedGates.includes(currentStageName)) {
        state.data._completedGates.push(currentStageName);
      }
      // [Component 10] Mark stage as completed for checkpoint integrity
      markStageCompleted(state, currentStageName);
      // Clear last error on success
      delete state.data._lastError;
      save(state);
    } else {
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
        retryHistory: (result.retryHistory || []).map((r: any) => ({
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
    try { save(state); } catch {}

    // [Component 1] Re-snapshot config after fetch_ticket (first stage captures fresh resolved values)
    if (currentStageName === "fetch_ticket") {
      logInfo("[Config] Refreshing config snapshot after fetch_ticket");
      state.data._config_snapshot = captureConfigSnapshot(cfg);
      save(state);
    }
  }

  // Final audit trail sync before done stage
  if (syncAuditToState) syncAuditToState(state);
  save(state);

  // Stop monitoring
  stopHealthMonitor();
  if (stopMonitoring) stopMonitoring();

  await stageDone(state);
}

main().catch((e: any) => {
  console.error(`\n${C.red}  Fatal: ${e.message}${C.reset}`);
  console.error(e.stack);
  if (stopMonitoring) stopMonitoring();
  process.exit(1);
});
