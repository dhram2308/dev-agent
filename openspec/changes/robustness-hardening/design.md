## Context

The MI Dev Agent is a production pipeline automating Jira→Code→GitLab→QA→Production. Deep analysis found 36+ fragility points across 3 layers. This change addresses the 12 highest-impact vulnerabilities that can cause data loss, pipeline hangs, or UI crashes.

## Goals / Non-Goals

**Goals:**
- Prevent state file race conditions from losing gate approvals
- Prevent duplicate agent spawning from concurrent API calls
- Ensure SSE messages are never permanently lost
- Enforce timeouts on all blocking waits (CI pipeline, merge polls)
- Prevent double-submit of gate actions in the UI
- Make render path null-safe so one missing element doesn't crash the whole UI
- Make silent failures visible via proper logging
- Clean up browser resources on tab close

**Non-Goals:**
- Automatic production rollback (complex, separate change)
- Saga/compensation pattern (architectural shift, future work)
- Full idempotency keys for Jira/Slack (nice-to-have, separate)
- Chaos testing infrastructure

## Decisions

### Decision 1: State CAS via _seq comparison, not full locking redesign
Add a sequence number check on write: read current _seq from disk, compare with in-memory _seq, reject write if they diverge. This is simpler than redesigning the locking system and catches the specific race where two writers read old state then both write.

### Decision 2: Synchronous Set.add() for agent-start guard
JavaScript Set operations are synchronous and atomic within the event loop tick. Moving the `agentStartingSet.add(ticket)` to immediately after the guard check (same tick) prevents the race window.

### Decision 3: Log-level upgrades for catch{} blocks, not error throws
Silent catches should log at WARN level, not throw — they were silent for a reason (non-critical paths). But making them visible helps debugging without changing control flow.

### Decision 4: Frontend _gateActionInFlight flag for mutual exclusion
A single boolean flag set before any gate POST, cleared in finally block. Simpler than request deduplication and prevents approve+reject race.

### Decision 5: Defensive getElementById pattern
Use helper `_safeEl(id)` that returns element or logs and returns null. Wrap all render functions to early-return on null. Minimal code change, maximum crash prevention.

## Risks / Trade-offs

- **[Risk] CAS rejects legitimate writes during high contention** → Mitigation: CAS only logs warning and retries once, doesn't hard-fail
- **[Risk] CI timeout may kill a pipeline that would have succeeded** → Mitigation: Default timeout is generous (30 min), configurable via env var
- **[Risk] Null-guard early-returns may hide real template bugs** → Mitigation: Log missing elements at WARN level so they're visible in dev
