## Context

The MI Dev Agent server (`server/agent-process.js`) already supports spawning up to `MAX_CONCURRENT_AGENTS=3` child processes via the `agentProcs` map. Each ticket gets its own `state-{TICKET}.json`, its own `state-{TICKET}.lock`, and all API endpoints accept a `ticket` parameter. However, all tickets share a single `.repo-cache/` directory for local code generation, and the SSE/UI layer is entirely single-ticket.

Key architectural facts discovered during investigation:
- **No `git push` exists in the codebase.** All code delivery uses the GitLab Commits API (`POST /repository/commits`).
- **The local clone is a scratchpad.** It's always on `enterprise-ts` — the feature branch `enterprise-ts-{TICKET}` only exists on GitLab (created via API).
- **`cfg.localRepo` is already the abstraction.** Every file that touches the repo receives it as a parameter or reads it from `cfg.localRepo`. Changing where it points requires a 1-line edit in `run-agent.js`.
- **Port allocation already handles concurrency.** `findFreePort()` scans ranges (4200-4299 for nx serve, 4300-4399 for vite preview) and dev-server.js retries on port+1 if binding fails.

## Goals / Non-Goals

**Goals:**
- Run up to 3 tickets simultaneously, each with its own agents-team (parallel Claude agents)
- Isolate local file writes via per-ticket git worktrees so `generate_code` stages don't collide
- Tag all SSE events with ticket ID for per-ticket log display
- Provide a multi-ticket Web UI with ticket tabs, per-ticket state, and gate notification badges
- Maintain full backward compatibility — existing single-ticket usage works unchanged
- Clean up worktrees on agent exit, server shutdown, and server restart (orphan detection)

**Non-Goals:**
- Auto-approval of gates (gates remain manual per the user's preference)
- Ticket queue/scheduler (user manually starts each ticket)
- Cross-ticket awareness (agents don't know about each other; no shared context or conflict avoidance)
- Shared `node_modules` optimization (each worktree runs its own `npm install`; optimize later if needed)
- Mobile-first UI redesign (the existing responsive layout from the recent redesign is sufficient)

## Decisions

### D1: Detached-HEAD git worktrees for file isolation

**Decision:** Use `git worktree add --detach <path> <sha>` to create per-ticket scratchpads.

**Why over alternatives:**
- *vs. separate clones*: Worktrees share the `.git` object store (~500MB saved per ticket). Clone takes 60-120s; worktree creation is instant.
- *vs. branch-based worktrees (`git worktree add <path> <branch>`)*: Two worktrees can't have the same branch checked out. Since all tickets need `enterprise-ts` as their baseline, detached HEAD avoids this conflict entirely.
- *vs. GitLab API-only file reads (no local clone)*: Claude CLI agents need `cwd` to use Read/Write/Edit/Grep/Glob tools. A local working tree is required.

**Worktree path:** `.repo-cache/.worktrees/{TICKET}/` (e.g., `.repo-cache/.worktrees/AUT-8203/`)

**Commit pinning:** Each worktree is created at `git rev-parse origin/enterprise-ts` — the latest fetched commit. This is a point-in-time snapshot; if `enterprise-ts` moves during generation, the agent's code is based on its snapshot, and GitLab MR merge checks catch conflicts.

### D2: `localResetRepo()` uses `checkout -f .` instead of branch name

**Decision:** Change `git checkout -f enterprise-ts` to `git checkout -f .` in `localResetRepo()`.

**Rationale:** In a detached-HEAD worktree, you can't checkout a branch (it's checked out in the main clone). `git checkout -f .` reverts all modified files to HEAD — which IS the `enterprise-ts` commit the worktree was created from. Identical result, works in both worktree and non-worktree contexts.

### D3: `ensureLocalRepo()` skips hard reset when worktrees are active

**Decision:** When active worktrees exist, `ensureLocalRepo()` runs `git fetch` but skips `git reset --hard`.

**Rationale:** `git reset --hard` moves the main clone's HEAD forward, which is fine when no worktrees exist. But with active worktrees, it could theoretically cause object pruning issues (though worktree refs protect objects). The safer approach: only update the main clone fully when no worktrees are active. New worktrees always pin to the latest `origin/enterprise-ts` commit regardless.

### D4: SSE events tagged with ticket, client-side filtering

**Decision:** Add `ticket` field to all SSE payloads. Broadcast to ALL clients. Client filters by `selectedTicket`.

**Why over server-side per-ticket channels:**
- Simpler implementation — no per-ticket SSE streams to manage
- The server already has backpressure handling and keepalive for a single broadcast model
- Client-side filtering is trivial (one `if` statement per event handler)
- Total event volume is low (logs are the heaviest — capped at 500 lines per ticket in the UI)

### D5: `Object.defineProperty` shims for backward-compatible UI state

**Decision:** Replace singleton globals (`currentStage`, `isRunning`, etc.) with per-ticket `ticketStates` map, but expose them via `Object.defineProperty` getters/setters that transparently redirect to the selected ticket's state.

**Rationale:** The `html.js` UI has hundreds of references to these globals. Rewriting all of them is error-prone and unnecessary. Property shims let all existing render logic work unchanged while the underlying data structure supports multiple tickets.

### D6: `node_modules` per worktree via npm install (no symlink optimization)

**Decision:** Each worktree runs its own `npm install --legacy-peer-deps` when it reaches the build/test phase.

**Why not symlink:**
- `runtime-tests.js` runs `npm install --save-dev` for test dependencies, which mutates `node_modules`
- `env-setup.js` has `_npm_install_hash` detection already — per-ticket state files means each worktree tracks its own hash
- npm cache makes repeated installs reasonably fast (~15-30s with warm cache)
- Phases 1-3 of `generate_code` (developer, review, fix) don't need `node_modules` — only phases 4+ (build, test, serve) do, so the install runs late and in parallel with other tickets

## Risks / Trade-offs

- **[Disk space] 3 worktrees = 3x working tree size** → Each worktree is a full working copy (~200-500MB for the frontend monorepo) but shares `.git` objects. Mitigation: worktrees are removed on agent exit. Monitor disk with a pre-creation check (warn if <1GB free).

- **[npm install time] ~60-120s per worktree** → Runs once per ticket in the build/test phase. Mitigated by npm cache and parallel execution. Not blocking — other tickets continue their pipeline while one installs.

- **[Git lock contention] Worktrees share `.git/`, concurrent git ops may briefly lock** → Each worktree has its own index file. Lock contention only happens for ref updates (`fetch`). Mitigation: `ensureLocalRepo()` only fetches when no worktrees are active, or uses a retry on `.git/index.lock`.

- **[Orphaned worktrees after crash] Server SIGKILL leaves worktrees on disk** → Mitigation: `cleanOrphanedWorktrees()` runs at server startup, scans `.worktrees/`, checks if owning agent PID is alive, removes stale ones. Same pattern as existing `cleanOrphanedLocks()`.

- **[SSE bandwidth with 3 tickets] All logs broadcast to all clients** → Max 500 lines per ticket in UI buffer. At 3 tickets, total is ~1500 lines max. Negligible bandwidth. Client filters and only renders the selected ticket's logs.

- **[Cross-tab state overwrite] BroadcastChannel messages without ticket would corrupt state** → Mitigation: ALL cross-tab messages MUST include `ticket` field. Follower handler MUST filter by `selectedTicket`.

- **[UI complexity] User managing 3 tickets with staggered gates** → Mitigation: auto-switch to ticket needing approval, notification badge pulsing on gate tabs, desktop notifications (from existing feature).
