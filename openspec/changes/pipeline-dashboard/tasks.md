## 1. Backend: Pipeline List Endpoint

- [x] 1.1 Add `scanAllStates()` function in `packages/backend/src/state/state-manager.ts` — scan `state-*.json` from project root, read each with HMAC validation, skip corrupt files, return array of `{ ticket, stage, startedAt, lastActivity, data }` objects
- [x] 1.2 Add pipeline status classification logic — cross-reference scan results with `agentProcs` map to determine `running`, `resumable`, `needsApproval`, `status` ("running" | "paused" | "gate_waiting" | "done" | "expired"), `progress`, `daysRemaining`
- [x] 1.3 Add in-memory pipeline list cache with 10-second TTL — export `invalidatePipelineCache()` function, call it on agent start/stop/state-write events
- [x] 1.4 Add `GET /api/pipelines` route in `packages/backend/src/server/routes.ts` — returns cached pipeline list, requires API token auth (same as other endpoints)
- [x] 1.5 Add `DELETE /api/pipeline/:ticket` route — deletes state file + log file, invalidates cache, broadcasts SSE event

## 2. Backend: Smart Start (Resume/Fresh)

- [x] 2.1 Modify `POST /api/start` in routes.ts to accept optional `mode: "resume" | "fresh"` in request body
- [x] 2.2 Implement resume logic — when `mode="resume"`: read state, validate 7-day window (`_lastActivity` < 7 days), reset `startedAt` to now, increment `_resumeCount`, push to `_resumeHistory`, write state back, then spawn agent
- [x] 2.3 Implement fresh logic — when `mode="fresh"`: delete existing state file if present, then spawn agent
- [x] 2.4 Default behavior — when no `mode` provided: if resumable state exists behave as "resume", if no state start fresh, if expired state return error with message
- [x] 2.5 Add error response for expired resume attempts — return `{ ok: false, error: "Pipeline expired (last active N days ago). Use mode=fresh to start over." }`

## 3. Backend: Auto-Cleanup & SSE Broadcast

- [x] 3.1 Add `cleanupStaleStates()` function in state-manager.ts — scan state files, archive `done` > 30 days and expired > 14 days to `.state-archive/` directory, delete `.state-archive/` files > 7 days old
- [x] 3.2 Call `cleanupStaleStates()` in `startServer()` in `packages/backend/src/server/http-server.ts` after shutdown handlers are installed
- [x] 3.3 Add `pipelines` SSE event broadcast in `packages/backend/src/server/sse.ts` — new `broadcastPipelineList()` function that sends the current pipeline list to all clients
- [x] 3.4 Wire SSE broadcast triggers — call `broadcastPipelineList()` on: agent start, agent stop/exit, state stage transitions, pipeline delete

## 4. Frontend: Pipeline List Sidebar

- [x] 4.1 Add `pipelines` state to Zustand store (`packages/frontend/src/store/pipeline.ts`) — array of pipeline summaries from `/api/pipelines`, with `fetchPipelines()` action
- [x] 4.2 Add SSE handler for `pipelines` event in `useSSEConnection.ts` — update the pipelines array in store on each event
- [x] 4.3 Add fallback polling in `useSSEConnection.ts` — poll `/api/pipelines` every 30 seconds as safety net
- [x] 4.4 Refactor `Sidebar.tsx` — replace simple ticket list with grouped pipeline list (Active, Awaiting Action, Paused, Completed, Expired) using data from store
- [x] 4.5 Add status indicator icons/colors per pipeline entry — green pulsing (running), amber pulsing (gate_waiting), gray (paused), check (done), strikethrough (expired)
- [x] 4.6 Add "Add Ticket" input at bottom of sidebar pipeline list — inline text input that validates ticket format and calls start

## 5. Frontend: Resume Dialog

- [x] 5.1 Create `ResumeDialog` component (`packages/frontend/src/components/ResumeDialog.tsx`) — shows stage, progress bar, last activity, resume window, and three action buttons
- [x] 5.2 Add conditional rendering in main panel — show `ResumeDialog` when selected pipeline is paused/expired/done and not running, show live view when running
- [x] 5.3 Wire Resume button — calls `POST /api/start { ticket, mode: "resume" }`, transitions to live pipeline view on success
- [x] 5.4 Wire Start Fresh button — calls `POST /api/start { ticket, mode: "fresh" }`, transitions to live pipeline view
- [x] 5.5 Wire Delete button — calls `DELETE /api/pipeline/:ticket`, removes from sidebar, shows add-ticket form
- [x] 5.6 Add expired state handling — disable Resume button with tooltip "Pipeline expired", show only Fresh and Delete
- [x] 5.7 Add resume history warning — if `_resumeCount >= 3` at same stage, show amber warning in dialog

## 6. Frontend: Cross-Ticket Gate Actions

- [x] 6.1 Create `GateNotificationBar` component (`packages/frontend/src/components/GateNotificationBar.tsx`) — renders above main content, shows all gate-waiting pipelines from store, hidden when none
- [x] 6.2 Create `InlineGatePanel` component (`packages/frontend/src/components/InlineGatePanel.tsx`) — slide-down panel with ticket, gate name, MR link, Approve/Reject buttons (combined into GateNotificationBar)
- [x] 6.3 Wire [Review] button in notification bar — opens `InlineGatePanel` for that ticket without changing active ticket
- [x] 6.4 Wire Approve action — calls existing `POST /api/approve { ticket, gate, action: "approve" }`, closes panel, notification removed on next SSE update
- [x] 6.5 Wire Reject with Feedback — show textarea input, call `POST /api/approve { ticket, gate, action: "reject", feedback }`, close panel
- [x] 6.6 Add gate badge to sidebar entries — amber bell icon for pipelines with `needsApproval: true`

## 7. Pipeline Detail View

- [x] 7.1 Create `PipelineDetail` component (`packages/frontend/src/components/PipelineDetail.tsx`) — shows stage progress bar (11 stages, filled/current/pending), stage history with timestamps, and metadata (startedAt, resume count, warnings)
- [x] 7.2 Integrate `PipelineDetail` into the main panel layout — shown above logs when viewing an active/paused pipeline
- [x] 7.3 Add stage history extraction — parse `state.data` for `_visited_*` fields and stage timestamps to build completion timeline

## 8. Testing & Verification

- [x] 8.1 Add backend tests for `scanAllStates()` — mock filesystem with multiple state files, verify correct classification
- [x] 8.2 Add backend tests for resume logic — verify timer reset, 7-day window enforcement, resume history tracking, expired rejection
- [x] 8.3 Add backend tests for `GET /api/pipelines` — verify caching, cache invalidation, correct response shape
- [x] 8.4 Add frontend tests for `ResumeDialog` — render with paused/expired/done states, verify button states
- [ ] 8.5 Manual verification — open http://localhost:3000, verify sidebar shows existing pipelines, test resume/fresh/delete flow, test cross-ticket gate approval
