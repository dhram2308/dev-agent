# Proposal: Browser-Based Verification in Generate Code Stage

## Problem

The MI Dev Agent's `generate_code` stage currently validates AI-generated code through **static analysis only**: TypeScript type checking, ESLint, AI code review, and AI acceptance criteria verification by reading files. None of these actually **run the application** to verify that generated code works in a real browser.

This creates a critical gap:

1. **Runtime errors invisible** — Missing environment variables (`VITE_APP_API_URL` undefined), broken imports, component mount failures are only caught when a human deploys to QA
2. **No visual verification** — The agent has no way to confirm that a new table, form, or modal actually renders
3. **Login/auth flow untested** — Generated code may break authentication flows that static analysis can't detect
4. **False confidence** — AI Reviewer says "LGTM" on code that crashes in the browser because it only reads files, never executes them
5. **Wasted QA cycles** — Human testers discover trivial rendering bugs that a 60-second browser check would catch

The target app is a React 19 + TypeScript 5.9 + Vite 7 + Nx 22 enterprise monorepo with:
- 2-step login form (email → password) with reCAPTCHA, 7 possible post-login screens
- `VITE_APP_API_URL` and 11 other env vars required for API connectivity
- 99 TypeScript path aliases (@mi/* → libs/*)
- Lazy-loaded routes with code splitting across 73 distinct paths
- No token refresh mechanism — 401 forces hard redirect to /login
- `nx serve enterprise` dev server with HTTPS + HMR on port 4200

## Solution

Restructure `generate_code` into a **3-part architecture** with a persistent local environment and real browser verification:

### Phase 0: Environment Setup (one-time, cached)
- Write `.env` file with all 12 VITE_* variables (protected by .gitignore — survives `git clean -fd`)
- Verify/fix node_modules health (check `.bin/nx` exists, clean install if broken)
- Install Playwright + chromium if missing (cached across runs)
- Start `nx serve enterprise` dev server (HTTPS port 4200-4299)
- Verify dev server health via HTTP GET

### Part 1: Development (existing flow, unchanged)
- Developer Agent writes code → Reviewer + Security audit → Fixer resolves issues
- Build check + AC verification (existing Phase 1-4 from runtime-testing-pipeline)

### Part 2: Browser Verification (NEW — the core of this proposal)
- Login to running dev server with real QA credentials via Playwright
- Detect feature routes from changed file paths (5-tier algorithm)
- Navigate to each route, wait for render
- Collect evidence: accessibility tree, visible text, DOM selectors, network log, console errors
- Gap Analysis Agent evaluates evidence against acceptance criteria (text-only, no screenshots)
- If gaps found: Developer Fix Agent patches code → HMR applies → re-login → re-verify (max 3 retries)
- If PASS or retries exhausted: proceed to Part 3

### Part 3: Push + MR (existing flow, enhanced)
- Push code to GitLab, create MR
- MR description includes browser verification results and evidence summary
- `localResetRepo()` cleanup (dev server stays running for next ticket)

**Key insight**: Unlike the existing runtime-testing-pipeline (which uses `vite preview` with mock APIs), this approach runs the **actual dev server** (`nx serve`) and logs into the **real QA backend** — testing the full stack, not a mocked approximation.

## Scope

### New Files (6)
- `stages/generate-code/env-setup.js` (~150 lines) — Phase 0 orchestrator
- `stages/generate-code/browser-verify.js` (~400 lines) — Part 2 orchestrator
- `stages/generate-code/route-detector.js` (~180 lines) — 5-tier route detection from file paths
- `stages/generate-code/login-helper.js` (~130 lines) — Playwright login + 7-screen post-login handler
- `stages/generate-code/dev-server.js` (~120 lines) — nx serve lifecycle management
- `stages/generate-code/evidence-collector.js` (~200 lines) — Accessibility tree, text, DOM, network, console capture

### Modified Files (4)
- `stages/generate-code/index.js` (+40 lines) — Insert Phase 0 before Part 1, Part 2 after Part 1
- `lib/config.js` (+20 lines) — New config constants (BROWSER_VERIFY, NX_SERVE_TIMEOUT, etc.)
- `lib/constants.js` (+15 keys) — New STAGE_CLEARS entries for verification checkpoints
- `server/html.js` (+3 pills) — Updated SUBSTAGES for browser verification visibility in Web UI

## Out of Scope

- No changes to the target app's source code, build config, or test infrastructure
- No visual/pixel-level regression testing (text-based evidence only)
- No mock API servers (uses real QA backend)
- No modifications to QA/pre-prod/prod deployment stages
- No Docker/cloud deployment changes
- Screenshots captured to disk for human reference but NOT analyzed by Claude (text-only CLI limitation)

## Impact

- **+2-5 min** per ticket for verification loop (dev server startup is one-time ~2 min, cached)
- **+0 min** for subsequent tickets on same agent run (dev server stays running)
- Catches runtime errors, render failures, and auth issues BEFORE human QA
- MR description includes concrete browser evidence (accessibility tree summary, console errors, navigation timeline)
- Reduces QA rejection rate by catching rendering and integration bugs early
- Developer Fix Agent can auto-fix simple rendering issues via HMR feedback loop

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| QA backend down during verification | Part 2 skipped, no browser evidence | Medium | Health check before login; ENV_DOWN detection (pattern from test-qa.js); graceful skip |
| Login credentials change | Verification fails on auth | Low | Configurable via env vars (VERIFY_LOGIN_EMAIL, VERIFY_LOGIN_PASS) |
| nx serve OOM on local machine | Dev server crashes | Low | NODE_OPTIONS=--max_old_space_size=4096, NX_SERVE_TIMEOUT=120s |
| Session expires between retries | Re-verification fails | Medium | Re-login before each retry attempt |
| Route detection misidentifies feature route | Wrong page verified | Medium | 5-tier fallback algorithm; worst case verifies /dashboard (always valid) |
| callClaude() is text-only — can't pass screenshots | Gap analysis has no visual evidence | N/A (confirmed) | Accessibility tree + visible text + DOM selectors provide equivalent signal |
| Port 4200 in use | Dev server can't start | Low | Port finder scans 4200-4299 range |
| Concurrent agent runs share .repo-cache | File conflicts | Medium | Lock file per-ticket (existing); dev server per-port isolation |
| Broken node_modules (.bin/ empty) | npm/nx commands fail | Medium | Phase 0 health check verifies .bin/nx exists, clean installs if broken |
| 7 possible post-login screens before dashboard | Login automation fragile | Medium | Explicit handler for each screen (reset-password, otp-verify, business-info, select-mode, buyer-wizard, enable-2fa, dashboard) |
