# Spec: AC Verification Crash Behavior Fix

## Capability: MODIFIED — `ac-verification.js` error handling

### WHEN the AC Verification Agent call throws (CLI crash, timeout, refusal)
THEN `_ac_verified` must NOT be set to `true`
AND `_ac_verification` must NOT be set to "skipped due to error"
AND on next pipeline restart, AC verification retries from scratch

### WHEN the AC Verification Agent returns valid output
THEN `_ac_verified` is set to `true`
AND `_ac_verification` is set to the agent's output
AND FAIL items trigger the fix retry loop (up to 2 retries)

### WHEN the AC Fix Agent call throws during retry
THEN the error is logged as warning
AND `_ac_verified` remains `true` (the verification itself succeeded, only the fix failed)
AND `_ac_known_gaps` is populated with FAIL items for MR description

## Capability: MODIFIED — `browser-verify.js` error tracking

### WHEN the Gap Analysis Agent call throws
THEN `_browser_verified` is set to `"SKIP"` (graceful degradation)
AND `_browser_verify_skip_reason` is set to `"agent_failure"`
AND the skip reason is distinguishable from intentional SKIP ("backend_unhealthy", "dev_server_down", etc.)

### WHEN the Gap Analysis Agent returns valid output that parses to SKIP
THEN `_browser_verified` is set to `"SKIP"`
AND `_browser_verify_skip_reason` is set to `"inconclusive"` or the agent's reason
