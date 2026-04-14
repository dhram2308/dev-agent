## ADDED Requirements

### Requirement: State write CAS guard
The state persistence system SHALL verify the on-disk sequence number (_seq) matches the in-memory sequence number before writing. If they diverge, the write SHALL re-read disk state, merge changes, and retry once.

#### Scenario: Concurrent write detected
- **WHEN** agent process writes state with _seq=42 but disk has _seq=43
- **THEN** the write SHALL log a warning "CAS conflict: expected seq 42, found 43"
- **THEN** the write SHALL re-read disk state and retry the write with merged data

#### Scenario: Normal sequential write
- **WHEN** agent writes state with _seq matching disk _seq
- **THEN** the write SHALL succeed and increment _seq

### Requirement: Atomic agent-start guard
The agent spawn endpoint SHALL prevent duplicate agent processes for the same ticket using an atomic check-and-set within a single event loop tick.

#### Scenario: Two concurrent start requests for same ticket
- **WHEN** two POST /api/start requests arrive simultaneously for AUT-1234
- **THEN** only one agent process SHALL be spawned
- **THEN** the second request SHALL receive an error response "Agent already starting"

### Requirement: SSE dropped messages added to replay buffer
Messages dropped from a client's pending queue due to backpressure SHALL be added to the global replay buffer so reconnecting clients can recover them.

#### Scenario: Client pending queue overflow
- **WHEN** a client's pending queue exceeds 200 messages
- **THEN** the oldest messages SHALL be moved to the replay buffer before being dropped from the client queue
- **THEN** a reconnecting client using Last-Event-ID SHALL receive those messages

### Requirement: CI pipeline wait timeout
All calls to gl.waitPipeline() SHALL enforce a configurable maximum wait time. Default: 30 minutes.

#### Scenario: CI pipeline stuck
- **WHEN** gl.waitPipeline() has been polling for longer than CI_WAIT_TIMEOUT
- **THEN** the call SHALL throw a timeout error with message including elapsed time
- **THEN** the pipeline stage SHALL fail with a clear error, not hang indefinitely

### Requirement: Frontend double-submit prevention
Gate action buttons (Approve, Reject, Refine) SHALL be mutually exclusive — only one gate action can be in-flight at a time.

#### Scenario: Rapid approve then reject
- **WHEN** user clicks Approve and immediately clicks Reject
- **THEN** only the first action (Approve) SHALL be sent to the server
- **THEN** the second click SHALL be ignored until the first completes
- **THEN** all gate buttons SHALL be disabled while any action is in-flight

### Requirement: Null-safe render path
All render functions that use getElementById SHALL handle null returns gracefully without throwing.

#### Scenario: Missing DOM element during render
- **WHEN** getElementById returns null for an expected element
- **THEN** the render function SHALL log a warning and return early
- **THEN** other render functions SHALL continue executing normally
- **THEN** the UI SHALL NOT crash

### Requirement: Silent catch block elimination
All empty `catch {}` blocks in production code SHALL log the caught error at WARN level minimum.

#### Scenario: Previously silent error occurs
- **WHEN** an error occurs in a path that previously had `catch {}`
- **THEN** the error message SHALL be logged with context (function name, operation)
- **THEN** the existing control flow SHALL NOT change (no new throws)

### Requirement: Browser interval cleanup on tab close
All setInterval and setTimeout references SHALL be cleared when the page unloads.

#### Scenario: User closes browser tab
- **WHEN** the beforeunload event fires
- **THEN** all polling intervals (pollState, fetchReview, pollAllTickets, heartbeat) SHALL be cleared
- **THEN** SSE connection SHALL be closed
- **THEN** no orphaned timers SHALL remain

### Requirement: Retry on initial Jira ticket fetch
The initial jira.getIssue() call in fetch_ticket SHALL retry with exponential backoff on transient network errors.

#### Scenario: Transient network error on ticket fetch
- **WHEN** jira.getIssue() fails with ECONNRESET or ETIMEDOUT
- **THEN** the call SHALL retry up to 3 times with exponential backoff
- **THEN** on all retries exhausted, the stage SHALL fail with the original error

### Requirement: Zero-files guard before push
The generate_code stage SHALL verify at least one file was changed before attempting to push to GitLab.

#### Scenario: All sub-stages complete but no files changed
- **WHEN** generate_code completes all sub-stages but localGetChanges returns 0 files
- **THEN** the stage SHALL throw a clear error "No files were changed by code generation"
- **THEN** the error SHALL NOT be a cryptic "No files to push" from deep in push-code
