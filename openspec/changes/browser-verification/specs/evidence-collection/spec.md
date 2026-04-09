# Spec: Evidence Collection

## Accessibility Tree Capture

### ADDED: captureAccessibilityTree(page)

**WHEN** page navigation completes (networkidle or timeout)
**THEN** call `page.accessibility.snapshot()` to get full accessibility tree

**WHEN** accessibility tree is captured
**THEN** serialize to JSON with roles, names, values, and children
**THEN** truncate to `EVIDENCE_MAX_SIZE` (default 10KB) — focus on `role: "main"` subtree
**THEN** store in evidence object as `accessibilityTree`

**WHEN** accessibility tree exceeds EVIDENCE_MAX_SIZE
**THEN** prune in order:
1. Remove `role: "generic"` nodes (keep only semantic roles)
2. Remove `role: "text"` nodes longer than 100 chars (truncate)
3. Flatten children deeper than 5 levels
4. If still over limit: keep only `role: "main"` subtree

**WHEN** page.accessibility.snapshot() throws or returns null
**THEN** fall back to `page.evaluate(() => document.body.innerHTML.substring(0, 5000))`
**THEN** log warning: `"Accessibility tree unavailable — using raw HTML"`

## Visible Text Capture

### ADDED: captureVisibleText(page)

**WHEN** page navigation completes
**THEN** call `page.textContent('body')` to get all visible text

**WHEN** visible text is captured
**THEN** truncate to 5KB
**THEN** normalize whitespace (collapse multiple spaces/newlines)
**THEN** store in evidence object as `visibleText`

**WHEN** page.textContent() returns empty or whitespace-only
**THEN** this indicates the page may not have rendered (blank screen)
**THEN** set DOM check `{ selector: "body", found: true, empty: true }` as signal

## Targeted DOM Checks

### ADDED: runDOMChecks(page, acceptanceCriteria)

**WHEN** evidence collection begins for a route
**THEN** parse acceptance criteria for expected UI elements:
- "table" / "list" / "grid" → check for `table`, `.ant-table`, `[role="grid"]`
- "form" / "input" → check for `form`, `.ant-form`, `input`
- "button" with label → check for `button:has-text('{label}')`, `.ant-btn:has-text('{label}')`
- "modal" / "dialog" → check for `.ant-modal`, `[role="dialog"]`
- "dropdown" / "select" → check for `.ant-select`, `select`
- "tab" / "tabs" → check for `.ant-tabs`, `[role="tablist"]`
- "chart" / "graph" → check for `canvas`, `.recharts-wrapper`, `svg`

**WHEN** each DOM check is performed
**THEN** use `page.locator(selector).count()` to check existence
**THEN** if found: capture `page.locator(selector).first().textContent()` (truncated 200 chars)
**THEN** store as `{ selector, found: boolean, text?: string, count?: number }`

**WHEN** a DOM selector times out (element not found within 5s)
**THEN** store as `{ selector, found: false }`
**THEN** this is NOT an error — element might legitimately not exist yet (lazy load, conditional render)

## Network Request Capture

### ADDED: captureNetworkActivity(page)

**WHEN** evidence collection begins (before navigation)
**THEN** attach listeners:
- `page.on("request", req)` — store `{ url, method, timestamp }`
- `page.on("response", res)` — store `{ url, status, timestamp }`
- `page.on("requestfailed", req)` — store `{ url, method, failure, timestamp }`

**WHEN** navigation completes and evidence is finalized
**THEN** build network summary:
```
{
  total: number,           // Total requests made
  succeeded: number,       // 2xx/3xx responses
  failed: number,          // 4xx/5xx responses + request failures
  failedUrls: string[],   // "METHOD /path → status" for failures (max 10)
  apiCallsMade: string[],  // "METHOD /path" for API calls (max 20)
}
```

**WHEN** response is 401 or 403
**THEN** flag as potential auth failure in summary
**THEN** include in evidence as `{ authFailure: true, url, status }`

**WHEN** request fails with network error (not HTTP error)
**THEN** classify:
- ECONNREFUSED → "Backend unreachable"
- ECONNRESET → "Connection reset"
- ERR_CERT_AUTHORITY_INVALID → "SSL cert error" (expected for localhost mkcert)
- ERR_CONNECTION_REFUSED → "Port not listening"

**WHEN** network summary shows >50% failed API calls
**THEN** flag: `networkHealthy: false` in evidence
**THEN** Gap Analysis Agent should weigh this when evaluating (backend issue, not code issue)

### Network capture size budget

**WHEN** storing network activity
**THEN** keep only:
- Request URL + method + status (always)
- Response headers for failed requests only
- Response body: NEVER stored (too large, may contain sensitive data)
- Total cap: 20 API entries + 10 failure entries

## Console Error Capture

### ADDED: captureConsoleErrors(page)

**WHEN** evidence collection begins (before navigation)
**THEN** attach listeners:
- `page.on("console", msg)` — if type is "error" or "warning": store `{ type, text: msg.text(), url: msg.location()?.url, timestamp }`
- `page.on("pageerror", err)` — store `{ type: "pageerror", message: err.message, stack: err.stack?.substring(0, 500), timestamp }`

**WHEN** evidence is finalized
**THEN** classify captured items by severity:

| Severity | Condition | Example |
|----------|-----------|---------|
| HIGH | `pageerror` (uncaught exception) | `TypeError: Cannot read property 'map' of undefined` |
| HIGH | Console error containing "Uncaught" or "unhandled" | `Unhandled promise rejection` |
| MEDIUM | Console error (not uncaught) | `Error: Network request failed` |
| LOW | React warning | `Warning: Each child in a list should have a unique key` |
| LOW | Deprecation warning | `Warning: componentWillMount has been renamed` |
| IGNORE | Network failure to third-party domains | `Failed to load: clarity.ms`, `atlassian.net` |
| IGNORE | WebSocket connection failure | `WebSocket connection to ... failed` |
| IGNORE | SSL certificate warnings | `NET::ERR_CERT_AUTHORITY_INVALID` |

**WHEN** storing console errors in evidence
**THEN** deduplicate by message text (keep first occurrence + count)
**THEN** max 20 entries (sorted by severity: HIGH first)
**THEN** store as `consoleErrors` array in evidence object

## Navigation Timeline

### ADDED: captureNavigationTimeline(page, expectedRoute)

**WHEN** page.goto() is called
**THEN** record start timestamp

**WHEN** page navigation events fire
**THEN** record:
- `domcontentloaded` timestamp
- `load` timestamp
- `networkidle` timestamp (if reached)
- Any URL changes (redirects)

**WHEN** navigation completes
**THEN** build timeline:
```
{
  started: "10:30:00.000",
  domReady: "10:30:01.200",
  loaded: "10:30:02.800",
  networkIdle: "10:30:03.500",
  redirects: [
    { from: "/gst-return/filing", to: "/login", reason: "auth" }
  ],
  finalUrl: "/gst-return/filing",
  totalMs: 3500
}
```

**WHEN** finalUrl !== expectedRoute AND finalUrl is /login
**THEN** flag as auth failure in timeline
**THEN** evidence includes `{ authRedirect: true }`

**WHEN** totalMs > 10000 (10s)
**THEN** flag as slow navigation in evidence
**THEN** Gap Analysis Agent should note but not fail (might be network latency)

## Screenshot Capture (Disk Only)

### ADDED: captureScreenshot(page, route, ticket)

**WHEN** page navigation completes and evidence is collected
**THEN** capture full-page screenshot: `page.screenshot({ fullPage: true, path: screenshotPath })`
**THEN** store at `.test-artifacts/{TICKET}/screenshots/{route-slug}.png`

**WHEN** screenshot is captured
**THEN** it is stored on disk for human reference ONLY
**THEN** it is NOT passed to Claude (callClaude() is text-only)
**THEN** screenshot path is included in MR description for human reviewers

**WHEN** screenshot capture fails
**THEN** log warning, continue (screenshot is supplementary, not critical)

## Evidence Aggregation

### ADDED: aggregateEvidence(routeResults)

**WHEN** all routes have been visited and individual evidence collected
**THEN** aggregate into single evidence object for Gap Analysis Agent:
```
{
  routes: [
    {
      route: "/gst-return/filing",
      accessibilityTree: { ... },      // Truncated to EVIDENCE_MAX_SIZE
      visibleText: "...",               // Truncated to 5KB
      domChecks: [ ... ],              // Per-AC element checks
      networkSummary: { ... },         // Request/response summary
      consoleErrors: [ ... ],          // Classified, deduplicated
      navigation: { ... },            // Timeline with redirect detection
      screenshotPath: "..."            // Disk path (for MR, not for Claude)
    }
  ],
  overallHealth: {
    allRoutesLoaded: boolean,
    authFailures: number,
    highSeverityErrors: number,
    networkHealthy: boolean
  }
}
```

**WHEN** total evidence exceeds MAX_PROMPT_TOKENS estimate
**THEN** truncate per route:
1. Reduce accessibilityTree to `role: "main"` children only
2. Reduce visibleText to 2KB
3. Keep only HIGH severity console errors
4. Keep network summary (already compact)

**WHEN** evidence is stored in state
**THEN** store summary only (not full evidence):
```javascript
state.data._verify_evidence = {
  routesChecked: number,
  routesPassed: number,
  highSeverityErrors: number,
  authFailures: number,
  networkHealthy: boolean,
};
state.data._verify_api_summary = { total, succeeded, failed };
state.data._verify_console_summary = [first 5 HIGH severity errors];
```
