## ADDED Requirements

### Requirement: Pipeline list endpoint
The system SHALL provide a `GET /api/pipelines` endpoint that scans all `state-*.json` files from the project root, cross-references with running agent processes, and returns an array of pipeline summaries.

Each summary SHALL include: `ticket`, `stage`, `startedAt`, `lastActivity`, `running` (boolean), `resumable` (boolean), `daysRemaining` (number, days until resume window expires), `needsApproval` (boolean), `gateStage` (string or null), `progress` (number, 0.0 to 1.0 based on stage index), and `status` (one of: `"running"`, `"paused"`, `"gate_waiting"`, `"done"`, `"expired"`).

#### Scenario: Multiple state files on disk
- **WHEN** the project root contains `state-AUT-8203.json`, `state-AUT-8343.json`, and `state-AUT-7991.json`
- **AND** AUT-8203 has an agent process running
- **THEN** the endpoint returns 3 entries with AUT-8203 marked `running: true` and the others marked `running: false`

#### Scenario: No state files on disk
- **WHEN** the project root contains no `state-*.json` files
- **THEN** the endpoint returns an empty array `[]`

#### Scenario: Corrupt state file
- **WHEN** a state file fails HMAC validation or JSON parsing
- **THEN** that file is skipped from the list (not included, no error thrown)
- **AND** a warning is logged

### Requirement: Pipeline list caching
The system SHALL cache the pipeline list scan result in memory with a 10-second TTL. The cache SHALL be invalidated when an agent starts, stops, or when state is written.

#### Scenario: Rapid consecutive requests
- **WHEN** two `GET /api/pipelines` requests arrive within 10 seconds
- **THEN** the second request is served from cache without rescanning disk

#### Scenario: Cache invalidation on agent start
- **WHEN** an agent is started via `POST /api/start`
- **THEN** the pipeline list cache is invalidated
- **AND** the next `GET /api/pipelines` request rescans disk

### Requirement: Pipeline list SSE broadcast
The system SHALL broadcast a `pipelines` SSE event whenever the pipeline list changes (agent start, agent stop, stage transition, state deletion).

#### Scenario: Agent starts
- **WHEN** an agent starts for AUT-8203
- **THEN** all SSE clients receive a `pipelines` event with the updated list containing AUT-8203 with `running: true`

#### Scenario: Agent completes
- **WHEN** an agent finishes and the stage becomes `done`
- **THEN** all SSE clients receive a `pipelines` event with AUT-8203 showing `status: "done"`

### Requirement: Sidebar pipeline list display
The frontend sidebar SHALL display all pipelines from `GET /api/pipelines`, grouped by status: Active (running), Awaiting Action (gate_waiting), Paused, Completed, Expired.

Each entry SHALL show: ticket ID, current stage (abbreviated), time since last activity, and a status indicator icon.

#### Scenario: User opens the app with existing pipelines
- **WHEN** the app loads and `/api/pipelines` returns 3 entries
- **THEN** the sidebar shows all 3 pipelines grouped by their status
- **AND** clicking a pipeline sets it as the active ticket and shows its details in the main panel

#### Scenario: Pipeline status changes while viewing
- **WHEN** an SSE `pipelines` event arrives with updated data
- **THEN** the sidebar list updates without page refresh
- **AND** items may move between status groups (e.g., paused → running)

### Requirement: Add ticket action
The sidebar SHALL include an "Add Ticket" action at the bottom of the pipeline list. Clicking it opens an inline input field for entering a new ticket ID.

#### Scenario: User adds a new ticket
- **WHEN** user clicks "Add Ticket" and enters "AUT-9000"
- **AND** no `state-AUT-9000.json` exists on disk
- **THEN** the system calls `POST /api/start { ticket: "AUT-9000", mode: "fresh" }`
- **AND** AUT-9000 appears in the sidebar under "Active"

#### Scenario: User adds a ticket that already has state
- **WHEN** user enters "AUT-8203" which has existing state
- **THEN** the system shows the resume dialog instead of starting immediately

### Requirement: Pipeline detail view
The main panel SHALL show details for the selected pipeline: stage progress bar (completed/current/remaining stages), last activity timestamp, resume window status, and the stage history (which stages completed with timestamps).

#### Scenario: Viewing a paused pipeline
- **WHEN** user selects AUT-8203 which is paused at `explore_plan`
- **THEN** the main panel shows progress as 2/11, lists `fetch_ticket` as completed with timestamp, `explore_plan` as current (paused), and remaining stages as pending

### Requirement: Delete pipeline endpoint
The system SHALL provide a `DELETE /api/pipeline/:ticket` endpoint that removes the state file and associated log file from disk.

#### Scenario: Delete existing pipeline
- **WHEN** `DELETE /api/pipeline/AUT-8203` is called
- **AND** `state-AUT-8203.json` exists on disk
- **THEN** the state file and `agent-AUT-8203.log` are deleted
- **AND** the pipeline list cache is invalidated
- **AND** a `pipelines` SSE event is broadcast

#### Scenario: Delete non-existent pipeline
- **WHEN** `DELETE /api/pipeline/AUT-9999` is called
- **AND** no state file exists for AUT-9999
- **THEN** the endpoint returns `{ ok: true }` (idempotent)

### Requirement: Auto-cleanup on server startup
On server startup, the system SHALL scan state files and archive those matching cleanup criteria: `done` pipelines with `_lastActivity` older than 30 days, and expired (non-done) pipelines with `_lastActivity` older than 14 days.

Archived files SHALL be moved to `.state-archive/` directory and permanently deleted after 7 more days.

#### Scenario: Done pipeline older than 30 days
- **WHEN** the server starts
- **AND** `state-AUT-7000.json` has stage `done` and `_lastActivity` from 35 days ago
- **THEN** the file is moved to `.state-archive/state-AUT-7000.json`
- **AND** `agent-AUT-7000.log` is moved to `.state-archive/agent-AUT-7000.log`

#### Scenario: Paused pipeline within retention window
- **WHEN** the server starts
- **AND** `state-AUT-8203.json` has stage `explore_plan` and `_lastActivity` from 5 days ago
- **THEN** the file is NOT archived or deleted
