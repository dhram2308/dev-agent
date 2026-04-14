## ADDED Requirements

### Requirement: SSE log events tagged with ticket ID
All SSE `log` events SHALL include a `ticket` field identifying which agent process produced the log line. System-level messages (not associated with a ticket) SHALL have `ticket: null`.

#### Scenario: Agent log line from AUT-8203
- **WHEN** `run-agent.js` for AUT-8203 writes to stdout
- **THEN** `addLog(line, "stdout", "AUT-8203")` is called
- **THEN** SSE broadcasts `{ ts, line, type: "stdout", ticket: "AUT-8203" }`

#### Scenario: System-level log (no ticket)
- **WHEN** server emits a system message (e.g., "Server started on port 3000")
- **THEN** `addLog(line, "system")` is called (no ticket param)
- **THEN** SSE broadcasts `{ ts, line, type: "system", ticket: null }`

### Requirement: Per-ticket log buffers on server
The server SHALL maintain separate in-memory log buffers per ticket, plus a global buffer for system messages. Each per-ticket buffer SHALL be capped at `MAX_LOG` entries (2000).

#### Scenario: Logs accumulate for two tickets
- **WHEN** AUT-8203 produces 100 log lines and AUT-8343 produces 50 log lines
- **THEN** `logBuffers["AUT-8203"]` contains 100 entries
- **THEN** `logBuffers["AUT-8343"]` contains 50 entries
- **THEN** `globalLogBuffer` contains only system messages

#### Scenario: Per-ticket buffer exceeds cap
- **WHEN** AUT-8203 produces its 2001st log line
- **THEN** the oldest entry in `logBuffers["AUT-8203"]` is removed (FIFO)

#### Scenario: Agent exits — buffer retained for replay
- **WHEN** AUT-8203 agent exits
- **THEN** `logBuffers["AUT-8203"]` is NOT immediately cleared (allows reconnecting clients to replay)
- **THEN** buffer is cleared when the ticket entry is removed from the UI (or server restarts)

### Requirement: Filtered log replay on SSE reconnect
When a client connects or reconnects to SSE, the server SHALL replay logs filtered by the `ticket` query parameter if provided.

#### Scenario: Client connects with ticket filter
- **WHEN** client connects to `GET /api/logs?token=xxx&ticket=AUT-8203`
- **THEN** server replays `logBuffers["AUT-8203"]` + `globalLogBuffer` entries (merged by timestamp)
- **THEN** server does NOT replay logs from other tickets

#### Scenario: Client connects without ticket filter (backward compat)
- **WHEN** client connects to `GET /api/logs?token=xxx` (no ticket param)
- **THEN** server replays ALL log buffers merged together (existing behavior)

### Requirement: SSE review events include ticket
All SSE `review` event broadcasts from `/api/approve`, `/api/reject`, `/api/refine` SHALL include the `ticket` field in the payload.

#### Scenario: Approve gate for AUT-8203
- **WHEN** `/api/approve` is called with `{ ticket: "AUT-8203", gate: "gate_code_review" }`
- **THEN** SSE broadcasts `{ gate: "gate_code_review", action: "approved", ticket: "AUT-8203" }`

### Requirement: SSE status events include ticket
All SSE `status` event broadcasts SHALL include the `ticket` field. This is already partially implemented in `agent-process.js` — this requirement ensures consistency.

#### Scenario: Agent for AUT-8203 stops
- **WHEN** `run-agent.js` for AUT-8203 exits
- **THEN** SSE broadcasts `{ running: false, code: 0, ticket: "AUT-8203" }`
