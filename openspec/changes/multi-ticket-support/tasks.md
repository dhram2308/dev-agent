## 1. Worktree Isolation (lib/local-repo.js)

- [x] 1.1 Add `createWorktree(ticket)` function — runs `git worktree add --detach .repo-cache/.worktrees/{TICKET} <sha>` where sha = `git rev-parse origin/enterprise-ts`. Includes disk space check (1GB minimum). If worktree already exists, reset it instead of creating new.
- [x] 1.2 Add `removeWorktree(ticket)` function — runs `git worktree remove --force`, falls back to `rm -rf` + `git worktree prune` on failure.
- [x] 1.3 Add `cleanOrphanedWorktrees()` function — scans `.repo-cache/.worktrees/`, checks `state-{TICKET}.lock` PID liveness, removes orphans, runs `git worktree prune`.
- [x] 1.4 Modify `localResetRepo(clonePath)` — change `git checkout -f enterprise-ts` to `git checkout -f .` (works in both worktree and main clone contexts).
- [x] 1.5 Modify `ensureLocalRepo()` — after `git fetch`, skip `git reset --hard` if `.repo-cache/.worktrees/` has any entries. Always do full reset when no worktrees exist.
- [x] 1.6 Export new functions: `createWorktree`, `removeWorktree`, `cleanOrphanedWorktrees`.

## 2. Config & Agent Process (lib/config.js, run-agent.js, server/agent-process.js)

- [x] 2.1 In `lib/config.js` — add `WORKTREE_PATH` to env var schema (string, optional). Add `DEV_SERVER_PORT` (number, optional).
- [x] 2.2 In `run-agent.js` — change `cfg.localRepo = await ensureLocalRepo()` to `cfg.localRepo = process.env.WORKTREE_PATH || await ensureLocalRepo()`. If WORKTREE_PATH is set, skip ensureLocalRepo entirely.
- [x] 2.3 In `server/agent-process.js` `startAgent(ticket)` — before spawn: call `ensureLocalRepo()`, then `createWorktree(ticket)`. Pass `WORKTREE_PATH` in env to spawned process.
- [x] 2.4 In `server/agent-process.js` `proc.on("close")` handler — call `removeWorktree(ticket)` after child exits.
- [x] 2.5 In `server/agent-process.js` — call `cleanOrphanedWorktrees()` during server startup (alongside existing `cleanOrphanedLocks()`).
- [x] 2.6 In `server/agent-process.js` `wrapProcessOutput()` — change `addLog(line, type)` to `addLog(line, type, ticket)` for both stdout and stderr pipes.

## 3. Graceful Shutdown (lib/graceful-shutdown.js)

- [x] 3.1 Register a shutdown hook `"worktree-cleanup"` that scans `.repo-cache/.worktrees/`, removes all worktrees via `removeWorktree()`, then runs `git worktree prune`. Place after the child process kill phase.

## 4. SSE Per-Ticket (server/sse.js)

- [x] 4.1 Change `addLog(line, type)` signature to `addLog(line, type, ticket)`. Add `ticket` field to the broadcast payload.
- [x] 4.2 Replace singleton `logBuffer` with `logBuffers` object (keyed by ticket) plus `globalLogBuffer` for system messages. Each capped at `MAX_LOG`.
- [x] 4.3 Modify `registerClient()` replay logic — accept `ticket` query param. If provided, replay only that ticket's buffer + globalLogBuffer (merged by timestamp). If not provided, replay all buffers (backward compat).
- [x] 4.4 Add `clearTicketLogs(ticket)` function to remove a ticket's log buffer (called when ticket is removed from UI).

## 5. API Endpoints (server/routes.js)

- [x] 5.1 Add `GET /api/tickets` endpoint — iterate `agentProcs` keys, read each `state-{ticket}.json` (stage, `_active_agents`, `startedAt`), compute `progress` (stage index / STAGES.length), compute `needsApproval` (gate stage check). Return `{ ok: true, tickets: [...] }`. Require auth token.
- [x] 5.2 Modify `broadcast("review", ...)` in `/api/approve`, `/api/reject`, `/api/refine` — include `ticket` field in the payload (already available from request body).
- [x] 5.3 Modify `GET /api/logs` handler — pass `ticket` query param through to `registerClient()` for filtered replay.

## 6. Web UI — State Management (server/html.js)

- [x] 6.1 Add `ticketStates` map, `selectedTicket` variable, `ticketList` array, and `DEFAULT_TICKET_STATE` template object.
- [x] 6.2 Add `Object.defineProperty` shims for `currentStage`, `isRunning`, `lastStateData`, `reviewData`, `isStuck`, `stuckMinutes`, `completedGates`, `lastHealth` — getters/setters redirect to `ticketStates[selectedTicket]`.
- [x] 6.3 Add `ensureTicketState(ticket)` helper — creates default state entry in `ticketStates` if not exists.
- [x] 6.4 Add per-ticket client-side log buffers: `ticketLogBuffers[ticket] = []`. Cap at 500 entries per ticket.

## 7. Web UI — Ticket Tab Bar (server/html.js)

- [x] 7.1 Add CSS for `.ticket-tabs` container, `.ticket-tab`, `.ticket-tab.active`, `.ticket-tab-badge`, `.ticket-tab-close`, `.ticket-tab-add` button. Use glass-card styling consistent with the recent UI redesign.
- [x] 7.2 Add HTML: `<div class="ticket-tabs" id="ticketTabs"></div>` in the topbar, after the search input area.
- [x] 7.3 Add `renderTicketTabs()` function — iterates `ticketList`, renders tab with ticket ID, status dot (● running, ◉ needs approval, ✓ done, ■ stopped), close [x] button, and [+ Add] button at the end.
- [x] 7.4 Add `switchTicket(ticket)` function — sets `selectedTicket`, clears log terminal and repopulates from `ticketLogBuffers[ticket]`, calls `render()`, `fetchReview()`.
- [x] 7.5 Add `addTicketTab()` function — focuses topbar input, user enters ticket and starts agent. On successful start, add to `ticketList` and switch to it.
- [x] 7.6 Add `closeTicketTab(ticket)` function — if running, show confirm dialog; stop agent if confirmed. Remove from `ticketList`, clear `ticketStates[ticket]` and `ticketLogBuffers[ticket]`. Switch to next tab or show empty state.

## 8. Web UI — Multi-Ticket Polling (server/html.js)

- [x] 8.1 Add `pollAllTickets()` function — calls `GET /api/tickets`, updates `ticketList` (add new tickets, update status), calls `renderTicketTabs()`. Detect newly gated tickets for auto-switch.
- [x] 8.2 Modify `pollState()` — use `selectedTicket` instead of reading from `#ticket` input. Write results to `ticketStates[selectedTicket]`.
- [x] 8.3 Modify `fetchReview()` — use `selectedTicket` instead of reading from `#ticket` input.
- [x] 8.4 Add `pollAllTickets` to the 5s polling interval alongside `pollState`.
- [x] 8.5 Modify `init()` — on startup, call `pollAllTickets()` first, then set `selectedTicket` to the first available ticket (or null for empty state).

## 9. Web UI — SSE Log Filtering (server/html.js)

- [x] 9.1 Modify SSE `log` event handler — check `data.ticket`. Store log in `ticketLogBuffers[data.ticket]`. Only call `appendLog()` if `data.ticket === selectedTicket` or `data.ticket === null` (system message).
- [x] 9.2 Modify `switchTicket()` — clear log terminal DOM, then replay all entries from `ticketLogBuffers[selectedTicket]` into the terminal.
- [x] 9.3 Modify SSE `status` event handler — check `data.ticket`. Only apply `isRunning` update if `data.ticket === selectedTicket`. Always update `ticketStates[data.ticket]` regardless.

## 10. Web UI — Cross-Tab Sync (server/html.js)

- [x] 10.1 Modify `crossTab.send("state:sync", ...)` — add `ticket: selectedTicket` to payload.
- [x] 10.2 Modify `on("state:sync", ...)` handler — only apply if `data.ticket === selectedTicket`.
- [x] 10.3 Modify `on("sse:log", ...)` handler — filter by ticket, store in per-ticket buffer.
- [x] 10.4 Modify `on("sse:status", ...)` handler — filter by ticket.
- [x] 10.5 Modify `on("gate:approved", ...)` and `on("gate:rejected", ...)` handlers — only disable buttons if `data.ticket === selectedTicket`.

## 11. Web UI — Agent Activity & Gate Badges (server/html.js)

- [x] 11.1 Add CSS for `.agent-activity-bar`, `.agent-pill`, `.agent-pill.running`, `.agent-pill.done`. Pulsing animation for running agents.
- [x] 11.2 Add `renderAgentActivity()` function — reads `ticketStates[selectedTicket].lastStateData._active_agents`, renders pills. Called from `render()`.
- [x] 11.3 Add gate badge logic to `renderTicketTabs()` — if `ticketStates[ticket].needsApproval`, show pulsing badge on that tab.
- [x] 11.4 Add auto-switch logic to `pollAllTickets()` — if a ticket enters a gate stage and the user is not actively interacting (no open forms), auto-switch to that ticket and show toast.

## 12. Verification

- [ ] 12.1 Start server (`node server.js`), load UI at localhost:3000. Verify empty state with no tickets.
- [ ] 12.2 Start one ticket — verify worktree is created at `.repo-cache/.worktrees/{TICKET}/`, tab appears, logs stream, pipeline progresses through stages.
- [ ] 12.3 Start a second ticket — verify second worktree is created, second tab appears, logs are per-ticket (switching tabs shows different logs).
- [ ] 12.4 Start a third ticket — verify it starts. Try starting a 4th — verify "Max concurrent agents" error.
- [ ] 12.5 Trigger a gate on one ticket — verify badge appears on that tab, auto-switch works, approve/reject flows work for the correct ticket.
- [ ] 12.6 Stop an agent — verify worktree is removed, tab shows stopped state.
- [ ] 12.7 Kill server (SIGTERM) — verify all worktrees are cleaned up on shutdown.
- [ ] 12.8 Kill server (SIGKILL), restart — verify orphaned worktrees are cleaned up on startup.
- [ ] 12.9 Open two browser tabs — verify cross-tab sync works per-ticket (approve in one tab reflects in the other, but only for the same ticket).
- [ ] 12.10 Verify backward compat — run `node run-agent.js` standalone (without WORKTREE_PATH) — verify it falls back to `.repo-cache/` as before.
