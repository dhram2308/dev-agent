# Design: Browser-Based Verification in Generate Code Stage

## Context

The MI Dev Agent generates code via Claude and pushes it to GitLab without ever running the application. The existing runtime-testing-pipeline (proposed separately) adds unit tests and browser smoke tests using `vite preview` with mocked APIs. This proposal goes further: **run the actual dev server and verify against the real QA backend**, providing true end-to-end confidence.

### Target App Stack
- React 19.1 + TypeScript 5.9 + Vite 7.2 + Nx 22.0.4 monorepo
- `nx serve enterprise` → Vite dev server at `https://localhost:4200` (HTTPS via mkcert plugin)
- 12 VITE_* env vars required (VITE_APP_API_URL, VITE_PRODUCT_ID, etc.)
- 2-step login: email (input[name="username"]) → Continue → password → Sign In
- 7 post-login screens before reaching /dashboard
- No token refresh — 401 forces `window.location.href = '/login'`
- 99 TypeScript path aliases in tsconfig.base.json
- `npm install --legacy-peer-deps` required (peer dependency conflicts)
- `.gitignore` line 59 protects `/apps/enterprise/.env` from `git clean -fd`

### Critical Discoveries (from 4 rounds of deep exploration)
1. **No .env file exists** in enterprise app — VITE_APP_API_URL is undefined, ALL API calls fail
2. **node_modules is often broken** — `.bin/` directory empty, nx/vite commands fail
3. **callClaude() is text-only** — cannot pass screenshots via CLI, must use accessibility tree
4. **Login form uses `name="username"`** not `name="email"` — selector matters
5. **"Skip for Now" button** is on `/enable-2fa` screen (TwoFactorConfirm component)
6. **No token refresh** — session dies on 401, must re-login between retry attempts
7. **nx serve needs ~120s** to be ready (TypeScript compilation + HMR setup), not 30s
8. **`recaptcha_disabled=true`** query param bypasses CAPTCHA on QA

## Goals

1. **Verify generated code runs in a real browser** — not just compiles, actually renders
2. **Provide text-based evidence** for Claude to evaluate gaps against acceptance criteria
3. **Auto-fix simple issues** via Developer Fix Agent + HMR hot reload
4. **Graceful degradation** — if verification can't run (backend down, server crash), skip and report
5. **Persistent environment** — dev server stays running across tickets, only restarted when needed

## Non-Goals

- Replace human QA testing
- Achieve full end-to-end test coverage
- Test API contract compliance
- Visual regression testing (pixel comparison)
- Modify the target app's source code permanently

## Architecture

### Pipeline Position (3-Part Flow)

```
stageGenerateCode() restructured flow:

  PHASE 0: Environment Setup          → _env_setup_complete, _dev_server_ready
  ────────────────────────────────────────────────────
  PART 1: Development (existing)
    Developer writes code              → _dev_complete
    Reviewer + Security audit          → _reviewed
    Fixer resolves issues              → _fixed
    Build check + AC verification      → _build_checked, _ac_verified
    Runtime tests (if enabled)         → _unit_tests_complete, _e2e_tests_complete
  ────────────────────────────────────────────────────
  PART 2: Browser Verification (NEW)
    Detect feature routes              → _routes_detected
    Login via Playwright               → _login_complete
    Navigate + collect evidence        → _verify_attempt
    Gap Analysis Agent evaluates       → _browser_verified
    If gaps: Dev Fix → HMR → re-verify (max 3)
  ────────────────────────────────────────────────────
  PART 3: Push + MR (existing)
    Push to GitLab + create MR         → (existing flow)
    Cleanup local repo                 → (existing flow)
```

### Phase 0: Environment Setup

```
ensureEnvironment(state, clonePath)
  │
  ├── 1. Write .env file (if missing)
  │     apps/enterprise/.env with 12 VITE_* vars
  │     Protected by .gitignore — survives git clean -fd
  │
  ├── 2. Verify node_modules health
  │     Check: .repo-cache/node_modules/.bin/nx exists?
  │     If broken: npm install --legacy-peer-deps (BUILD_INSTALL_TIMEOUT)
  │
  ├── 3. Install Playwright (if missing)
  │     npx playwright install chromium
  │     Cached in ~/.cache/ms-playwright/ across runs
  │
  └── 4. Start/verify dev server
        Check: existing _nx_serve_pid alive on _nx_serve_port?
        If yes: health check, reuse if healthy
        If no: findFreePort(4200, 4299)
                spawn: npx nx serve enterprise --port {port}
                poll https://localhost:{port} every 2s (max NX_SERVE_TIMEOUT=120s)
                Store PID + port in state
```

### .env File Contents

```env
VITE_APP_API_URL=https://qa-enterprise.mastersindia-einv.com/api/v2.1/
VITE_PRODUCT_ID=enterprises
VITE_APP_QA=https://qa-enterprise.mastersindia-einv.com
VITE_APP_ENV=qa
VITE_APP_TYPE=enterprise
VITE_INITIAL_URL=/dashboard
VITE_CHAT_SOCKET_URL=wss://qa-taxgptbackend.mastersindia-einv.com/ws/v1/
VITE_APP_NICKNAME=Masters India
VITE_SHOW_CLARITY=false
VITE_SHOW_TOUR_GUIDE=no
VITE_DISABLE_CAPTCHA_ON_QA=true
NODE_OPTIONS=--max_old_space_size=4096
```

### Part 2: Browser Verification Flow

```
runBrowserVerification(state, ctx)
  │
  ├── 1. Route Detection
  │     Input: changed file paths from localGetChanges()
  │     Output: [{route, confidence, source}]
  │     Algorithm: 5-tier (see route-detection spec)
  │
  ├── 2. Login via Playwright
  │     goto https://localhost:{port}/login?recaptcha_disabled=true
  │     fill input[name="username"] → click Continue
  │     fill input[name="password"] → click Sign In
  │     Handle 7 post-login screens (see login-helper spec)
  │     Verify: URL ends at /dashboard or expected route
  │
  ├── 3. Navigate + Collect Evidence (per route)
  │     page.goto(route, { waitUntil: "networkidle" })
  │     Collect:
  │       - page.accessibility.snapshot() → structured tree
  │       - page.textContent("body") → visible text (truncated 5KB)
  │       - Targeted DOM checks from AC items
  │       - Network request/response log
  │       - Console errors (categorized)
  │       - Navigation timeline
  │     Screenshot to disk (for human, NOT for Claude)
  │
  ├── 4. Gap Analysis Agent
  │     Prompt: AC items + evidence (text-only)
  │     Output: per-AC verdict (PASS/PARTIAL/FAIL + reason)
  │     Overall: PASS / NEEDS_FIX / SKIP
  │
  └── 5. Fix Loop (if NEEDS_FIX, max 3 retries)
        Developer Fix Agent: prompt with specific gaps
        Wait 5s for HMR hot reload
        Re-login (session may have expired)
        Re-navigate + re-collect evidence
        Re-evaluate with Gap Analysis Agent
```

### Evidence Collection Strategy

Claude CLI (`callClaude()`) is **text-only** — cannot pass screenshots or images. Evidence must be entirely text-based:

```
Evidence Object (per route):
{
  route: "/gst-return/filing",
  timestamp: "2026-04-08T10:30:00Z",

  // Structured accessibility tree — best signal for UI structure
  accessibilityTree: {
    role: "document",
    children: [
      { role: "navigation", name: "Main Nav", children: [...] },
      { role: "main", children: [
        { role: "heading", name: "GST Filing", level: 1 },
        { role: "table", name: "Filing List", children: [...] },
        { role: "button", name: "New Filing" }
      ]}
    ]
  },

  // Visible text content (truncated to 5KB)
  visibleText: "GST Filing\nFiling List\nGSTIN | Period | Status...",

  // Targeted DOM checks from acceptance criteria
  domChecks: [
    { selector: "table.filing-list", found: true, text: "..." },
    { selector: "button:has-text('New Filing')", found: true },
    { selector: ".error-boundary", found: false }
  ],

  // Network summary (not full bodies)
  networkSummary: {
    total: 15, succeeded: 13, failed: 2,
    failedUrls: ["api/v2.1/filing/list → 500"],
    apiCallsMade: ["GET /filing/list", "GET /user/permissions"]
  },

  // Console errors (categorized)
  consoleErrors: [
    { severity: "HIGH", message: "Uncaught TypeError: Cannot read property 'map' of undefined" },
    { severity: "LOW", message: "Warning: Each child in a list should have a unique key" }
  ],

  // Navigation timeline
  navigation: {
    started: "10:30:00",
    loaded: "10:30:03",
    redirects: [],
    finalUrl: "/gst-return/filing"
  }
}
```

### Dev Server Lifecycle

```
Dev Server States:
  ┌─────────┐     startDevServer()    ┌──────────┐
  │ STOPPED │ ───────────────────────▶ │ STARTING │
  └─────────┘                          └──────────┘
                                            │
                          health check OK   │ spawn nx serve
                                            ▼
  ┌─────────┐     timeout/crash        ┌─────────┐
  │  ERROR  │ ◀─────────────────────── │ RUNNING │
  └─────────┘                          └─────────┘
       │                                    │
       │ retry                              │ ticket complete
       ▼                                    │ (keep running)
  ┌─────────┐                               ▼
  │ STOPPED │                          ┌─────────┐
  └─────────┘                          │ RUNNING │ ← reuse for next ticket
                                       └─────────┘
                                            │
                                            │ agent shutdown / SIGTERM
                                            ▼
                                       ┌─────────┐
                                       │ STOPPED │ ← cleanup in signal handler
                                       └─────────┘

Persistence:
  - state.data._nx_serve_pid: PID of nx serve process
  - state.data._nx_serve_port: Port number (4200-4299)
  - state.data._dev_server_ready: true when health check passes
  - On agent restart: check if PID alive → reuse if healthy
```

### Login Automation Sequence

```
Login Flow:
  goto /login?recaptcha_disabled=true
  │
  ├── fill input[name="username"] with email
  ├── click button[type="submit"]  ("Continue")
  ├── waitForSelector input[name="password"]
  ├── fill input[name="password"]
  ├── click button[type="submit"]  ("Sign In")
  │
  └── Post-Login Screen Handler:
      waitForNavigation() or waitForURL change
      │
      ├── /reset-password     → SKIP verification (can't proceed)
      ├── /otp-verify         → SKIP verification (needs real OTP)
      ├── /business-info      → SKIP verification (onboarding)
      ├── /select-mode        → click "Enterprise" mode button
      ├── /buyer-wizard       → SKIP verification (onboarding)
      ├── /enable-2fa         → click "Skip for Now" (ghost button)
      ├── /dashboard          → SUCCESS, proceed to verification
      └── timeout (30s)       → FAIL login, skip Part 2
```

### Route Detection Algorithm (5 Tiers)

```
Input: changed file paths (e.g., "libs/entp/src/lib/gst-return/Filing/index.tsx")

Tier 1: Direct file path → route mapping (95% confidence)
  - Parse: libs/entp/src/lib/{module}/{feature}/
  - Map to known routes from 17 route files
  - Example: gst-return/Filing → /gst-return/filing

Tier 2: Import chain analysis (80% confidence)
  - Read route files, grep for component name
  - Find which <Route path="..."> renders the changed component

Tier 3: AC text extraction (70% confidence)
  - Parse acceptance criteria for route/URL mentions
  - "Navigate to GST Return > Filing" → /gst-return/filing

Tier 4: Module name grep (50% confidence)
  - Grep route files for module name substring
  - gst-return → any route containing "gst-return"

Tier 5: Fallback to /dashboard (30% confidence)
  - If no route detected, verify /dashboard renders
  - Still catches global breaking changes (providers, auth)
```

### Gap Analysis Agent Design

```
Prompt Template:
  Role: "QA Gap Analyst"
  Input:
    - Acceptance criteria (numbered list)
    - Evidence object (accessibility tree, text, DOM checks, network, console)
    - Current attempt number (1-3)
    - Known gaps from previous attempt (if retry)

  Output Format:
    AC 1: [text] → PASS | PARTIAL | FAIL
      Evidence: [what was found in accessibility tree / text / DOM]
      Gap: [if PARTIAL/FAIL, what's missing]

    AC 2: [text] → PASS | PARTIAL | FAIL
      ...

    OVERALL: PASS | NEEDS_FIX | SKIP
    FIX_INSTRUCTIONS: [if NEEDS_FIX, specific code changes needed]

  Rules:
    - PASS if evidence confirms AC is met (element exists, text matches, etc.)
    - PARTIAL if element exists but content/behavior uncertain
    - FAIL if element clearly missing or wrong content
    - SKIP if unable to verify (backend error, wrong route, etc.)
    - NEEDS_FIX only if specific fixable issues identified
    - After 3 failed attempts → SKIP (don't block pipeline)
```

### State Checkpoint Keys

```javascript
// Phase 0
_env_setup_complete: true,           // .env written, node_modules healthy
_npm_install_hash: "sha256:...",     // Hash of package-lock for cache invalidation
_nx_serve_pid: 12345,               // Dev server process ID
_nx_serve_port: 4200,               // Dev server port
_dev_server_ready: true,            // Health check passed

// Part 2
_routes_detected: [{route, confidence, source}],  // Detected feature routes
_login_complete: true,              // Playwright login succeeded
_verify_attempt: 1,                 // Current verification attempt (1-3)
_verify_known_gaps: [...],          // Gaps from previous attempt (for fix agent)
_browser_verified: "PASS",          // Overall: PASS / SKIP / NEEDS_FIX
_verify_evidence: {...},            // Evidence summary (truncated for state size)
_verify_api_summary: {...},         // Network request summary
_verify_console_summary: [...],     // Console error summary
```

### Integration with agents-team.js

Phase 0 tasks (env setup, npm install, playwright install) run **sequentially** — each depends on the previous.

Part 2 evidence collection per route can run **sequentially** (single Playwright browser instance, one page at a time). The Gap Analysis Agent runs once after all routes are checked.

The Developer Fix Agent (on retry) uses the same `callClaude()` pattern as existing fix agents:
```javascript
callClaude(fixPrompt, DEVELOPER_TIMEOUT_MS, {
  cwd: cfg.localRepo,
  maxTurns: 15,
  allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"],
  agentName: "Browser Fix Agent",
});
```

### QA Backend Health Detection

Before attempting login, check if QA backend is reachable:

```javascript
// Pattern from existing test-qa.js ENV_DOWN classification
const ENV_DOWN_ERRORS = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"];

async function checkQAHealth(qaUrl) {
  try {
    const res = await fetch(`${qaUrl}/api/v2.1/iv-generation/`, { timeout: 10000 });
    return res.status < 500;  // 4xx is "up but auth required" = healthy
  } catch (e) {
    if (ENV_DOWN_ERRORS.some(code => e.message.includes(code))) {
      return false;  // Backend is down
    }
    return false;
  }
}
```

If unhealthy: skip Part 2 entirely, set `_browser_verified = "SKIP"`, include "QA backend unreachable" in MR description.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Real QA backend over mock APIs | True end-to-end verification. Mock APIs miss integration issues (CORS, auth headers, response shapes). The runtime-testing-pipeline already covers mock-based testing. |
| D2 | Accessibility tree over screenshots | `callClaude()` is text-only (CLI spawn). Accessibility tree provides structured UI information equivalent to visual inspection for gap analysis. |
| D3 | nx serve (dev server) over vite preview (static) | HMR enables fix-and-verify loop without server restart. Dev server persists across tickets for zero-cost re-verification. |
| D4 | Re-login between retry attempts | No token refresh mechanism exists. JWT expires in 15-30 min. Re-login guarantees fresh session. |
| D5 | 5-tier route detection with fallback | Direct file→route mapping only works ~40% of the time. Tiered fallback ensures we always verify something. /dashboard fallback still catches global breaks. |
| D6 | Dev server persists across tickets | Startup cost is ~120s. Persisting eliminates this for 2nd+ tickets. State stores PID/port for reuse detection. |
| D7 | Phase 0 separate from Part 1 | Environment setup must succeed before developer writes code (dev server provides real-time feedback). Separating makes checkpoint/resume cleaner. |
| D8 | Max 3 verification retries | Diminishing returns after 3 fix attempts. After 3: set SKIP, report gaps in MR, let human QA decide. |
| D9 | Evidence stored on disk, summary in state | Full evidence (accessibility tree, network log) can be 50-200KB per route. State file has 10MB cap. Only summary + verdict in state. |
| D10 | Screenshots to disk only, not to Claude | Captured for human reference in `.test-artifacts/`. Claude gets accessibility tree + text equivalent via prompt. |

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| QA backend down during verification | Part 2 skipped entirely | Medium | Health check before login; ENV_DOWN detection; graceful skip with MR note |
| nx serve takes >120s to start | Phase 0 timeout | Low | Configurable NX_SERVE_TIMEOUT; retry once; skip if still fails |
| Login credentials expire/change | Verification fails on auth | Low | Configurable via env vars; SKIP with clear error message |
| Session expires mid-verification | Re-navigation fails with 401 redirect | Medium | Detect hard redirect to /login; re-login before each retry |
| Route detection picks wrong page | Wrong feature verified | Medium | 5-tier algorithm; confidence score logged; worst case verifies /dashboard |
| Concurrent agents share .repo-cache | Port conflicts, file race conditions | Medium | Per-ticket lock file (existing); per-port dev server isolation; single Playwright instance |
| Accessibility tree too large for prompt | Exceeds MAX_PROMPT_TOKENS | Low | Truncate to 10KB; focus on `role: "main"` subtree only |
| node_modules broken (.bin/ empty) | All npm/nx commands fail | Medium | Phase 0 health check; clean install if broken; skip Part 2 if install fails |
| Post-login screen unknown (new screen added) | Login automation hangs | Low | 30s timeout per screen; SKIP with error message; configurable screen handlers |
| Memory pressure: nx serve + Playwright + Claude | OOM on local machine | Low | NODE_OPTIONS=4GB; sequential execution; kill Playwright between routes |

## New Configuration Constants

| Variable | Default | Purpose |
|----------|---------|---------|
| `BROWSER_VERIFY` | `"true"` | Master switch for Part 2 browser verification |
| `MAX_VERIFY_RETRIES` | `3` | Max verification → fix → re-verify cycles |
| `VERIFY_LOGIN_EMAIL` | from cfg.qa.main.user | QA login email for Playwright |
| `VERIFY_LOGIN_PASS` | from cfg.qa.main.pass | QA login password |
| `NX_SERVE_TIMEOUT` | `120000` (2 min) | Max wait for nx serve to be ready |
| `NX_SERVE_PORT_RANGE_START` | `4200` | Dev server port range start |
| `NX_SERVE_PORT_RANGE_END` | `4299` | Dev server port range end |
| `VERIFICATION_TIMEOUT` | `300000` (5 min) | Total timeout for Part 2 verification loop |
| `EVIDENCE_MAX_SIZE` | `10240` (10KB) | Max accessibility tree size in prompt |
| `QA_HEALTH_TIMEOUT` | `10000` (10s) | Timeout for QA backend health check |
