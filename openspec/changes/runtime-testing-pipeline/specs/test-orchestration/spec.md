# Spec: Test Orchestration & Integration

## Pipeline Orchestration

### ADDED: runRuntimeTests() orchestrator function

**WHEN** `stageGenerateCode()` completes Fixer stage AND `RUN_RUNTIME_TESTS` env var is truthy
**THEN** execute runtime testing phases in order:
1. Phase 0: `bootstrapTestEnvironment()` (if not cached)
2. Phase 1: Enhanced build check (existing Q5, extended with Vite build)
3. Phase 2: `runUnitTests()` (if change type is not STYLE)
4. Phase 3: `runBrowserTests()` (if change type is COMPONENT or API_INTEGRATION)
5. Cleanup: `revertTestFiles()`
6. Phase 4: Enhanced AC verification (existing Q6, with test evidence)

**WHEN** `RUN_RUNTIME_TESTS` is false or not set
**THEN** skip Phases 0-3, run only existing Q5 + Q6 (backward compatible)

**WHEN** `state.data._env_bootstrap_failed` is true
**THEN** skip Phases 2-3, run Phase 1 only (graceful degradation)

### ADDED: State checkpoints for runtime test phases

**WHEN** each phase completes
**THEN** save state with checkpoint flag:
- `_env_bootstrapped`: Phase 0 complete
- `_build_checked`: Phase 1 complete (existing, enhanced)
- `_unit_tests_complete`: Phase 2 complete ("PASS" | "FAIL" | "INCONCLUSIVE")
- `_e2e_tests_complete`: Phase 3 complete ("PASS" | "FAIL" | "INCONCLUSIVE")
- `_ac_verified`: Phase 4 complete (existing, enhanced)

**WHEN** agent resumes after crash AND a checkpoint exists
**THEN** skip completed phases (same pattern as existing _dev_complete checkpoint)

## Cleanup

### ADDED: revertTestFiles()

**WHEN** all test phases complete (pass, fail, or error)
**THEN** revert ALL generated test infrastructure from `.repo-cache/`:
- `git checkout -- '*.spec.tsx' '*.spec.ts'` (generated unit tests)
- Remove `jest.config.override.ts`
- Remove `setupTests.runtime.ts`
- Remove `test-providers.tsx`
- Remove `@mi/core` shim
- Remove `.env.local` (VITE_* overrides)
- Keep `node_modules/` and `dist/` (cached for next run)

**WHEN** cleanup fails (git checkout error)
**THEN** log warning, proceed anyway (pushCodeToGitLab filters by `localGetChanges()` which reads git status)

**WHEN** `.test-artifacts/{TICKET}/` exists from a previous run
**THEN** delete and recreate (fresh results per run)

### ADDED: revertTestFiles() called in error handler

**WHEN** any runtime test phase throws an unhandled error
**THEN** `revertTestFiles()` runs in finally block before error propagates

## Process Cleanup

### ADDED: cleanupTestProcesses()

**WHEN** called (from signal handlers, error handlers, or normal completion)
**THEN**:
1. If `state.data._vite_preview_pid` exists → `process.kill(pid, "SIGTERM")` → wait 5s → SIGKILL
2. Clear `_vite_preview_pid` and `_vite_preview_port` from state
3. Save state

**WHEN** agent starts AND `state.data._vite_preview_pid` is set (stale from crash)
**THEN** attempt to kill the stale process, log warning, clear state

### MODIFIED: Global signal handlers (C2/CR1)

**WHEN** SIGTERM or SIGINT received
**THEN** call `cleanupTestProcesses()` BEFORE existing cleanup logic

**WHEN** uncaughtException or unhandledRejection
**THEN** call `cleanupTestProcesses()` in catch block

## MR Quality Report Enhancement

### MODIFIED: pushCodeToGitLab() MR description

**WHEN** building MR description AND runtime test results exist in state
**THEN** add "Runtime Test Results" section:

```markdown
### Runtime Test Results
- Build: {tscStatus}, {eslintStatus}, Vite build {viteStatus}
- Unit Tests: {passed}/{total} passed{flakyNote}{inconclusiveNote}
- Browser Smoke: {e2eStatus}{consoleNote}
- AC Verification: {acResults}
```

**WHEN** `_unit_tests_complete` is "INCONCLUSIVE"
**THEN** note in MR: "Unit Tests: INCONCLUSIVE — {failedCount} tests could not be verified. Manual testing recommended."

**WHEN** `_e2e_tests_complete` is "INCONCLUSIVE"
**THEN** note in MR: "Browser Smoke: INCONCLUSIVE — {reason}. Manual testing recommended."

**WHEN** `_e2e_console_errors` has entries
**THEN** list first 5 in MR description under "Console Warnings" subsection

**WHEN** runtime tests were skipped (RUN_RUNTIME_TESTS=false or bootstrap failed)
**THEN** note in MR: "Runtime Tests: Skipped"

## AC Verification Enhancement

### MODIFIED: Q6 AC Verification Agent prompt

**WHEN** AC Verification runs AND runtime test results exist
**THEN** include test evidence in prompt:
```
## Test Evidence
Unit Tests: {passed}/{total} passed
  - AC-1 related tests: PASS (testName1, testName2)
  - AC-2 related tests: FAIL (testName3 — expected X got Y)
Browser Smoke: {status}
  - Route /module-path renders: YES/NO
  - Key elements found: table, form, submit button
  - Console errors: {count} ({first error text})
```

**WHEN** test evidence shows a test FAILED for a specific AC
**THEN** AC Verification Agent should rate that AC as PARTIAL or FAIL (test evidence overrides code-reading confidence)

**WHEN** test evidence shows all tests PASSED for a specific AC
**THEN** AC Verification Agent may rate as PASS with higher confidence

## Web UI Dashboard Enhancement

### MODIFIED: server.js status display

**WHEN** state contains `_unit_tests_complete` or `_e2e_tests_complete`
**THEN** show in dashboard:
- Test phase status badges (PASS=green, INCONCLUSIVE=yellow, FAIL=red)
- Unit test count: "{passed}/{total} passed, {flaky} flaky"
- E2E test status with console error count
- Link to test artifacts directory

### ADDED: /api/test-artifacts endpoint

**WHEN** `GET /api/test-artifacts?ticket={TICKET}`
**THEN** return JSON listing files in `.test-artifacts/{TICKET}/`:
- jest-results.json (if exists)
- playwright-results.json (if exists)
- screenshots/ file list (if exists)
- console-errors.json (if exists)

**WHEN** ticket parameter is invalid or artifacts don't exist
**THEN** return `{ files: [] }`

## Timeout Coordination

### ADDED: Phase-level timeout enforcement

**WHEN** any phase exceeds its timeout
**THEN** kill running process, mark phase as INCONCLUSIVE, proceed to next phase

Phase timeouts:
- Phase 0: 10 min (`ENV_BOOTSTRAP_TIMEOUT`)
- Phase 1 (Vite build): 10 min (`VITE_BUILD_TIMEOUT`)
- Phase 2 (Jest): 3 min (`UNIT_TESTS_TIMEOUT`)
- Phase 3 (Playwright): 5 min (`E2E_TESTS_TIMEOUT`)
- Total runtime tests: sum of individual timeouts (~28 min max)

**WHEN** overall pipeline timeout (`MAX_PIPELINE_DURATION`) is approaching
**THEN** skip remaining test phases, proceed directly to pushCodeToGitLab with available results
