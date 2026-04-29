## Context

`runAgentsTeam()` in `packages/agent/src/lib/agents-team.ts` fans out parallel Claude agents (e.g. Requirements, Code Explorer, Risk Analyst in the analysis team; Coder in the coder team) during the `generate_code` stage. Its lifecycle signals today are three plain log calls:

```
agents-team.ts:231  logInfo(`  [${agent.name}] Starting… (timeout: …)`)
agents-team.ts:239  logOk(`  [${agent.name}] Complete (${elapsed}s, ${output.length} chars)`)
agents-team.ts:252  logWarn(`  [${agent.name}] Failed (${elapsed}s): ${err.message…}`)
```

These logs are broadcast to the frontend via the generic `broadcast("log", entry)` in `packages/agent/src/server/sse.ts:354` and rendered by `LogViewer.tsx` — a virtualized raw-text stream. There is no structured event shape and no UI component dedicated to per-agent progress. The only purpose-built "what's happening" surface is `AgentActivityBar.tsx`, which renders a single string (`state.data._agent_action`).

Two pieces of existing state come close but don't solve the problem:

- `state.data._active_agents: string[]` — names only; no phase, no start time, no history after an agent completes (the name is removed on completion at `agents-team.ts:244`).
- `codegen:live` SSE + `/api/codegen/live` — carries `activeAgents[]` as a side-car but its purpose is streaming diff snapshots to the review viewer, not agent lifecycle.

We also see frequent `[State CAS] CAS conflict: expected seq N, found N+1 -- merging` lines when multiple agents complete within the same tick. The conflict originates at `packages/agent/src/lib/state-unified.ts:526` because each agent's completion handler does `state.data[…] = …; save(state)` without a serialized writer. This is benign (the merge layer handles it) but it is noise in the log feed we're trying to make user-facing.

Constraints:
- Node.js (ESM/TS compiled), no new runtime deps.
- SSE broadcast is already ticket-scoped via `entry.ticket` filtering in `sse.ts`.
- State persistence must be crash-recoverable so refresh during a long agents-team run continues showing the right swim lanes.
- Must not regress `codegen:live` / `/api/codegen/live` which reads `_active_agents`.

## Goals / Non-Goals

**Goals:**
- User can glance at the `generate_code` stage card during an agents-team run and immediately see each agent's name, phase, live elapsed time, and relative duration bar.
- After agents complete, the lanes show final durations and output sizes so the user can compare (e.g. "Code Explorer took 3× longer than Risk Analyst").
- A page refresh during a run restores the swim lanes without gap (hydration endpoint).
- CAS conflict spam caused by concurrent agent completions stops appearing in user-visible log streams.
- Prompt sizes, timeouts, maxTurns, and full agent output remain available but gated behind a click-to-expand drawer — they are dev context, not ambient UI.

**Non-Goals:**
- No Gantt/timeline across pipeline stages (single stage only).
- No per-agent tool-call trace or token streaming. The MVP reports only lifecycle boundaries.
- No changes to `LogViewer.tsx`. Raw logs stay as the debug-level fallback.
- No generalization to non-agents-team callers of `callClaude` (the single-agent stages don't need swim lanes).

## Decisions

### 1. Emit structured SSE events co-located with existing log lines
At each of the three lifecycle sites in `agents-team.ts` we call `broadcast('agent:progress', { … })` alongside the existing `logInfo/logOk/logWarn`. Payload:
```ts
{
  ticket: string,
  team: 'analysis' | 'coder' | string,     // teamName param
  agent: string,                            // agent.name
  phase: 'start' | 'complete' | 'failed',
  ts: number,                               // emission time
  startedAt: number,                        // start wall time (for 'complete'/'failed' too, so lanes can render the bar)
  durationMs?: number,                      // complete|failed only
  outputChars?: number,                     // complete only
  required: boolean,
  promptChars?: number,                     // start only (for the drawer)
  timeoutMs?: number,                       // start only
  maxTurns?: number | null,                 // start only
  errorMessage?: string                     // failed only, trimmed to 500 chars
}
```
**Why a new event type, not reusing `log`:** Parsing `[Requirements Agent] Complete (37.3s, 4159 chars)` in the frontend is possible but fragile — any wording tweak silently breaks the UI. A typed event decouples the surface from log prose. **Alternatives considered:** extending the `log` payload with optional structured fields (rejected — overloads a text-oriented channel); a dedicated `agent:lifecycle` stream like `codegen:live` (rejected — same generic broadcast works, SSE clients already multiplex by event name).

### 2. Extend `_active_agents` to structured objects, keep the field name
Change `state.data._active_agents: string[]` → `state.data._active_agents: { name: string; team: string; startedAt: number; phase: 'running' }` during a run. On completion an entry is removed (same as today). Terminal entries are NOT persisted here — terminal history lives in `state.data._agents_history: { name, team, startedAt, durationMs, phase: 'complete'|'failed', outputChars?, required }[]`, capped to the last 50 entries per ticket.

**Why keep the same field name:** `codegen:live` reads `_active_agents` for its `activeAgents[]` shape. We rewrite `buildLiveSnapshot()` to map to names, preserving the existing wire format. The alternative — a new field — leaves stale code reading strings and the new code reading objects.

**Why a separate history array:** `_active_agents` must stay accurate to "currently running" for `codegen:live`. Embedding completed entries there would leak semantics.

### 3. One-writer serialization for `_active_agents` + `_agents_history`
Funnel every lifecycle mutation through a `withState(ticket, fn)` helper that acquires the existing per-ticket state mutex (already used elsewhere in `state-unified.ts`) and batches read-modify-write into a single `save(state)` call. This removes the concurrent-writer CAS conflicts because completions from three agents will serialize instead of racing.

**Alternatives considered:** (a) swallow the CAS warn at log level — rejected, masks real bugs elsewhere; (b) use optimistic retry with jitter — rejected, retry storm under load; (c) move to a queue — rejected, introduces async complexity for a 3-operation burst.

### 4. Hydration endpoint `/api/agents/progress?ticket=…`
Returns `{ live: boolean, active: ActiveAgent[], history: HistoryAgent[], ts: number }` for the given ticket. `live` = true when the stage is `generate_code` AND `_active_agents.length > 0`. Mirrors the `/api/codegen/live` pattern. The frontend store (`agentProgress.ts`) calls this on first view if the ticket is on `generate_code` and the local map has no entry yet.

### 5. Client-side elapsed timer, not server ticks
`AgentSwimLanes.tsx` holds each running agent's `startedAt` and uses a `useState` + `setInterval` to re-render every 1s, deriving `elapsed = now - startedAt`. No server-side "Working… Xs elapsed" tick needs to go over the wire. (The existing `claude.ts:101` debug log stays in debug level, off by default in the UI.)

**Why:** Network-independent, zero idle bandwidth, and the elapsed is derivable from the `start` event alone.

### 6. CAS conflict warnings downgraded in UI surface
The CAS-conflict `logWarn` calls in `state-unified.ts:526` / `:684` stay in the code for debugging but their `level` drops from `warn` to `debug`. Rationale: with decision 3 these become rare; any remaining instance indicates a code path bypassing the mutex and is worth investigating but not worth alarming a user.

### 7. Component lives in the stage card, not a new tab
`AgentSwimLanes` renders inside the `generate_code` stage card (the same card that already hosts the diff viewer). It returns `null` when the store has no entry for the active ticket, so it imposes zero layout cost on other stages.

## Risks / Trade-offs

- **State shape migration of `_active_agents`** → Mitigation: the field is ephemeral to a running stage, never archived. A rolling deploy could have old clients reading object-shaped entries as strings — the frontend tolerates both shapes during the transition (see tasks 4.2).
- **History cap at 50** → a single ticket could in theory run more than 50 agents (re-runs across stages). Mitigation: FIFO drop, newest kept. Users who need the full trace still have the raw LogViewer.
- **SSE replay vs. hydration race** → if the user loads the page mid-run, they may get `/api/agents/progress` + a burst of live events. Mitigation: store applies events idempotently by `(ticket, agent, phase)` and takes `max(ts)`.
- **`agent:progress` volume** → 3 events per agent × ~4 agents per team × 2 teams = ~24 events per `generate_code` run. Negligible versus `codegen:live` (every 1.5s).
- **Writer serialization latency** → the serialization lock adds at worst ~tens of ms per completion. Mitigation: completions are already async and not in any hot path.
- **LogViewer redundancy** → we're not removing the "[Agent] Starting…/Complete" log lines. They remain as the debug/developer fallback. Mitigation: acceptable; duplication is cheap and backward-compatible.

## Migration Plan

1. Ship backend changes first (event emission + state shape extension + writer serialization). The frontend ignoring unknown SSE events means no UI regression.
2. Ship frontend changes second. Until both are deployed, the swim lane component simply shows nothing (empty store).
3. No data migration — `_active_agents` is ephemeral to an in-flight run. Any stage restart (resume) starts the lanes fresh.
4. Rollback: delete the `agent:progress` broadcast calls and revert `_active_agents` back to `string[]`. No persisted state depends on the new shape.

## Open Questions

- Should the drawer ever show the agent's full output text (it can be tens of KB) or only the first N chars + a "view in raw logs" link? Current lean: first 2 KB + link.
- Do we want swim lanes to persist visually after `generate_code` completes (e.g. collapsed "3 agents, 82s total" summary on later stages)? Current lean: yes, but keep out of MVP scope — controlled by a follow-up change.
