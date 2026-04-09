# Spec: Browser Verification (Part 2)

## Login Automation

### ADDED: loginToApp(page, port, credentials)

**WHEN** Part 2 begins AND dev server is ready
**THEN** navigate to `https://localhost:{port}/login?recaptcha_disabled=true`

**WHEN** login page loads
**THEN**:
1. Wait for `input[name="username"]` to be visible (max 10s)
2. Fill with `VERIFY_LOGIN_EMAIL` (default: cfg.qa.main.user)
3. Click `button[type="submit"]` ("Continue" button)
4. Wait for `input[name="password"]` to be visible (max 10s)
5. Fill with `VERIFY_LOGIN_PASS` (default: cfg.qa.main.pass)
6. Click `button[type="submit"]` ("Sign In" button)

**WHEN** login succeeds AND URL changes from /login
**THEN** enter post-login screen handler

### ADDED: Post-login screen handler

**WHEN** URL is `/reset-password` after login
**THEN** set `_login_complete = false`, `_browser_verified = "SKIP"`
**THEN** log: `"Cannot proceed — account requires password reset"`

**WHEN** URL is `/otp-verify` after login
**THEN** set `_login_complete = false`, `_browser_verified = "SKIP"`
**THEN** log: `"Cannot proceed — account requires OTP verification (no automation possible)"`

**WHEN** URL is `/business-info` after login
**THEN** set `_login_complete = false`, `_browser_verified = "SKIP"`
**THEN** log: `"Cannot proceed — account requires business info onboarding"`

**WHEN** URL is `/select-mode` after login
**THEN** click the "Enterprise" mode option
**THEN** wait for navigation to next screen
**THEN** re-enter post-login screen handler

**WHEN** URL is `/buyer-wizard` after login
**THEN** set `_login_complete = false`, `_browser_verified = "SKIP"`
**THEN** log: `"Cannot proceed — account in buyer wizard onboarding"`

**WHEN** URL is `/enable-2fa` after login
**THEN** find and click the "Skip for Now" button (ghost type button in TwoFactorConfirm component)
**THEN** wait for navigation to /dashboard
**THEN** set `_login_complete = true`

**WHEN** URL is `/dashboard` after login
**THEN** set `_login_complete = true`
**THEN** log: `"Login complete — at dashboard"`

**WHEN** no URL change within 30s after clicking Sign In
**THEN** check for error messages on page (`page.textContent('.ant-form-item-explain-error')`)
**THEN** set `_login_complete = false`, `_browser_verified = "SKIP"`
**THEN** log error message

**WHEN** login page shows reCAPTCHA challenge despite `recaptcha_disabled=true`
**THEN** set `_login_complete = false`, `_browser_verified = "SKIP"`
**THEN** log: `"CAPTCHA not bypassed — recaptcha_disabled=true may not work on this environment"`

## QA Backend Health Check

### ADDED: checkQAHealth(qaUrl)

**WHEN** Part 2 begins (before login attempt)
**THEN** send HTTP GET to `{qaUrl}/api/v2.1/iv-generation/` with timeout QA_HEALTH_TIMEOUT (default 10s)

**WHEN** response status < 500
**THEN** backend is healthy (4xx = up but auth required = healthy)
**THEN** proceed with login

**WHEN** response contains ENV_DOWN error (ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND, EHOSTUNREACH)
**THEN** set `_browser_verified = "SKIP"`
**THEN** log: `"QA backend unreachable — skipping browser verification"`
**THEN** skip entire Part 2

**WHEN** response status >= 500
**THEN** log warning: `"QA backend returning 5xx — verification may fail"`
**THEN** proceed with login attempt anyway (might be a specific endpoint issue)

## Verification Loop

### ADDED: runVerificationLoop(page, routes, state, ctx)

**WHEN** login is complete AND routes are detected
**THEN** enter verification loop (max `MAX_VERIFY_RETRIES` attempts, default 3)

**WHEN** verification attempt begins
**THEN** set `state.data._verify_attempt = attemptNumber`
**THEN** save state

**WHEN** attempt > 1 (retry after fix)
**THEN**:
1. Run Developer Fix Agent with gap details from previous attempt
2. Wait 5s for HMR hot reload to apply
3. Re-login via Playwright (session may have expired)
4. If re-login fails: break loop, set `_browser_verified = "SKIP"`

**WHEN** navigating to each detected route
**THEN**:
1. `page.goto(route, { waitUntil: "networkidle", timeout: 30000 })`
2. Collect evidence (see evidence-collection spec)
3. Take screenshot to disk: `.test-artifacts/{TICKET}/screenshots/{route-slug}.png`

**WHEN** hard redirect to /login detected during navigation
**THEN** log: `"Auth session expired — 401 redirect detected"`
**THEN** re-login and retry current route

**WHEN** page error or crash detected during navigation
**THEN** capture error in evidence
**THEN** continue to next route (don't abort entire verification)

**WHEN** all routes visited and evidence collected
**THEN** run Gap Analysis Agent with all evidence

### ADDED: Gap Analysis Agent evaluation

**WHEN** evidence is collected for all routes
**THEN** construct Gap Analysis Agent prompt with:
- Acceptance criteria (numbered list)
- Evidence per route (accessibility tree, visible text, DOM checks, network summary, console errors)
- Current attempt number
- Known gaps from previous attempt (if retry)

**WHEN** Gap Analysis Agent returns verdict
**THEN** parse per-AC verdicts: PASS / PARTIAL / FAIL
**THEN** determine overall: PASS / NEEDS_FIX / SKIP

**WHEN** overall is PASS
**THEN** set `state.data._browser_verified = "PASS"`
**THEN** log: `"Browser verification PASSED on attempt {n}"`
**THEN** exit verification loop

**WHEN** overall is NEEDS_FIX AND attempts < MAX_VERIFY_RETRIES
**THEN** store gap details in `state.data._verify_known_gaps`
**THEN** continue to next iteration (Developer Fix Agent will run)

**WHEN** overall is NEEDS_FIX AND attempts >= MAX_VERIFY_RETRIES
**THEN** set `state.data._browser_verified = "SKIP"`
**THEN** log: `"Browser verification failed after {n} attempts — continuing with gaps noted in MR"`
**THEN** store gap summary for MR description

**WHEN** overall is SKIP (unable to verify — backend down, wrong route, etc.)
**THEN** set `state.data._browser_verified = "SKIP"`
**THEN** log reason

## Developer Fix Agent (Retry)

### ADDED: runBrowserFixAgent(ctx, gaps, attempt)

**WHEN** verification attempt fails with NEEDS_FIX
**THEN** construct Developer Fix Agent prompt with:
- Original acceptance criteria
- Specific gaps identified (per-AC FAIL/PARTIAL reasons)
- Evidence showing what's wrong (accessibility tree excerpt, console errors)
- Changed file list (for context)
- Instruction: "Fix ONLY the specific gaps. Do NOT rewrite files unnecessarily."

**WHEN** Developer Fix Agent runs
**THEN** use `callClaude()` with:
- `cwd: cfg.localRepo`
- `maxTurns: 15`
- `allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"]`
- `agentName: "Browser Fix Agent"`
- `timeout: DEVELOPER_TIMEOUT_MS`

**WHEN** Developer Fix Agent completes
**THEN** wait 5s for HMR to apply changes
**THEN** verify HMR didn't trigger full page reload (check dev server logs)
**THEN** proceed to re-verification

## Session Management

### ADDED: Session expiry handling

**WHEN** any Playwright navigation results in redirect to /login
**THEN** detect as session expiry (401 → hard redirect)
**THEN** re-execute full login sequence
**THEN** resume verification from current route

**WHEN** re-login after session expiry fails
**THEN** set `_browser_verified = "SKIP"`
**THEN** log: `"Session expired and re-login failed — aborting verification"`

## Graceful Degradation

### ADDED: Part 2 skip conditions

**WHEN** `BROWSER_VERIFY` env var is `"false"`
**THEN** skip Part 2 entirely, no state changes

**WHEN** `_dev_server_ready` is false (Phase 0 failed)
**THEN** skip Part 2, set `_browser_verified = "SKIP"`, log reason

**WHEN** `_login_complete` is false
**THEN** skip verification loop, set `_browser_verified = "SKIP"`, log reason

**WHEN** no routes detected (route-detector returns empty array)
**THEN** use fallback route `/dashboard`
**THEN** verify dashboard renders (catches global breaks)

**WHEN** Part 2 throws unexpected error
**THEN** catch at top level, set `_browser_verified = "SKIP"`
**THEN** log error with stack trace (first 500 chars)
**THEN** proceed to Part 3 (push + MR) — never block pipeline on verification failure
