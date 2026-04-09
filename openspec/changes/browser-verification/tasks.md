# Tasks: Browser-Based Verification

## 1. Configuration & Constants

- [x] 1.1 Add new config constants to `lib/config.js`: `BROWSER_VERIFY`, `MAX_VERIFY_RETRIES`, `VERIFY_LOGIN_EMAIL`, `VERIFY_LOGIN_PASS`, `NX_SERVE_TIMEOUT`, `NX_SERVE_PORT_RANGE_START`, `NX_SERVE_PORT_RANGE_END`, `VERIFICATION_TIMEOUT`, `EVIDENCE_MAX_SIZE`, `QA_HEALTH_TIMEOUT`
- [x] 1.2 Export new constants from `lib/config.js` module.exports
- [x] 1.3 Add new STAGE_CLEARS entries to `lib/constants.js` for generate_code: `_env_setup_complete`, `_npm_install_hash`, `_nx_serve_pid`, `_nx_serve_port`, `_dev_server_ready`, `_routes_detected`, `_login_complete`, `_verify_attempt`, `_verify_known_gaps`, `_browser_verified`, `_verify_evidence`, `_verify_api_summary`, `_verify_console_summary`, `_browser_verify_available`
- [x] 1.4 Update `server/html.js` SUBSTAGES for generate_code: add `_routes_detected` ("Routes"), `_login_complete` ("Login"), `_browser_verified` ("Browser Verify") pills

## 2. Phase 0: Environment Setup (`stages/generate-code/env-setup.js`)

- [x] 2.1 Create `env-setup.js` with `ensureEnvironment(state, clonePath)` entry function
- [x] 2.2 Implement `writeEnvFile(clonePath)` — write 12 VITE_* vars to `apps/enterprise/.env`, verify existing file, allow env var overrides
- [x] 2.3 Implement `verifyNodeModules(clonePath)` — check `.bin/nx` exists, run `npm install --legacy-peer-deps` if broken, hash package-lock.json for cache invalidation
- [x] 2.4 Implement `ensurePlaywright()` — check chromium installed, install if missing, handle timeout/failure
- [x] 2.5 Implement Phase 0 checkpoint: `_env_setup_complete = true`, skip on re-entry if dev server still alive

## 3. Dev Server Lifecycle (`stages/generate-code/dev-server.js`)

- [x] 3.1 Create `dev-server.js` with `startDevServer(clonePath, state)` and `stopDevServer(state)` functions
- [x] 3.2 Implement `findFreePort(start, end)` — TCP connect test on port range 4200-4299
- [x] 3.3 Implement nx serve spawn — `npx nx serve enterprise --port {port}` with NODE_OPTIONS, PID/port stored in state
- [x] 3.4 Implement health check polling — HTTPS GET every 2s, ignore SSL errors, max NX_SERVE_TIMEOUT (120s)
- [x] 3.5 Implement dev server reuse — check existing PID alive, health check, reuse if healthy
- [x] 3.6 Implement cleanup in signal handlers (SIGTERM, SIGINT) — kill nx serve by PID
- [x] 3.7 Implement orphan detection on re-entry — if `_nx_serve_pid` exists, check alive, kill if stale

## 4. Login Helper (`stages/generate-code/login-helper.js`)

- [x] 4.1 Create `login-helper.js` with `loginToApp(page, port, credentials)` entry function
- [x] 4.2 Implement login form automation — navigate to /login?recaptcha_disabled=true, fill username, click Continue, fill password, click Sign In
- [x] 4.3 Implement post-login screen handler — 7 screens: reset-password (SKIP), otp-verify (SKIP), business-info (SKIP), select-mode (click Enterprise), buyer-wizard (SKIP), enable-2fa (click Skip for Now), dashboard (SUCCESS)
- [x] 4.4 Implement login failure detection — timeout, error messages, CAPTCHA not bypassed
- [x] 4.5 Implement QA backend health check — HTTP GET to iv-generation endpoint, ENV_DOWN error classification

## 5. Route Detection (`stages/generate-code/route-detector.js`)

- [x] 5.1 Create `route-detector.js` with `detectRoutes(changedFiles, clonePath, acceptanceCriteria)` entry function
- [x] 5.2 Implement Tier 1: Direct file path → route mapping with known module-to-route table
- [x] 5.3 Implement Tier 2: Import chain analysis — grep route files for component name, trace lazy imports
- [x] 5.4 Implement Tier 3: AC text extraction — parse "Navigate to X > Y", explicit URLs, module name mentions
- [x] 5.5 Implement Tier 4: Module name grep — case-insensitive search in route files
- [x] 5.6 Implement Tier 5: Fallback to /dashboard
- [x] 5.7 Implement route validation — discard auth routes, deduplicate, max 5 routes, sort by confidence

## 6. Evidence Collection (`stages/generate-code/evidence-collector.js`)

- [x] 6.1 Create `evidence-collector.js` with `collectEvidence(page, route, acceptanceCriteria)` entry function
- [x] 6.2 Implement `captureAccessibilityTree(page)` — snapshot, truncate to EVIDENCE_MAX_SIZE, prune generic nodes
- [x] 6.3 Implement `captureVisibleText(page)` — textContent('body'), truncate 5KB, normalize whitespace
- [x] 6.4 Implement `runDOMChecks(page, acceptanceCriteria)` — parse AC for expected elements, check existence, capture text
- [x] 6.5 Implement `captureNetworkActivity(page)` — request/response/failure listeners, build summary, detect auth failures
- [x] 6.6 Implement `captureConsoleErrors(page)` — console/pageerror listeners, severity classification (HIGH/MEDIUM/LOW/IGNORE), deduplication
- [x] 6.7 Implement `captureNavigationTimeline(page, expectedRoute)` — timestamps, redirect detection, auth redirect flagging
- [x] 6.8 Implement `captureScreenshot(page, route, ticket)` — full-page PNG to .test-artifacts/ (disk only, not for Claude)
- [x] 6.9 Implement `aggregateEvidence(routeResults)` — combine per-route evidence, overall health summary, truncation for prompt size

## 7. Browser Verification Orchestrator (`stages/generate-code/browser-verify.js`)

- [x] 7.1 Create `browser-verify.js` with `runBrowserVerification(state, ctx)` entry function
- [x] 7.2 Implement Playwright browser launch — chromium headless, ignore HTTPS errors, viewport 1280x720
- [x] 7.3 Implement verification loop — login → detect routes → navigate → collect evidence → gap analysis → fix (max 3 retries)
- [x] 7.4 Implement Gap Analysis Agent prompt construction — AC + evidence (text-only), per-AC verdict format
- [x] 7.5 Implement Gap Analysis Agent verdict parsing — PASS/PARTIAL/FAIL per AC, OVERALL: PASS/NEEDS_FIX/SKIP
- [x] 7.6 Implement Developer Fix Agent invocation — callClaude with gap details, wait 5s for HMR
- [x] 7.7 Implement re-login between retry attempts (session expiry handling)
- [x] 7.8 Implement hard redirect detection (401 → /login) during navigation
- [x] 7.9 Implement graceful degradation — catch all errors at top level, set _browser_verified="SKIP", never block pipeline
- [x] 7.10 Implement state checkpoints — _routes_detected, _login_complete, _verify_attempt, _browser_verified
- [x] 7.11 Implement Playwright cleanup — close browser on completion/error/timeout

## 8. Integration with `stages/generate-code/index.js`

- [x] 8.1 Import env-setup and browser-verify modules
- [x] 8.2 Add Phase 0 call before Part 1 (before line 128): `await ensureEnvironment(state, clonePath)`
- [x] 8.3 Add Part 2 call after Part 1 (after line 184 / after runtime tests): `await runBrowserVerification(state, ctx)`
- [x] 8.4 Add BROWSER_VERIFY master switch check — skip Phase 0 and Part 2 if false
- [x] 8.5 Ensure dev server cleanup in finally block / signal handlers
- [x] 8.6 Add browser verification results to MR description (in pushCodeToGitLab section)

## 9. MR Description Enhancement

- [x] 9.1 Add "Browser Verification" section to MR description template
- [x] 9.2 Include routes checked, per-route verdict, overall result
- [x] 9.3 Include console error summary (HIGH severity only)
- [x] 9.4 Include screenshot paths for human reviewers
- [x] 9.5 Include verification attempt count (e.g., "Passed on attempt 2 after 1 fix")
- [x] 9.6 Include "SKIP" reason if verification was skipped

## 10. Verification

- [ ] 10.1 Test Phase 0: fresh .repo-cache — .env written, node_modules installed, Playwright installed, dev server starts
- [ ] 10.2 Test Phase 0: cached re-entry — .env exists, node_modules healthy, dev server reused
- [ ] 10.3 Test Phase 0: broken node_modules — .bin/nx missing → clean install → healthy
- [ ] 10.4 Test Phase 0: dev server crash → restart on re-entry
- [ ] 10.5 Test login: successful 2-step login → reach dashboard
- [ ] 10.6 Test login: enable-2fa screen → "Skip for Now" clicked → reach dashboard
- [ ] 10.7 Test login: backend down → health check fails → Part 2 skipped
- [ ] 10.8 Test route detection: changed file in libs/entp/src/lib/gst-return/ → detects /gst-return route
- [ ] 10.9 Test route detection: no match → fallback to /dashboard
- [ ] 10.10 Test evidence collection: accessibility tree captured, truncated within size limit
- [ ] 10.11 Test evidence collection: console errors classified by severity
- [ ] 10.12 Test evidence collection: network auth failure flagged
- [ ] 10.13 Test verification loop: PASS on first attempt → proceed to Part 3
- [ ] 10.14 Test verification loop: NEEDS_FIX → fix → re-login → PASS on attempt 2
- [ ] 10.15 Test verification loop: 3 failures → SKIP → proceed to Part 3 with gaps noted
- [ ] 10.16 Test graceful degradation: unexpected error in Part 2 → SKIP → pipeline continues
- [ ] 10.17 Test signal handler: SIGTERM → dev server killed → clean shutdown
- [ ] 10.18 Test MR description: includes browser verification section with all fields
- [ ] 10.19 Test Web UI: sub-stage pills show Routes → Login → Browser Verify progression
- [ ] 10.20 Full end-to-end: run agent on real ticket with BROWSER_VERIFY=true
