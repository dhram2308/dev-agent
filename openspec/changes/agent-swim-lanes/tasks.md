## 1. Backend — SSE event emission

- [x] 1.1 In `packages/agent/src/lib/agents-team.ts`, import `broadcast` from `../server/sse` at module top (replace the three inline `require()` calls in the poller/cleanup blocks with a single import).
- [x] 1.2 At the existing `logInfo(...Starting…)` site (currently line 231), broadcast `agent:progress` with `phase: 'start'`, `ticket`, `team: teamName`, `agent: agent.name`, `ts: Date.now()`, `startedAt: agentStart`, `required: agent.required !== false`, `promptChars: agent.prompt.length`, `timeoutMs: agent.timeout`, `maxTurns: agent.opts?.maxTurns ?? null`.
- [x] 1.3 At the existing `logOk(...Complete)` site (currently line 239), broadcast `agent:progress` with `phase: 'complete'`, same identifiers, `durationMs: Date.now() - agentStart`, `outputChars: output.length`, `required`.
- [x] 1.4 At the existing `logWarn(...Failed)` site (currently line 252), broadcast `agent:progress` with `phase: 'failed'`, `durationMs`, `required`, `errorMessage: err.message.slice(0, 500)`.
- [x] 1.5 Verify the ticket value is available in scope — thread it from `runAgentsTeam()` parameters (state.data.ticket / the `TICKET` const already used on line 208).

## 2. Backend — `_active_agents` shape change

- [x] 2.1 Define a shared `ActiveAgent` type `{ name: string; team: string; startedAt: number; phase: 'running' }` in `packages/agent/src/lib/agents-team.ts` (or a shared `types.ts` nearby).
- [x] 2.2 Replace the two write sites in `agents-team.ts` that mutate `_active_agents`:
  - on start (add near the `Starting…` log): push `{ name, team, startedAt, phase: 'running' }`;
  - on finish (line 244 and 254): filter by `name`.
- [x] 2.3 In `buildLiveSnapshot()` (same file), map `_active_agents.map(a => a.name)` before returning `activeAgents` so `codegen:live` payload stays `string[]`.
- [x] 2.4 Grep the repo (`packages/**`) for any other reader of `_active_agents` and adapt it to the new shape. Likely candidates: `/api/codegen/live` handler in `packages/agent/src/server/routes.ts`, any checkpoint/resume code. Verify no reader assumes `string[]`.
- [x] 2.5 Update tests under `packages/agent/tests/` and `packages/backend/tests/` that construct `_active_agents: ['Foo']` fixtures — change to the object shape.

## 3. Backend — agents history + writer serialization

- [x] 3.1 Add `state.data._agents_history` to the state schema (if typed). Initialize on first write; cap length at 50 with `history.shift()` before `push()` when over cap.
- [x] 3.2 Introduce a small helper `withTicketState(ticket, mutator)` in `packages/agent/src/lib/state-unified.ts` (or reuse the existing mutex utility) that: locks the per-ticket mutex, loads the latest state, runs `mutator(state)`, saves once, releases the lock.
- [x] 3.3 Route the two lifecycle write sites in `agents-team.ts` (start push; finish remove + history append) through `withTicketState`. Remove the direct `state.data.xxx = ...; save(state)` pattern at those sites.
- [x] 3.4 Downgrade the CAS-conflict `warn` calls in `packages/agent/src/lib/state-unified.ts:526` and `:684` (and the equivalent `onWarn(...)` in `packages/backend/src/state/state-manager.ts:708`, `:759`) to `debug` level.
- [x] 3.5 Run the existing `packages/backend/tests/unit/state-manager.test.ts` "CAS conflict detectable via _seq mismatch" test (line 317) — it should still pass; the test asserts detectability, not a warn log.

## 4. Backend — hydration endpoint

- [x] 4.1 Add a route handler for `GET /api/agents/progress` in `packages/agent/src/server/routes.ts`. Read `ticket` from querystring; respond 400 if missing.
- [x] 4.2 Load the ticket's state via the same helper used by `/api/codegen/live` (grep for `/api/codegen/live` to find the loader). On missing state, respond 404 with `{ error: "ticket not found" }`.
- [x] 4.3 Build the response body: `live = (state.data.stage === 'generate_code' && (state.data._active_agents?.length ?? 0) > 0)`; `active = state.data._active_agents ?? []`; `history = state.data._agents_history ?? []`; `ts = Date.now()`.
- [x] 4.4 Ensure the route is behind the same auth check (token querystring) that `/api/codegen/live` uses.

## 5. Frontend — store

- [x] 5.1 Create `packages/frontend/src/store/agentProgress.ts` exporting a Zustand store with state `{ byTicket: Map<ticket, { active: ActiveAgent[]; history: HistoryAgent[]; ts: number }> }` and actions `applyEvent(ev)`, `hydrate(ticket)`, `clear(ticket)`.
- [x] 5.2 Implement `applyEvent(ev)` idempotently: on `start`, add an active entry unless one with the same `agent` name already exists; on `complete`/`failed`, remove the active entry for that name and append to `history` unless a history entry with the same `(agent, startedAt)` already exists. Bump stored `ts` to `max(existing.ts, ev.ts)`.
- [x] 5.3 Implement `hydrate(ticket)` calling `GET /api/agents/progress?ticket=...` with the same auth-token pattern used by `codegenLive.ts:80-102`. Replace the store entry atomically with the returned body.
- [x] 5.4 Export selectors `useActiveAgents(ticket)` and `useAgentHistory(ticket)` and a combined `useAgentProgress(ticket)`.

## 6. Frontend — SSE subscription

- [x] 6.1 In `packages/frontend/src/hooks/useSSEConnection.ts`, add a listener for the SSE event name `agent:progress` that parses the JSON body and calls `useAgentProgressStore.getState().applyEvent(payload)`.
- [x] 6.2 Ensure the listener is ticket-filtered the same way the existing `codegen:live` listener is (see `useSSE.ts` for the pattern).

## 7. Frontend — SwimLanes component

- [x] 7.1 Create `packages/frontend/src/components/AgentSwimLanes.tsx`. Reads `useAgentProgress(activeTicket)`. Returns `null` when there is no entry.
- [x] 7.2 Render a container with a header ("Agents — <team name>, <N> running / <M> done") and one row per agent in order: active agents first (by `startedAt` ascending), then history entries (by `startedAt` descending).
- [x] 7.3 Each row: icon (`⟳` / `✓` / `✗`), name (bolded), elapsed-or-final-duration, a horizontal bar `<div>` whose `width` is `(duration / max_duration_on_screen) * 100%`, and `outputChars` formatted via a small `formatBytes(n)` helper.
- [x] 7.4 Implement a client-side elapsed ticker: `useState` + `useEffect` with `setInterval(() => setTick(t => t+1), 1000)` scoped to any row whose `phase === 'running'`. Derive `elapsed = Date.now() - startedAt` in the render pass — no store mutation.
- [x] 7.5 Add row click → `useState` toggle for an expanded drawer below that row displaying `promptChars`, `timeoutMs`, `maxTurns`, and (when present) the first 2048 characters of the agent output. (Agent output is not in the event payload; include a "View raw logs" link that navigates to the LogViewer filtered to this agent's name.)
- [x] 7.6 Style to match `AgentActivityBar.tsx` and `LogViewer.tsx` (glass container, `--text-*` + `--glass-bg` tokens).

## 8. Frontend — stage card wiring

- [x] 8.1 Render `<AgentSwimLanes />` inside the `generate_code` stage card (same parent as the `DiffViewer` — grep for where `DiffViewer` is mounted for the generate_code stage and add the component near it).
- [x] 8.2 On first view of a ticket whose `stage === 'generate_code'` and whose store has no entry, call `useAgentProgressStore.getState().hydrate(ticket)` (mirror the pattern in `codegenLive.ts` hydration).
- [x] 8.3 Verify the component returns `null` on non-`generate_code` stages — spot-check on `deploy_qa` / `done` tickets.

## 9. Verification

- [ ] 9.1 Start a dev run on a test ticket. Open the Web UI at `http://localhost:3000`, navigate to the ticket during `generate_code`.
- [ ] 9.2 Confirm swim lanes render for every agent and the elapsed times tick in real-time (running rows update at least once per second).
- [ ] 9.3 Refresh the browser mid-run and confirm swim lanes re-hydrate with no gap via `/api/agents/progress`.
- [ ] 9.4 Click a completed row and confirm the drawer shows `promptChars`, `timeoutMs`, `maxTurns`, and a 2 KB output preview.
- [ ] 9.5 Force a failure (e.g. set a tiny timeout on a test agent); confirm the failed row renders in error color with the trimmed error message.
- [ ] 9.6 Confirm `[State CAS] CAS conflict` lines no longer appear in the default LogViewer stream during `generate_code`. Enable debug-level filtering and confirm they are still visible there.
- [ ] 9.7 Confirm `codegen:live` continues to drive the `DiffViewer` correctly (no regression from the `_active_agents` shape change).
- [ ] 9.8 Navigate to a ticket on a non-`generate_code` stage and confirm `AgentSwimLanes` does not render or reserve layout space.
