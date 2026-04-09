# HTTP Client Hardening — Delta Spec

**Change:** fix-econnreset-gitlab
**Scope:** `run-agent.js` — `req()` HTTP helper, `gl.getTree()`, keepAlive agents, `logWarn()` helper
**Target:** Internal GitLab at `http://10.200.11.32`

---

## ADDED Requirements

### Requirement: Socket-level timeout on every outbound request
The system SHALL enforce a 30-second socket timeout on every HTTP/HTTPS request issued by `req()`. If no data is received within 30 seconds the socket MUST be destroyed with error code `SOCKET_TIMEOUT`.

#### Scenario: Request stalls with no response bytes
- **WHEN** a request is sent and the remote server accepts the TCP connection but sends no data for 30 seconds
- **THEN** `req()` destroys the socket with a `SOCKET_TIMEOUT` error and the error is eligible for retry

#### Scenario: Normal response arrives within timeout window
- **WHEN** the server responds with data before the 30-second deadline
- **THEN** the timeout has no effect and the response is returned normally

---

### Requirement: Automatic retry with exponential backoff
The system SHALL retry failed requests up to 3 times using exponential backoff delays of 1 s, 2 s, and 4 s (calculated as `1000 * 2^(attempt-1)` ms).

#### Scenario: Transient network error triggers retry
- **WHEN** `req()` encounters a socket error whose code is one of `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, or `SOCKET_TIMEOUT`
- **THEN** the request is retried up to 3 times with delays of 1 s, 2 s, 4 s between attempts

#### Scenario: Retryable HTTP status triggers retry
- **WHEN** the server responds with HTTP status 502, 503, or 504 and the retry budget has not been exhausted
- **THEN** the request is retried with the same exponential backoff schedule

#### Scenario: Retry budget exhausted on network error
- **WHEN** all 3 retry attempts fail with a retryable socket error code
- **THEN** `req()` throws the underlying error to the caller

#### Scenario: Retry budget exhausted on HTTP status
- **WHEN** all 3 retry attempts return a retryable HTTP status
- **THEN** `req()` returns the last response object (status, data, headers) without throwing

#### Scenario: Non-retryable error is not retried
- **WHEN** a request fails with a non-retryable error code (e.g., `ENOTFOUND`, `ERR_INVALID_URL`)
- **THEN** the error is thrown immediately without any retry

#### Scenario: Non-retryable HTTP status is not retried
- **WHEN** the server responds with a non-retryable status (e.g., 400, 401, 404, 500)
- **THEN** the response is returned immediately without retry

---

### Requirement: keepAlive connection-reuse agents
The system SHALL create module-level `http.Agent` and `https.Agent` instances with `keepAlive: true` and reuse them for all requests through `req()`.

#### Scenario: Multiple sequential requests to GitLab
- **WHEN** `req()` is called multiple times against the same GitLab host
- **THEN** the underlying TCP connections are reused via the keepAlive agent instead of opening a new socket per request

---

### Requirement: Response includes headers alongside status and data
The system SHALL return an object with shape `{ status, data, headers }` from every successful `req()` call so that callers (e.g., `getTree()`) can inspect response headers such as pagination cursors.

#### Scenario: Caller reads a response header
- **WHEN** `req()` resolves successfully
- **THEN** the resolved object contains `status` (number), `data` (parsed JSON or raw string), and `headers` (the full `res.headers` object from Node's HTTP response)

---

### Requirement: logWarn helper for retry visibility
The system SHALL provide a `logWarn(msg)` function that prints a yellow warning indicator (`!`) followed by the message to stdout, used during retry attempts to surface transient failures to the operator.

#### Scenario: Retry attempt logs a warning
- **WHEN** `req()` enters a retry attempt due to a retryable error or status
- **THEN** a `logWarn` message is emitted containing the error code or HTTP status, the current attempt number, the backoff delay, and the request URL

---

## MODIFIED Requirements

### Requirement: `gl.getTree()` returns complete file listing via pagination
Previously `getTree()` issued a single request with `per_page=100` and returned only the first page. It now MUST paginate through all pages by following the `x-next-page` response header until every entry has been collected.

#### Scenario: Repository tree fits in one page
- **GIVEN** the GitLab tree endpoint returns 100 or fewer items and the `x-next-page` header is absent or empty
- **WHEN** `getTree()` is called
- **THEN** exactly one request is made and all items are returned

#### Scenario: Repository tree spans multiple pages
- **GIVEN** the GitLab tree endpoint returns 100 items on page 1 and the response header `x-next-page` is `2`
- **WHEN** `getTree()` is called
- **THEN** `getTree()` issues a second request with `&page=2`, concatenates the results, and continues until `x-next-page` is absent, empty, or not greater than the current page number

#### Scenario: Mid-pagination request fails and is retried
- **GIVEN** `getTree()` is fetching page 3 of the tree
- **WHEN** the request for page 3 encounters an `ECONNRESET` error
- **THEN** the underlying `req()` retry logic handles the transient failure transparently and `getTree()` receives the page 3 response after retry succeeds

#### Scenario: Page returns non-200 or empty array
- **GIVEN** `getTree()` is iterating pages
- **WHEN** a page request returns a non-200 status or an empty array
- **THEN** pagination stops and all items collected so far are returned

---

### Requirement: `req()` request options include keepAlive agent
Previously `req()` opened a fresh socket per call. It now MUST attach the appropriate keepAlive agent (`httpAgent` or `httpsAgent`) to every outbound request based on the URL protocol.

#### Scenario: HTTP request to GitLab uses httpAgent
- **GIVEN** the request URL starts with `http://`
- **WHEN** `req()` builds the Node `http.request` options
- **THEN** the `agent` field is set to the module-level `httpAgent` (keepAlive enabled)

#### Scenario: HTTPS request uses httpsAgent
- **GIVEN** the request URL starts with `https://`
- **WHEN** `req()` builds the Node `https.request` options
- **THEN** the `agent` field is set to the module-level `httpsAgent` (keepAlive enabled)
