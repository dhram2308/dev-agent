// ═══════════════════════════════════════════════════════════════
// server/agent-process.ts — Agent child process management
// Converted from: server/agent-process.js (259 lines)
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';

import type {
  AgentStartResult,
  AgentStopResult,
  ProcessHealthCheck,
  StageDataMap,
  ProcessRedactorHandle,
} from '@mi/shared';

// SSE module is resolved lazily so a host (e.g. packages/backend) can inject
// its own sse implementation via setSseModule() before any agent is started.
// This prevents the agent's addLog/broadcast calls from being routed to a
// detached legacy sse instance that has no connected UI clients.
type SseLike = {
  addLog: (line: string, type: string, ticket: string) => void;
  broadcast: (event: string, data: any) => void;
  clearTicketLogs: (ticket: string) => void;
};

let _sseModule: SseLike | null = null;

function _loadDefaultSse(): SseLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./sse') as SseLike;
}

function _sse(): SseLike {
  if (!_sseModule) _sseModule = _loadDefaultSse();
  return _sseModule;
}

export function setSseModule(mod: SseLike): void {
  _sseModule = mod;
}

const addLog: SseLike['addLog'] = (line, type, ticket) => _sse().addLog(line, type, ticket);
const broadcast: SseLike['broadcast'] = (event, data) => _sse().broadcast(event, data);
const clearTicketLogs: SseLike['clearTicketLogs'] = (ticket) => _sse().clearTicketLogs(ticket);
const { loadEnv, getState } = require('./state-io') as {
  loadEnv: () => Record<string, string>;
  getState: (ticket: string) => any;
};
const { wrapProcessOutput, setProcessRedactor } = require('../lib/process-redactor') as {
  wrapProcessOutput: (proc: ChildProcess, opts: any) => ProcessRedactorHandle;
  setProcessRedactor: (fn: any) => void;
};
const { redactAll } = require('../lib/redaction') as { redactAll: (s: string) => string };
const { ensureLocalRepo, createWorktree, removeWorktree, cleanOrphanedWorktrees } = require('../lib/local-repo') as {
  ensureLocalRepo: () => Promise<string | null>;
  createWorktree: (ticket: string) => string;
  removeWorktree: (ticket: string) => void;
  cleanOrphanedWorktrees: () => void;
};

// Wire redaction into process output interceptor
setProcessRedactor(redactAll);

// ── Resilience modules ──────────────────────────────────────────
const { trackChildProcess, untrackChildProcess } = require('../lib/graceful-shutdown') as {
  trackChildProcess: (proc: ChildProcess, name: string) => void;
  untrackChildProcess: (proc: ChildProcess) => void;
};

// Restart protection: backoff on rapid restarts per ticket
let applyRestartProtection: any;
let checkCrashLoop: ((state: any) => { inCrashLoop: boolean; recentCount: number }) | null;
try {
  const rp = require('../lib/restart-protection');
  applyRestartProtection = rp.applyRestartProtection;
  checkCrashLoop = rp.checkCrashLoop;
} catch (e: any) { console.warn("[Agent] restart-protection module not available:", e.message); applyRestartProtection = null; checkCrashLoop = null; }

// Escalation: alert on repeated failures
let escalateImmediate: ((type: string, severity: string, message: string, opts?: any) => Promise<void>) | null;
try {
  escalateImmediate = require('../lib/escalation').escalateImmediate;
} catch (e: any) { console.warn("[Agent] escalation module not available:", e.message); escalateImmediate = null; }

// [OAuth] Token manager injection point -- set by the backend server
interface TokenManagerLike {
  getAccessTokenSync(provider: string): string | null;
  // `trigger` is a diagnostic label propagated to the backend's refresh-history
  // ring buffer (oauth-connectors task 11.12). Optional for back-compat with
  // older builds of the backend that don't accept it.
  refresh(provider: string, trigger?: string): Promise<unknown>;
}
let _tokenManager: TokenManagerLike | null = null;

/** Inject the TokenManager so agent-process can fetch fresh tokens before spawn */
export function setTokenManager(tm: TokenManagerLike): void {
  _tokenManager = tm;
}

// [OAuth] Exit code 78 = AUTH_REFRESH_NEEDED (sysexits.h EX_CONFIG)
const EXIT_AUTH_REFRESH = 78;
const MAX_AUTH_RESPAWNS_PER_PROVIDER = 3;

// [OAuth] Auth timeout: how long to wait for re-auth before failing the pipeline.
// Default 120 minutes (2 hours). Configurable via AUTH_TIMEOUT_MIN env var.
const AUTH_TIMEOUT_MIN = Math.max(1, parseInt(process.env.AUTH_TIMEOUT_MIN as string, 10) || 120);
const AUTH_TIMEOUT_MS = AUTH_TIMEOUT_MIN * 60 * 1000;

// Per-ticket auth timeout timers. When a pipeline enters PAUSED_AUTH_REQUIRED
// (i.e. authRequired is broadcast), a countdown starts. If the user does not
// re-auth and resume within AUTH_TIMEOUT_MIN, the pipeline transitions to FAILED.
const _authTimeouts: Record<string, NodeJS.Timeout> = {};

/**
 * Start the auth-timeout countdown for a ticket.
 * If a timer already exists for the ticket it is replaced.
 */
function startAuthTimeout(ticket: string, provider: string): void {
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
function clearAuthTimeout(ticket: string): void {
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
function getAuthWaitingTickets(): Record<string, { provider: string }> {
  return { ..._authWaitingMeta };
}

// Track which provider each ticket is waiting on (for resume lookup)
const _authWaitingMeta: Record<string, { provider: string }> = {};

// Navigate to project root: at runtime __dirname is packages/agent/dist/server/
// so ../../../../ = project root. With source (src/server/) the extra depth is the same.
const BASE_DIR = path.resolve(__dirname, '..', '..', '..', '..');

// X1: Multi-ticket concurrency -- map of ticket -> child process
const agentProcs: Record<string, ChildProcess> = {};
const agentRedactors: Record<string, ProcessRedactorHandle> = {}; // Track redactor cleanup functions per ticket
const MAX_CONCURRENT_AGENTS = parseInt(process.env.MAX_CONCURRENT_AGENTS as string, 10) || 3;

// Track consecutive failures per ticket for escalation
const _ticketFailureCounts: Record<string, number> = {};

// F11: Per-ticket starting guard (synchronous) to prevent double-start races
const agentStartingSet = new Set<string>();

function startAgent(ticket: string): AgentStartResult {
  // F11: Synchronous double-start prevention -- check both running AND starting
  if (agentProcs[ticket]) return { ok: false, error: `Agent already running for ${ticket}` };
  if (agentStartingSet.has(ticket)) return { ok: false, error: `Agent already starting for ${ticket}` };

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
            escalateImmediate("agent_crash_loop", "critical", msg, { notifySlack: true }).catch(() => {});
          }
          agentStartingSet.delete(ticket);
          return { ok: false, error: msg };
        }
      }
    } catch { /* state may not exist yet -- proceed */ }
  }

  try {
    // Create per-ticket worktree (ensureLocalRepo is called by run-agent.js if no worktree)
    let worktreePath: string | null = null;
    try {
      worktreePath = createWorktree(ticket);
      addLog(`Worktree created for ${ticket}: ${worktreePath}`, "system", ticket);
    } catch (e: any) {
      addLog(`Worktree creation failed: ${e.message} — agent will use shared repo`, "system", ticket);
    }

    const envVars: Record<string, string | undefined> = { ...process.env, ...loadEnv(), TICKET: ticket };
    if (worktreePath) envVars.WORKTREE_PATH = worktreePath;

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
          if (token) envVars[envKey] = token;
        } catch { /* provider not configured — skip */ }
      }
    }

    addLog(`Starting agent for ${ticket}...`, "system", ticket);

    const proc = spawn("node", [path.join(BASE_DIR, "run-agent.js")], {
      env: envVars,
      cwd: BASE_DIR,
    });

    agentProcs[ticket] = proc;

    // [Graceful Shutdown] Track child process for cleanup on server shutdown
    trackChildProcess(proc, `agent-${ticket}`);

    // Wrap process output with redaction -- all output is redacted before reaching SSE
    const redactorHandle = wrapProcessOutput(proc, {
      onStdoutLine(line: string) {
        addLog(line, "stdout", ticket);
      },
      onStderrLine(line: string) {
        addLog(line, "stderr", ticket);
      },
      onBinaryDetected(stream: string) {
        addLog(`[${stream}] Binary data detected -- redaction skipped for binary content`, "system", ticket);
      },
    });
    agentRedactors[ticket] = redactorHandle;

    proc.on("close", (code: number | null) => {
      // [Graceful Shutdown] Untrack child process
      untrackChildProcess(proc);

      // Cleanup redactor (exception-safe)
      if (agentRedactors[ticket]) {
        try { agentRedactors[ticket].cleanup(); } catch (e: any) { console.warn(`[Agent] redactor cleanup error: ${e.message}`); }
        delete agentRedactors[ticket];
      }

      // Remove per-ticket worktree
      try { removeWorktree(ticket); } catch (e: any) {
        console.warn(`[Worktree] Cleanup failed for ${ticket}: ${e.message}`);
      }

      addLog(`Agent for ${ticket} exited with code ${code}`, "system", ticket);

      // [OAuth] Exit-78 but no TokenManager wired: surface the diagnostic
      // instead of silently failing. See oauth-connectors design.md Decision 10
      // and tasks.md 11.5. This branch is reached if the backend never called
      // setTokenManager (e.g., legacy boot path or build mismatch).
      if (code === EXIT_AUTH_REFRESH && !_tokenManager) {
        const state = getState(ticket);
        const provider = (state?.data?._authFailure as { provider: string } | undefined)?.provider || 'unknown';
        const msg = `[OAuth] Agent for ${ticket} exited with code 78 (AUTH_REFRESH_NEEDED) for provider ${provider}, but TokenManager is not wired into agent-process. Refresh+respawn cannot run. Check that the backend HTTP server called setTokenManager() at startup.`;
        addLog(msg, "system", ticket);
        console.warn(msg);
        broadcast("authRequired", { provider, reason: "token-manager-not-wired", ticket });
        broadcast("status", { running: false, code, ticket });
        clearTicketLogs(ticket);
        delete agentProcs[ticket];
        return;
      }

      // [OAuth] Exit-78: agent requests auth refresh + respawn
      if (code === EXIT_AUTH_REFRESH && _tokenManager) {
        delete agentProcs[ticket];
        const state = getState(ticket);
        const authFailure = state?.data?._authFailure as { provider: string; ts: number } | undefined;
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
          _tokenManager.refresh(provider, 'exit-78').then(() => {
            addLog(`[OAuth] Token refreshed for ${provider}. Respawning agent for ${ticket}...`, "system", ticket);
            startAgent(ticket);
          }).catch((err: any) => {
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
          escalateImmediate("agent_repeated_failure", "critical", msg, { notifySlack: true }).catch(() => {});
        }
      } else {
        // Clean exit — delete entry to prevent unbounded map growth
        delete _ticketFailureCounts[ticket];
      }
    });

    broadcast("status", { running: true, ticket });
    return { ok: true };
  } catch (err: any) {
    // F11: Ensure flag is cleared on spawn failure
    delete agentProcs[ticket];
    if (agentRedactors[ticket]) {
      try { agentRedactors[ticket].cleanup(); } catch (e: any) { console.warn("[Agent] redactor cleanup error:", e.message); }
      delete agentRedactors[ticket];
    }
    return { ok: false, error: "Failed to start agent: " + err.message };
  } finally {
    // F11: Always clear starting guard
    agentStartingSet.delete(ticket);
  }
}

function stopAgent(ticket?: string | null): AgentStopResult {
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
  if (keys.length === 0) return { ok: false, error: "No agent running" };
  const firstTicket = keys[0];
  // [OAuth] Clear auth timeout on manual stop
  clearAuthTimeout(firstTicket);
  delete _authWaitingMeta[firstTicket];
  agentProcs[firstTicket].kill("SIGTERM");
  addLog(`Agent for ${firstTicket} stopped by user`, "system", firstTicket);
  return { ok: true };
}

// O12: Process health check -- verify child process is actually alive
function checkProcessHealth(ticket: string): ProcessHealthCheck {
  const proc = agentProcs[ticket];
  if (!proc) return { alive: false, reason: "no_process" };
  if (proc.exitCode !== null) return { alive: false, reason: "exited", exitCode: proc.exitCode };
  try {
    process.kill(proc.pid!, 0); // Signal 0 = just check existence
    return { alive: true, pid: proc.pid! };
  } catch {
    return { alive: false, reason: "unreachable", pid: proc.pid! };
  }
}

// F10: Orphaned agent detection on startup
function cleanOrphanedLocks(): void {
  try {
    const files = fs.readdirSync(BASE_DIR).filter((f: string) => f.startsWith("state-") && f.endsWith(".lock"));
    for (const lockFile of files) {
      const lockPath = path.join(BASE_DIR, lockFile);
      try {
        const pidStr = fs.readFileSync(lockPath, "utf8").trim();
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid)) { fs.unlinkSync(lockPath); continue; }
        try {
          process.kill(pid, 0); // Check if alive
          console.warn(`  [F10] Lock file ${lockFile} -- PID ${pid} is still alive (agent may be running)`);
        } catch {
          // Process is dead -- remove stale lock
          fs.unlinkSync(lockPath);
          console.log(`  [F10] Removed stale lock file ${lockFile} (PID ${pid} is dead)`);
        }
      } catch (e: any) {
        try { fs.unlinkSync(lockPath); } catch {}
      }
    }
  } catch (e: any) {
    console.warn("  [F10] Failed to check orphaned locks:", e.message);
  }
}

// O8: Stage data map -- which fields to clear per stage
const STAGE_DATA_MAP: StageDataMap = {
  fetch_ticket: ["ticketData", "ticketTitle", "ticketDescription", "_lastError"],
  explore_plan: ["explore_plan", "explore_plan_posted", "explore_agents", "explore_plan_ui_approved", "explore_plan_ui_rejected", "explore_plan_ui_feedback"],
  generate_code: ["codeChanges", "code_mr_iid", "code_mr_url", "original_files", "code_branch"],
  gate_code_review: ["gate1_ui_approved", "gate1_ui_rejected", "gate1_ui_feedback"],
  deploy_qa: ["deploy_qa_posted", "deploy_qa_ui_approved", "deploy_qa_ui_rejected", "deploy_qa_ui_feedback", "qa_merge_result"],
  test_qa: ["qa_test", "qa_test_results"],
  gate_preprod_approval: ["gate2a_posted", "gate2a_ui_approved", "gate2a_ui_rejected", "gate2a_ui_feedback"],
  create_preprod_mr: ["preprod_mr_iid", "preprod_mr_url"],
  gate_dual_approval: ["gate2b_posted", "gate2b_ui_approved", "gate2b_ui_rejected", "gate2b_ui_feedback", "gate2b_qa_approved"],
  deploy_prod: ["prod_deploy_result", "prod_smoke_result"],
  done: [],
};

// Clean up orphaned worktrees at startup (alongside cleanOrphanedLocks)
function cleanOrphanedWorktreesOnStartup(): void {
  try {
    cleanOrphanedWorktrees();
  } catch (e: any) {
    console.warn(`[Worktree] Orphan cleanup failed: ${e.message}`);
  }
}

function getAgentProcs(): Record<string, ChildProcess> { return agentProcs; }

export {
  startAgent,
  stopAgent,
  checkProcessHealth,
  cleanOrphanedLocks,
  cleanOrphanedWorktreesOnStartup,
  getAgentProcs,
  getAuthWaitingTickets,
  clearAuthTimeout,
  STAGE_DATA_MAP,
};
