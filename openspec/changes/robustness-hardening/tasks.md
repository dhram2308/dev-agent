## 1. State CAS Guard (state-unified.js)

- [x] 1.1 Add `_seq` field initialization in state read path. On every `_writeFile()`, read current disk `_seq`, compare with in-memory `_seq`. If mismatch: log warning, re-read disk state, merge, retry once. On match: increment `_seq` and write. File: `lib/state-unified.js`
- [x] 1.2 Ensure `_seq` increments on successful write and persists in the JSON state file. Verify normal sequential writes succeed without warning.

## 2. Atomic Agent-Start Guard (agent-process.js)

- [x] 2.1 Move `agentStartingSet.add(ticket)` to immediately after the duplicate check (same event loop tick) in the spawn endpoint handler. Add error response "Agent already starting" for duplicate concurrent requests. File: `server/agent-process.js`

## 3. SSE Dropped Message Recovery (sse.js)

- [x] 3.1 In the client pending queue overflow path, add warning log and verify messages are already in the global replay buffer. Reconnecting clients using Last-Event-ID recover those messages via the existing replay mechanism. File: `server/sse.js`

## 4. CI Pipeline Wait Timeout (deploy-qa.js, deploy-prod.js)

- [x] 4.1 Already implemented: `CI_TIMEOUT` env var (default 30 minutes = 1,800,000ms) is enforced in `gl.waitPipeline()` which is used by both `deploy-qa.js` and `deploy-prod.js`. Defined in `lib/config-schema.js` line 1284.
- [x] 4.2 Same timeout already applies to `deploy-prod.js` via shared `gl.waitPipeline()` call.

## 5. Frontend Double-Submit Prevention (html.js)

- [x] 5.1 Add `_gateActionInFlight` boolean flag. In `approveGate()`, `confirmReject()`, and `submitRefine()`: check flag at entry, set flag before POST, clear in finally block. Disable all gate buttons while any action is in-flight. File: `server/html.js`

## 6. Null-Safe Render Path (html.js)

- [x] 6.1 Add `_safeEl(id)` helper that calls `getElementById`, logs warning and returns null if missing. Update render functions (`renderDetail`, `renderSummary`, `renderReviewPanel`, `renderBanners`, `renderStuckBanner`) to use `_safeEl` and early-return on null. File: `server/html.js`

## 7. Silent Catch Block Elimination

- [x] 7.1 Replace empty `catch {}` blocks with `catch (e) { console.warn('[context] ' + e.message); }` in: `claude.js` (3 catches), `sse.js` (1 catch), `state-unified.js` (3 catches), `state-lock.js` (1 catch), `graceful-shutdown.js` (7 catches), `http-client.js` (1 catch), `agent-process.js` (3 catches). Preserve existing control flow — no new throws.

## 8. Browser Interval Cleanup on Tab Close (html.js)

- [x] 8.1 Extended existing `beforeunload` handler to also clear `ticketPollId` and `logViewerInterval` intervals. Also replaced empty catch in SSE cleanup with warning log. File: `server/html.js`

## 9. Retry on Initial Jira Ticket Fetch (fetch-ticket.js)

- [x] 9.1 Wrap the initial `jira.getIssue()` call in a retry loop: up to 3 retries with exponential backoff (1s, 2s, 4s) on transient errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, ECONNREFUSED, EAI_AGAIN). On exhaustion, throw original error. File: `stages/fetch-ticket.js`

## 10. Zero-Files Guard Before Push (generate-code/index.js)

- [x] 10.1 After all generate_code sub-stages complete, check `fileChanges` array length. If 0 files changed, throw clear error "No files were changed by code generation" before attempting push. File: `stages/generate-code/index.js`

## 11. Verification

- [x] 11.1 Restart server (`node server.js`), open Web UI at localhost:3000. Server starts successfully, JS parses without errors, all new functions present in output.
