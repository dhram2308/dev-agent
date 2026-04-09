# Spec: Call-Site Migration to runSingleAgent

## Capability: MODIFIED — `browser-verify.js` (2 calls)

### WHEN Gap Analysis Agent is invoked
THEN it uses `runSingleAgent` with:
  - `name`: "Gap Analysis Agent"
  - `timeout`: `applyComplexityTimeout(120_000, state)` (was hardcoded 120_000)
  - `checkpointKey`: `_gap_analysis_attempt_${attempt}` (attempt-scoped)
  - `required`: false (failure → SKIP, not halt)
  - `opts`: `{ maxTurns: 3, allowedTools: [] }`

### WHEN Browser Fix Agent is invoked
THEN it uses `runSingleAgent` with:
  - `name`: "Browser Fix Agent"
  - `timeout`: `applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state)` (was DEVELOPER_TIMEOUT_MS without scaling)
  - `checkpointKey`: `_gap_fix_attempt_${attempt}` (attempt-scoped)
  - `required`: false (failure → warn and continue loop)
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 15, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] }`

## Capability: MODIFIED — `ac-verification.js` (2 calls)

### WHEN AC Verification Agent is invoked
THEN it uses `runSingleAgent` with:
  - `name`: "AC Verification Agent"
  - `timeout`: `applyComplexityTimeout(REVIEWER_TIMEOUT_MS, state)`
  - `checkpointKey`: `_ac_agent_result`
  - `required`: false (failure → skip verification, DON'T mark as verified)
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 10, allowedTools: ["Read", "Grep", "Glob"] }`

### WHEN AC Fix Agent is invoked (retry loop)
THEN it uses `runSingleAgent` with:
  - `name`: "Developer Agent (AC Fix)"
  - `timeout`: `applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state)`
  - `checkpointKey`: `_ac_fix_attempt_${retryCount}`
  - `required`: false (failure → warn and continue)
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 15, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] }`

## Capability: MODIFIED — `runtime-tests.js` (4 calls)

### WHEN Unit Test Generator Agent is invoked
THEN it uses `runSingleAgent` with:
  - `name`: "QA Test Engineer Agent"
  - `timeout`: `applyComplexityTimeout(UNIT_TESTS_TIMEOUT, state)`
  - `checkpointKey`: `_unit_test_gen_result`
  - `required`: false (failure → skip unit tests)
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 8, allowedTools: ["Read", "Write", "Glob", "Grep"] }`

### WHEN Test Fixer Agent is invoked
THEN it uses `runSingleAgent` with:
  - `name`: "Test Fixer Agent"
  - `timeout`: `applyComplexityTimeout(TEST_FIXER_TIMEOUT_MS, state)`
  - `checkpointKey`: `_test_fixer_result`
  - `required`: false (failure → warn, continue with failing tests)
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 10, allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"] }`

### WHEN Developer Agent (test source fix) is invoked
THEN it uses `runSingleAgent` with:
  - `name`: "Developer Agent (Test Fix)"
  - `timeout`: `applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state)`
  - `checkpointKey`: `_test_fix_dev_result`
  - `required`: false
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 15, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] }`

### WHEN E2E Test Generator Agent is invoked
THEN it uses `runSingleAgent` with:
  - `name`: "E2E Test Engineer Agent"
  - `timeout`: `applyComplexityTimeout(E2E_TESTS_TIMEOUT, state)`
  - `checkpointKey`: `_e2e_test_gen_result`
  - `required`: false (failure → skip E2E tests)
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 8, allowedTools: ["Read", "Write", "Glob", "Grep"] }`

## Capability: MODIFIED — `build-check.js` (1 call)

### WHEN Build Fixer Agent is invoked
THEN it uses `runSingleAgent` with:
  - `name`: "Build Fixer Agent"
  - `timeout`: `applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state)`
  - `checkpointKey`: `_build_fix_result`
  - `required`: false (failure → warn, continue with build errors)
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 20, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] }`

## Capability: MODIFIED — `explore-plan.js` (1 call)

### WHEN OpenSpec Architect Agent is invoked
THEN it uses `runSingleAgent` with:
  - `name`: "OpenSpec Architect Agent"
  - `timeout`: `applyComplexityTimeout(ANALYSIS_TIMEOUT_MS * 1.5, state)`
  - `checkpointKey`: `_architect_result`
  - `required`: true (failure → halt explore_plan stage)
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 3, allowedTools: ["Read", "Grep", "Glob"] }`

## Capability: MODIFIED — `developer.js` (2 calls)

### WHEN single Developer Agent is invoked (fallback path)
THEN it uses `runSingleAgent` with:
  - `name`: "Developer Agent"
  - `timeout`: `applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state)`
  - `checkpointKey`: `_dev_single_result`
  - `required`: true (failure → halt pipeline)
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 30, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] }`

### WHEN Developer Agent retry is invoked (0 files changed)
THEN it uses `runSingleAgent` with:
  - `name`: "Developer Agent (Retry)"
  - `timeout`: `applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state)`
  - `checkpointKey`: `_dev_retry_result`
  - `required`: true (failure → mark _dev_failed)
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 30, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] }`

## Capability: MODIFIED — `reviewer.js` (1 call)

### WHEN Fixer Agent is invoked
THEN it uses `runSingleAgent` with:
  - `name`: "Fixer Agent"
  - `timeout`: `applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state)`
  - `checkpointKey`: `_fixer_result`
  - `required`: true (failure → halt with F7 error)
  - `opts`: `{ cwd: cfg.localRepo, maxTurns: 20, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] }`

## Capability: MODIFIED — `lib/constants.js` STAGE_CLEARS

### WHEN `generate_code` stage is cleared
THEN these additional keys are removed:
  - `_gap_analysis_attempt_1`, `_gap_analysis_attempt_2`, `_gap_analysis_attempt_3`
  - `_gap_fix_attempt_2`, `_gap_fix_attempt_3`
  - `_ac_agent_result`, `_ac_fix_attempt_1`, `_ac_fix_attempt_2`
  - `_unit_test_gen_result`, `_e2e_test_gen_result`
  - `_test_fixer_result`, `_test_fix_dev_result`
  - `_build_fix_result`
  - `_fixer_result`
  - `_dev_single_result`, `_dev_retry_result`
  - `_browser_verify_skip_reason`

### WHEN `explore_plan` stage is cleared
THEN this additional key is removed:
  - `_architect_result`
