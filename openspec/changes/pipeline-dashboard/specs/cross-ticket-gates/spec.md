## ADDED Requirements

### Requirement: Gate notification bar
The frontend SHALL display a persistent notification bar (below the top bar, above the main content) that shows all pipelines currently waiting for gate approval across all tickets.

#### Scenario: One pipeline awaiting approval
- **WHEN** AUT-8343 is paused at `gate_code_review`
- **AND** the user is viewing AUT-8203
- **THEN** the notification bar shows: "AUT-8343 needs approval at Code Review [Review]"

#### Scenario: Multiple pipelines awaiting approval
- **WHEN** AUT-8343 is at `gate_code_review` and AUT-8100 is at `gate_preprod_approval`
- **THEN** the notification bar shows both entries, each with a [Review] action

#### Scenario: No pipelines awaiting approval
- **WHEN** no pipelines are at a gate stage
- **THEN** the notification bar is hidden (not rendered)

### Requirement: Inline gate approval panel
Clicking [Review] on a gate notification SHALL open an inline panel (slide-down or modal) showing the gate details and approval actions, without switching the active ticket.

The panel SHALL show: ticket ID, gate stage name, MR details (URL, changed files count, additions/deletions) if available from state data, and action buttons.

#### Scenario: Review code review gate
- **WHEN** user clicks [Review] on AUT-8343's `gate_code_review` notification
- **THEN** an inline panel opens showing:
  - Ticket: AUT-8343
  - Gate: Code Review
  - MR: link to the merge request (from `state.data.code_mr_url`)
  - Actions: [Approve] [Reject with Feedback]
- **AND** the active ticket remains unchanged (still viewing AUT-8203)

#### Scenario: Approve gate from notification
- **WHEN** user clicks [Approve] in the inline gate panel for AUT-8343
- **THEN** the system calls `POST /api/approve { ticket: "AUT-8343", gate: "gate1", action: "approve" }`
- **AND** the notification for AUT-8343 is removed from the bar
- **AND** AUT-8343's status in the sidebar changes from "gate_waiting" to "running" (after agent resumes)

#### Scenario: Reject gate with feedback
- **WHEN** user clicks [Reject with Feedback] in the inline gate panel
- **THEN** a text input appears for feedback
- **WHEN** user enters feedback and submits
- **THEN** the system calls `POST /api/approve { ticket: "AUT-8343", gate: "gate1", action: "reject", feedback: "..." }`

### Requirement: Gate waiting detection from pipeline data
The `/api/pipelines` endpoint SHALL detect gate-waiting status by checking if the pipeline's current stage is a gate stage (`gate_code_review`, `gate_preprod_approval`, `gate_dual_approval`) AND the agent is not running (paused at the gate).

#### Scenario: Pipeline at gate stage with no running agent
- **WHEN** AUT-8343 has stage `gate_code_review` and no agent process running
- **THEN** the pipeline entry has `needsApproval: true`, `gateStage: "gate_code_review"`, `status: "gate_waiting"`

#### Scenario: Pipeline at gate stage with running agent
- **WHEN** AUT-8343 has stage `gate_code_review` and an agent process IS running (actively polling for approval)
- **THEN** the pipeline entry has `needsApproval: true`, `gateStage: "gate_code_review"`, `status: "running"`

### Requirement: Sidebar gate badge
Pipelines waiting for gate approval SHALL display a notification badge in the sidebar entry to draw attention.

#### Scenario: Gate waiting pipeline in sidebar
- **WHEN** AUT-8343 is at `gate_code_review` and needs approval
- **THEN** the sidebar entry shows a bell icon or "Needs approval" badge below the stage name
- **AND** the status indicator is a distinct color (e.g., amber/yellow pulsing)
