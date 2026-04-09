# Proposal: agents-team as Universal Agent Backbone

## Problem

19 `callClaude()` invocations across the pipeline. Only 3 go through `runAgentsTeam()` (explore-plan Analysis Team, developer Task Groups, reviewer Review Team). The remaining 16 raw calls are missing:

1. **Per-agent checkpointing** — crash during a 10-minute Fix Agent loses all work; full re-run on restart
2. **`_active_agents` UI tracking** — Web UI shows zero agent-level progress during 12+ minute operations
3. **Output validation** — 8 of 16 raw calls have zero validation; Claude refusals silently become agent "output"
4. **Required vs optional semantics** — errors either throw (halting pipeline) or catch-and-continue (silently skipping); no middle ground
5. **Structured timing logs** — no start/complete/elapsed logging for most agent calls
6. **Complexity-aware timeouts** — 1 call uses hardcoded 120s regardless of ticket complexity

### Critical Safety Bug

`ac-verification.js` line 121: when `callClaude` throws (CLI crash, timeout), the catch block sets `_ac_verified = true` — marking AC as verified when it wasn't. On restart, the skip guard sees `_ac_verified = true` and never retries. Code ships without AC verification.

Same pattern in `browser-verify.js`: crash returns `{ overall: "SKIP" }` — indistinguishable from intentional "can't verify". Observer can't tell if verification ran or crashed.

## Solution

Add a thin `runSingleAgent()` wrapper (~5 lines) that delegates to existing `runAgentsTeam` infrastructure with a single-agent team. Then migrate 13 high-value raw `callClaude` sites to use it.

Every call automatically gets: checkpoint/resume, `_active_agents`, timing logs, and consistent error semantics. Output validation (`validateClaudeNotEmpty` + `detectClaudeRefusal`) added to `runAgentsTeam` itself so ALL 19 calls benefit.

### What Changes

| Layer | Change |
|-------|--------|
| `lib/agents-team.js` | Add `runSingleAgent()` wrapper + output validation in agent completion path |
| `stages/generate-code/browser-verify.js` | 2 raw calls → `runSingleAgent` |
| `stages/generate-code/ac-verification.js` | 2 raw calls → `runSingleAgent` + fix crash behavior |
| `stages/generate-code/runtime-tests.js` | 4 raw calls → `runSingleAgent` |
| `stages/generate-code/build-check.js` | 1 raw call → `runSingleAgent` |
| `stages/explore-plan.js` | 1 raw call (Architect) → `runSingleAgent` |
| `stages/generate-code/developer.js` | 2 raw calls (single + retry) → `runSingleAgent` |
| `stages/generate-code/reviewer.js` | 1 raw call (Fixer) → `runSingleAgent` |
| `lib/constants.js` | ~10 new checkpoint keys in STAGE_CLEARS |

### What Doesn't Change

- `runAgentsTeam()` API — fully backward compatible
- `callClaude()` — unchanged, still the low-level primitive
- `legacy-codegen.js` — low priority (rare path, cfg.localRepo=false)
- Existing 3 `runAgentsTeam` callers — untouched

## Scope

- **In scope**: `runSingleAgent` wrapper, output validation in agents-team, 13 call-site migrations, AC crash fix, STAGE_CLEARS additions
- **Out of scope**: `legacy-codegen.js` (5 calls, rarely used path), sequential mode for agents-team, UI changes (existing `_active_agents` rendering already works)

## Risks

| Risk | Mitigation |
|------|------------|
| Breaking existing `runAgentsTeam` callers | Output validation is additive — only warns on empty, throws on refusal. Existing callers already produce non-empty non-refusal output. |
| Checkpoint key collisions | Use unique, descriptive keys per agent per module (e.g., `_gap_analysis_result`, `_ac_agent_result`) |
| State size growth from checkpointing agent outputs | Outputs already exist in memory; checkpointing to disk adds ~2-10KB per agent. State pruning handles cleanup. |
| Over-aggressive validation on short outputs | `validateClaudeNotEmpty` threshold is 20 chars — safe for all known agents. Gap Analysis outputs are 200+ chars minimum. |
| Retry logic interaction with checkpointing | Loop-based agents (browser-verify, ac-verification) use attempt-scoped checkpoint keys (`_gap_result_attempt_1`) so retries don't read stale cache. |
