## Why

The MI Dev Agent pipeline (`run-agent.js`) crashes with an unrecoverable `ECONNRESET`
error when fetching the repository tree from the internal GitLab server
(`http://10.200.11.32`). Three root causes compound into a single point of failure:

1. **No connection reuse** — every HTTP call opens a fresh TCP socket; the internal
   server occasionally resets idle connections under load, and there is no keepAlive
   agent to maintain warm sockets.
2. **No timeout or retry in `req()`** — a hung or dropped connection blocks the
   process forever. A transient `ECONNRESET`, `ETIMEDOUT`, or 502/503/504 response
   immediately kills the pipeline with no recovery attempt.
3. **No pagination in `getTree()`** — the function makes a single API call without
   following GitLab's `x-next-page` pagination header, so large repositories return
   incomplete file lists *and* the oversized single request is more likely to be
   dropped by the server.

Because the agent runs unattended (Jira ticket in, Merge Request out), any of these
failures forces a full manual restart, delaying the entire code-generation workflow.

## What Changes

All changes are scoped to **`run-agent.js`**:

- **Add keepAlive HTTP agents** — create `http.Agent({ keepAlive: true })` and
  `https.Agent({ keepAlive: true })` at module level; pass the appropriate agent
  into every outgoing request so TCP connections are reused across calls to the same
  GitLab host.
- **Add `logWarn()` helper** — new logging function (yellow `!` prefix) used by the
  retry logic to surface transient-failure warnings without cluttering the error path.
- **Replace `req()` with a robust version** — the new implementation adds:
  - 30-second socket timeout (`r.setTimeout(30_000)`) that destroys the request with
    a `SOCKET_TIMEOUT` error code.
  - Retry up to 3 times (`MAX_RETRIES`) on retryable error codes (`ECONNRESET`,
    `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `SOCKET_TIMEOUT`) and retryable HTTP
    status codes (502, 503, 504).
  - Exponential backoff: 1 s, 2 s, 4 s between retries.
  - Returns `{ status, data, headers }` (previously did not expose response headers).
- **Replace `getTree()` with a paginated version** — the new implementation:
  - Requests 100 items per page (`per_page=100`).
  - Reads the `x-next-page` response header after each page.
  - Loops until the header is absent, non-numeric, or not greater than the current
    page, then returns the concatenated result array.

## Capabilities

### New Capabilities

- `keepAlive agents`: Module-level `http.Agent` and `https.Agent` with `keepAlive: true` that maintain persistent TCP connections to the GitLab server, eliminating per-request socket setup overhead and reducing exposure to connection-reset errors.
- `logWarn()`: Warning-level log helper (yellow `!` icon) for surfacing transient retry events in the console without using the error (`logErr`) channel.
- `RETRYABLE_CODES`: Constant `Set` of Node.js error codes (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `SOCKET_TIMEOUT`) that qualify a failed request for automatic retry.
- `RETRYABLE_STATUS`: Constant `Set` of HTTP status codes (502, 503, 504) that qualify a server response for automatic retry.
- `MAX_RETRIES`: Constant (`3`) controlling the maximum number of retry attempts per request.
- `socket timeout`: Every outgoing request is hard-capped at 30 seconds; if no response arrives the socket is destroyed with a `SOCKET_TIMEOUT` code and the retry loop takes over.

### Modified Capabilities

- `req()`: Now accepts the keepAlive agent, enforces a 30-second socket timeout, retries up to 3 times with exponential backoff on transient failures, and returns response headers alongside status and data (`{ status, data, headers }`).
- `getTree()`: Now paginates through the GitLab Repository Tree API using `per_page=100` and the `x-next-page` response header, accumulating all pages into a single array before returning.

## Impact

- **`run-agent.js`** — sole file modified; all four changes are contained here.
- **`req()` return shape** — every call site now receives `{ status, data, headers }` instead of `{ status, data }`. Existing code that only destructures `status` and `data` is unaffected; callers that need pagination headers (e.g., `getTree`) can now read `r.headers`.
- **GitLab API traffic** — `getTree()` will issue multiple paginated requests instead of one large request; net traffic volume is comparable but individual payloads are smaller and less likely to be dropped.
- **Latency on transient failure** — a single request may now take up to ~37 seconds in the worst case (30 s timeout + 1 s + 2 s + 4 s backoff) before surfacing a hard failure, compared to the previous behavior of blocking indefinitely or crashing immediately.
- **No external dependency changes** — uses only Node.js built-in `http` and `https` modules; no new packages required.
- **No configuration changes** — timeout, retry count, and backoff are hard-coded constants; no new environment variables are introduced.
