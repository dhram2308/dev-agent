# Tasks

## 1. Restructure tabs to match pipeline sub-steps
- [x] 1.1 Change from 3 tabs to 7 tabs: Developer, Review & Security, Build Check, Runtime Tests, Browser Verify, AC Verification, Create MR
- [x] 1.2 Update tab status derivation for all 7 tabs using correct checkpoint fields
- [x] 1.3 Add horizontal scroll to tab bar for overflow on small screens

## 2. Developer tab — full coverage
- [x] 2.1 Show codegen mode indicator (local vs legacy) from `_codegen_mode`
- [x] 2.2 Show rejection count from `_codegen_rejections` and max rejections
- [x] 2.3 Show dev agent mode (parallel groups vs single) from presence of `_dev_group_N` fields
- [x] 2.4 Keep existing: `_dev_complete`, `_dev_failed`, `_dev_summary` rows
- [x] 2.5 Show current feedback text if `feedback` field exists (pending refinement)

## 3. Review & Security tab — full coverage
- [x] 3.1 Show Code Review status from `_reviewed` with verdict indicator
- [x] 3.2 Show Security Review status from `_security_result` presence
- [x] 3.3 Show Fixer status from `_fixed` — distinguish "passed" (no issues) vs "fixed" (issues found + fixed)
- [x] 3.4 Show fixer agent result indicator from `_fixer_result` presence

## 4. Build Check tab — full coverage
- [x] 4.1 Show TSC status from `_build_tsc` handling PASS/FAIL strings
- [x] 4.2 Show ESLint status from `_build_eslint` handling PASS/FAIL/SKIP strings
- [x] 4.3 Show Build Fix Attempted indicator from `_build_fix_attempted`
- [x] 4.4 Show Build Checked completion from `_build_checked`

## 5. Runtime Tests tab — full coverage (currently mostly missing)
- [x] 5.1 Show Env Bootstrap status from `_env_bootstrapped` / `_env_bootstrap_failed`
- [x] 5.2 Show Playwright Install status from `_playwright_install_failed`
- [x] 5.3 Show Vite Build status from `_vite_build_done` (true / "FAIL")
- [x] 5.4 Show Unit Tests status from `_unit_tests_complete` (PASS/INCONCLUSIVE/SKIP)
- [x] 5.5 Parse and display `_unit_tests_count` JSON string as "N passed / M total (F failed)"
- [x] 5.6 Show E2E Browser Smoke status from `_e2e_tests_complete` (PASS/INCONCLUSIVE/SKIP)
- [x] 5.7 Parse and display `_e2e_tests_count` as "N passed / M total"
- [x] 5.8 Show console errors count from `_e2e_console_errors` array length

## 6. Browser Verify tab — full coverage (currently only 1 row)
- [x] 6.1 Show Dev Server status from `_dev_server_ready`
- [x] 6.2 Show Env Setup from `_env_setup_complete` / `_browser_verify_available`
- [x] 6.3 Show Login status from `_login_complete`
- [x] 6.4 Show Routes Detected count from `_routes_detected` array
- [x] 6.5 Show Verification Attempt from `_verify_attempt`
- [x] 6.6 Show overall verdict from `_browser_verified` (PASS/SKIP) with skip reason from `_browser_verify_skip_reason`
- [x] 6.7 Show Evidence Health from `_verify_evidence` object
- [x] 6.8 Show Known Gaps from `_verify_known_gaps` array

## 7. AC Verification tab — full coverage
- [x] 7.1 Show AC Verified status from `_ac_verified`
- [x] 7.2 Show Retry Count from `_ac_retry_count` (0/1/2)
- [x] 7.3 Show AC Report text from `_ac_verification` (collapsible)
- [x] 7.4 Show Known Gaps from `_ac_known_gaps` — handle as newline-separated string, not array

## 8. Create MR tab — add missing fields
- [x] 8.1 Keep existing: branch, committed, SHA, conflict check, MR link, slack
- [x] 8.2 Add source branch from `code_source_branch`
- [x] 8.3 Add divergence check from `_divergence_checked`

## 9. Build and verify
- [x] 9.1 Run `tsc --noEmit` — zero errors
- [x] 9.2 Run `npm run build` in frontend — successful build
- [x] 9.3 Verify with real pipeline data (AUT-8456 has full checkpoint data)
