# Spec: Browser Smoke Testing (Phase 3)

## Vite Preview Server Management

### ADDED: startVitePreview()

**WHEN** Phase 3 begins AND change type is COMPONENT or API_INTEGRATION
**THEN** the agent:
1. Scans ports 4300-4399 for first available (TCP connect test)
2. Spawns `npx vite preview --port {port}` with `cwd: .repo-cache/{project}/`
3. Polls `http://localhost:{port}` every 1s until HTTP 200 (max `VITE_PREVIEW_TIMEOUT`, default 30s)
4. Stores PID in `state.data._vite_preview_pid` and port in `state.data._vite_preview_port`
5. Saves state (for orphan cleanup on crash)

**WHEN** `dist/apps/enterprise/` does not exist (Phase 1 build failed or was skipped)
**THEN** skip Phase 3 with log: "No build output — skipping browser tests"

**WHEN** no free port found in 4300-4399
**THEN** skip Phase 3 with log: "No free port — skipping browser tests"
**THEN** `state.data._e2e_tests_complete = "INCONCLUSIVE"`

**WHEN** vite preview doesn't respond within timeout
**THEN** kill process, skip Phase 3, log warning

**WHEN** Phase 3 completes (pass or fail) OR agent crashes
**THEN** kill vite preview process by PID, kill any chromium processes spawned by Playwright
**THEN** clear `state.data._vite_preview_pid`

### ADDED: Orphan cleanup on re-entry

**WHEN** `stageGenerateCode()` starts AND `state.data._vite_preview_pid` exists
**THEN** check if process is alive (`kill(pid, 0)`)
**THEN** if alive: kill it (stale from previous crash)
**THEN** clear `state.data._vite_preview_pid`

## Playwright Route Interception

### ADDED: setupPlaywrightMocks(page)

**WHEN** Playwright browser context is created
**THEN** set up route interception for ALL mandatory init APIs:

```
/iv-generation/*   → { iv: "0123456789abcdef" }
/sync-data/*       → { status: 200, data: {} }  (empty = skip Firebase init)
/auth-user/*       → { user: { name: "Test User", email: "test@test.com",
                        roles: ["admin"], businessType: "enterprise" } }
/user/permissions/* → { permissions: [{module: "*", access: "full"}] }
```

**WHEN** route interception is set up
**THEN** also intercept:
- `**/*.clarity.ms/**` → abort (block Microsoft Clarity)
- `**/*.atlassian.net/**` → abort (block Jira widget)
- `**/api/**` catch-all → `{ data: [], total: 0, status: 200 }` (generic success)
- WebSocket connections → close immediately (no chat server)

**WHEN** any intercepted route handler throws
**THEN** log warning, return generic 200 response (never let mock failure crash tests)

### ADDED: localStorage setup

**WHEN** Playwright browser context is created (before page.goto)
**THEN** inject into localStorage:
- `AUTH_TOKEN`: valid-format JWT (header.payload.signature, payload contains exp in future)
- `REFRESH_TOKEN`: "mock-refresh-token"
- `orgId`: "test-org-1"
- `activeGstin`: "29ABCDE1234F1ZK"
- `userMode`: "enterprise"
- `selectedLocale`: "en"
- `themeMode`: "light"

## Playwright Test Generation

### ADDED: Playwright Test Agent prompt and execution

**WHEN** Phase 3 begins
**THEN** spawn Claude agent with role "E2E Test Engineer"

**WHEN** constructing the E2E Test Engineer prompt
**THEN** include:
- Acceptance criteria from Jira ticket
- Route-to-module mapping (from AppRoutes.tsx analysis)
- Module permissions required for the route
- Expected UI elements per AC (table, form, button, etc.)
- The setupPlaywrightMocks template
- Instruction: "Generate Playwright tests that verify the UI renders correctly after navigation"

**WHEN** E2E Test Engineer generates test files
**THEN** write them to `.test-artifacts/{TICKET}/e2e/` (NOT in source tree)

### ADDED: Playwright test execution

**WHEN** test files are generated and vite preview is ready
**THEN** run:
```
npx playwright test .test-artifacts/{TICKET}/e2e/
  --timeout=30000
  --reporter=json
  --output=.test-artifacts/{TICKET}/playwright-results/
```
- Total timeout: `E2E_TESTS_TIMEOUT` (default 5 min)
- Browser: `PLAYWRIGHT_BROWSER` (default chromium, headless)

## Console Error Capture

### ADDED: captureConsoleErrors(page)

**WHEN** Playwright page is created
**THEN** attach listeners:
- `page.on("console", msg)` — if type is "error" or "warning": store `{ type, text, url, timestamp }`
- `page.on("pageerror", err)` — store `{ message, stack, timestamp }`
- `page.on("requestfailed", req)` — store `{ url, method, failure, timestamp }`

**WHEN** tests complete
**THEN** classify captured items:
- Page errors (uncaught exceptions) → HIGH severity
- Console errors → MEDIUM severity
- React warnings ("Each child should have a key") → LOW severity
- Network failures to mocked endpoints → IGNORE (expected)
- Network failures to real endpoints → MEDIUM severity

**WHEN** HIGH severity errors exist
**THEN** `state.data._e2e_tests_complete = "INCONCLUSIVE"` (even if assertions passed)

**WHEN** total console warnings exceed `CONSOLE_WARNING_THRESHOLD` (default 5)
**THEN** `state.data._e2e_tests_complete = "INCONCLUSIVE"`

**WHEN** only LOW severity warnings exist AND count <= threshold
**THEN** status determined by assertion results only

## Navigation Guard

### ADDED: detectHardRedirects(page)

**WHEN** page navigates away from the expected route via `window.location.href` change
**THEN** detect this as a hard redirect (auth failure or ErrorBoundary reload)

**WHEN** hard redirect to /signin or /login detected
**THEN** fail test with: "Auth redirect detected — route interception may have failed for auth-user API"

**WHEN** same-page reload detected (ErrorBoundary → window.location.reload())
**THEN** fail test with: "Page reload loop detected — component threw an error caught by ErrorBoundary"

**WHEN** navigation to unexpected route detected
**THEN** log warning, continue test (might be intentional redirect)

## Retry Logic

### ADDED: E2E flaky test retry

**WHEN** Playwright tests fail AND retry count < `MAX_E2E_TEST_RETRIES` (default 3)
**THEN** re-run Playwright with same configuration

**WHEN** a test fails on run N but passes on run N+1
**THEN** mark as flaky

**WHEN** all retries exhausted
**THEN** `state.data._e2e_tests_complete = "INCONCLUSIVE"` (report, don't block)

## Result Storage

### ADDED: E2E test results in filesystem

**WHEN** Phase 3 completes
**THEN** store in `.test-artifacts/{TICKET}/`:
- `playwright-results.json` — full Playwright JSON output
- `screenshots/` — PNG screenshots from each test
- `console-errors.json` — all captured console/page/network errors

**WHEN** storing results in state
**THEN** store summary only:
- `_e2e_tests_complete`: "PASS" | "FAIL" | "INCONCLUSIVE"
- `_e2e_tests_count`: `{ total, passed, failed, flaky }`
- `_e2e_console_errors`: first 10 error entries (truncated to prevent state bloat)
