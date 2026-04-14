## Context

The MI Dev Agent is a long-running Node.js pipeline that automates Jira ticket → Claude code gen → GitLab MR → QA → Production. It runs unattended for hours, communicates with an internal GitLab server (10.200.11.32) prone to ECONNRESET, and manages complex state through JSON files with file-level locking.

Three rounds of systematic audit identified 52 robustness gaps. Stress-testing revealed that 2 of 7 originally proposed abstractions (withRetry wrapper, safeSlack wrapper) are unnecessary — existing error-recovery and slack resilience patterns already handle those cases. The remaining 5 abstractions need careful design to avoid introducing new failure modes.

**Key constraint**: The codebase uses CommonJS (`require`), native `http`/`https` modules, no external dependencies. All fixes must preserve this.

## Goals / Non-Goals

**Goals:**
- Self-healing circuit breaker that recovers after transient GitLab outages without manual restart
- Deadlock-proof mutex with timeout and clean rejection path
- Safe save-before-throw pattern that doesn't mask original errors
- SSE reliability: drain protection, memory-bounded buffers, correct replay
- Unified signal handling with graceful HTTP server shutdown
- Frontend timer lifecycle management preventing leaks across tab visibility changes
- Fix all 52 identified gaps with minimal code changes (~300 lines net)

**Non-Goals:**
- New external dependencies (no Redis, no SQLite, no npm packages)
- Changing the SSE wire protocol or API route signatures
- Refactoring the pipeline stage architecture
- Building generic retry wrapper (existing `executeWithRecovery()` and per-module retry suffice)
- Building slack wrapper (slack.js already has 6-layer resilience, never throws)
- Changing the state file format (backward compatible with existing state-*.json files)

## Decisions

### D1: Circuit Breaker — Prune on State Transitions Only

**Choice**: Call `_prune()` only during OPEN→HALF_OPEN and HALF_OPEN→CLOSED transitions, not on every `recordSuccess()`.

**Why not prune on every success**: At 100+ RPS, `_prune()` uses `Array.shift()` which is O(n). With a 5-min window and 100 RPS, the failures array can reach 30K entries, causing ~600K array operations/sec.

**Why not periodic timer**: Adds complexity; state transitions are the natural pruning point and happen infrequently.

**Also**: Remove dead `refCount` code from `Deduplicator` class — it's incremented but never checked.

### D2: Mutex Timeout — Simple Promise.reject, No Queue Splice

**Choice**: Add `acquire(timeoutMs)` parameter. On timeout, reject the pending Promise. Do NOT splice the entry from the queue — let it drain naturally when its turn comes (and the resolve is a no-op since the Promise is already settled).

**Why not splice**: Splicing during queue processing creates index corruption. The queue uses `shift()` in sequence, and removing arbitrary entries breaks iteration.

**Why reject is safe**: The caller receives a rejected Promise, retries or throws. The abandoned queue entry resolves to nothing (the lock holder already moved on). No state corruption.

**Default timeout**: 30,000ms (600x the typical 50ms hold time). Configurable via parameter.

### D3: saveAndThrow — Try-Catch Around save()

**Choice**: `saveAndThrow(state, error)` calls `save(state)` in a try-catch. If save fails, log the save error as WARNING and still throw the original error.

**Why not bare save+throw**: `save()` can throw on DISK FULL (exits process via state-migration.js L78-96), lock timeout, or CAS conflict. Without try-catch, the save error masks the original pipeline error.

**Why not skip save on known-fatal**: All 8 identified throw sites have meaningful state to preserve (e.g., error messages, partial progress). Saving is worth attempting even if it might fail.

**Apply at**: deploy-prod.js (4 sites), gate stages (2 sites), generate-code/index.js (1 site), run-agent.js (1 site).

### D4: SSE Circular Buffer — Fixed-Size Array with Head/Tail Pointers

**Choice**: Replace `replayBuffer` array + `shift()` with a fixed-size circular buffer (capacity = MAX_REPLAY, default 1000). Use `head`/`tail` indices for O(1) insert and O(n) ordered iteration on replay.

**Why not Map/Set**: Need ordered iteration by insertion time. Circular array is simplest, zero-allocation after init.

**Fresh replay IDs**: On replay, assign new sequential IDs starting from global counter. This prevents browser EventSource from deduplicating replayed messages with IDs it already processed.

**Drain handler**: Wrap in try-catch. On exception, log warning and force-resume the response stream.

### D5: Signal Handler — Consolidate, Don't Layer

**Choice**: Remove `cleanup.js` entirely. `graceful-shutdown.js` already handles SIGTERM/SIGINT/uncaughtException/unhandledRejection. Add server.close() to the shutdown sequence in server.js.

**Why remove cleanup.js**: It registers competing signal handlers. `graceful-shutdown.js` calls `process.removeAllListeners()` on shutdown, which wipes cleanup.js handlers anyway — they never execute during graceful shutdown.

**Server.js handler**: Register with `onShutdown('http-server', () => server.close())` instead of adding separate signal handlers.

### D6: Frontend Timer Manager — Object Registry, Not Class

**Choice**: Simple `_timers = {}` registry. `registerTimer(name, fn, intervalMs)` stores the interval ID. `clearAllTimers()` clears all. `pauseTimers()` / `resumeTimers()` for tab visibility changes.

**Why not a class**: Only one instance needed, global state is fine for a single-page app. Keeps it under 30 lines.

**Tab visibility**: Single `visibilitychange` listener (remove the duplicate). On hidden: pause all timers except heartbeat. On visible: resume all.

**Dependency ordering**: `resumeTimers()` starts timers in registration order. Register poll → review → heartbeat → leader check. fetchReview only runs after first poll completes (guard flag).

## Risks / Trade-offs

- **[Mutex timeout too short]** → Default 30s is 600x typical hold time. Only risk: disk I/O stall under extreme load. Mitigation: log WARNING on timeout with hold duration for diagnosis.

- **[Circular buffer loses oldest on overflow]** → Same behavior as current `shift()` approach but O(1). No functional regression.

- **[Removing cleanup.js breaks unknown dependents]** → Searched codebase: only `run-agent.js` imports it, and only for `installCleanupHandlers()`. Mitigation: grep for all imports before removing.

- **[save() in saveAndThrow may exit process on DISK FULL]** → state-migration.js L78-96 calls `process.exit(1)` on disk full. This is existing behavior and is intentional (unrecoverable). saveAndThrow won't change this.

- **[Fresh replay IDs break Last-Event-ID tracking]** → Clients reconnecting mid-replay may miss messages between old ID and new ID. Mitigation: replay sends ALL buffered messages (up to MAX_REPLAY), not just since Last-Event-ID. Client-side dedup handles duplicates.

- **[Frontend timer pause may delay poll updates]** → Hidden tabs won't poll. This is intentional — saves resources. Resuming on visibility fires immediate poll.

## Open Questions

_(None — all design decisions validated through three rounds of stress-testing)_
