## Why

Deep analysis revealed 36+ fragility points across backend, frontend, and pipeline stages. The most critical: state file race conditions can lose gate approvals, double-start race can spawn duplicate agents, SSE drops messages permanently, CI pipeline waits have no timeout (hang forever), frontend allows double-submit of approve/reject, and 40+ unchecked getElementById calls can crash the entire UI. Production deploy has no automatic rollback — if smoke tests fail at 3am, broken code stays live until a human wakes up.

## What Changes

**Backend (6 files):**
- **State CAS guard**: Add sequence-number compare-and-swap to state writes, preventing concurrent write stomping (state-unified.js)
- **Atomic agent-start**: Replace check-then-act with atomic guard using synchronous Set operation (agent-process.js)
- **SSE message recovery**: Add dropped messages to replay buffer so reconnecting clients recover them (sse.js)
- **CI timeout enforcement**: Add configurable timeout to gl.waitPipeline calls in deploy stages (deploy-qa.js, deploy-prod.js)
- **Silent catch elimination**: Replace 11 empty `catch{}` blocks with proper logging across 6 files
- **Retry on initial Jira fetch**: Add retry-with-backoff to jira.getIssue() in fetch-ticket (fetch-ticket.js)
- **Zero-files guard**: Check file count before push, give clear error instead of crash (generate-code/index.js)

**Frontend (1 file):**
- **Double-submit prevention**: Add mutual exclusion to approveGate/rejectGate/submitRefine (html.js)
- **Null-safe renders**: Guard all getElementById calls in render path with early-return on null (html.js)
- **Interval cleanup**: Clear all setInterval/setTimeout on beforeunload (html.js)

## Capabilities

### New Capabilities
- `robustness-core`: State CAS, atomic guards, timeout enforcement, silent-error elimination, null-safe rendering, double-submit prevention, interval cleanup, SSE message recovery

### Modified Capabilities

## Impact

- **Files changed**: state-unified.js, agent-process.js, sse.js, deploy-qa.js, deploy-prod.js, fetch-ticket.js, generate-code/index.js, server/html.js, claude.js, graceful-shutdown.js, local-repo.js, state-lock.js
- **No API changes**: All endpoints unchanged
- **No dependency additions**: Pure fixes to existing code
- **Risk**: Low-medium — each fix is isolated, testable independently
- **Pipeline stages affected**: fetch_ticket, deploy_qa, deploy_prod, generate_code (all made more resilient)
