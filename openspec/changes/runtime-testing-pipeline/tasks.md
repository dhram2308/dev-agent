# Tasks: Runtime Testing Pipeline

## 1. Core Infrastructure

- [x] 1.1 Add new env var constants to `run-agent.js`: `RUN_RUNTIME_TESTS`, `UNIT_TESTS_TIMEOUT`, `E2E_TESTS_TIMEOUT`, `VITE_PREVIEW_TIMEOUT`, `VITE_BUILD_TIMEOUT`, `MAX_UNIT_TEST_RETRIES`, `MAX_E2E_TEST_RETRIES`, `CONSOLE_WARNING_THRESHOLD`, `TEST_ARTIFACTS_DIR`, `PLAYWRIGHT_BROWSER`
- [x] 1.2 Add new state checkpoint fields: `_env_bootstrapped`, `_unit_tests_complete`, `_unit_tests_count`, `_e2e_tests_complete`, `_e2e_tests_count`, `_e2e_console_errors`, `_test_artifacts_path`, `_vite_preview_pid`, `_vite_preview_port`
- [x] 1.3 Add `cleanupTestProcesses()` function — kill stale vite preview/chromium by PID from state
- [x] 1.4 Register `cleanupTestProcesses()` in global signal handlers (SIGTERM, SIGINT, uncaughtException)
- [x] 1.5 Add stale process detection on `stageGenerateCode()` entry — kill orphan vite/chromium from previous crash

## 2. Phase 0: Environment Bootstrap

- [x] 2.1 Implement `bootstrapTestEnvironment()` function with full bootstrap sequence
- [x] 2.2 Implement npm install guard (--legacy-peer-deps, --ignore-scripts, timeout 3 min)
- [x] 2.3 Implement jest-environment-jsdom + jest-canvas-mock install check and install
- [x] 2.4 Implement Playwright install check (`npx playwright install chromium`)
- [x] 2.5 Implement `jest.config.override.ts` generator — read tsconfig.base.json, build moduleNameMapper for 150+ aliases + @mi/core + SVG/CSS/image mocks, set testEnvironment: jsdom
- [x] 2.6 Implement `setupTests.runtime.ts` generator — matchMedia, IntersectionObserver, ResizeObserver, crypto, canvas, mapbox-gl/pdfjs-dist/html2canvas module mocks, import.meta.env stub
- [x] 2.7 Implement `test-providers.tsx` generator — MemoryRouter, mock AuthContext, AppContext, ThemeProvider, InfoViewActionsContext, BusinessContext, IntlProvider
- [x] 2.8 Implement `@mi/core` shim generator — renderWithWrapper, defineMatchMedia, re-exports from @testing-library/react
- [x] 2.9 Implement `.env.local` writer for VITE_* mock values
- [x] 2.10 Implement validation step — run 1 existing test file to confirm setup works
- [x] 2.11 Implement graceful degradation — if bootstrap fails, set `_env_bootstrap_failed`, skip Phases 2-3

## 3. Phase 1: Enhanced Build Verification

- [x] 3.1 Add Vite build step to existing Q5 build check: `nx build enterprise` with affected detection
- [x] 3.2 Handle first-run full build (no dist/ exists) vs subsequent affected build
- [x] 3.3 Add `VITE_BUILD_TIMEOUT` enforcement and NODE_OPTIONS=--max_old_space_size=8192
- [x] 3.4 Implement change classifier: analyze changed file paths → STYLE / UTILITY / COMPONENT / API_INTEGRATION
- [x] 3.5 Wire classifier result to Phase 2/3 skip logic

## 4. Phase 2: Unit Tests

- [x] 4.1 Implement QA Test Engineer Agent prompt construction — AC, component public API (NOT implementation), existing test examples, tsconfig aliases, test-providers template, anti-tautology rules
- [x] 4.2 Implement component public API extractor — regex to extract exported function signatures, prop types, hook return types from changed files (without full implementation code)
- [x] 4.3 Implement existing test file finder — find 3-5 *.spec.tsx files nearest to changed files as pattern examples
- [x] 4.4 Implement `callClaude()` invocation for QA Test Engineer with appropriate tools (Write, Read, Glob) and timeout
- [x] 4.5 Implement Jest execution: `npx jest --config override --json --outputFile --forceExit --testTimeout=10000`
- [x] 4.6 Implement Jest JSON output parser — extract total/passed/failed, per-test failure messages
- [x] 4.7 Implement flaky test detection — re-run failed tests, mark as flaky if they pass on retry
- [x] 4.8 Implement Test Fixer Agent for compile errors (wrong imports/types) — single pass fix
- [x] 4.9 Implement logic error feedback to Developer Agent — feed assertion failures for ONE code fix retry
- [x] 4.10 Implement INCONCLUSIVE status assignment and state storage
- [x] 4.11 Implement test count validation — warn if fewer tests than acceptance criteria count

## 5. Phase 3: Browser Smoke Tests

- [x] 5.1 Implement `findFreePort(startPort, endPort)` — scan TCP ports 4300-4399
- [x] 5.2 Implement `startVitePreview(port)` — spawn background process, health check polling, PID tracking
- [x] 5.3 Implement Playwright Test Agent prompt construction — AC, route-to-module mapping, mock setup template, expected UI elements
- [x] 5.4 Implement `setupPlaywrightMocks(page)` template — route interception for iv-generation, sync-data, auth-user, permissions, third-party blocking, catch-all API mock
- [x] 5.5 Implement localStorage injection template — AUTH_TOKEN (JWT format), REFRESH_TOKEN, orgId, activeGstin, theme, locale
- [x] 5.6 Implement `captureConsoleErrors(page)` — page.on("console"), page.on("pageerror"), page.on("requestfailed")
- [x] 5.7 Implement `detectHardRedirects(page)` — detect auth redirects and ErrorBoundary reload loops
- [x] 5.8 Implement Playwright test execution: `npx playwright test --timeout=30000 --reporter=json`
- [x] 5.9 Implement screenshot capture per test
- [x] 5.10 Implement console error severity classification (HIGH/MEDIUM/LOW/IGNORE)
- [x] 5.11 Implement E2E retry logic (up to 3 retries, flaky detection)
- [x] 5.12 Implement vite preview cleanup — kill process on completion, timeout, or error
- [x] 5.13 Implement result storage — playwright-results.json, screenshots/, console-errors.json to `.test-artifacts/`

## 6. Cleanup & Revert

- [x] 6.1 Implement `revertTestFiles()` — git checkout generated specs, remove jest.config.override, setupTests.runtime, test-providers, @mi/core shim, .env.local
- [x] 6.2 Wire `revertTestFiles()` into finally block of runtime test orchestrator
- [x] 6.3 Implement `.test-artifacts/{TICKET}/` cleanup on re-run (delete + recreate)
- [x] 6.4 Ensure `localGetChanges()` does NOT include test infrastructure files (already reverted, but validate)

## 7. Phase 4: Enhanced AC Verification

- [x] 7.1 Modify Q6 AC Verification Agent prompt to include test evidence (unit test results, e2e results, console errors, screenshots described)
- [x] 7.2 Add logic: if test FAILED for specific AC, weight AC verdict toward PARTIAL/FAIL
- [x] 7.3 Add logic: if test PASSED for specific AC, note higher confidence in verdict

## 8. MR Quality Report

- [x] 8.1 Enhance `pushCodeToGitLab()` MR description with "Runtime Test Results" section
- [x] 8.2 Include unit test counts (passed/total, flaky note)
- [x] 8.3 Include browser smoke status and console warning count
- [x] 8.4 Include INCONCLUSIVE notes with "Manual testing recommended" guidance
- [x] 8.5 Include first 5 console errors in MR description (if any)

## 9. Web UI Dashboard

- [x] 9.1 Add test result badges to server.js dashboard (PASS=green, INCONCLUSIVE=yellow, FAIL=red)
- [x] 9.2 Add unit test count display: "{passed}/{total} passed, {flaky} flaky"
- [x] 9.3 Add E2E test status with console error count
- [x] 9.4 Add `/api/test-artifacts?ticket=X` endpoint — list files in `.test-artifacts/{TICKET}/`
- [x] 9.5 Add test artifacts link in dashboard

## 10. Orchestration & Integration

- [x] 10.1 Implement `runRuntimeTests()` orchestrator — sequences Phase 0 → 1 → 2 → 3 → cleanup → 4
- [x] 10.2 Wire `runRuntimeTests()` into `stageGenerateCode()` after Fixer, before pushCodeToGitLab
- [x] 10.3 Implement `RUN_RUNTIME_TESTS` master switch (skip all if false)
- [x] 10.4 Implement checkpoint-based resume — skip completed phases on agent restart
- [x] 10.5 Implement overall pipeline timeout check before each phase
- [x] 10.6 Implement change classifier skip logic (STYLE → skip 2+3, UTILITY → skip 3)

## 11. Audit Gap Fixes (Post-Implementation Hardening)

- [x] 11.A1 Add `_vite_build_done`, `_playwright_install_failed`, `_dev_failed`, `_fixer_failed`, `_codegen_rejections`, `_codegen_mode`, `_claude_pid` to STAGE_CLEARS in constants.js
- [x] 11.A2 Save `_verify_evidence` (overallHealth) and `_verify_console_summary` to state in browser-verify.js after evidence collection
- [x] 11.A3 Improve `buildBrowserVerifyMRSection()` to render overallHealth data (routes loaded, auth failures, high severity errors, network status)
- [x] 11.A4 Fix execution order: move AC Verification AFTER runtime tests + browser verify in index.js (was running before, so evidence always empty)
- [x] 11.A5 Remove redundant second AC verification block (dead code, `_ac_verified` already true)
- [x] 11.A6 Call `cleanupOrphanDevServer(state)` at start of `stageGenerateCode()` to kill orphan processes from previous crash
- [x] 11.A7 Add `reset()` methods to `setupNetworkCapture()` and `setupConsoleCapture()` in evidence-collector.js to prevent cross-route contamination
- [x] 11.A8 Reset network/console captures per-route in browser-verify.js verification loop
- [x] 11.A9 Invalidate stale route cache (`_routes_detected = null`) after fix agent runs, re-detect on retry
- [x] 11.A10 Add safe URL parsing in browser-verify.js auth redirect check (try/catch around `new URL()`)
- [x] 11.A11 Fix tsconfig JSON.parse crash in `_generateJestConfig()` — strip comments before parsing
- [x] 11.A12 Add reviewer skip guard — skip `runReviewerAndSecurity()` if `_reviewed && _fixed` on re-entry
- [x] 11.A13 (Previous session) Fix silent catch blocks in route-detector.js — log warnings instead
- [x] 11.A14 (Previous session) Add depth limit to `walkForRouteFiles()` in route-detector.js (max 10)
- [x] 11.A15 (Previous session) Cap network capture at 500, console capture at 200 entries in evidence-collector.js
- [x] 11.A16 (Previous session) Add credential null check in `loginToApp()` in login-helper.js
- [x] 11.A17 (Previous session) Add safe URL parsing in `handlePostLoginScreens()` (3 sites) in login-helper.js
- [x] 11.A18 (Previous session) Fix Phase 1 guard from `_build_checked` to `_env_bootstrapped` in runtime-tests.js
- [x] 11.A19 (Previous session) Fix git cleanup: `git clean -f` for untracked test files in runtime-tests.js
- [x] 11.A20 (Previous session) Replace shell `find` with fs.readdirSync walker in `findNearestTests()` (shell injection fix)
- [x] 11.A21 (Previous session) Replace shell `find` in `_validateTestSetup()` with safe walker
- [x] 11.A22 (Previous session) Wrap mkdirSync for artifacts dir in try/catch in runtime-tests.js
- [x] 11.A23 (Previous session) Wrap writeEnvFile in try/catch with error context in env-setup.js
- [x] 11.A24 (Previous session) Wrap readFileSync for package-lock hash in try/catch in env-setup.js
- [x] 11.A25 Register shutdown hooks for dev server and vite preview in index.js (onShutdown)
- [x] 11.A26 Widen cleanup glob from `*.spec.tsx` to `**/*.spec.tsx **/*.test.tsx` (recursive) in runtime-tests.js
- [x] 11.A27 Add `-d` flag to `git clean` for test file cleanup (removes empty directories too)
- [x] 11.A28 Add SIGKILL fallback (5s after SIGTERM) in `execWithProgress()` timeout handler
- [x] 11.A29 Re-fetch final fileChanges from `localGetChanges()` before building MR changes object in index.js
- [x] 11.A30 Backfill originalFiles for any files added by runtime tests or AC fixer
- [x] 11.A31 Make vite preview port range configurable: add `VITE_PREVIEW_PORT_START`/`VITE_PREVIEW_PORT_END` to config-schema.js, config.js, runtime-tests.js
- [x] 11.A32 Register Playwright browser shutdown hook via `onShutdown("codegen-playwright")` — track browser at module level in browser-verify.js
- [x] 11.A33 Fix early exit checkpoint: only fast-path to push if ALL stages done (dev+review+fix+tests+verify+AC), not just dev/review/fix

## 12. Verification

- [ ] 12.1 Test Phase 0 bootstrap on fresh .repo-cache (no node_modules) — verify all files generated, validation test runs
- [ ] 12.2 Test Phase 0 cached re-entry — verify bootstrap is skipped when `_env_bootstrapped` is true
- [ ] 12.3 Test Phase 0 graceful degradation — simulate npm install failure → Phases 2-3 skipped
- [ ] 12.4 Test Phase 1 Vite build — verify dist/ created, build errors passed to Fixer
- [ ] 12.5 Test change classifier — CSS-only change → STYLE → Phases 2-3 skipped
- [ ] 12.6 Test Phase 2 unit test generation — verify adversarial prompt (no implementation code in input)
- [ ] 12.7 Test Phase 2 flaky detection — mock test that fails then passes → marked flaky, not failure
- [ ] 12.8 Test Phase 2 compile error → Test Fixer → re-run flow
- [ ] 12.9 Test Phase 2 logic error → Developer retry → re-run flow
- [ ] 12.10 Test Phase 3 port finder — block port 4300 → finds 4301
- [ ] 12.11 Test Phase 3 vite preview lifecycle — starts, health check passes, killed after tests
- [ ] 12.12 Test Phase 3 route interception — all init APIs mocked, app renders past AppLoader
- [ ] 12.13 Test Phase 3 console error capture — React warning injected → captured in results
- [ ] 12.14 Test Phase 3 hard redirect detection — auth redirect → test fails with clear message
- [ ] 12.15 Test Phase 3 orphan cleanup — kill agent mid-test → restart → stale vite killed
- [ ] 12.16 Test cleanup — verify all generated test files reverted, only production code in git status
- [ ] 12.17 Test MR description — verify "Runtime Test Results" section with all fields
- [ ] 12.18 Test Web UI — verify test result badges, counts, artifacts link
- [ ] 12.19 Test checkpoint resume — crash after Phase 2 → restart → Phase 2 skipped, Phase 3 runs
- [ ] 12.\10 Full end-to-end — run agent on real ticket with RUN_RUNTIME_TESTS=true
