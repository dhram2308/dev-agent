## 1. Circuit Breaker Self-Healing (lib/http-client.js)

- [ ] 1.1 In `recordSuccess()`: remove the `_prune()` call in CLOSED state (keep only HALF_OPEN→CLOSED transition). Add `_prune()` call in the OPEN→HALF_OPEN transition path (inside the reset timeout callback or the first request check). Verify failures array is cleaned on recovery.
- [ ] 1.2 Remove dead `refCount` field from `Deduplicator` class: delete the `refCount` property initialization, remove all `refCount++` statements, and remove the `refCount` check in `cleanup()`. Ensure `cleanup()` deletes entries unconditionally.
- [ ] 1.3 Add inflight TTL eviction to `Deduplicator.acquire()`: before coalescing, check if existing entry is older than 300s (5 min). If so, evict and treat as fresh request. Add `_createdAt` timestamp on entry creation.

## 2. Mutex Timeout (lib/state-lock.js)

- [ ] 2.1 Add `timeoutMs` parameter (default 30000) to `InProcessMutex.acquire()`. When queuing a waiter, start a `setTimeout`. On timeout: set a `_timedOut` flag on the resolve wrapper, reject the Promise with `MutexTimeoutError` (new Error subclass). In the dequeue path: if the shifted entry has `_timedOut`, skip and shift next.
- [ ] 2.2 In `acquireLockAsync()`: wrap the `mutex.acquire()` call in try-catch. On `MutexTimeoutError`, throw descriptive error with ticket ID and timeout duration. Log WARNING.

## 3. Save-and-Throw Guard (lib/state-migration.js + stages)

- [ ] 3.1 Add `saveAndThrow(state, error)` function in `lib/state-migration.js`: try `save(state)` catch log warning, then throw original error. Export it.
- [ ] 3.2 Apply `saveAndThrow()` at 4 unguarded throw sites in `stages/deploy-prod.js`: lines ~51, ~120, ~171, ~180 where state mutations precede throws without save. Do NOT apply where save() already exists before throw.
- [ ] 3.3 Apply `saveAndThrow()` at 2 unguarded throw sites in gate stages (`stages/gate-code-review.js`) where state has been mutated.
- [ ] 3.4 Apply `saveAndThrow()` at 1 site in `stages/generate-code/index.js` and 1 site in `run-agent.js` where state mutations precede throws.

## 4. CAS & State Consistency (lib/state-unified.js)

- [ ] 4.1 Fix `_seq` initialization mismatch: change `wrapEnvelope` fallback from `|| 1` to `(state._seq || 0) + 1` and `unwrapEnvelope` fallback to `|| 0`. Ensure both paths start from the same base.
- [ ] 4.2 Fix `atomicWriteSync` FD double-close: add a `closed` flag, set after `fs.closeSync(fd)` in the happy path, check flag in catch/finally before closing again.
- [ ] 4.3 Add WARNING log when HMAC secret is regenerated due to read failure (in the secret initialization path, ~line 40-65). Message: "HMAC secret regenerated — existing state files may fail verification".

## 5. SSE Resilience (server/sse.js)

- [ ] 5.1 Wrap the drain event handler body (~line 193-207) in try-catch. On error: `console.warn('[SSE] drain handler error:', e.message)` and call `res.resume()`.
- [ ] 5.2 Replace `replayBuffer` array with circular buffer: add `_replayBuf` fixed-size array (MAX_REPLAY), `_replayHead`, `_replayTail` pointers. Replace `push()`/`shift()` with O(1) pointer operations. Add `_replayIterate()` generator/function that yields messages from head to tail in order.
- [ ] 5.3 In the replay path (client reconnect with Last-Event-ID): assign fresh sequential IDs from the global `msgId` counter to replayed messages instead of reusing old IDs.
- [ ] 5.4 Add message size limit: before storing in replay buffer, truncate messages exceeding 64KB with "[truncated]" suffix.
- [ ] 5.5 Ensure `clearTicketLogs(ticket)` is called in the `proc.on("close")` handler in `agent-process.js` for ALL exit paths (already called at line 136, verify it covers startup failures).

## 6. Signal Lifecycle (server.js, lib/graceful-shutdown.js, lib/cleanup.js)

- [ ] 6.1 In `server.js`: add `onShutdown('http-server', () => { server.close(); })` after the server starts listening. Import `onShutdown` from `lib/graceful-shutdown.js`.
- [ ] 6.2 In `lib/cleanup.js`: remove or comment out the `installCleanupHandlers()` signal registration (SIGTERM/SIGINT listeners). Keep any file-cleanup utility functions. Update `run-agent.js` to not call `installCleanupHandlers()` if it currently does.
- [ ] 6.3 In `run-agent.js` (~line 421): change escalation error logging from `console.debug()` to `console.warn()` for `evaluateRules()` catch block.

## 7. Agent Process Cleanup (server/agent-process.js)

- [ ] 7.1 In `proc.on("close")` handler: change `_ticketFailureCounts[ticket] = 0` (clean exit) to `delete _ticketFailureCounts[ticket]` to prevent unbounded map growth.
- [ ] 7.2 Wrap `agentRedactors[ticket].cleanup()` in try-catch. On error: `console.warn('[Agent] redactor cleanup error:', e.message)`. Ensure `delete agentRedactors[ticket]` happens in finally.

## 8. Pipeline Stage Hardening (stages/*.js)

- [ ] 8.1 In `stages/gate-code-review.js`: wrap `gl.getMR()`, `gl.getMRApprovals()`, `gl.getMRNotes()` calls inside the poll loop in try-catch. On transient error: log warning, continue polling. On permanent error: throw.
- [ ] 8.2 In `stages/deploy-qa.js` (~line 131-141): replace empty `catch {}` on `getMR()` with `catch (e) { console.warn('[deploy-qa] getMR error:', e.message); }`. Continue polling on transient error.
- [ ] 8.3 In `stages/deploy-prod.js` (~line 20): move `preprod_merged = true` + `save()` to AFTER the `getMR()` verification confirms merge, not before.
- [ ] 8.4 In `stages/fetch-ticket.js` (~line 25): add optional chaining for `preflightIssue.fields.status?.name` to prevent crash on null status field.
- [ ] 8.5 In `stages/generate-code/index.js` (~line 137-158): add early zero-files warning after developer agent completes (~line 168) — log a WARNING if `localGetChanges()` returns empty, before proceeding to review.

## 9. Frontend Timer & Safety (server/html.js)

- [ ] 9.1 Add `_timers` registry object and `registerTimer(name, fn, ms)`, `clearTimer(name)`, `clearAllTimers()`, `pauseTimers()`, `resumeTimers()` functions. Migrate all existing `setInterval` calls to use `registerTimer`.
- [ ] 9.2 Remove the duplicate `visibilitychange` listener. Consolidate into single listener that calls `pauseTimers()` on hidden (except heartbeat) and `resumeTimers()` on visible with immediate poll.
- [ ] 9.3 Clear `leaderCheckInterval` on tab hide via `pauseTimers()`. Restart on tab visible via `resumeTimers()`.
- [ ] 9.4 Add `_pollComplete` guard flag. Set to true after first successful `pollState()`. Guard `fetchReview` callback to return early if `_pollComplete` is false.
- [ ] 9.5 Add null checks in `showConfirmDialog()`: check each `getElementById()` result, fall back to `window.confirm()` if dialog elements are missing.
- [ ] 9.6 Add ticket ID format validation: regex `/^[A-Z]+-\d+$/i` check in start handler. Show warning toast on invalid format.
- [ ] 9.7 Add formDrafts cleanup: limit each draft to 10KB, remove drafts older than 7 days on page load.

## 10. Verification

- [ ] 10.1 Restart server (`node server.js`), open Web UI at localhost:3000. Verify server starts without errors, all JS parses correctly, no console errors in browser.
- [ ] 10.2 Test circuit breaker: verify `recordSuccess()` in CLOSED state does NOT call `_prune()` (add a temporary log or inspect code path).
- [ ] 10.3 Test mutex: verify `acquireLockAsync()` catches timeout properly (can test by temporarily setting timeout to 1ms).
- [ ] 10.4 Verify SSE reconnection: disconnect and reconnect, check that replayed messages have fresh IDs.
- [ ] 10.5 Verify signal handling: send SIGTERM to server process, confirm graceful shutdown with "Shutting down..." log and server.close() execution.
