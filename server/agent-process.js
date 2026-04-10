"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { addLog, broadcast, clearTicketLogs } = require("./sse");
const { loadEnv, getState } = require("./state-io");
const { wrapProcessOutput, setProcessRedactor } = require("../lib/process-redactor");
const { redactAll } = require("../lib/redaction");
const { ensureLocalRepo, createWorktree, removeWorktree, cleanOrphanedWorktrees } = require("../lib/local-repo");

// Wire redaction into process output interceptor
setProcessRedactor(redactAll);

// ── Resilience modules ──────────────────────────────────────────
const { trackChildProcess, untrackChildProcess } = require("../lib/graceful-shutdown");

// Restart protection: backoff on rapid restarts per ticket
let applyRestartProtection, checkCrashLoop;
try {
  const rp = require("../lib/restart-protection");
  applyRestartProtection = rp.applyRestartProtection;
  checkCrashLoop = rp.checkCrashLoop;
} catch { applyRestartProtection = null; checkCrashLoop = null; }

// Escalation: alert on repeated failures
let escalateImmediate;
try {
  escalateImmediate = require("../lib/escalation").escalateImmediate;
} catch { escalateImmediate = null; }

const BASE_DIR = path.join(__dirname, "..");

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
  if (agentProcs[ticket]) return { ok: false, error: `Agent already running for ${ticket}` };
  if (agentStartingSet.has(ticket)) return { ok: false, error: `Agent already starting for ${ticket}` };

  // X1: Enforce concurrency limit
  const runningCount = Object.keys(agentProcs).length;
  if (runningCount >= MAX_CONCURRENT_AGENTS) {
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
          return { ok: false, error: msg };
        }
      }
    } catch { /* state may not exist yet -- proceed */ }
  }

  agentStartingSet.add(ticket);

  try {
    // Create per-ticket worktree (ensureLocalRepo is called by run-agent.js if no worktree)
    let worktreePath = null;
    try {
      worktreePath = createWorktree(ticket);
      addLog(`Worktree created for ${ticket}: ${worktreePath}`, "system", ticket);
    } catch (e) {
      addLog(`Worktree creation failed: ${e.message} — agent will use shared repo`, "system", ticket);
    }

    const envVars = { ...process.env, ...loadEnv(), TICKET: ticket };
    if (worktreePath) envVars.WORKTREE_PATH = worktreePath;
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

      // Cleanup redactor
      if (agentRedactors[ticket]) {
        agentRedactors[ticket].cleanup();
        delete agentRedactors[ticket];
      }

      // Remove per-ticket worktree
      try { removeWorktree(ticket); } catch (e) {
        console.warn(`[Worktree] Cleanup failed for ${ticket}: ${e.message}`);
      }

      addLog(`Agent for ${ticket} exited with code ${code}`, "system", ticket);
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
        // Reset failure count on clean exit
        _ticketFailureCounts[ticket] = 0;
      }
    });

    broadcast("status", { running: true, ticket });
    return { ok: true };
  } catch (err) {
    // F11: Ensure flag is cleared on spawn failure
    delete agentProcs[ticket];
    if (agentRedactors[ticket]) {
      try { agentRedactors[ticket].cleanup(); } catch { /* swallow */ }
      delete agentRedactors[ticket];
    }
    return { ok: false, error: "Failed to start agent: " + err.message };
  } finally {
    // F11: Always clear starting guard
    agentStartingSet.delete(ticket);
  }
}

function stopAgent(ticket) {
  // X1: If ticket provided, stop that specific agent; otherwise stop first running
  if (ticket && agentProcs[ticket]) {
    agentProcs[ticket].kill("SIGTERM");
    addLog(`Agent for ${ticket} stopped by user`, "system", ticket);
    return { ok: true };
  }
  // Legacy: stop any running agent if no ticket specified
  const keys = Object.keys(agentProcs);
  if (keys.length === 0) return { ok: false, error: "No agent running" };
  const firstTicket = keys[0];
  agentProcs[firstTicket].kill("SIGTERM");
  addLog(`Agent for ${firstTicket} stopped by user`, "system", firstTicket);
  return { ok: true };
}

// O12: Process health check -- verify child process is actually alive
function checkProcessHealth(ticket) {
  const proc = agentProcs[ticket];
  if (!proc) return { alive: false, reason: "no_process" };
  if (proc.exitCode !== null) return { alive: false, reason: "exited", exitCode: proc.exitCode };
  try {
    process.kill(proc.pid, 0); // Signal 0 = just check existence
    return { alive: true, pid: proc.pid };
  } catch {
    return { alive: false, reason: "unreachable", pid: proc.pid };
  }
}

// F10: Orphaned agent detection on startup
function cleanOrphanedLocks() {
  try {
    const files = fs.readdirSync(BASE_DIR).filter(f => f.startsWith("state-") && f.endsWith(".lock"));
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
      } catch (e) {
        try { fs.unlinkSync(lockPath); } catch {}
      }
    }
  } catch (e) {
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

// Clean up orphaned worktrees at startup (alongside cleanOrphanedLocks)
function cleanOrphanedWorktreesOnStartup() {
  try {
    cleanOrphanedWorktrees();
  } catch (e) {
    console.warn(`[Worktree] Orphan cleanup failed: ${e.message}`);
  }
}

function getAgentProcs() { return agentProcs; }

module.exports = {
  startAgent,
  stopAgent,
  checkProcessHealth,
  cleanOrphanedLocks,
  cleanOrphanedWorktreesOnStartup,
  getAgentProcs,
  STAGE_DATA_MAP,
};
