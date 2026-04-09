# Tasks — Fix ECONNRESET on GitLab API calls

**Change:** `fix-econnreset-gitlab`
**File:** `run-agent.js`
**Status:** Complete

---

## 1. Keep-Alive Agents

- [x] 1.1 Add `http.Agent({ keepAlive: true })` and `https.Agent({ keepAlive: true })` after the require statements (line 28-30) to reuse TCP connections and reduce ECONNRESET from idle socket teardown

## 2. Logging

- [x] 2.1 Add `logWarn()` helper function using yellow `!` icon (`C.yellow`) to surface retry warnings without polluting error-level output

## 3. Robust HTTP Client (`req()`)

- [x] 3.1 Replace naive `req()` with retry-capable version that defines `RETRYABLE_CODES` (ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, SOCKET_TIMEOUT) and `RETRYABLE_STATUS` (502, 503, 504) sets
- [x] 3.2 Add 30-second socket timeout via `r.setTimeout(30_000)` that destroys the request with a `SOCKET_TIMEOUT` error code on expiry
- [x] 3.3 Implement retry loop with exponential backoff (1s, 2s, 4s) up to `MAX_RETRIES` (3), logging each retry via `logWarn()`
- [x] 3.4 Pass `httpAgent` / `httpsAgent` to each request based on URL protocol so connections are reused across calls
- [x] 3.5 Return `{ status, data, headers }` from every response to give callers access to response headers (needed by paginated `getTree`)

## 4. Paginated `getTree()`

- [x] 4.1 Replace single-page `getTree()` with paginated loop that appends `&page=N` to each request
- [x] 4.2 Read `x-next-page` response header to determine the next page number
- [x] 4.3 Add safety guards: break on non-200 status, empty array, non-array response, or invalid/non-advancing next-page value

## 5. Verification

- [ ] 5.1 Run a full agent cycle (`node run-agent.js`) against the internal GitLab server and confirm no ECONNRESET crashes
- [ ] 5.2 Confirm retry log lines (`logWarn`) appear in the console when GitLab returns transient errors
- [ ] 5.3 Verify `getTree()` returns the complete repository tree (compare entry count before and after the fix)
- [ ] 5.4 Open the Web UI at `http://localhost:3000` and trigger a pipeline run to confirm end-to-end operation
