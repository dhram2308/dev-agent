## ADDED Requirements

### Requirement: Cause-classified stuck detection
The system SHALL classify a running stage as stuck based on a real failure signal (a recorded external-service failure, e.g. a GitLab/Jira network timeout) or absence of recent activity, rather than raw elapsed stage duration alone, and SHALL expose a `cause` of `network`, `slow`, or `gate-wait` alongside the stuck flag.

#### Scenario: Network failure during a stage produces a network cause
- **WHEN** a stage's external call (e.g. a GitLab API request in `fetch_ticket`) fails with a timeout/connection error during a retry loop
- **THEN** the failure is recorded against that service's health record with the raw error message, and the stage's stuck classification (once the stage exceeds its activity threshold) reports `cause: "network"`

#### Scenario: Long-running but active stage is not classified as network-caused
- **WHEN** a stage (e.g. `generate_code`) has been running longer than its per-stage threshold but has emitted recent activity/heartbeat updates and no external-service failure is recorded
- **THEN** the stage is not classified with `cause: "network"`, and if flagged at all, is classified `cause: "slow"`

#### Scenario: Human-gate stages are never classified as stuck
- **WHEN** the pipeline is waiting at a human-approval gate (e.g. `gate_code_review`, `test_qa`)
- **THEN** the stage is not classified as stuck regardless of elapsed time

### Requirement: Actionable stuck-stage popup
The system SHALL present an actionable popup — not a passive banner — when a stage is classified as stuck, offering at minimum a "Keep Waiting" action, and offering "Retry Stage" and "Switch Model & Retry" actions only when contextually applicable to the classified cause.

#### Scenario: Popup appears with all three actions for a slow-but-alive cause
- **WHEN** a stage is classified as stuck with `cause: "slow"`
- **THEN** the popup displays Keep Waiting, Retry Stage, and Switch Model & Retry as available actions

#### Scenario: Switch Model is de-emphasized for a network cause
- **WHEN** a stage is classified as stuck with `cause: "network"`
- **THEN** the popup still displays Keep Waiting and Retry Stage as primary actions, and Switch Model & Retry is shown de-emphasized or with an explanation that a model change will not address a network failure

### Requirement: Keep Waiting is a non-destructive dismissal
The system SHALL allow the operator to dismiss the stuck-stage popup without altering pipeline state; the underlying stage and any in-flight retries continue unaffected.

#### Scenario: Dismissing the popup does not touch pipeline state
- **WHEN** the operator selects "Keep Waiting"
- **THEN** no API call is made to reset, restart, or otherwise mutate the ticket's pipeline state, and the popup may reappear on a subsequent stuck-classification tick

### Requirement: Retry Stage resets the current stage with confirmation
The system SHALL allow the operator to reset the currently stuck stage via a confirmation step, clearing that stage's associated cached data and rewinding pipeline state to re-enter the stage.

#### Scenario: Operator confirms Retry Stage
- **WHEN** the operator selects "Retry Stage" and confirms the action in the resulting confirmation dialog
- **THEN** the system clears the fields associated with the current stage and sets the pipeline's stage back to that stage, causing it to be re-executed

#### Scenario: Operator cancels the Retry Stage confirmation
- **WHEN** the operator selects "Retry Stage" but cancels the confirmation dialog
- **THEN** no pipeline state is modified

### Requirement: Switch Model & Retry is scoped to a single ticket
The system SHALL allow the operator to override the AI model used for a specific stuck ticket without affecting the global model configuration or any other concurrently running ticket, by killing and respawning that ticket's process with the override applied.

#### Scenario: Switching model for one ticket does not affect another running ticket
- **GIVEN** two tickets are running concurrently under the global default model
- **WHEN** the operator selects "Switch Model & Retry" for one stuck ticket and picks a different model
- **THEN** only that ticket's subsequent pipeline process uses the overridden model; the other running ticket continues under the global default

#### Scenario: Switch Model & Retry restarts the ticket's process
- **WHEN** the operator confirms a model switch for a stuck ticket
- **THEN** the system stops that ticket's running process, persists the per-ticket model override, and starts a new process for that ticket in resume mode with the override applied to its environment
