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

// ── Adaptive max-turns on retry (Fix B from AUT-8648 post-mortem) ─
//
// When an agent fails with "Reached max turns" and the pipeline retries
// the stage, the SAME max-turns cap fires again — wasting another full
// timeout window on a guaranteed-fail attempt. AUT-8648 burned ~30 min
// on identical Dev-Agent retries at 09:38 / 09:39 / 09:40.
//
// On each subsequent invocation of a checkpointKey that previously hit
// max-turns, we scale the per-agent turn cap by MULTIPLIER. After
// FAILURE_LIMIT consecutive max-turns failures, the agent is short-
// circuited (required → team failure; optional → silent skip) so we
// stop burning time on it without operator intervention or task
// subdivision.
//
// Counter is per-(ticket, checkpointKey) and lives at
// state.data._max_turns_failures[checkpointKey]. It clears on the next
// successful run of the same checkpointKey, so a follow-up ticket
// starts fresh.
const MAX_TURNS_RETRY_MULTIPLIER = 1.5;
const MAX_TURNS_HARD_CAP = 200;
const MAX_TURNS_FAILURE_LIMIT = 3;

function _isMaxTurnsError(err: Error | undefined | null): boolean {
  if (!err || !err.message) return false;
  return /Reached max turns|max[\s-]turns?\s+exceeded|max[\s-]turns?\s+reached/i.test(err.message);
}

function _getMaxTurnsFailures(state: any, checkpointKey: string): number {
  const map = state?.data?._max_turns_failures;
  const v = map && map[checkpointKey];
  return typeof v === 'number' && v > 0 ? v : 0;
}

function _scaleMaxTurnsForRetry(originalMaxTurns: number | undefined, failures: number): number | undefined {
  if (!originalMaxTurns || originalMaxTurns <= 0) return originalMaxTurns;
  if (failures <= 0) return originalMaxTurns;
  const scaled = Math.ceil(originalMaxTurns * Math.pow(MAX_TURNS_RETRY_MULTIPLIER, failures));
  return Math.min(scaled, MAX_TURNS_HARD_CAP);
}

function _recordMaxTurnsFailure(state: any, checkpointKey: string): number {
  if (!state.data._max_turns_failures) state.data._max_turns_failures = {};
  state.data._max_turns_failures[checkpointKey] = (state.data._max_turns_failures[checkpointKey] || 0) + 1;
  return state.data._max_turns_failures[checkpointKey];
}

function _clearMaxTurnsFailure(state: any, checkpointKey: string): void {
  if (state?.data?._max_turns_failures && state.data._max_turns_failures[checkpointKey]) {
    delete state.data._max_turns_failures[checkpointKey];
  }
}

// ── Adaptive startup-kill timeout (Fix F from AUT-8648 post-mortem) ─
//
// Distinct from Fix B: this catches the "agent never produced any
// output before SIGTERM/timeout fired" pattern. AUT-8648 had 10 such
// transcripts — exit 143 + zero stdout means the Claude CLI was killed
// before it could start streaming. Cause is usually a too-tight wall-
// clock budget on cold starts (large context, slow API), NOT a max-
// turns problem.
//
// Strategy: when an agent fails with isTimeout=true && stdoutLength=0,
// increment a per-checkpoint counter and scale the OUTER agent.timeout
// on the next invocation. After STARTUP_KILL_FAILURE_LIMIT consecutive
// startup kills, fail-fast (operator likely has a network or auth
// problem; throwing more time at it won't help).
//
// Counter lives at state.data._startup_kill_failures[checkpointKey],
// clears on success.
const STARTUP_KILL_RETRY_MULTIPLIER = 1.5;
const STARTUP_KILL_TIMEOUT_CAP = 30 * 60 * 1000; // 30 minutes
const STARTUP_KILL_FAILURE_LIMIT = 3;
const STARTUP_KILL_STDOUT_THRESHOLD = 100; // chars; anything less means "didn't actually start"

function _isStartupKill(err: any): boolean {
  if (!err) return false;
  // Primary signal: callClaude attached isTimeout + stdoutLength via Fix F.
  if (err.isTimeout && typeof err.stdoutLength === 'number' && err.stdoutLength < STARTUP_KILL_STDOUT_THRESHOLD) {
    return true;
  }
  // Secondary signal: exit-code path (e.g. 143 SIGTERM) with empty stdout.
  if (typeof err.exitCode === 'number' && err.exitCode !== 0 && typeof err.stdoutLength === 'number' && err.stdoutLength < STARTUP_KILL_STDOUT_THRESHOLD) {
    return true;
  }
  return false;
}

function _getStartupKills(state: any, checkpointKey: string): number {
  const map = state?.data?._startup_kill_failures;
  const v = map && map[checkpointKey];
  return typeof v === 'number' && v > 0 ? v : 0;
}

function _scaleTimeoutForStartupKills(originalTimeout: number | undefined, failures: number): number | undefined {
  if (!originalTimeout || originalTimeout <= 0) return originalTimeout;
  if (failures <= 0) return originalTimeout;
  const scaled = Math.ceil(originalTimeout * Math.pow(STARTUP_KILL_RETRY_MULTIPLIER, failures));
  return Math.min(scaled, STARTUP_KILL_TIMEOUT_CAP);
}

function _recordStartupKill(state: any, checkpointKey: string): number {
  if (!state.data._startup_kill_failures) state.data._startup_kill_failures = {};
  state.data._startup_kill_failures[checkpointKey] = (state.data._startup_kill_failures[checkpointKey] || 0) + 1;
  return state.data._startup_kill_failures[checkpointKey];
}

function _clearStartupKill(state: any, checkpointKey: string): void {
  if (state?.data?._startup_kill_failures && state.data._startup_kill_failures[checkpointKey]) {
    delete state.data._startup_kill_failures[checkpointKey];
  }
}

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

        // Fix B: Adaptive max-turns. Read prior max-turns failures for
        // this checkpointKey, fail-fast if the cap is reached, otherwise
        // scale opts.maxTurns for this attempt.
        const priorFailures = _getMaxTurnsFailures(state, agent.checkpointKey);
        const originalMaxTurns = (agent.opts || {}).maxTurns as number | undefined;
        const effectiveMaxTurns = _scaleMaxTurnsForRetry(originalMaxTurns, priorFailures);

        // Fix F: Adaptive timeout for startup-killed agents. Orthogonal
        // to Fix B — if the prior failure was a SIGTERM before any
        // output (cold start, slow API), scale agent.timeout (wall
        // clock) on the retry instead of maxTurns.
        const startupKills = _getStartupKills(state, agent.checkpointKey);
        const originalTimeout = agent.timeout;
        const effectiveTimeout = _scaleTimeoutForStartupKills(originalTimeout, startupKills) || originalTimeout;

        if (priorFailures >= MAX_TURNS_FAILURE_LIMIT) {
          const requiredAgent = agent.required !== false;
          const msg = `[${agent.name}] Skipped — exceeded max-turns failure limit (${priorFailures}/${MAX_TURNS_FAILURE_LIMIT}). Task likely too large for one agent; manual subdivision required.`;
          logWarn(`  ${msg}`);
          broadcast('agent:progress', {
            ticket: TICKET,
            team: teamName,
            agent: agent.name,
            phase: 'failed',
            ts: Date.now(),
            startedAt: agentStart,
            durationMs: 0,
            required: requiredAgent,
            errorMessage: msg,
          });
          return Promise.resolve({
            name: agent.name,
            output: null,
            status: 'rejected' as const,
            error: new Error(msg),
            required: requiredAgent,
          });
        }

        if (startupKills >= STARTUP_KILL_FAILURE_LIMIT) {
          const requiredAgent = agent.required !== false;
          const msg = `[${agent.name}] Skipped — exceeded startup-kill failure limit (${startupKills}/${STARTUP_KILL_FAILURE_LIMIT}). Agent is being SIGTERM'd before producing output; likely a network/auth issue, more time won't help.`;
          logWarn(`  ${msg}`);
          broadcast('agent:progress', {
            ticket: TICKET,
            team: teamName,
            agent: agent.name,
            phase: 'failed',
            ts: Date.now(),
            startedAt: agentStart,
            durationMs: 0,
            required: requiredAgent,
            errorMessage: msg,
          });
          return Promise.resolve({
            name: agent.name,
            output: null,
            status: 'rejected' as const,
            error: new Error(msg),
            required: requiredAgent,
          });
        }

        if (priorFailures > 0 && effectiveMaxTurns !== originalMaxTurns) {
          logInfo(`  [${agent.name}] Prior max-turns failure(s)=${priorFailures} — scaling maxTurns ${originalMaxTurns} → ${effectiveMaxTurns}`);
        }
        if (startupKills > 0 && effectiveTimeout !== originalTimeout) {
          logInfo(`  [${agent.name}] Prior startup-kill(s)=${startupKills} — scaling timeout ${Math.round(originalTimeout / 1000)}s → ${Math.round(effectiveTimeout / 1000)}s`);
        }

        const effectiveOpts: ClaudeCallOptions = { ...(agent.opts || {}) };
        if (effectiveMaxTurns !== undefined) effectiveOpts.maxTurns = effectiveMaxTurns;

        logInfo(`  [${agent.name}] Starting… (timeout: ${Math.round(effectiveTimeout / 1000)}s)`);
        broadcast('agent:progress', {
          ticket: TICKET,
          team: teamName,
          agent: agent.name,
          phase: 'start',
          ts: Date.now(),
          startedAt: agentStart,
          required: agent.required !== false,
          promptChars: agent.prompt.length,
          timeoutMs: effectiveTimeout,
          maxTurns: effectiveOpts.maxTurns ?? null,
        });
        return callClaude(agent.prompt, effectiveTimeout, {
          agentName: agent.name,
          ...effectiveOpts,
        })
          .then((output: string) => {
            const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
            const durationMs = Date.now() - agentStart;
            logOk(`  [${agent.name}] Complete (${elapsed}s, ${output.length} chars)`);
            validateClaudeNotEmpty(output, agent.name);
            detectClaudeRefusal(output, agent.name);
            // Fix B: clear the max-turns failure counter on success so a
            // future re-invocation of this checkpointKey starts fresh.
            _clearMaxTurnsFailure(state, agent.checkpointKey);
            // Fix F: same for startup-kill counter — a clean run means
            // the prior timeout-before-output condition has resolved.
            _clearStartupKill(state, agent.checkpointKey);
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

            // Fix B: If the failure is specifically "Reached max turns",
            // bump the per-checkpoint counter so the next invocation
            // gets a scaled cap. Non-max-turns failures don't change
            // the counter (no point boosting turns for a network error).
            if (_isMaxTurnsError(err)) {
              const newCount = _recordMaxTurnsFailure(state, agent.checkpointKey);
              const nextScaled = _scaleMaxTurnsForRetry(originalMaxTurns, newCount);
              logWarn(`  [${agent.name}] Max-turns failure recorded (${newCount}/${MAX_TURNS_FAILURE_LIMIT}). Next attempt will use ${nextScaled} turns (was ${originalMaxTurns}).`);
            }
            // Fix F: If the failure is a startup kill (SIGTERM/timeout
            // before any output), bump a separate per-checkpoint counter
            // so the next invocation gets a longer wall-clock budget.
            // This is independent of Fix B — the agent never started,
            // so its turn budget wasn't the problem.
            if (_isStartupKill(err)) {
              const newCount = _recordStartupKill(state, agent.checkpointKey);
              const nextScaled = _scaleTimeoutForStartupKills(originalTimeout, newCount);
              logWarn(`  [${agent.name}] Startup-kill recorded (${newCount}/${STARTUP_KILL_FAILURE_LIMIT}, stdoutLength=${(err as any).stdoutLength ?? '?'}). Next attempt will use ${Math.round((nextScaled || 0) / 1000)}s timeout (was ${Math.round(originalTimeout / 1000)}s).`);
            }

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

module.exports = {
  runAgentsTeam,
  runSingleAgent,
  buildLiveSnapshot,
  simpleHash,
  // Fix B helpers — exported for unit tests only.
  _isMaxTurnsError,
  _getMaxTurnsFailures,
  _scaleMaxTurnsForRetry,
  _recordMaxTurnsFailure,
  _clearMaxTurnsFailure,
  MAX_TURNS_RETRY_MULTIPLIER,
  MAX_TURNS_HARD_CAP,
  MAX_TURNS_FAILURE_LIMIT,
  // Fix F helpers — exported for unit tests only.
  _isStartupKill,
  _getStartupKills,
  _scaleTimeoutForStartupKills,
  _recordStartupKill,
  _clearStartupKill,
  STARTUP_KILL_RETRY_MULTIPLIER,
  STARTUP_KILL_TIMEOUT_CAP,
  STARTUP_KILL_FAILURE_LIMIT,
  STARTUP_KILL_STDOUT_THRESHOLD,
};
