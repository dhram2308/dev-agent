"use strict";
// ═══════════════════════════════════════════════════════════════
// server/agent-process.ts — Agent child process management
// Converted from: server/agent-process.js (259 lines)
// ═══════════════════════════════════════════════════════════════
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.STAGE_DATA_MAP = void 0;
exports.setSseModule = setSseModule;
exports.setTokenManager = setTokenManager;
exports.startAgent = startAgent;
exports.stopAgent = stopAgent;
exports.checkProcessHealth = checkProcessHealth;
exports.cleanOrphanedLocks = cleanOrphanedLocks;
exports.cleanOrphanedWorktreesOnStartup = cleanOrphanedWorktreesOnStartup;
exports.getAgentProcs = getAgentProcs;
exports.getAuthWaitingTickets = getAuthWaitingTickets;
exports.clearAuthTimeout = clearAuthTimeout;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
let _sseModule = null;
function _loadDefaultSse() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./sse');
}
function _sse() {
    if (!_sseModule)
        _sseModule = _loadDefaultSse();
    return _sseModule;
}
function setSseModule(mod) {
    _sseModule = mod;
}
const addLog = (line, type, ticket) => _sse().addLog(line, type, ticket);
const broadcast = (event, data) => _sse().broadcast(event, data);
const clearTicketLogs = (ticket) => _sse().clearTicketLogs(ticket);
const { loadEnv, getState } = require('./state-io');
const { wrapProcessOutput, setProcessRedactor } = require('../lib/process-redactor');
const { redactAll } = require('../lib/redaction');
const { ensureLocalRepo, createWorktree, removeWorktree, cleanOrphanedWorktrees } = require('../lib/local-repo');
// Wire redaction into process output interceptor
setProcessRedactor(redactAll);
// ── Resilience modules ──────────────────────────────────────────
const { trackChildProcess, untrackChildProcess } = require('../lib/graceful-shutdown');
// Restart protection: backoff on rapid restarts per ticket
let applyRestartProtection;
let checkCrashLoop;
try {
    const rp = require('../lib/restart-protection');
    applyRestartProtection = rp.applyRestartProtection;
    checkCrashLoop = rp.checkCrashLoop;
}
catch (e) {
    console.warn("[Agent] restart-protection module not available:", e.message);
    applyRestartProtection = null;
    checkCrashLoop = null;
}
// Escalation: alert on repeated failures
let escalateImmediate;
try {
    escalateImmediate = require('../lib/escalation').escalateImmediate;
}
catch (e) {
    console.warn("[Agent] escalation module not available:", e.message);
    escalateImmediate = null;
}
let _tokenManager = null;
/** Inject the TokenManager so agent-process can fetch fresh tokens before spawn */
function setTokenManager(tm) {
    _tokenManager = tm;
}
// [OAuth] Exit code 78 = AUTH_REFRESH_NEEDED (sysexits.h EX_CONFIG)
const EXIT_AUTH_REFRESH = 78;
const MAX_AUTH_RESPAWNS_PER_PROVIDER = 3;
// [OAuth] Auth timeout: how long to wait for re-auth before failing the pipeline.
// Default 120 minutes (2 hours). Configurable via AUTH_TIMEOUT_MIN env var.
const AUTH_TIMEOUT_MIN = Math.max(1, parseInt(process.env.AUTH_TIMEOUT_MIN, 10) || 120);
const AUTH_TIMEOUT_MS = AUTH_TIMEOUT_MIN * 60 * 1000;
// Per-ticket auth timeout timers. When a pipeline enters PAUSED_AUTH_REQUIRED
// (i.e. authRequired is broadcast), a countdown starts. If the user does not
// re-auth and resume within AUTH_TIMEOUT_MIN, the pipeline transitions to FAILED.
const _authTimeouts = {};
/**
 * Start the auth-timeout countdown for a ticket.
 * If a timer already exists for the ticket it is replaced.
 */
function startAuthTimeout(ticket, provider) {
    clearAuthTimeout(ticket);
    addLog(`[OAuth] Auth timeout started for ${ticket} (${AUTH_TIMEOUT_MIN}m). Re-authorize ${provider} before it expires.`, "system", ticket);
    const timer = setTimeout(() => {
        delete _authTimeouts[ticket];
        addLog(`[OAuth] Auth timeout expired for ${ticket} after ${AUTH_TIMEOUT_MIN}m waiting for ${provider} re-authorization. Pipeline FAILED.`, "system", ticket);
        broadcast("status", { running: false, code: "AUTH_TIMEOUT", ticket });
    }, AUTH_TIMEOUT_MS);
    // Allow the Node.js process to exit even if the timer is active
    timer.unref();
    _authTimeouts[ticket] = timer;
}
/**
 * Clear any pending auth-timeout timer for a ticket.
 */
function clearAuthTimeout(ticket) {
    if (_authTimeouts[ticket]) {
        clearTimeout(_authTimeouts[ticket]);
        delete _authTimeouts[ticket];
    }
}
/**
 * Get the set of tickets currently waiting for auth re-authorization.
 * Useful for the resume path: if a connector reconnects, check if any
 * ticket was waiting on that provider.
 */
function getAuthWaitingTickets() {
    return { ..._authWaitingMeta };
}
// Track which provider each ticket is waiting on (for resume lookup)
const _authWaitingMeta = {};
// Navigate to project root: at runtime __dirname is packages/agent/dist/server/
// so ../../../../ = project root. With source (src/server/) the extra depth is the same.
const BASE_DIR = path_1.default.resolve(__dirname, '..', '..', '..', '..');
// X1: Multi-ticket concurrency -- map of ticket -> child process
const agentProcs = {};
const agentRedactors = {}; // Track redactor cleanup functions per ticket
const MAX_CONCURRENT_AGENTS = parseInt(process.env.MAX_CONCURRENT_AGENTS, 10) || 3;
// Track consecutive failures per ticket for escalation
const _ticketFailureCounts = {};
// F11: Per-ticket starting guard (synchronous) to prevent double-start races
const agentStartingSet = new Set();
function startAgent(ticket) {
    // F11: Synchronous double-start prevention -- check both running AND starting
    if (agentProcs[ticket])
        return { ok: false, error: `Agent already running for ${ticket}` };
    if (agentStartingSet.has(ticket))
        return { ok: false, error: `Agent already starting for ${ticket}` };
    // [OAuth] Clear any pending auth timeout — the agent is being (re)started
    clearAuthTimeout(ticket);
    delete _authWaitingMeta[ticket];
    // Atomic guard: add to starting set immediately after check (same event loop tick)
    agentStartingSet.add(ticket);
    // X1: Enforce concurrency limit
    const runningCount = Object.keys(agentProcs).length;
    if (runningCount >= MAX_CONCURRENT_AGENTS) {
        agentStartingSet.delete(ticket);
        return { ok: false, error: `Max concurrent agents reached (${MAX_CONCURRENT_AGENTS}). Stop one first.` };
    }
    // [Restart Protection] Check crash loop from state before starting
    if (checkCrashLoop) {
        try {
            const state = getState(ticket);
            if (state) {
                const crashCheck = checkCrashLoop(state);
                if (crashCheck.inCrashLoop) {
                    const msg = `Agent for ${ticket} is in a crash loop (${crashCheck.recentCount} restarts). Manual intervention required.`;
                    addLog(`[Restart Protection] ${msg}`, "system", ticket);
                    // [Escalation] Alert on crash loop
                    if (escalateImmediate) {
                        escalateImmediate("agent_crash_loop", "critical", msg, { notifySlack: true }).catch(() => { });
                    }
                    agentStartingSet.delete(ticket);
                    return { ok: false, error: msg };
                }
            }
        }
        catch { /* state may not exist yet -- proceed */ }
    }
    try {
        // Create per-ticket worktree (ensureLocalRepo is called by run-agent.js if no worktree)
        let worktreePath = null;
        try {
            worktreePath = createWorktree(ticket);
            addLog(`Worktree created for ${ticket}: ${worktreePath}`, "system", ticket);
        }
        catch (e) {
            addLog(`Worktree creation failed: ${e.message} — agent will use shared repo`, "system", ticket);
        }
        const envVars = { ...process.env, ...loadEnv(), TICKET: ticket };
        if (worktreePath)
            envVars.WORKTREE_PATH = worktreePath;
        // [OAuth] Inject fresh OAuth access tokens from TokenManager (if available)
        if (_tokenManager) {
            const oauthProviders = [
                { provider: 'google', envKey: 'GOOGLE_OAUTH_ACCESS_TOKEN' },
                { provider: 'figma', envKey: 'FIGMA_OAUTH_ACCESS_TOKEN' },
                { provider: 'gitlab', envKey: 'GITLAB_OAUTH_ACCESS_TOKEN' },
            ];
            for (const { provider, envKey } of oauthProviders) {
                try {
                    const token = _tokenManager.getAccessTokenSync(provider);
                    if (token)
                        envVars[envKey] = token;
                }
                catch { /* provider not configured — skip */ }
            }
        }
        addLog(`Starting agent for ${ticket}...`, "system", ticket);
        const proc = (0, child_process_1.spawn)("node", [path_1.default.join(BASE_DIR, "run-agent.js")], {
            env: envVars,
            cwd: BASE_DIR,
        });
        agentProcs[ticket] = proc;
        // [Graceful Shutdown] Track child process for cleanup on server shutdown
        trackChildProcess(proc, `agent-${ticket}`);
        // Wrap process output with redaction -- all output is redacted before reaching SSE
        const redactorHandle = wrapProcessOutput(proc, {
            onStdoutLine(line) {
                addLog(line, "stdout", ticket);
            },
            onStderrLine(line) {
                addLog(line, "stderr", ticket);
            },
            onBinaryDetected(stream) {
                addLog(`[${stream}] Binary data detected -- redaction skipped for binary content`, "system", ticket);
            },
        });
        agentRedactors[ticket] = redactorHandle;
        proc.on("close", (code) => {
            // [Graceful Shutdown] Untrack child process
            untrackChildProcess(proc);
            // Cleanup redactor (exception-safe)
            if (agentRedactors[ticket]) {
                try {
                    agentRedactors[ticket].cleanup();
                }
                catch (e) {
                    console.warn(`[Agent] redactor cleanup error: ${e.message}`);
                }
                delete agentRedactors[ticket];
            }
            // Remove per-ticket worktree
            try {
                removeWorktree(ticket);
            }
            catch (e) {
                console.warn(`[Worktree] Cleanup failed for ${ticket}: ${e.message}`);
            }
            addLog(`Agent for ${ticket} exited with code ${code}`, "system", ticket);
            // [OAuth] Exit-78: agent requests auth refresh + respawn
            if (code === EXIT_AUTH_REFRESH && _tokenManager) {
                delete agentProcs[ticket];
                const state = getState(ticket);
                const authFailure = state?.data?._authFailure;
                const provider = authFailure?.provider;
                if (provider) {
                    const respawnCount = (state?.data?._authRespawnCount?.[provider] || 0) + 1;
                    if (respawnCount > MAX_AUTH_RESPAWNS_PER_PROVIDER) {
                        addLog(`[OAuth] Auth respawn cap reached for ${provider} (${respawnCount}/${MAX_AUTH_RESPAWNS_PER_PROVIDER}). Pipeline PAUSED — waiting for re-auth.`, "system", ticket);
                        broadcast("authRequired", { provider, reason: "respawn-exhausted", ticket });
                        broadcast("status", { running: false, code, ticket });
                        // [OAuth] Start auth timeout countdown — pipeline will FAIL if not re-authed in time
                        _authWaitingMeta[ticket] = { provider };
                        startAuthTimeout(ticket, provider);
                        clearTicketLogs(ticket);
                        return;
                    }
                    addLog(`[OAuth] Exit-78 for ${provider}. Refreshing token and respawning (attempt ${respawnCount}/${MAX_AUTH_RESPAWNS_PER_PROVIDER})...`, "system", ticket);
                    _tokenManager.refresh(provider).then(() => {
                        addLog(`[OAuth] Token refreshed for ${provider}. Respawning agent for ${ticket}...`, "system", ticket);
                        startAgent(ticket);
                    }).catch((err) => {
                        addLog(`[OAuth] Token refresh failed for ${provider}: ${err.message}. Re-auth required.`, "system", ticket);
                        broadcast("authRequired", { provider, reason: "refresh-failed", ticket });
                        broadcast("status", { running: false, code, ticket });
                        // [OAuth] Start auth timeout countdown — pipeline will FAIL if not re-authed in time
                        _authWaitingMeta[ticket] = { provider };
                        startAuthTimeout(ticket, provider);
                        clearTicketLogs(ticket);
                    });
                    return;
                }
            }
            broadcast("status", { running: false, code, ticket });
            clearTicketLogs(ticket);
            delete agentProcs[ticket];
            // [Escalation] Track failures and escalate on repeated non-zero exits
            if (code !== 0 && code !== null) {
                _ticketFailureCounts[ticket] = (_ticketFailureCounts[ticket] || 0) + 1;
                const failCount = _ticketFailureCounts[ticket];
                if (failCount >= 3 && escalateImmediate) {
                    const msg = `Agent for ${ticket} has failed ${failCount} times consecutively (last exit code: ${code}). Check logs and state.`;
                    escalateImmediate("agent_repeated_failure", "critical", msg, { notifySlack: true }).catch(() => { });
                }
            }
            else {
                // Clean exit — delete entry to prevent unbounded map growth
                delete _ticketFailureCounts[ticket];
            }
        });
        broadcast("status", { running: true, ticket });
        return { ok: true };
    }
    catch (err) {
        // F11: Ensure flag is cleared on spawn failure
        delete agentProcs[ticket];
        if (agentRedactors[ticket]) {
            try {
                agentRedactors[ticket].cleanup();
            }
            catch (e) {
                console.warn("[Agent] redactor cleanup error:", e.message);
            }
            delete agentRedactors[ticket];
        }
        return { ok: false, error: "Failed to start agent: " + err.message };
    }
    finally {
        // F11: Always clear starting guard
        agentStartingSet.delete(ticket);
    }
}
function stopAgent(ticket) {
    // X1: If ticket provided, stop that specific agent; otherwise stop first running
    if (ticket && agentProcs[ticket]) {
        // [OAuth] Clear auth timeout on manual stop
        clearAuthTimeout(ticket);
        delete _authWaitingMeta[ticket];
        agentProcs[ticket].kill("SIGTERM");
        addLog(`Agent for ${ticket} stopped by user`, "system", ticket);
        return { ok: true };
    }
    // Legacy: stop any running agent if no ticket specified
    const keys = Object.keys(agentProcs);
    if (keys.length === 0)
        return { ok: false, error: "No agent running" };
    const firstTicket = keys[0];
    // [OAuth] Clear auth timeout on manual stop
    clearAuthTimeout(firstTicket);
    delete _authWaitingMeta[firstTicket];
    agentProcs[firstTicket].kill("SIGTERM");
    addLog(`Agent for ${firstTicket} stopped by user`, "system", firstTicket);
    return { ok: true };
}
// O12: Process health check -- verify child process is actually alive
function checkProcessHealth(ticket) {
    const proc = agentProcs[ticket];
    if (!proc)
        return { alive: false, reason: "no_process" };
    if (proc.exitCode !== null)
        return { alive: false, reason: "exited", exitCode: proc.exitCode };
    try {
        process.kill(proc.pid, 0); // Signal 0 = just check existence
        return { alive: true, pid: proc.pid };
    }
    catch {
        return { alive: false, reason: "unreachable", pid: proc.pid };
    }
}
// F10: Orphaned agent detection on startup
function cleanOrphanedLocks() {
    try {
        const files = fs_1.default.readdirSync(BASE_DIR).filter((f) => f.startsWith("state-") && f.endsWith(".lock"));
        for (const lockFile of files) {
            const lockPath = path_1.default.join(BASE_DIR, lockFile);
            try {
                const pidStr = fs_1.default.readFileSync(lockPath, "utf8").trim();
                const pid = parseInt(pidStr, 10);
                if (isNaN(pid)) {
                    fs_1.default.unlinkSync(lockPath);
                    continue;
                }
                try {
                    process.kill(pid, 0); // Check if alive
                    console.warn(`  [F10] Lock file ${lockFile} -- PID ${pid} is still alive (agent may be running)`);
                }
                catch {
                    // Process is dead -- remove stale lock
                    fs_1.default.unlinkSync(lockPath);
                    console.log(`  [F10] Removed stale lock file ${lockFile} (PID ${pid} is dead)`);
                }
            }
            catch (e) {
                try {
                    fs_1.default.unlinkSync(lockPath);
                }
                catch { }
            }
        }
    }
    catch (e) {
        console.warn("  [F10] Failed to check orphaned locks:", e.message);
    }
}
// O8: Stage data map -- which fields to clear per stage
const STAGE_DATA_MAP = {
    fetch_ticket: ["ticketData", "ticketTitle", "ticketDescription", "_lastError"],
    explore_plan: ["explore_plan", "explore_plan_posted", "explore_agents", "explore_plan_ui_approved", "explore_plan_ui_rejected", "explore_plan_ui_feedback"],
    generate_code: ["codeChanges", "code_mr_iid", "code_mr_url", "original_files", "code_branch"],
    gate_code_review: ["gate1_ui_approved", "gate1_ui_rejected", "gate1_ui_feedback"],
    deploy_qa: ["deploy_qa_posted", "deploy_qa_ui_approved", "deploy_qa_ui_rejected", "deploy_qa_ui_feedback", "qa_merge_result"],
    test_qa: ["qa_test", "qa_test_results"],
    gate_preprod_approval: ["gate2a_posted", "gate2a_ui_approved", "gate2a_ui_rejected", "gate2a_ui_feedback"],
    create_preprod_mr: ["preprod_mr_iid", "preprod_mr_url"],
    gate_dual_approval: ["gate2b_posted", "gate2b_ui_approved", "gate2b_ui_rejected", "gate2b_ui_feedback", "gate2b_anshit_approved"],
    deploy_prod: ["prod_deploy_result", "prod_smoke_result"],
    done: [],
};
exports.STAGE_DATA_MAP = STAGE_DATA_MAP;
// Clean up orphaned worktrees at startup (alongside cleanOrphanedLocks)
function cleanOrphanedWorktreesOnStartup() {
    try {
        cleanOrphanedWorktrees();
    }
    catch (e) {
        console.warn(`[Worktree] Orphan cleanup failed: ${e.message}`);
    }
}
function getAgentProcs() { return agentProcs; }
//# sourceMappingURL=agent-process.js.map