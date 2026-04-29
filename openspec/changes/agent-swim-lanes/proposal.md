## Why

During `generate_code`, the agents-team spawns 3+ parallel Claude agents (Requirements, Code Explorer, Risk Analyst, then Coder). Their progress today is buried in an unstructured terminal log stream — the only UI surface is a one-line `AgentActivityBar` and a virtualized raw log viewer. Users can't answer at a glance: "who's running, who's done, how long did each take, who failed?" The info already exists; it just isn't shaped for humans.

## What Changes

- Add a structured **Agent Swim Lanes** component inline in the `generate_code` stage card showing one row per agent with: name, phase (pending / running / complete / failed), client-ticking elapsed time, a duration-proportional bar, and final output size. Click a row to expand a drawer with prompt size, timeout, maxTurns, and an output preview.
- Emit new **`agent:progress` SSE events** from the three existing lifecycle sites in `packages/agent/src/lib/agents-team.ts` (Starting…, Complete, Failed) carrying `{ ticket, team, agent, phase, ts, startedAt, durationMs?, outputChars?, required, promptChars?, timeoutMs?, maxTurns? }`.
- Extend `state.data._active_agents` from `string[]` to a structured array `{ name, team, startedAt, phase }` so a page refresh during an agents-team run re-hydrates the swim lanes (mirrors how `codegen:live` hydrates via `/api/codegen/live`). Add `/api/agents/progress?ticket=...` endpoint for hydration.
- Serialize the `_active_agents` writer through the existing state save path so concurrent agent completions stop emitting `[State CAS] CAS conflict: expected seq N, found N+1 -- merging` warnings (benign today; noisy).
- Keep prompt char counts, timeout seconds, and CAS merges in debug logs only — never user-facing outside the click-to-expand drawer.
- **Non-goal**: no changes to the `LogViewer`; no Gantt view across stages; no per-agent tool-call trace or token streaming.

## Capabilities

### New Capabilities
- `agent-progress`: Structured per-agent lifecycle reporting for agents-team runs. Defines the shape of `agent:progress` SSE events, the `_active_agents` state contract, the hydration endpoint, and the UI requirement that the `generate_code` stage card renders swim lanes sourced from this data.

### Modified Capabilities
<!-- None — no existing specs cover agent progress reporting. -->

## Impact

- **Affected code**:
  - `packages/agent/src/lib/agents-team.ts` — emit structured events alongside existing `logInfo/logOk/logWarn` calls; change `_active_agents` shape and its two write sites (add-on-start, remove-on-finish).
  - `packages/agent/src/server/sse.ts` — no change (broadcast already generic).
  - `packages/agent/src/server/routes.ts` — add `/api/agents/progress?ticket=…` handler.
  - `packages/frontend/src/store/` — add `agentProgress.ts` Zustand store.
  - `packages/frontend/src/components/` — add `AgentSwimLanes.tsx`; wire into the `generate_code` stage card.
  - `packages/frontend/src/hooks/useSSEConnection.ts` — subscribe to `agent:progress` event.
- **Affected pipeline stage**: `generate_code` only. Other stages do not use `runAgentsTeam()`.
- **State schema migration**: `_active_agents` shape change is backward-readable (front-end tolerates both `string[]` and object array during rollout; agent always writes the new shape). No persistent state rewrite needed — this field is ephemeral to a running stage.
- **No external API / GitLab / Jira impact.**
- **CAS conflict reduction** is a side benefit — the current `state-unified.ts:526` warnings from concurrent completers go away once writes are serialized through one path.
