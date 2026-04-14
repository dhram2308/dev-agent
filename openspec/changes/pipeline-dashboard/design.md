## Context

The MI Dev Agent Web UI currently uses a ticket input form as the primary entry point. Users type a ticket ID and click "Start" — the backend spawns an agent process that reads `state-{TICKET}.json` from disk and either starts fresh or resumes from the saved stage. The UI has no visibility into what's on disk before starting. If a state file is stale (started >24h ago), the agent silently aborts. Users managing 3-5 tickets in parallel have no way to see all pipelines at a glance, and gate approvals require switching active ticket context.

The frontend is React + Zustand with SSE for real-time updates. The backend is TypeScript (compiled to CJS) with a Node.js HTTP server. State files live in the project root as `state-{TICKET}.json` with HMAC-verified V3 envelopes. Agent processes are spawned via `server/agent-process.js` and tracked in an in-memory `agentProcs` map.

## Goals / Non-Goals

**Goals:**
- Pipeline list from disk scan as the primary navigation (replaces ticket input as main UX)
- Resume/Fresh/Delete decision dialog when selecting an existing pipeline
- 7-day resume window with timer reset on resume
- Cross-ticket gate approval notifications and inline actions
- Auto-cleanup of stale state files on server startup

**Non-Goals:**
- Persistent database for pipeline history (disk state files remain the source of truth)
- Pipeline scheduling or queueing (start remains manual)
- Real-time multi-user collaboration (single operator assumed)
- Modifying the agent pipeline logic itself (only the server + UI layer changes)

## Decisions

### D1: Disk scan for pipeline list (over database/index)

Scan `state-*.json` files from the project root using `fs.readdirSync` + `fs.readFileSync` with HMAC validation. Cross-reference with `agentProcs` map for running status.

**Why not a database/index?** State files are already the source of truth. Adding a database creates sync problems. The file count is low (typically <20 state files) so scan cost is negligible (<10ms).

**Caching:** Cache the scan result in memory with a 10-second TTL. Invalidate on state write or agent start/stop events. The `/api/pipelines` endpoint serves from cache when fresh.

### D2: `mode` parameter on `/api/start` (over separate endpoints)

Extend `POST /api/start` with `{ ticket, mode: "resume" | "fresh" }`. Default: if state exists and is resumable, behave as "resume"; if no state, start fresh.

**Why not separate `/api/resume` and `/api/start`?** Fewer endpoints, backward compatible. Existing callers without `mode` get current behavior. The mode decision happens in the UI before the call.

**Resume logic:** Read state → set `startedAt = new Date().toISOString()` → increment `_resumeCount` → push to `_resumeHistory` array → write state → spawn agent. The agent reads the updated state with a fresh timer and continues from `state.stage`.

### D3: 7-day window based on `_lastActivity` (over `startedAt`)

Resumability is determined by: `Date.now() - _lastActivity < 7 * 24 * 60 * 60 * 1000`. Using `_lastActivity` (set by the agent on every stage transition) rather than `startedAt` (which we reset on resume) gives the true measure of staleness.

**Fallback:** If `_lastActivity` is missing (older state files), fall back to `_written_at` from the envelope, then `startedAt`.

### D4: Cross-ticket gate actions via existing approval API

Gate approvals already work via `POST /api/approve` with `{ ticket, gate, action }`. The cross-ticket notification bar simply calls this endpoint for any ticket — no backend change needed for the approval itself.

**New data needed:** The `/api/pipelines` response includes `needsApproval: boolean` and `gateStage: string | null` so the frontend can render notifications without per-ticket polling.

### D5: Frontend pipeline list in sidebar (over separate page)

Embed the pipeline list in the existing sidebar component. It replaces the simple ticket list. The "Add Ticket" action moves to a small input at the bottom of the list.

**Why not a separate dashboard page?** The sidebar is always visible. Users need to see all pipelines while working on one. A separate page forces navigation.

### D6: Auto-cleanup on server startup (over cron/scheduled)

On `startServer()`, scan state files and delete those matching cleanup criteria. No external scheduler needed.

**Cleanup rules:**
- `done` + `_lastActivity` > 30 days ago → delete state file + log file
- Expired (not done) + `_lastActivity` > 14 days ago → delete state file + log file
- Archive deleted files to `.state-archive/` directory for 7 days before permanent removal (safety net)

### D7: SSE broadcast for pipeline list changes

When a pipeline starts, stops, changes stage, or gets deleted, broadcast a `pipelines` SSE event with the updated list. This avoids polling from the frontend.

**Fallback polling:** Frontend polls `/api/pipelines` every 30 seconds as a safety net for missed SSE events (e.g., after reconnection).

## Risks / Trade-offs

**[Risk] State file scan could be slow with many files** → Mitigated by 10-second cache and typically <20 files. If file count grows, switch to maintaining an in-memory index updated on write events.

**[Risk] Resume after 7 days might resume into a stale external state (Jira ticket closed, MR merged by someone else)** → The agent's stage handlers already validate preconditions on entry. If external state changed, the stage will fail gracefully and the user can start fresh.

**[Risk] Timer reset could mask genuinely stuck pipelines** → Track `_resumeCount` and `_resumeHistory`. If a pipeline is resumed >3 times at the same stage, surface a warning in the UI.

**[Risk] Cross-ticket gate approval could approve the wrong thing** → The inline approval panel shows ticket ID, gate name, MR details prominently. Require confirmation click (not one-click approve).

**[Risk] Auto-cleanup deletes something the user wanted** → Archive to `.state-archive/` for 7 days before permanent deletion. Log all cleanup actions.
