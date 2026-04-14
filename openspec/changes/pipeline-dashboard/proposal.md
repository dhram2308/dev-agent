## Why

When a user enters a ticket and clicks "Start", the agent spawns and blindly reads any existing state from disk. If that state is stale (e.g., `startedAt` from 4 days ago), the pipeline immediately aborts with "Pipeline exceeded maximum duration" — with no UI feedback about what went wrong. There is no way to see which pipelines exist on disk, which are paused at gates, or which timed out. Users managing multiple tickets in parallel have no dashboard to triage across pipelines. Gate approvals require switching to the specific ticket context, breaking flow.

## What Changes

- **Pipeline List as primary entry point**: Replace the ticket input form as the main interaction with a sidebar pipeline list that scans `state-*.json` files from disk, grouped by status (running, paused, awaiting approval, completed, expired).
- **Smart Start with Resume/Fresh dialog**: When a user selects a paused pipeline, show its stage, progress, last activity time, and resume window (7 days). Offer "Resume" (resets `startedAt`, continues from saved stage), "Start Fresh" (deletes state, begins at `fetch_ticket`), or "Delete".
- **7-day resume window**: Pipelines can be resumed within 7 days of last activity. After 7 days, state is marked expired — only "Start Fresh" or "Delete" are available.
- **Timer reset on resume**: `POST /api/start` accepts `mode: "resume" | "fresh"`. Resume mode resets `startedAt` to now, preserves stage and all accumulated data, tracks resume history.
- **Cross-ticket gate actions**: A notification bar surfaces gate approvals needed across ALL tickets. Users can approve/reject gates without switching active ticket context.
- **Auto-cleanup**: Done pipelines auto-delete after 30 days, expired pipelines after 14 days. Cleanup runs on server startup.
- **New `GET /api/pipelines` endpoint**: Scans disk for all state files, cross-references with running agent processes, returns enriched pipeline list with status, progress, resumability, and gate info.

## Capabilities

### New Capabilities
- `pipeline-dashboard`: Sidebar pipeline list from disk scan, grouped by status (active/paused/gate-waiting/done/expired), with progress indicators and time-since-last-activity
- `smart-start`: Resume vs fresh-start decision flow when selecting an existing pipeline, including 7-day resume window enforcement and timer reset logic
- `cross-ticket-gates`: Notification bar and inline approval panel for gate stages across all tickets without switching context

### Modified Capabilities
<!-- No existing specs to modify -->

## Impact

- **Backend routes** (`packages/backend/src/server/routes.ts`): New `GET /api/pipelines` endpoint, modified `POST /api/start` to accept `mode` parameter, new `DELETE /api/pipeline/:ticket` endpoint
- **Backend state** (`packages/backend/src/state/`): New `scanAllStates()` function to read all `state-*.json` files, resume logic that resets `startedAt` and tracks `_resumeHistory`
- **Backend server** (`packages/backend/src/server/http-server.ts`): Auto-cleanup sweep on startup for expired/done states
- **Frontend sidebar** (`packages/frontend/src/components/Sidebar.tsx`): Pipeline list replaces simple ticket list, grouped by status with rich metadata
- **Frontend components**: New `ResumeDialog`, `GateNotificationBar`, `InlineGateApproval` components
- **Frontend store** (`packages/frontend/src/store/pipeline.ts`): New `pipelines` state from `/api/pipelines`, polling for pipeline list updates
- **Pipeline stages affected**: All gate stages (`gate_code_review`, `gate_preprod_approval`, `gate_dual_approval`) — approval actions callable cross-ticket
- **No breaking changes**: Existing `/api/start` without `mode` defaults to current behavior
