## ADDED Requirements

### Requirement: Resume mode on start endpoint
The `POST /api/start` endpoint SHALL accept an optional `mode` field: `"resume"` or `"fresh"`. When `mode` is `"resume"` and a resumable state file exists, the system SHALL reset `startedAt` to the current time, increment `_resumeCount`, append to `_resumeHistory`, write the updated state, and spawn the agent. When `mode` is `"fresh"`, any existing state file SHALL be deleted before spawning.

#### Scenario: Resume a paused pipeline
- **WHEN** `POST /api/start { ticket: "AUT-8203", mode: "resume" }` is called
- **AND** `state-AUT-8203.json` exists with stage `explore_plan` and `_lastActivity` from 3 days ago
- **THEN** the state file is updated with `startedAt` set to now, `_resumeCount` incremented by 1
- **AND** `_resumeHistory` receives a new entry `{ at: <now>, fromStage: "explore_plan" }`
- **AND** the agent spawns and continues from `explore_plan`

#### Scenario: Fresh start with existing state
- **WHEN** `POST /api/start { ticket: "AUT-8203", mode: "fresh" }` is called
- **AND** `state-AUT-8203.json` exists
- **THEN** the existing state file is deleted
- **AND** the agent spawns fresh at `fetch_ticket`

#### Scenario: Start without mode (backward compatible)
- **WHEN** `POST /api/start { ticket: "AUT-8203" }` is called without `mode`
- **AND** a resumable state file exists
- **THEN** the system behaves as `mode: "resume"` (resets timer, continues from saved stage)

#### Scenario: Start without mode, no existing state
- **WHEN** `POST /api/start { ticket: "AUT-9000" }` is called without `mode`
- **AND** no state file exists for AUT-9000
- **THEN** the agent spawns fresh at `fetch_ticket` (same as current behavior)

### Requirement: 7-day resume window
A pipeline SHALL be resumable only if its `_lastActivity` timestamp (falling back to `_written_at`, then `startedAt`) is within 7 days of the current time. Pipelines older than 7 days SHALL be marked `resumable: false` and `status: "expired"`.

#### Scenario: Pipeline within resume window
- **WHEN** a pipeline's `_lastActivity` is 5 days ago
- **THEN** `resumable` is `true` and `daysRemaining` is `2`

#### Scenario: Pipeline outside resume window
- **WHEN** a pipeline's `_lastActivity` is 8 days ago
- **THEN** `resumable` is `false` and `status` is `"expired"`

#### Scenario: Resume attempted on expired pipeline
- **WHEN** `POST /api/start { ticket: "AUT-OLD", mode: "resume" }` is called
- **AND** the pipeline's `_lastActivity` is 10 days ago
- **THEN** the endpoint returns `{ ok: false, error: "Pipeline expired (last active 10 days ago). Use mode=fresh to start over." }`

### Requirement: Resume dialog in frontend
When a user selects a pipeline that has existing state on disk, the frontend SHALL show a resume dialog with: current stage, progress, last activity time, resume window remaining, and three actions: "Resume", "Start Fresh", "Delete".

#### Scenario: User selects paused resumable pipeline
- **WHEN** user clicks AUT-8203 in the sidebar
- **AND** AUT-8203 is paused at `explore_plan`, last active 4 days ago
- **THEN** the main panel shows a dialog with:
  - Stage: `explore_plan` (2/11)
  - Last active: 4 days ago
  - Resumable: Yes (3 days remaining)
  - Buttons: [Resume] [Start Fresh] [Delete]

#### Scenario: User selects expired pipeline
- **WHEN** user clicks AUT-OLD in the sidebar
- **AND** AUT-OLD is expired (last active 10 days ago)
- **THEN** the dialog shows "Expired" badge
- **AND** only [Start Fresh] and [Delete] buttons are available (Resume is disabled)

#### Scenario: User selects completed pipeline
- **WHEN** user clicks AUT-7991 in the sidebar
- **AND** AUT-7991 has stage `done`
- **THEN** the dialog shows "Completed" with the pipeline results
- **AND** offers [Start Fresh] and [Delete] (no Resume — it's already done)

#### Scenario: User selects running pipeline
- **WHEN** user clicks AUT-8100 in the sidebar
- **AND** AUT-8100 has an active agent process
- **THEN** the main panel shows the live pipeline view (logs, stage, gates) — no dialog needed

### Requirement: Resume history warning
When a pipeline has been resumed 3 or more times at the same stage, the resume dialog SHALL display a warning: "This pipeline has been resumed N times at this stage. Consider starting fresh."

#### Scenario: Pipeline resumed repeatedly at same stage
- **WHEN** user opens resume dialog for AUT-8203
- **AND** `_resumeHistory` contains 3 entries all with `fromStage: "explore_plan"`
- **THEN** the dialog shows a warning about repeated resumes at the same stage
