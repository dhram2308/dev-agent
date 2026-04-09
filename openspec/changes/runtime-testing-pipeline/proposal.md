# Proposal: Runtime Testing Pipeline

## Problem

The MI Dev Agent generates code via AI (Developer Agent) but only validates it through:
- **Static analysis**: TypeScript type checking (`tsc --noEmit`) and ESLint
- **AI code review**: Reviewer + Security agents read the code and give opinions
- **AI AC verification**: AC Verification Agent compares code against acceptance criteria by reading files

**None of these actually RUN the code.** The first time generated code executes is when a human deploys it to a QA environment and manually tests it. This means:

1. **Runtime errors** (missing imports that tsc misses, wrong API calls, broken renders) are only caught in QA
2. **UI rendering bugs** (component doesn't mount, wrong layout, missing elements) are invisible until human sees them
3. **Logic errors** (wrong data transformation, broken form validation) slip through because AI review checks patterns, not behavior
4. **False confidence** from AI-only review — Reviewer says "LGTM" on code that crashes at runtime

The target app is a React 19 + TypeScript 5.9 + Vite 7 + Nx 22 enterprise monorepo with:
- 7-layer nested provider tree that blocks rendering until 3 mandatory API calls succeed
- HMAC-SHA256 checksum validation on every API response
- 150+ TypeScript path aliases
- Lazy-loaded routes with code splitting
- Browser-only libraries (mapbox-gl, pdfjs-dist, html2canvas) that break in Node.js
- Custom API hooks tightly coupled to axios + checksums + notification context

## Solution

Add a 4-phase runtime testing pipeline that actually builds, executes, and tests the generated code BEFORE pushing to GitLab:

- **Phase 0**: Environment bootstrap (one-time setup of Jest, Playwright, mocks)
- **Phase 1**: Enhanced build verification (tsc + eslint + actual Vite build via Nx)
- **Phase 2**: AI-generated unit tests run in Jest (adversarial — written from AC, not from code)
- **Phase 3**: Browser smoke tests via Playwright (build → serve → navigate → verify render)
- **Phase 4**: Enhanced AC verification with test evidence

Key architectural decisions:
- **Playwright route interception** for mock APIs (no standalone mock server needed)
- **Tests are throwaway** — generated, run, results captured, then reverted before commit
- **Adversarial test generation** — Test Agent sees acceptance criteria, NOT implementation code
- **Tests are informational, not blocking** — only build failures (Phase 1) block the pipeline; test failures report as INCONCLUSIVE in MR description
- **Sequential execution** — phases run one after another to avoid memory spikes on local machine

## Scope

- `run-agent.js` — Add Phase 0-3 to `stageGenerateCode()`, enhance Phase 4, enhance MR quality report
- `server.js` — Add test results display in Web UI dashboard
- New runtime files generated temporarily in `.repo-cache/` during test execution

## Out of Scope

- Tests are NOT committed to the MR (throwaway verification only)
- No changes to the target app's source code or test infrastructure
- No CI/CD pipeline changes
- No cloud/Docker deployment (local machine execution)
- No visual regression testing (pixel comparison)
- No performance/load testing

## Impact

- **+10-17 min** per ticket (subsequent runs after bootstrap)
- **+3-5 min** first run only (environment bootstrap)
- Catches runtime errors, render failures, and missing UI elements BEFORE human QA
- MR description includes concrete test evidence (pass/fail counts, screenshots, console errors)
- Reduces QA rejection rate by catching obvious failures early

## Risks

1. **Time overhead**: 10-17 min added to each ticket. Mitigated by change classifier (STYLE changes skip tests entirely)
2. **Flaky AI-generated tests**: Tests written by AI may be unreliable. Mitigated by retry logic + INCONCLUSIVE status (don't block on uncertain results)
3. **Memory pressure**: Build + Jest + Chromium = 2-4GB additional RAM. Mitigated by sequential execution
4. **Tautological tests**: AI writes tests that verify its own bugs. Mitigated by adversarial pattern (test agent sees AC, not code)
5. **@mi/core missing**: 365 existing test files import from non-existent library. Must shim this in Phase 0
6. **sync-data encrypted response**: App decrypts Firebase config with RSA. Route interception bypasses this at network level
