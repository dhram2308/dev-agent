## Context

The MI Dev Agent (`run-agent.js`) orchestrates a CI/CD pipeline that calls an
internal GitLab instance at `http://10.200.11.32` for branch, MR, and tree
operations. The Node.js default HTTP behaviour creates a new TCP connection for
every request and offers no retry logic, so transient network errors --
especially `ECONNRESET` -- cause the entire pipeline run to abort.

`ECONNRESET` is the most frequent failure mode because the on-prem GitLab
server (or an intermediate proxy) occasionally tears down idle connections
before the client is aware. Other observed transient errors include
`ECONNREFUSED` during brief restarts, `ETIMEDOUT` under load, and sporadic
HTTP 502/503/504 from the GitLab Rails stack.

The `getTree()` helper also fetched only the first page of the GitLab
Repository Tree API, silently dropping files when a directory contained more
than `per_page` entries. This produced incomplete context for Claude's code
generation step.

## Goals / Non-Goals

**Goals:**
- Eliminate pipeline crashes caused by transient TCP and HTTP errors against the internal GitLab API
- Reuse TCP connections via keep-alive agents to reduce the chance of stale-socket resets
- Provide a robust `req()` function with configurable retries, exponential backoff, and a socket-level timeout
- Add a `logWarn()` helper so retry events are visible in the console without being mistaken for hard errors
- Fix `getTree()` to paginate correctly using the `x-next-page` response header so every file in the repo tree is returned

**Non-Goals:**
- Replacing Node.js built-in `http`/`https` with a third-party HTTP client (e.g. axios, got, undici)
- Adding retry logic to Jira or Slack API calls (they use external HTTPS endpoints that are already stable; can be done later if needed)
- Implementing circuit-breaker or rate-limiting patterns
- Changing the public interface of any existing function -- `req()` returns `{ status, data, headers }` which is a non-breaking addition consumed internally

## Decisions

1. **Keep-alive agents placed immediately after `require` statements.**
   `new http.Agent({ keepAlive: true })` and `new https.Agent({ keepAlive: true })`
   are created once at module scope and passed into every request via `req()`.
   Rationale: reusing TCP connections avoids the repeated TCP + TLS handshake
   cost and, more importantly, prevents the race condition where the server
   closes an idle connection just as the client sends a new request (the primary
   source of `ECONNRESET`).

2. **`logWarn()` as a yellow `!` log function.**
   Follows the same `log(icon, msg)` pattern used by `logOk`, `logErr`,
   `logWait`, and `logInfo`. Uses yellow colouring with an exclamation mark
   (`!`) to distinguish warnings (transient, auto-recovered) from errors
   (fatal). Rationale: retry attempts must be visible for post-mortem
   debugging but should not trigger false-alarm alerts.

3. **`req()` function with inner `once()` / outer `run()` architecture.**
   - `once()` executes a single HTTP request wrapped in a `Promise`. It sets a
     30-second socket timeout (`r.setTimeout(30_000)`) that calls `r.destroy()`
     with a synthetic `SOCKET_TIMEOUT` error code so it can be retried like any
     network error.
   - `run()` loops up to 3 retries (attempts 1-3 after the initial try) with
     exponential backoff delays of 1 s, 2 s, and 4 s.
   - Retryable error codes: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`,
     `SOCKET_TIMEOUT`.
   - Retryable HTTP statuses: `502`, `503`, `504`.
   - Returns `{ status, data, headers }` -- the `headers` field is new but all
     existing call-sites already destructure only `status` and `data`, so the
     addition is non-breaking.
   - Rationale: keeps the codebase dependency-free (no axios/got), addresses
     all observed transient failure modes, and the exponential backoff avoids
     hammering a recovering server.

4. **Paginated `getTree()` using `x-next-page` header.**
   Loops `&page=N` starting from 1, reads the `x-next-page` response header
   after each call, and stops when any of these conditions is met:
   - HTTP status is not `200`
   - Response body is empty or not an array
   - `x-next-page` header is absent, non-numeric, or not greater than the
     current page
   Rationale: GitLab's REST API paginates tree results (default 20, our
   `per_page=100`). Without full pagination the agent was missing files in
   large directories, leading to incomplete code-generation context.

## Risks / Trade-offs

[Risk] Keep-alive connections may go stale if the server's idle timeout is shorter than Node's. -> Mitigation: The 30-second socket timeout in `once()` will catch stale connections quickly, and the retry loop will transparently re-establish them. Node's default `keepAliveMsecs` (1 s) sends TCP keep-alive probes that detect dead sockets before the next real request in most cases.

[Risk] Three retries with exponential backoff add up to a worst-case 7-second delay per request (1+2+4 s waits). -> Mitigation: This only triggers on transient failures. In the normal path there is zero added latency. Seven seconds is negligible compared to the 30-second poll intervals and multi-minute CI pipelines the agent already waits on.

[Risk] The `SOCKET_TIMEOUT` synthetic error code is not a real Node.js error code. -> Mitigation: It is only used internally within `req()` and is added to the `RETRYABLE_CODES` set, so it never leaks outside the function. The pattern is explicit (`Object.assign(new Error(...), { code: "SOCKET_TIMEOUT" })`) and self-documenting.

[Risk] Paginated `getTree()` could loop excessively on a very large monorepo tree. -> Mitigation: GitLab caps `per_page` at 100 and the agent only calls `getTree()` once per run with `recursive=true`. Even a 10,000-file tree would require only 100 pages -- well within acceptable limits for a CI pipeline that already takes minutes.

[Risk] Non-retryable errors (e.g. HTTP 401 unauthorized, 404 not found) are not retried, which is correct, but a misconfigured token will still fail immediately with no special handling. -> Mitigation: This is intentional -- auth and config errors should fail fast. The existing `throw new Error(...)` call-sites already surface these clearly in the logs.
