## ADDED Requirements

### Requirement: Emit structured agent lifecycle events
The system SHALL emit a typed `agent:progress` SSE event for every agents-team agent at each lifecycle transition (start, complete, failed).

The event payload SHALL include the fields `ticket`, `team`, `agent`, `phase` (`"start" | "complete" | "failed"`), `ts`, `startedAt`, and `required`. Complete and failed phases SHALL additionally include `durationMs`. Complete SHALL include `outputChars`. Start SHALL include `promptChars`, `timeoutMs`, and `maxTurns`. Failed SHALL include `errorMessage` trimmed to 500 characters.

Events SHALL be emitted from within `runAgentsTeam()` in `packages/agent/src/lib/agents-team.ts` at the same code sites as the existing `logInfo`/`logOk`/`logWarn` lifecycle logs (currently lines 231, 239, 252).

#### Scenario: Agent starts
- **WHEN** `runAgentsTeam()` begins executing a pending agent
- **THEN** the system broadcasts an `agent:progress` event with `phase: "start"`, the agent's `name`, the `team` name, `ts` and `startedAt` set to the current time, `promptChars` equal to `agent.prompt.length`, `timeoutMs` equal to `agent.timeout`, `maxTurns` equal to `agent.opts?.maxTurns ?? null`, and `required` equal to `agent.required !== false`

#### Scenario: Agent completes successfully
- **WHEN** an agent's `callClaude` promise resolves with output
- **THEN** the system broadcasts an `agent:progress` event with `phase: "complete"`, `durationMs` equal to `Date.now() - agentStart`, `outputChars` equal to `output.length`, and the same `startedAt` that was sent in the corresponding start event

#### Scenario: Agent fails
- **WHEN** an agent's `callClaude` promise rejects
- **THEN** the system broadcasts an `agent:progress` event with `phase: "failed"`, `durationMs` equal to `Date.now() - agentStart`, `errorMessage` equal to the error's `message` trimmed to 500 characters, and `required` reflecting whether the agent was required

#### Scenario: Event delivery is ticket-scoped
- **WHEN** an `agent:progress` event is broadcast for ticket `AUT-X`
- **THEN** only SSE clients subscribed to ticket `AUT-X` (or to the global feed) receive the event, following the existing ticket-scoping rules of `broadcast()` in `packages/agent/src/server/sse.ts`

### Requirement: Track running agents as structured objects
The system SHALL represent `state.data._active_agents` as an array of objects with fields `{ name: string; team: string; startedAt: number; phase: "running" }` while any agents-team agent is executing.

An entry SHALL be appended when an agent starts and removed when the agent completes or fails. The field SHALL be empty (`[]`) when no agents-team agents are executing for the ticket.

`buildLiveSnapshot()` and any other consumer of `_active_agents` SHALL map this array to `string[]` of agent names before exposing it on the `codegen:live` SSE payload, preserving the existing wire format for that event.

#### Scenario: Agent start adds entry
- **WHEN** `runAgentsTeam()` begins executing an agent named `Risk Analyst` on team `analysis`
- **THEN** `state.data._active_agents` contains an entry `{ name: "Risk Analyst", team: "analysis", startedAt: <now>, phase: "running" }`

#### Scenario: Agent completion removes entry
- **WHEN** the `Risk Analyst` agent completes
- **THEN** the entry with `name === "Risk Analyst"` is removed from `state.data._active_agents`

#### Scenario: Backward-compatible codegen:live payload
- **WHEN** the live poller emits a `codegen:live` event while `_active_agents` contains structured entries
- **THEN** the `activeAgents` field in the payload is an array of strings (the `name` of each entry), matching the shape consumed by `packages/frontend/src/store/codegenLive.ts`

### Requirement: Record a bounded history of completed agents
The system SHALL maintain `state.data._agents_history` as an ordered array of completed-or-failed agent records scoped to the ticket, capped at 50 entries with FIFO drop of the oldest when the cap is exceeded.

Each entry SHALL include `{ name, team, startedAt, durationMs, phase: "complete" | "failed", outputChars?, required, errorMessage? }`.

#### Scenario: Successful completion is appended
- **WHEN** the `Requirements` agent completes after 37.3 seconds with 4159 output characters
- **THEN** `state.data._agents_history` gains an entry with `name: "Requirements"`, `phase: "complete"`, `durationMs: 37300`, `outputChars: 4159`

#### Scenario: Failure is appended
- **WHEN** a required agent fails after 12 seconds with error `"timed out"`
- **THEN** `state.data._agents_history` gains an entry with `phase: "failed"`, `durationMs: 12000`, `errorMessage: "timed out"`, `required: true`

#### Scenario: History cap
- **WHEN** a 51st entry would be appended to `_agents_history`
- **THEN** the oldest existing entry (index 0) is dropped before the new entry is appended, keeping the array length at 50

### Requirement: Serialize lifecycle writes through the state mutex
Every mutation to `_active_agents` and `_agents_history` performed by `runAgentsTeam()` SHALL execute inside the per-ticket state mutex already provided by `packages/agent/src/lib/state-unified.ts`.

This requirement exists so that concurrent agent completions do not race `save(state)` calls and therefore do not produce `[State CAS] CAS conflict: expected seq N, found N+1 -- merging` warnings.

#### Scenario: Concurrent completions do not emit CAS warnings
- **WHEN** three agents on the same team complete within the same 100ms window
- **THEN** no `[State CAS] CAS conflict` warning is logged for the sequence of writes they perform to `_active_agents` and `_agents_history`

#### Scenario: Each mutation results in exactly one save
- **WHEN** an agent transitions to `complete`
- **THEN** exactly one `save(state)` call occurs for the combined `_active_agents` removal + `_agents_history` append

### Requirement: Provide a hydration endpoint for agent progress
The system SHALL expose `GET /api/agents/progress?ticket=<id>` returning JSON of the shape `{ live: boolean, active: ActiveAgent[], history: HistoryAgent[], ts: number }` so that a client loading the page mid-run can reconstruct the swim lanes before its first SSE event arrives.

`live` SHALL be `true` when the ticket's current stage is `generate_code` AND `_active_agents.length > 0`.

#### Scenario: Mid-run hydration
- **WHEN** a client calls `/api/agents/progress?ticket=AUT-8457` while `generate_code` is running with two active agents and one completed agent
- **THEN** the response has `live: true`, `active.length === 2`, `history.length === 1`, and `ts` set to the current server time

#### Scenario: No active agents
- **WHEN** a client calls the endpoint for a ticket whose stage is not `generate_code`
- **THEN** the response has `live: false` and `active: []`; `history` SHALL still reflect any persisted history entries for the ticket

#### Scenario: Unknown ticket
- **WHEN** a client calls the endpoint for a ticket that has no state file
- **THEN** the server responds with HTTP 404 and a JSON body `{ error: "ticket not found" }`

### Requirement: Render swim lanes in the generate_code stage card
The Web UI SHALL render an `AgentSwimLanes` component inside the `generate_code` stage card whenever the per-ticket agent-progress store contains at least one entry.

Each swim lane row SHALL display: the agent's name; its phase indicated by an icon (`⟳` running, `✓` complete, `✗` failed); the elapsed or final duration; a horizontal bar whose width is proportional to duration; and the final `outputChars` (in human-readable form like `4.2 KB`) for completed agents.

Rows SHALL be clickable; clicking a row SHALL expand a drawer displaying `promptChars`, `timeoutMs`, `maxTurns`, and (for completed agents) the first 2 KB of the agent's output text with a link to the raw log viewer for the full output.

The component SHALL return `null` on any other stage or when the store has no entry for the active ticket.

#### Scenario: Running agent row
- **WHEN** an agent is in phase `running` with `startedAt` 42 seconds ago
- **THEN** the row renders `⟳ <name>  42s (running)` with the bar width proportional to 42s

#### Scenario: Client-side elapsed ticking
- **WHEN** an agent is running
- **THEN** the row re-renders at least once per second to update its elapsed-time display, without any additional SSE event being required

#### Scenario: Completed agent row
- **WHEN** an agent has completed in 37.3 seconds with 4159 output characters
- **THEN** the row renders `✓ <name>  37.3s  4.2 KB` with the bar width proportional to 37.3s

#### Scenario: Failed required agent row
- **WHEN** a required agent has failed after 12 seconds with error `"timed out"`
- **THEN** the row renders `✗ <name>  12.0s  failed` in an error-colored style; the drawer shows the error message

#### Scenario: Row drawer
- **WHEN** the user clicks a completed agent's row
- **THEN** a drawer expands showing `promptChars`, `timeoutMs`, `maxTurns`, and a preview of the first 2048 characters of the agent's output

#### Scenario: Hidden on non-codegen stages
- **WHEN** the active ticket's stage is `deploy_qa`
- **THEN** `AgentSwimLanes` returns null and reserves no layout space

### Requirement: Subscribe to agent:progress in the SSE connection hook
The `useSSEConnection` hook SHALL add a listener for `agent:progress` events and dispatch each event to the agent-progress Zustand store.

Dispatch SHALL be idempotent: receiving the same `(ticket, agent, phase)` combination twice SHALL NOT duplicate active-list entries or history entries; the event with the higher `ts` SHALL take precedence.

#### Scenario: Start event populates active list
- **WHEN** the hook receives an `agent:progress` event with `phase: "start"` for a ticket the user is viewing
- **THEN** the agent-progress store for that ticket gains one entry in its active list

#### Scenario: Duplicate events are idempotent
- **WHEN** the hook receives two `agent:progress` events with the same `ticket`, `agent`, and `phase: "complete"` (e.g. after an SSE reconnection replay)
- **THEN** `_agents_history` in the store contains exactly one matching entry

### Requirement: Downgrade CAS conflict warnings to debug level
The `[State CAS] CAS conflict: expected seq N, found N+1 -- merging` messages emitted from `packages/agent/src/lib/state-unified.ts` SHALL be logged at `debug` level rather than `warn` level, so that they do not appear in the default user-visible log stream.

#### Scenario: CAS conflict not shown by default
- **WHEN** a CAS conflict is detected during a state write
- **THEN** the message is logged at level `debug` and does not appear in the default `LogViewer` output

#### Scenario: CAS conflict still available for debugging
- **WHEN** a developer enables debug-level log filtering in the `LogViewer`
- **THEN** the CAS conflict message is visible with the same wording as today
