## Why

The agent currently processes one Jira ticket at a time. With 3 concurrent agent slots already supported by the server infrastructure (`MAX_CONCURRENT_AGENTS=3`), the pipeline sits idle waiting on gates (code review, QA approval, dual approval) while it could be processing other tickets in parallel. Running multiple tickets simultaneously — each with its own agents-team (parallel Claude agents for explore, develop, review) — would multiply throughput without additional infrastructure, since all GitLab operations are API-based and each ticket's state is already isolated in `state-{TICKET}.json`.

## What Changes

- **Per-ticket git worktrees**: Replace the shared `.repo-cache/` scratchpad with isolated detached-HEAD worktrees (`.repo-cache/.worktrees/{TICKET}/`), so multiple tickets can run `generate_code` simultaneously without clobbering each other's file changes.
- **SSE per-ticket log tagging**: Tag all SSE log/status/review events with a `ticket` field. Per-ticket log buffers on the server for filtered replay on reconnect.
- **New `/api/tickets` endpoint**: Lightweight overview of all active tickets (stage, running state, active agents, gate status) for the multi-ticket dashboard.
- **Worktree lifecycle management**: Create worktree before agent spawn, remove on agent exit. Orphaned worktree cleanup on server startup and graceful shutdown.
- **Multi-ticket Web UI**: Ticket tab bar for switching between active tickets, per-ticket state maps (with `Object.defineProperty` shims for backward compatibility), per-ticket log filtering, agent activity indicators, and gate notification badges.
- **Cross-tab sync with ticket awareness**: All `BroadcastChannel` messages tagged with ticket ID so follower tabs filter correctly.

## Capabilities

### New Capabilities
- `worktree-isolation`: Per-ticket git worktree lifecycle (create detached-HEAD worktree from `.repo-cache`, symlink node_modules, cleanup on exit/shutdown/startup)
- `sse-per-ticket`: SSE log/status/review events tagged with ticket ID, per-ticket log buffers, filtered replay
- `multi-ticket-api`: New `/api/tickets` endpoint returning overview of all active tickets with stage, agents, and gate status
- `multi-ticket-ui`: Ticket tab bar, per-ticket state management, per-ticket log display, agent activity bar, gate notification badges, auto-switch to ticket needing approval

### Modified Capabilities
<!-- No existing spec-level capabilities to modify — this is additive -->

## Impact

- **Backend (7 files modified)**:
  - `lib/local-repo.js` — new `createWorktree()`, `removeWorktree()`, `cleanOrphanedWorktrees()`, modified `localResetRepo()` (`checkout -f enterprise-ts` → `checkout -f .`), modified `ensureLocalRepo()` (skip hard reset if worktrees active)
  - `run-agent.js` — 1 line: read `WORKTREE_PATH` env var into `cfg.localRepo`
  - `lib/config.js` — add `WORKTREE_PATH` and `DEV_SERVER_PORT` env var support
  - `server/agent-process.js` — worktree create/remove in `startAgent()`/`close` handler, pass ticket to `addLog()`, startup orphan cleanup
  - `server/sse.js` — `addLog(line, type, ticket)`, per-ticket `logBuffers`, ticket-filtered replay
  - `server/routes.js` — `GET /api/tickets`, include ticket in `broadcast("review")` payload
  - `lib/graceful-shutdown.js` — worktree cleanup shutdown hook
- **Frontend (1 file modified)**:
  - `server/html.js` — ticket tab bar, `ticketStates` map, `Object.defineProperty` shims, per-ticket log buffers, `pollAllTickets()`, cross-tab ticket tags, agent activity bar, gate badges
- **Zero-touch (14 files)**: All stage handlers, `lib/claude.js`, `lib/agents-team.js`, `lib/approval.js` — these already use `cfg.localRepo` parametrically and per-ticket state files
- **Port management**: Existing `findFreePort(4200-4299)` and `findFreePort(4300-4399)` already handle concurrent dev servers — no changes needed
- **Pipeline stages affected**: Only `generate_code` (uses local repo for code writing) is impacted by the worktree change. All other stages use GitLab API exclusively.
