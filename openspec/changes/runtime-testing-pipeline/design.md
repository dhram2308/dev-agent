# Design: Runtime Testing Pipeline

## Context

The MI Dev Agent pipeline currently validates generated code through static analysis (tsc, eslint) and AI review only. No code is actually executed before being pushed to GitLab and deployed to QA. This design adds 4 phases of runtime testing within `stageGenerateCode()` in `run-agent.js`.

### Target App Stack
- React 19.1 + TypeScript 5.9 + Vite 7.2 + Nx 22.0.4 monorepo
- Ant Design 6 + styled-components 6.1 + react-intl
- React Router v6 with lazy-loaded routes (35 route configs, 11 modules)
- Custom API hooks (`useGetDataApi`, `postDataApi`, etc.) using jwtAxios
- HMAC-SHA256 checksum validation on every API response (CryptoJS)
- 7-layer provider tree: AppProviders > AppContextProvider > AppLocaleProvider > AppThemeProvider > AppStyleProvider > AppBusinessContextProvider > AppAuthContextProvider
- 3 mandatory init APIs: iv-generation/, sync-data/ (RSA-encrypted Firebase config), auth-user/
- Hard auth redirects (window.location.href, not React Router) on 401/403
- Browser fingerprinting (broprint.js generates Deviceid header)
- 407 existing test files using Jest 29 + @testing-library/react 16.3

### Critical Discovery: Broken Test Infrastructure
- `@mi/core` imported in 365 test files but path alias points nowhere — ALL existing tests broken
- `jest.config.ts` has NO testEnvironment specified (defaults to Node, not jsdom)
- `setupTests.tsx` is EMPTY (all imports commented out)
- `jest-canvas-mock` referenced but NOT installed
- Browser-only libs (mapbox-gl, pdfjs-dist, html2canvas, recharts) break in jsdom
- `npm install` requires `--legacy-peer-deps` flag
- Builds require `NODE_OPTIONS=--max_old_space_size=8192`

## Goals

1. **Catch runtime errors before QA** — build failures, missing imports, component crashes
2. **Verify UI renders correctly** — route loads, key elements visible, no infinite spinners
3. **Prevent tautological testing** — tests written from requirements, not from code
4. **Minimize pipeline time** — adaptive depth based on change type, cached bootstrap
5. **Never block on uncertain results** — INCONCLUSIVE status for flaky/inconclusive tests

## Non-Goals

- Replace human QA testing
- Achieve full code coverage
- Test visual/pixel-level correctness
- Test API contract compliance (backend testing)
- Modify the target app's test infrastructure permanently

## Architecture

### Pipeline Position

```
stageGenerateCode() flow:
  Developer writes code          → _dev_complete
  Reviewer + Security audit      → _reviewed
  Fixer resolves issues          → _fixed
  ─────────────────────────────────────────────
  Phase 0: Environment Bootstrap → _env_bootstrapped (one-time)
  Phase 1: Build Verification    → _build_checked (enhanced)
  Phase 2: Unit Tests (Jest)     → _unit_tests_complete (NEW)
  Phase 3: Browser Smoke (PW)    → _e2e_tests_complete (NEW)
  ─────────────────────────────────────────────
  Phase 4: AC Verification       → _ac_verified (enhanced with evidence)
  Push to GitLab
```

### Phase 0: Environment Bootstrap

One-time setup cached via `state.data._env_bootstrapped = true`. Generates temporary config files in `.repo-cache/` that are reverted before commit.

**Creates**:
- `jest.config.override.ts` — testEnvironment: jsdom, moduleNameMapper for 150+ aliases + @mi/core shim + SVG/CSS/image mocks
- `setupTests.runtime.ts` — Mock matchMedia, IntersectionObserver, ResizeObserver, mapbox-gl, pdfjs-dist, html2canvas, import.meta.env
- `test-providers.tsx` — MemoryRouter wrapper (not BrowserRouter), mock AuthContext, AppContext, ThemeContext, InfoViewActionsContext, BusinessContext
- `@mi/core` shim — Exports `renderWithWrapper()` that delegates to test-providers.tsx

**Installs** (if missing): jest-environment-jsdom, jest-canvas-mock, @playwright/test + chromium browser

**Validates**: Runs 1 existing test file to confirm setup works.

### Phase 1: Enhanced Build Verification

Extends existing Q5 build check:
- `tsc --noEmit` (existing)
- `eslint` on changed files (existing)
- **NEW**: `nx affected:build --base=origin/enterprise-ts` (actual Vite build)
  - First run: full build (~5-8 min) since no dist/ exists
  - Subsequent: affected build only (~2-4 min)
  - Produces `dist/apps/enterprise/` needed for Phase 3

Build failures → Fixer Agent (existing pattern).

### Phase 2: Unit Tests (Jest)

**Agent**: QA Test Engineer Agent (adversarial — NEW agent type)

**Input** (what the agent sees):
- Acceptance criteria from Jira ticket
- Component public API (props, exported functions) — NOT implementation code
- 3-5 existing *.spec.tsx files as pattern examples
- tsconfig path aliases relevant to changed files
- test-providers.tsx from Phase 0
- Ant Design Form interaction patterns

**Input** (what the agent does NOT see):
- Implementation code of changed files (prevents tautological tests)
- Developer Agent's output
- Review feedback

**Output**: *.spec.tsx files written to `.repo-cache/` alongside source files

**Execution**:
```
npx jest --config jest.config.override.ts
         --testPathPattern='generated-test-pattern'
         --testTimeout=10000
         --forceExit
         --json
```

**Retry**: Up to 2 retries. If a test fails on run 1 but passes on run 2 → marked as flaky (excluded from failure count).

**Failure handling**:
- Compile error (wrong imports/types) → Test Fixer Agent (one pass)
- Logic error (assertion fails consistently) → Feed to Developer Agent for ONE code retry
- Still failing after retry → INCONCLUSIVE (report in MR, don't block)

### Phase 3: Browser Smoke Tests (Playwright)

**Process management**:
1. Find free port in 4300-4399 range
2. Spawn `vite preview --port {port}` as background process
3. Poll `http://localhost:{port}` until 200 response (max 30s)
4. Register PID in state for orphan cleanup
5. Run Playwright tests
6. Kill vite preview + chromium on completion (or crash)

**Playwright route interception** (bypasses HMAC, JWT, Firebase RSA):
```javascript
// Intercept ALL init APIs at network level — app never sees real HTTP
page.route('**/iv-generation/**', → mock IV response)
page.route('**/sync-data/**', → mock sync response)  // Bypasses RSA decryption
page.route('**/auth-user/**', → mock user profile)
page.route('**/user/permissions/**', → mock all-routes-enabled)
page.route('**/*.clarity.ms/**', → abort)  // Block 3rd party
page.route('**/api/**', → generic empty success)  // Catch-all
```

**localStorage setup** (before navigation):
```javascript
AUTH_TOKEN, REFRESH_TOKEN, orgId, activeGstin, theme, locale
```

**Console capture**:
- `page.on("console")` — capture error + warning
- `page.on("pageerror")` — capture unhandled exceptions
- `page.on("requestfailed")` — capture failed network requests

**Navigation guard**: Detect `window.location.href` redirects (hard auth redirects, ErrorBoundary reload loops) — fail test with clear message.

**Tests**:
1. Navigate to module route
2. Wait for lazy chunk load + render (`waitForSelector`)
3. Assert key UI elements exist (table, form, button per AC)
4. Capture screenshot

**Retry**: Up to 3 retries (Playwright is inherently more flaky than Jest).

### Phase 4: Enhanced AC Verification

Existing Q6 agent enhanced with test evidence in prompt:
- Unit test results: "8/10 passed, 1 flaky, 1 inconclusive"
- Browser smoke results: "Route renders, table visible, 2 React warnings"
- Screenshots from Playwright (described, not attached)
- Build output: "tsc clean, eslint clean, vite build success"

### Change Classifier

Determines test depth per change — avoids running full pipeline for CSS tweaks:

| Change Type | Criteria | Phases Run |
|-------------|----------|------------|
| STYLE | Only .css/.scss/.styled files changed | Phase 1 only |
| UTILITY | Only utils/helpers/services changed (no components) | Phase 1 + 2 |
| COMPONENT | React components changed | Phase 1 + 2 + 3 |
| API_INTEGRATION | API hooks/services + components changed | Phase 1 + 2 + 3 |

### Test Result Storage

**Filesystem** (not state file — avoids 10MB cap):
```
.test-artifacts/{TICKET}/
  jest-results.json
  playwright-results.json
  screenshots/
  console-errors.json
```

**State file** (summary only):
```javascript
_unit_tests_complete: "PASS" | "FAIL" | "INCONCLUSIVE"
_unit_tests_count: { total, passed, failed, flaky }
_e2e_tests_complete: "PASS" | "FAIL" | "INCONCLUSIVE"
_e2e_console_errors: [first 10 errors]
_test_artifacts_path: ".test-artifacts/{TICKET}/"
```

### MR Quality Report (enhanced)

```markdown
## Runtime Test Results
- Build: tsc clean, eslint clean, vite build success
- Unit Tests: 8/10 passed (1 flaky retried, 1 inconclusive)
- Browser Smoke: Route renders, table visible
- Console Warnings: 2 React key warnings (non-blocking)
- AC Verification: 4/5 PASS, 1 PARTIAL
```

### Rollback Decision Tree

```
Test failure
├── Phase 1 (Build): Fixer Agent → retry → HALT if still fails
├── Phase 2 (Unit):
│   ├── Compile error → Test Fixer → retry
│   ├── Logic error → Developer retry (ONE pass)
│   └── Still fails → INCONCLUSIVE (report, continue)
└── Phase 3 (Browser):
    ├── Server won't start → INCONCLUSIVE (infra issue)
    ├── Element not found → INCONCLUSIVE (report for human)
    └── Console errors only → INCONCLUSIVE (report, continue)
```

**Key principle**: Only Phase 1 (build) is a hard gate. Phases 2-3 are informational — they add evidence to the MR but never block it.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Playwright route interception over mock server | Eliminates HMAC/JWT/RSA complexity. We test UI rendering, not HTTP behavior. |
| D2 | Tests are throwaway (not committed) | Tests are verification artifacts, not deliverables. Prevents test debt. |
| D3 | Adversarial test generation (AC-driven) | Prevents tautological tests where AI verifies its own bugs. |
| D4 | Sequential phase execution | Avoids 3-4GB memory spike from parallel build+jest+chromium. |
| D5 | INCONCLUSIVE status (not just PASS/FAIL) | AI-generated tests are inherently uncertain. Binary pass/fail creates false confidence or false alarms. |
| D6 | Phase 0 bootstrap cached per-ticket | First run pays setup cost (~5 min), subsequent runs skip. |
| D7 | Change classifier determines depth | CSS-only changes don't need browser tests. Saves 5-10 min. |
| D8 | @mi/core shimmed, not created | We generate a temporary shim that satisfies imports. We don't modify the target app's test infrastructure. |
| D9 | Console warnings threshold = 5 | >5 React warnings → INCONCLUSIVE. Prevents noisy but harmless warnings from triggering false alarms. |
| D10 | Retry: 2x jest, 3x playwright | Playwright is inherently more flaky (timing, network, rendering). More retries needed. |

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Phase 0 bootstrap fails (npm install, missing deps) | Tests skipped entirely | Medium | Graceful degradation — skip Phases 2-3, proceed with existing Q5+Q6 only |
| Vite build OOM on local machine | Pipeline stalls | Low | NODE_OPTIONS=--max_old_space_size=8192, timeout with clean error |
| Playwright can't render app (init APIs fail despite mocks) | Phase 3 always INCONCLUSIVE | Medium | Route interception tested in Phase 0 validation step |
| AI generates tests that always pass (vacuous) | False confidence | Medium | Adversarial pattern + mandatory negative test cases + human reviewer sees test results |
| Port 4300 in use when Phase 3 starts | Phase 3 fails | Low | Port finder scans 4300-4399, picks first free |
| Orphan vite/chromium processes on crash | Resource leak | Medium | PID tracking in state + cleanup in signal handlers + stale process detection on re-entry |
| State file grows with test artifacts | Performance degradation | Low | Artifacts stored on filesystem, only summary in state |

## New Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `RUN_RUNTIME_TESTS` | `"true"` | Master switch for entire runtime testing pipeline |
| `UNIT_TESTS_TIMEOUT` | `180000` (3 min) | Jest execution timeout |
| `E2E_TESTS_TIMEOUT` | `300000` (5 min) | Playwright execution timeout |
| `VITE_PREVIEW_TIMEOUT` | `30000` (30s) | Wait for vite preview to be ready |
| `VITE_BUILD_TIMEOUT` | `600000` (10 min) | Vite build timeout |
| `MAX_UNIT_TEST_RETRIES` | `2` | Jest flaky test retries |
| `MAX_E2E_TEST_RETRIES` | `3` | Playwright flaky test retries |
| `CONSOLE_WARNING_THRESHOLD` | `5` | Max React warnings before INCONCLUSIVE |
| `TEST_ARTIFACTS_DIR` | `.test-artifacts` | Directory for test output files |
| `PLAYWRIGHT_BROWSER` | `chromium` | Browser for Playwright tests |
