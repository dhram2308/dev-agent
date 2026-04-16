/**
 * agents-team.ts -- Parallel Claude Agent Orchestration
 *
 * Converted from lib/agents-team.js (zero functional changes).
 *
 * Features:
 * - Promise.allSettled -- one failure does NOT abort siblings
 * - Each agent has `required: boolean` -- required failure aborts whole team
 * - Built-in checkpoint/resume via `checkpointKey` -- completed agents skip on restart
 * - Caller-defined `merge()` callback for combining results
 * - Integrates with existing `callClaude()` -- no changes to lib/claude.js
 */

import type {
  ClaudeCallOptions,
  ClaudeResponse,
} from '@mi/shared';

const { logInfo, logOk, logWarn, logErr } = require('./logging') as {
  logInfo: (msg: string) => void;
  logOk: (msg: string) => void;
  logWarn: (msg: string) => void;
  logErr: (msg: string) => void;
};
const { save } = require('./state') as {
  save: (state: any) => void;
};
const { callClaude } = require('./claude') as {
  callClaude: (prompt: string, timeoutMs: number, opts?: ClaudeCallOptions) => Promise<ClaudeResponse>;
};
const { validateClaudeNotEmpty, detectClaudeRefusal } = require('./utils') as {
  validateClaudeNotEmpty: (output: string, agentName: string) => void;
  detectClaudeRefusal: (output: string, agentName: string) => void;
};

interface AgentDef {
  name: string;
  prompt: string;
  timeout: number;
  opts?: ClaudeCallOptions;
  required?: boolean;
  checkpointKey: string;
}

interface AgentResult {
  name: string;
  output: string | null;
  status: 'fulfilled' | 'rejected';
  fromCache?: boolean;
  error?: Error;
  required?: boolean;
}

interface TeamOptions {
  teamName: string;
  agents: AgentDef[];
  state: any;
  merge: (results: AgentResult[]) => string;
}

/**
 * Run a team of Claude agents in parallel using Promise.allSettled.
 */
async function runAgentsTeam({ teamName, agents, state, merge }: TeamOptions): Promise<string> {
  logInfo(`[${teamName}] Starting ${agents.length} parallel agent(s)…`);
  const startTime = Date.now();

  // Phase 1: Check for already-completed agents (checkpoint/resume)
  const pending: AgentDef[] = [];
  const completed: AgentResult[] = [];
  for (const agent of agents) {
    const cached = state.data[agent.checkpointKey];
    if (cached) {
      // T2.1: Validate cached checkpoints — pruned/empty values must be re-run
      try {
        validateClaudeNotEmpty(cached, agent.name);
        detectClaudeRefusal(cached, agent.name);
        logOk(`  [${agent.name}] Skipped (checkpoint: ${agent.checkpointKey})`);
        completed.push({ name: agent.name, output: cached, status: "fulfilled", fromCache: true });
      } catch (validationErr: any) {
        logWarn(`  [${agent.name}] Cached checkpoint invalid (${validationErr.message}) — re-running`);
        state.data[agent.checkpointKey] = null;
        pending.push(agent);
      }
    } else {
      pending.push(agent);
    }
  }

  // Phase 2: Run pending agents in parallel
  if (pending.length > 0) {
    logInfo(`  Running ${pending.length} agent(s) in parallel (${completed.length} cached)…`);

    // Track active agents in state for UI
    const activeNames = pending.map(a => a.name);
    state.data._active_agents = activeNames;
    try { save(state); } catch (e: any) { logWarn(`[${teamName}] Failed to save active agents: ${e.message}`); }

    const promises = pending.map((agent) => {
      logInfo(`  [${agent.name}] Starting… (timeout: ${Math.round(agent.timeout / 1000)}s)`);
      const agentStart = Date.now();
      return callClaude(agent.prompt, agent.timeout, {
        agentName: agent.name,
        ...(agent.opts || {}),
      })
        .then((output: string) => {
          const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
          logOk(`  [${agent.name}] Complete (${elapsed}s, ${output.length} chars)`);
          // Validate output before checkpointing (invalid output is never cached)
          validateClaudeNotEmpty(output, agent.name);
          detectClaudeRefusal(output, agent.name);
          // Remove from active list
          state.data._active_agents = (state.data._active_agents || []).filter((n: string) => n !== agent.name);
          // Checkpoint to state
          state.data[agent.checkpointKey] = output;
          try { save(state); } catch (e: any) { logWarn(`[${teamName}] Failed to save checkpoint ${agent.checkpointKey}: ${e.message}`); }
          return { name: agent.name, output, status: "fulfilled" as const };
        })
        .catch((err: Error) => {
          const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
          logWarn(`  [${agent.name}] Failed (${elapsed}s): ${err.message.substring(0, 200)}`);
          // Remove from active list
          state.data._active_agents = (state.data._active_agents || []).filter((n: string) => n !== agent.name);
          try { save(state); } catch (e2: any) { logWarn(`[${teamName}] Failed to save error state for ${agent.name}: ${e2.message}`); }
          return { name: agent.name, output: null, status: "rejected" as const, error: err, required: agent.required !== false };
        });
    });

    const results = await Promise.allSettled(promises);

    // Unwrap Promise.allSettled (each is { status: "fulfilled", value: ... })
    for (const r of results) {
      const val = (r as any).value || (r as any).reason || {};
      completed.push(val);
    }
  }

  // Phase 3: Check for required agent failures
  const failures = completed.filter((r) => r.status === "rejected" && r.required);
  if (failures.length > 0) {
    const failNames = failures.map((f) => f.name).join(", ");
    logErr(`[${teamName}] Required agent(s) failed: ${failNames}`);
    throw new Error(`[${teamName}] Required agent(s) failed: ${failNames}. ${failures[0].error?.message || ""}`);
  }

  // Phase 4: Clear active agents and log summary
  state.data._active_agents = [];
  const fulfilled = completed.filter((r) => r.status === "fulfilled");
  const optional_failed = completed.filter((r) => r.status === "rejected" && !r.required);
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logOk(`[${teamName}] Done in ${totalElapsed}s — ${fulfilled.length} succeeded, ${optional_failed.length} optional failed`);

  if (optional_failed.length > 0) {
    logWarn(`  Optional agents that failed: ${optional_failed.map((f) => f.name).join(", ")}`);
  }

  // Phase 5: Merge results
  const mergedOutput = merge(completed);
  return mergedOutput;
}

interface SingleAgentOptions {
  name: string;
  prompt: string;
  timeout: number;
  opts?: ClaudeCallOptions;
  state: any;
  checkpointKey: string;
  required?: boolean;
}

/**
 * Run a single Claude agent with all agents-team features.
 */
async function runSingleAgent({ name, prompt, timeout, opts, state, checkpointKey, required = true }: SingleAgentOptions): Promise<string | null> {
  try {
    const result = await runAgentsTeam({
      teamName: name,
      agents: [{ name, prompt, timeout, opts, required, checkpointKey }],
      state,
      merge: (results) => results[0]?.output || null as any,
    });
    return result;
  } catch (err) {
    if (required) throw err;
    return null;
  }
}

module.exports = { runAgentsTeam, runSingleAgent };
