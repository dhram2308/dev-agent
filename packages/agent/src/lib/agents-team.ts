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
  CodegenLivePayload,
  FileChange,
} from '@mi/shared';

const { logInfo, logOk, logWarn, logErr, logDebug } = require('./logging') as {
  logInfo: (msg: string) => void;
  logOk: (msg: string) => void;
  logWarn: (msg: string) => void;
  logErr: (msg: string) => void;
  logDebug: (msg: string) => void;
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
const { localGetChanges, localGetOriginal } = require('./local-repo') as {
  localGetChanges: (clonePath: string) => FileChange[];
  localGetOriginal: (clonePath: string, filePath: string) => string | null;
};
const { TICKET } = require('./config') as { TICKET: string };
const { broadcast } = require('../server/sse') as {
  broadcast: (event: string, data: unknown) => void;
};
const { withTicketStateSync } = require('./state-unified') as {
  withTicketStateSync: (
    stateFilePath: string,
    mutator: (state: any) => void,
    opts?: { onWarn?: (msg: string) => void; onDebug?: (msg: string) => void },
  ) => void;
};

export interface ActiveAgent {
  name: string;
  team: string;
  startedAt: number;
  phase: 'running';
}

export interface HistoryAgent {
  name: string;
  team: string;
  startedAt: number;
  durationMs: number;
  phase: 'complete' | 'failed';
  outputChars?: number;
  required: boolean;
  errorMessage?: string;
}

const AGENTS_HISTORY_CAP = 50;

function normalizeActiveAgents(raw: unknown): ActiveAgent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (typeof entry === 'string') {
      return { name: entry, team: '', startedAt: 0, phase: 'running' as const };
    }
    return entry as ActiveAgent;
  });
}

// ── Live codegen diff — module constants ─────────────────────────
const LIVE_TICK_MS = 1500;
const MAX_FILES_LIVE = 40;
const MAX_FILE_BYTES_LIVE = 200_000;

/**
 * Tiny xor/rolling hash for de-duping live poller broadcasts.
 * No crypto deps — same input produces same hash; different inputs
 * very likely differ. Used to skip no-op broadcasts between ticks.
 */
function simpleHash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i); // h * 33 ^ c
    h |= 0; // force int32
  }
  return (h >>> 0).toString(36);
}

/**
 * Build a single live-diff snapshot from the working tree.
 *
 * Used both by the internal poller in `runAgentsTeam` and by the
 * on-demand `/api/codegen/live` snapshot endpoint so both data
 * sources produce the identical shape. Synchronous on purpose —
 * `localGetChanges` / `localGetOriginal` are execFileSync-based.
 *
 * Caps:
 *   - `changes` is truncated at `MAX_FILES_LIVE`; excess count is
 *     reported in `truncated.files`.
 *   - Each `content` string exceeding `MAX_FILE_BYTES_LIVE` is
 *     sliced; the affected paths are listed in `truncated.bytes`.
 *
 * The `truncated` field is omitted when no cap was applied.
 */
function buildLiveSnapshot(
  cwd: string,
  ticket: string,
  team: string,
  activeAgents: string[] | ActiveAgent[],
): CodegenLivePayload {
  const activeNames: string[] = (activeAgents as Array<string | ActiveAgent>).map((a) =>
    typeof a === 'string' ? a : a.name,
  );
  const allChanges = localGetChanges(cwd);
  const droppedFiles = Math.max(0, allChanges.length - MAX_FILES_LIVE);
  const capped = allChanges.slice(0, MAX_FILES_LIVE);

  const truncatedBytes: string[] = [];
  const changes: FileChange[] = capped.map((c) => {
    if (typeof c.content === 'string' && c.content.length > MAX_FILE_BYTES_LIVE) {
      truncatedBytes.push(c.file_path);
      return { ...c, content: c.content.slice(0, MAX_FILE_BYTES_LIVE) };
    }
    return c;
  });

  const originals: Record<string, string> = {};
  for (const c of changes) {
    if (c.action !== 'update') continue;
    const original = localGetOriginal(cwd, c.file_path);
    if (original !== null) {
      originals[c.file_path] = original.length > MAX_FILE_BYTES_LIVE
        ? original.slice(0, MAX_FILE_BYTES_LIVE)
        : original;
    }
  }

  const payload: CodegenLivePayload = {
    ticket,
    team,
    activeAgents: activeNames,
    changes,
    original_files: originals,
    ts: Date.now(),
  };

  if (droppedFiles > 0 || truncatedBytes.length > 0) {
    payload.truncated = {};
    if (droppedFiles > 0) payload.truncated.files = droppedFiles;
    if (truncatedBytes.length > 0) payload.truncated.bytes = truncatedBytes;
  }

  return payload;
}

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

  // Live codegen diff — poller lifecycle across Phase 2 + Phase 3.
  // Opt-in by presence of `opts.cwd` on any pending agent. For teams
  // without a cwd (Reviewer, Security, etc.) this is a strict no-op.
  let poller: ReturnType<typeof setInterval> | null = null;
  const hasCwd = pending.some((a) => a.opts?.cwd);
  const cwd = hasCwd
    ? (pending.find((a) => a.opts?.cwd)?.opts?.cwd as string)
    : undefined;
  let outcome: 'success' | 'failure' = 'success';

  try {
    // Phase 2: Run pending agents in parallel
    if (pending.length > 0) {
      logInfo(`  Running ${pending.length} agent(s) in parallel (${completed.length} cached)…`);

      // Track active agents in state for UI
      const teamStartTs = Date.now();
      const activeEntries: ActiveAgent[] = pending.map((a) => ({
        name: a.name,
        team: teamName,
        startedAt: teamStartTs,
        phase: 'running' as const,
      }));
      state.data._active_agents = activeEntries;
      try { save(state); } catch (e: any) { logWarn(`[${teamName}] Failed to save active agents: ${e.message}`); }

      // Start live-diff poller (only when at least one pending agent writes files).
      if (hasCwd && cwd) {
        let lastHash = '';
        poller = setInterval(() => {
          try {
            const snap = buildLiveSnapshot(
              cwd,
              TICKET,
              teamName,
              normalizeActiveAgents(state.data._active_agents),
            );
            const hashInput = snap.changes
              .map((c) => `${c.file_path}|${c.action}|${c.content?.length ?? 0}`)
              .join('||');
            const hash = simpleHash(hashInput);
            if (hash !== lastHash) {
              lastHash = hash;
              broadcast('codegen:live', snap);
            }
          } catch (err: any) {
            logDebug(`[${teamName}] live poll: ${err.message}`);
          }
        }, LIVE_TICK_MS);
        poller.unref();
      }

      const { stateFilePath } = require('./state-migration') as {
        stateFilePath: (ticket?: string) => string;
      };
      const ticketStatePath = stateFilePath(TICKET);
      const onDebug = (msg: string) => logDebug(msg);

      const promises = pending.map((agent) => {
        const agentStart = Date.now();
        logInfo(`  [${agent.name}] Starting… (timeout: ${Math.round(agent.timeout / 1000)}s)`);
        broadcast('agent:progress', {
          ticket: TICKET,
          team: teamName,
          agent: agent.name,
          phase: 'start',
          ts: Date.now(),
          startedAt: agentStart,
          required: agent.required !== false,
          promptChars: agent.prompt.length,
          timeoutMs: agent.timeout,
          maxTurns: agent.opts?.maxTurns ?? null,
        });
        return callClaude(agent.prompt, agent.timeout, {
          agentName: agent.name,
          ...(agent.opts || {}),
        })
          .then((output: string) => {
            const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
            const durationMs = Date.now() - agentStart;
            logOk(`  [${agent.name}] Complete (${elapsed}s, ${output.length} chars)`);
            validateClaudeNotEmpty(output, agent.name);
            detectClaudeRefusal(output, agent.name);
            // Mirror updates into in-memory state too so a later caller save() does not
            // overwrite disk with stale values from this process's memory copy.
            state.data._active_agents = normalizeActiveAgents(state.data._active_agents).filter(
              (a) => a.name !== agent.name,
            );
            state.data[agent.checkpointKey] = output;
            const historyEntry: HistoryAgent = {
              name: agent.name,
              team: teamName,
              startedAt: agentStart,
              durationMs,
              phase: 'complete',
              outputChars: output.length,
              required: agent.required !== false,
            };
            state.data._agents_history = Array.isArray(state.data._agents_history) ? state.data._agents_history : [];
            state.data._agents_history.push(historyEntry);
            while (state.data._agents_history.length > AGENTS_HISTORY_CAP) state.data._agents_history.shift();
            try {
              withTicketStateSync(ticketStatePath, (s: any) => {
                s.data = s.data || {};
                const active = normalizeActiveAgents(s.data._active_agents);
                s.data._active_agents = active.filter((a) => a.name !== agent.name);
                const history: HistoryAgent[] = Array.isArray(s.data._agents_history) ? s.data._agents_history : [];
                history.push({ ...historyEntry });
                while (history.length > AGENTS_HISTORY_CAP) history.shift();
                s.data._agents_history = history;
                s.data[agent.checkpointKey] = output;
              }, { onDebug });
            } catch (e: any) {
              logWarn(`[${teamName}] Failed to save checkpoint ${agent.checkpointKey}: ${e.message}`);
            }
            broadcast('agent:progress', {
              ticket: TICKET,
              team: teamName,
              agent: agent.name,
              phase: 'complete',
              ts: Date.now(),
              startedAt: agentStart,
              durationMs,
              outputChars: output.length,
              required: agent.required !== false,
            });
            return { name: agent.name, output, status: "fulfilled" as const };
          })
          .catch((err: Error) => {
            const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
            const durationMs = Date.now() - agentStart;
            logWarn(`  [${agent.name}] Failed (${elapsed}s): ${err.message.substring(0, 200)}`);
            state.data._active_agents = normalizeActiveAgents(state.data._active_agents).filter(
              (a) => a.name !== agent.name,
            );
            const historyEntry: HistoryAgent = {
              name: agent.name,
              team: teamName,
              startedAt: agentStart,
              durationMs,
              phase: 'failed',
              required: agent.required !== false,
              errorMessage: err.message.slice(0, 500),
            };
            state.data._agents_history = Array.isArray(state.data._agents_history) ? state.data._agents_history : [];
            state.data._agents_history.push(historyEntry);
            while (state.data._agents_history.length > AGENTS_HISTORY_CAP) state.data._agents_history.shift();
            try {
              withTicketStateSync(ticketStatePath, (s: any) => {
                s.data = s.data || {};
                const active = normalizeActiveAgents(s.data._active_agents);
                s.data._active_agents = active.filter((a) => a.name !== agent.name);
                const history: HistoryAgent[] = Array.isArray(s.data._agents_history) ? s.data._agents_history : [];
                history.push({ ...historyEntry });
                while (history.length > AGENTS_HISTORY_CAP) history.shift();
                s.data._agents_history = history;
              }, { onDebug });
            } catch (e2: any) {
              logWarn(`[${teamName}] Failed to save error state for ${agent.name}: ${e2.message}`);
            }
            broadcast('agent:progress', {
              ticket: TICKET,
              team: teamName,
              agent: agent.name,
              phase: 'failed',
              ts: Date.now(),
              startedAt: agentStart,
              durationMs,
              required: agent.required !== false,
              errorMessage: err.message.slice(0, 500),
            });
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
      outcome = 'failure';
      throw new Error(`[${teamName}] Required agent(s) failed: ${failNames}. ${failures[0].error?.message || ""}`);
    }
  } finally {
    if (poller) clearInterval(poller);
    if (hasCwd) {
      try {
        broadcast('codegen:live-stop', {
          ticket: TICKET,
          team: teamName,
          outcome,
          ts: Date.now(),
        });
      } catch { /* ignore broadcast failures during cleanup */ }
    }
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

module.exports = { runAgentsTeam, runSingleAgent, buildLiveSnapshot, simpleHash };
