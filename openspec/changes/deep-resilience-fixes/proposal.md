## Why

The MI Dev Agent pipeline has 52 verified robustness gaps discovered through three rounds of systematic audit and stress-testing. These range from a circuit breaker that never self-heals (causing permanent request blocking after transient GitLab outages), to an in-process mutex with no timeout path (potential deadlocks under load), to 13 newly-discovered gaps including dual signal handler conflicts, missing server SIGTERM handling, and memory leaks in long-running maps. The internal GitLab server (10.200.11.32) is prone to ECONNRESET errors, making resilience patterns critical for unattended pipeline operation.

## What Changes

### Backend — Core Libraries
- **Circuit breaker self-healing**: Add `_prune()` on OPEN→HALF_OPEN and HALF_OPEN→CLOSED transitions only (not every request); remove dead `refCount` code from deduplicator
- **Mutex with timeout**: Add configurable timeout + rejection path to `InProcessMutex`; callers must handle rejection (no queue splice, simple rejection)
- **Save-and-throw guard**: New `saveAndThrow(state, error)` helper that wraps `save()` in try-catch to prevent masking original errors; apply to 8 throw sites missing pre-save
- **CAS sequence consistency**: Fix `_seq` initialization mismatch (envelope wraps `|| 1` but unwraps `|| 0`); ensure consistent starting value
- **State FD leak fix**: Fix double-close ordering in `atomicWriteSync` error path
- **Secret rotation guard**: Log warning when HMAC secret regenerated due to read failure

### Backend — Pipeline Stages
- **GL API calls in poll loops**: Wrap `getMR()`, `getMRApprovals()`, `getMRNotes()` in try-catch inside poll loops in gate-code-review, deploy-qa, deploy-prod to prevent transient errors from crashing the poll
- **Save-before-throw**: Add `save(state)` before 8 identified throw sites in deploy-prod, gate stages
- **Early zero-files check**: Add secondary check after developer agent completes (line ~168) in addition to existing final check
- **Unsafe property access**: Add optional chaining for `preflightIssue.fields.status.name` in fetch-ticket.js

### Backend — Server Infrastructure
- **Signal handler deconfliction**: Remove legacy `cleanup.js` handlers; consolidate into `graceful-shutdown.js`
- **Server SIGTERM handler**: Add SIGTERM/SIGINT handling in `server.js` for graceful HTTP server close
- **SSE drain guard**: Wrap drain handler in try-catch to prevent exception from permanently pausing client
- **SSE replay buffer**: Replace O(n) `shift()` with circular buffer; assign fresh IDs on replay to prevent browser EventSource dedup
- **Memory leak fixes**: Prune `_ticketFailureCounts` on agent exit; clean `logBuffers` on startup failure; add TTL to deduplicator inflight map

### Frontend — html.js
- **Timer lifecycle**: Clear `leaderCheckInterval` on tab hide; deduplicate `visibilitychange` listeners; enforce timer initialization order
- **Null guards**: Add null checks in `showConfirmDialog`; validate ticket ID format with regex
- **FormDrafts cleanup**: Add per-draft size limit and expiration

### Cross-Cutting
- **Escalation visibility**: Upgrade swallowed escalation errors from DEBUG to WARN level

## Capabilities

### New Capabilities
- `circuit-breaker-healing`: Self-healing circuit breaker that prunes stale failures on state transitions and recovers automatically after transient outages
- `mutex-timeout`: In-process mutex with configurable timeout and clean rejection path for deadlock prevention
- `save-throw-guard`: Safe save-before-throw pattern that preserves original error context when disk write fails
- `sse-resilience`: SSE drain protection, circular replay buffer with fresh IDs, and memory-bounded log buffers
- `signal-lifecycle`: Unified signal handling across server.js, graceful-shutdown.js, and child processes
- `frontend-timer-lifecycle`: Centralized timer management with dependency ordering, tab-visibility awareness, and leak prevention

### Modified Capabilities

_(No existing specs to modify — all capabilities are new)_

## Impact

- **Files modified**: `lib/http-client.js`, `lib/state-unified.js`, `lib/state-lock.js`, `lib/state-migration.js`, `server/sse.js`, `server/html.js`, `server/agent-process.js`, `server.js`, `lib/graceful-shutdown.js`, `stages/gate-code-review.js`, `stages/deploy-qa.js`, `stages/deploy-prod.js`, `stages/fetch-ticket.js`, `stages/generate-code/index.js`, `run-agent.js`
- **Files removed**: `lib/cleanup.js` (legacy, consolidated into graceful-shutdown.js)
- **No API changes**: All fixes are internal; no route signatures or SSE protocol changes
- **No dependencies added**: All fixes use native Node.js APIs
- **Pipeline stages affected**: All 11 stages benefit from improved error handling; gate stages and deploy stages most impacted
