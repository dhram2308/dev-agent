# API Contract Spec

## ADDED Requirements

### Requirement: `/api/start` SHALL accept optional `mode` parameter

The sanitizer schema for `POST /api/start` MUST allow `mode` as an optional string restricted to `'resume'` or `'fresh'`. When present, the backend handler uses it to choose between resuming existing state and clobbering for a fresh run.

#### Scenario: Client omits mode

- **WHEN** the frontend calls `startAgent('AUT-8500')` with no mode argument
- **THEN** the sanitizer strips nothing, the handler receives `{ ticket: 'AUT-8500' }`, and the default start path runs

#### Scenario: Client sends `mode: 'resume'`

- **WHEN** the frontend calls `startAgent('AUT-8500', 'resume')` and local state exists for the ticket
- **THEN** the sanitizer preserves the `mode` field, the handler resumes from the saved stage instead of starting over

#### Scenario: Client sends invalid mode

- **WHEN** the frontend sends `{ ticket: 'AUT-8500', mode: 'wipe' }`
- **THEN** the sanitizer returns a 400 response with `code: INVALID_FIELD` and `field: mode`

### Requirement: `/api/skip-stage` SHALL require explicit `confirm: true`

The sanitizer schema for `POST /api/skip-stage` MUST define `confirm` as a required boolean. The route handler rejects requests where `confirm !== true` with a 400 response.

#### Scenario: Client omits confirm

- **WHEN** the frontend sends `{ ticket: 'AUT-8500' }` without `confirm`
- **THEN** the sanitizer returns 400 with `code: MISSING_FIELD` and `field: confirm`

#### Scenario: Client confirms the skip

- **WHEN** the UI shows the skip-stage confirmation modal and the user clicks "Skip", the frontend sends `{ ticket: 'AUT-8500', confirm: true }`
- **THEN** the handler advances the pipeline to the next stage and broadcasts a `state` SSE event

### Requirement: `/api/refine` SHALL require `gate` from the active gate

The frontend MUST send `{ ticket, gate, instructions }` to `POST /api/refine`. The sanitizer schema already requires `gate`; callers that omit it receive a 400.

#### Scenario: Refine from explore_plan gate

- **WHEN** the user submits the refine form while the pipeline is paused at `explore_plan`
- **THEN** the frontend calls `submitRefine(ticket, 'explore_plan', instructions)` and the backend appends the refinement note to the stage's refine log

#### Scenario: Frontend omits gate

- **WHEN** a caller sends `{ ticket, instructions }` with no gate
- **THEN** the sanitizer returns 400 with `code: MISSING_FIELD` and `field: gate`

### Requirement: SSE pipeline SHALL emit a `review` event for approve/reject/refine actions

The backend MUST continue broadcasting a `review` event with shape `{ gate, action, ticket, feedback?, instructions? }` on every review action. The frontend SSE hook MUST attach a named listener that invalidates the open gate modal for that ticket and forwards the payload to any mounted `GateApproval` component.

#### Scenario: Operator approves a gate

- **WHEN** a user approves `gate_code_review` on ticket AUT-8500 via `POST /api/approve`
- **THEN** the backend broadcasts `{ type: 'review', data: { gate: 'gate_code_review', action: 'approved', ticket: 'AUT-8500' } }` over SSE
- **AND** every connected frontend closes that ticket's gate modal without waiting for the next `state` broadcast

#### Scenario: Operator rejects with feedback

- **WHEN** a user rejects `explore_plan` with reason "missing edge cases"
- **THEN** the SSE payload includes `action: 'rejected'` and `feedback: 'missing edge cases'`

### Requirement: Deprecated endpoints SHALL be removed from routes.ts

The 11 endpoints with no frontend caller and no external consumer MUST be deleted: `GET /api/error`, `POST /api/reset-stage`, `GET /api/test-artifacts`, `GET /api/notification-audit`, `GET /api/escalations`, `GET /api/tickets`, `GET /api/comments`, `GET /api/review-comments`, `POST /api/review-comments`. Their corresponding sanitizer entries and auth allowlist entries MUST also be cleaned up.

`GET /api/state` and `GET /api/review` SHALL be retained (exported in `api.ts` for debug use even if not called by components today).

#### Scenario: Deprecated endpoint call

- **WHEN** any client issues `GET /api/escalations`
- **THEN** the backend responds with 404 `{ error: 'Not Found' }` (no handler registered)
