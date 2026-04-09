# Tasks: agents-team as Universal Agent Backbone

## Phase 1: Core Infrastructure — `lib/agents-team.js`

- [x] 1.1 Add `validateClaudeNotEmpty` and `detectClaudeRefusal` imports from `lib/utils`
- [x] 1.2 Add output validation after `callClaude` returns in Phase 2 (before checkpointing) — validate, then checkpoint; if validation throws, treat agent as rejected
- [x] 1.3 Add `runSingleAgent()` function that delegates to `runAgentsTeam` with a 1-agent team and a simple merge that returns `results[0]?.output || null`
- [x] 1.4 Export `runSingleAgent` alongside existing `runAgentsTeam`
- [x] 1.5 Verify existing 3 callers (explore-plan, developer, reviewer) still work with validation added — their agents produce valid non-empty non-refusal output

## Phase 2: Critical Safety Fix — `ac-verification.js`

- [x] 2.1 Import `runSingleAgent` from `lib/agents-team` (replace or augment existing `callClaude` import)
- [x] 2.2 Import `applyComplexityTimeout` if not already imported
- [x] 2.3 Convert AC Verification Agent call (line 58) to `runSingleAgent({ required: false, checkpointKey: "_ac_agent_result" })`
- [x] 2.4 Remove the catch block (lines 121-126) that sets `_ac_verified = true` on error — let null return handle the skip
- [x] 2.5 Add null check after `runSingleAgent`: if null, log warning and return fileChanges WITHOUT setting `_ac_verified = true`
- [x] 2.6 Convert AC Fix Agent call (line 89) to `runSingleAgent({ required: false, checkpointKey: "_ac_fix_attempt_${retryCount}" })`
- [x] 2.7 Verify: on CLI crash, `_ac_verified` stays false; on restart, AC verification retries

## Phase 3: Browser Verification Fix — `browser-verify.js`

- [x] 3.1 Import `runSingleAgent` from `lib/agents-team` and `applyComplexityTimeout` from config
- [x] 3.2 Convert Gap Analysis Agent call (line 348) to `runSingleAgent({ required: false, checkpointKey: "_gap_analysis_attempt_${attempt}", timeout: applyComplexityTimeout(120_000, state) })`
- [x] 3.3 Add null check after `runSingleAgent`: if null, set `_browser_verify_skip_reason = "agent_failure"` and break loop
- [x] 3.4 Convert Browser Fix Agent call (line 408) to `runSingleAgent({ required: false, checkpointKey: "_gap_fix_attempt_${attempt}", timeout: applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state) })`
- [x] 3.5 Add `_browser_verify_skip_reason` to state when SKIP for any reason (agent failure, backend unhealthy, timeout, login failed)
- [x] 3.6 Update `buildBrowserVerifyMRSection` to include skip reason in MR description

## Phase 4: Runtime Tests — `runtime-tests.js`

- [x] 4.1 Import `runSingleAgent` from `lib/agents-team`
- [x] 4.2 Convert Unit Test Generator call to `runSingleAgent({ required: false, checkpointKey: "_unit_test_gen_result" })`
- [x] 4.3 Convert Test Fixer Agent call to `runSingleAgent({ required: false, checkpointKey: "_test_fixer_result" })`
- [x] 4.4 Convert Developer Agent (test fix) call to `runSingleAgent({ required: false, checkpointKey: "_test_fix_dev_result" })`
- [x] 4.5 Convert E2E Test Generator call to `runSingleAgent({ required: false, checkpointKey: "_e2e_test_gen_result" })`
- [x] 4.6 Add null checks after each: if agent returns null, skip that test phase gracefully

## Phase 5: Build Check + Fixer — `build-check.js`

- [x] 5.1 Import `runSingleAgent` from `lib/agents-team`
- [x] 5.2 Convert Build Fixer Agent call to `runSingleAgent({ required: false, checkpointKey: "_build_fix_result" })`
- [x] 5.3 Add null check: if agent returns null, log warning and mark build as checked (fixer failed but build errors remain)

## Phase 6: Explore Plan Architect — `explore-plan.js`

- [x] 6.1 Import `runSingleAgent` from `lib/agents-team` (already imports `runAgentsTeam`)
- [x] 6.2 Convert OpenSpec Architect Agent call to `runSingleAgent({ required: true, checkpointKey: "_architect_result" })`
- [x] 6.3 Add checkpoint check before architect call: if `_architect_result` exists in state, use cached output (skip re-run on restart)

## Phase 7: Developer + Fixer — `developer.js` and `reviewer.js`

- [x] 7.1 In `developer.js`: import `runSingleAgent` from `lib/agents-team`
- [x] 7.2 Convert single Developer Agent call to `runSingleAgent({ required: true, checkpointKey: "_dev_single_result" })`
- [x] 7.3 Convert Developer retry call to `runSingleAgent({ required: true, checkpointKey: "_dev_retry_result" })`
- [x] 7.4 In `reviewer.js`: import `runSingleAgent` from `lib/agents-team`
- [x] 7.5 Convert Fixer Agent call to `runSingleAgent({ required: true, checkpointKey: "_fixer_result" })`
- [x] 7.6 Keep existing `validateClaudeNotEmpty` + `detectClaudeRefusal` calls OR remove them (now handled by agents-team validation) — choose one, don't double-validate

## Phase 8: Constants + State — `lib/constants.js`

- [x] 8.1 Add to `STAGE_CLEARS.generate_code`: `_gap_analysis_attempt_1`, `_gap_analysis_attempt_2`, `_gap_analysis_attempt_3`, `_gap_fix_attempt_2`, `_gap_fix_attempt_3`
- [x] 8.2 Add to `STAGE_CLEARS.generate_code`: `_ac_agent_result`, `_ac_fix_attempt_1`, `_ac_fix_attempt_2`
- [x] 8.3 Add to `STAGE_CLEARS.generate_code`: `_unit_test_gen_result`, `_e2e_test_gen_result`, `_test_fixer_result`, `_test_fix_dev_result`
- [x] 8.4 Add to `STAGE_CLEARS.generate_code`: `_build_fix_result`, `_fixer_result`, `_dev_single_result`, `_dev_retry_result`, `_browser_verify_skip_reason`
- [x] 8.5 Add to `STAGE_CLEARS.explore_plan`: `_architect_result`

## Phase 9: Verification

- [x] 9.1 Run `node -c` syntax check on all modified files (agents-team.js, ac-verification.js, browser-verify.js, runtime-tests.js, build-check.js, explore-plan.js, developer.js, reviewer.js, constants.js)
- [ ] 9.2 Verify existing `runAgentsTeam` callers (explore-plan Analysis Team, developer Task Groups, reviewer Review Team) produce non-empty non-refusal output — validation doesn't break them
- [ ] 9.3 Verify `_active_agents` is set during every `runSingleAgent` call (check via state file or Web UI)
- [ ] 9.4 Verify AC crash recovery: kill agent mid-run → restart → AC verification retries (not marked as verified)
- [ ] 9.5 Verify browser-verify crash recovery: kill agent mid-gap-analysis → restart → gap analysis re-runs (not marked SKIP)
- [ ] 9.6 Verify checkpoint resume: complete Gap Analysis → crash during Fix Agent → restart → Gap Analysis skipped (loaded from checkpoint), Fix Agent re-runs
- [ ] 9.7 Verify loop-scoped keys: browser-verify attempt 1 gap result doesn't pollute attempt 2
- [ ] 9.8 Verify STAGE_CLEARS: clear generate_code → all new checkpoint keys removed from state
