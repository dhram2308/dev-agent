## 1. API Contract Fixes

- [x] 1.1 Extend sanitizer schema for `POST /api/start` in `packages/backend/src/middleware/security.ts` to accept optional `mode: { type: 'string', allowed: ['resume','fresh'] }`
- [x] 1.2 Extend sanitizer schema for `POST /api/skip-stage` to require `confirm: { type: 'boolean', required: true }` (already present — verify)
- [x] 1.3 Update frontend `skipStage(ticket)` in `packages/frontend/src/lib/api.ts` to always send `confirm: true`
- [x] 1.4 Update frontend `submitRefine(ticket, instructions)` to require a `gate` argument and pass it through to the backend; update every caller (`RefineForm`, `GateApproval`) accordingly
- [x] 1.5 Run `npm run lint:backend` + `npm run lint:frontend`; confirm typecheck is green

## 2. SSE Event Pipeline

- [x] 2.1 In `packages/frontend/src/hooks/useSSE.ts`, add a ref that collects every `{ event, handler }` pair registered on the EventSource and iterate it to `removeEventListener` inside `closeEventSource()`
- [x] 2.2 Add a `review` event listener in `useSSE` that calls the new `pipelineStore.handleReviewEvent(payload)` action
- [x] 2.3 In `packages/frontend/src/store/pipeline.ts`, implement `handleReviewEvent({ gate, action, ticket, feedback, instructions })` — clears `activeGate[ticket]` so any mounted `GateApproval` unmounts immediately
- [x] 2.4 Confirm typecheck green

## 3. State Store Hardening

- [x] 3.1 In `packages/frontend/src/store/pipeline.ts`, introduce a `STAGE_ORDER: Record<PipelineStage, number>` map (or reuse existing) and guard `updateState` against a new stage whose order is strictly less than the current stage's order, unless `resetAt` has changed
- [x] 3.2 Deduplicate by `(stage, updatedAt)` — skip the update if both match the existing record (using `_seq` since the frontend PipelineState type doesn't expose `updatedAt`; `_seq` is monotonic per-ticket and serves the same purpose)
- [x] 3.3 Add a `console.warn` in dev when a dropped/duplicate event is detected
- [x] 3.4 Confirm typecheck green

## 4. Pipeline UI Parity

- [ ] 4.1 Create `packages/frontend/src/components/AgentActivityBar.tsx` that reads `state.data._agent_action` and renders a one-line status with pulsing dot prefix (or null)
- [ ] 4.2 Mount `AgentActivityBar` inside `AgentStatus.tsx` below the stage strip
- [ ] 4.3 Create `packages/frontend/src/components/SubStageProgress.tsx` (three pills: write → review → fix) driven by `state.data._sub_stage`
- [ ] 4.4 Mount `SubStageProgress` inside `AgentStatus.tsx` but only when `stage === 'generate_code'` AND `_sub_stage` is present
- [ ] 4.5 In `packages/frontend/src/hooks/useGlobalKeyboardShortcuts.ts`, add a binding for `f` that dispatches a `useReviewStore.setState({ refineOpen: true })` when the active ticket is paused at `explore_plan` and no input has focus
- [ ] 4.6 Wire `GateApproval.tsx` / `RefineForm.tsx` to honor the `refineOpen` flag so `f` actually opens the form
- [ ] 4.7 Confirm typecheck green

## 5. Code Review UI Parity

- [ ] 5.1 Add a `filterQuery` search input at the top of `packages/frontend/src/components/review/FileTree.tsx`; filter files by case-insensitive substring
- [ ] 5.2 Display match count badge ("3 of 42") beside the search input
- [ ] 5.3 Create `packages/frontend/src/components/review/LargeDiffWarning.tsx` with "Render anyway" and "Close" actions
- [ ] 5.4 Compute total diff line count in `packages/frontend/src/components/review/DiffViewer.tsx` on review data load; if >= 5 000 and no session ack, render `LargeDiffWarning` instead of the diff
- [ ] 5.5 Persist "Render anyway" ack per ticket in `sessionStorage[`diff_ack_{ticket}`]`
- [ ] 5.6 Confirm typecheck green

## 6. Log Viewer Parity

- [ ] 6.1 Add an **Export** button to `packages/frontend/src/components/LogViewer.tsx` toolbar
- [ ] 6.2 On click, serialize the currently-filtered log buffer to plain text (`[HH:MM:SS] [LEVEL] message`) and trigger a Blob download as `{ticket}-logs-{YYYYMMDD-HHmmss}.txt`
- [ ] 6.3 Disable the Export button when no ticket is active
- [ ] 6.4 Confirm typecheck green

## 7. Dead Endpoint Cleanup

- [ ] 7.1 In `packages/backend/src/server/routes.ts`, delete handlers for: `GET /api/error`, `POST /api/reset-stage`, `GET /api/test-artifacts`, `GET /api/notification-audit`, `GET /api/escalations`, `GET /api/tickets`, `GET /api/comments`, `GET /api/review-comments`, `POST /api/review-comments`
- [ ] 7.2 Remove their sanitizer schema entries (if any) from `packages/backend/src/middleware/security.ts`
- [ ] 7.3 Remove any imports / helper functions that become unused
- [ ] 7.4 Confirm `npm run lint:backend` is green; confirm no broken frontend references by running `npm run lint:frontend`

## 8. End-to-End Verification

- [ ] 8.1 Restart `npm run dev`; visit `http://localhost:3000` and verify Dashboard loads
- [ ] 8.2 Start a test ticket (e.g. AUT-8500) and step through explore_plan → gate; verify `f` opens refine, refine POST succeeds
- [ ] 8.3 Approve the code review gate; verify the modal closes immediately (review SSE event handled)
- [ ] 8.4 Trigger skip-stage from the UI; verify it succeeds (confirm param sent)
- [ ] 8.5 Inspect a >5000-line diff (use a large existing review) and verify the warning modal appears; click Render Anyway, confirm persists on reload
- [ ] 8.6 Click **Export** in the log viewer; open downloaded file, verify format + content
- [ ] 8.7 Run `npm run lint` + `npm run test` at workspace root; all green
