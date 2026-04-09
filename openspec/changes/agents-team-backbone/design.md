# Design: agents-team as Universal Agent Backbone

## Context

The pipeline has 19 `callClaude()` invocations. Three orchestrations use `runAgentsTeam()` (parallel agents with checkpoint/resume). The remaining 16 use raw `callClaude` — missing checkpointing, UI tracking, validation, and structured error handling.

## Architecture

```
                    ┌─────────────────────────────┐
                    │       callClaude()           │
                    │  (low-level CLI wrapper)     │
                    │  • spawn claude -p           │
                    │  • heartbeat, timeout, retry │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────┴───────────────┐
                    │      runAgentsTeam()          │
                    │  (parallel team orchestrator) │
                    │  • checkpoint/resume          │
                    │  • _active_agents tracking    │
                    │  • required/optional agents   │
                    │  • timing logs                │
                    │  + NEW: output validation     │
                    └──────────┬───────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     runAgentsTeam()    runSingleAgent()   runSingleAgent()
     (2+ agents)        (1 agent)          (1 agent)
              │                │                │
    ┌─────────┤         ┌─────┤          ┌─────┤
    │         │         │     │          │     │
 Analysis  Review     Gap   Browser   AC     Build
 Team(3)   Team(2)   Analysis Fix    Agent   Fixer
 Dev(N)               Agent  Agent
```

### `runSingleAgent` — The New Wrapper

Lives in `lib/agents-team.js`. Delegates to `runAgentsTeam` with a 1-agent team:

```
runSingleAgent({
  name,            // Agent display name
  prompt,          // Prompt string
  timeout,         // Timeout in ms
  opts,            // { cwd, maxTurns, allowedTools }
  state,           // Pipeline state (for checkpointing)
  checkpointKey,   // State key for caching result
  required,        // true = throw on failure, false = return null
})
→ Promise<string|null>   // Agent output or null if optional+failed
```

Internally:
```
runSingleAgent(args) {
  const result = await runAgentsTeam({
    teamName: args.name,
    agents: [{ ...args }],
    state: args.state,
    merge: (results) => results[0]?.output || null,
  });
  return result;
}
```

### Output Validation — Added to `runAgentsTeam`

In Phase 2 (after `callClaude` returns), before checkpointing:

```
const output = await callClaude(agent.prompt, agent.timeout, ...);
validateClaudeNotEmpty(output, agent.name);      // throws if < 20 chars
detectClaudeRefusal(output, agent.name);          // throws if refusal pattern
state.data[agent.checkpointKey] = output;         // checkpoint AFTER validation
```

If validation fails, agent is treated as "rejected" — `required: true` throws, `required: false` returns null. This protects ALL callers including the existing 3 team orchestrations.

### Checkpoint Key Strategy

#### Non-Loop Agents (one-shot)
Simple key per agent:
```
_architect_result          explore-plan.js Architect
_dev_single_result         developer.js single agent
_fixer_result              reviewer.js Fixer
_build_fix_result          build-check.js Build Fixer
_unit_test_gen_result      runtime-tests.js Unit Test Generator
_e2e_test_gen_result       runtime-tests.js E2E Test Generator
_test_fixer_result         runtime-tests.js Test Fixer
_test_fix_dev_result       runtime-tests.js Dev Test Fix
```

#### Loop Agents (retry-based)
Attempt-scoped keys to avoid stale cache across retries:
```
browser-verify.js:
  _gap_analysis_attempt_N     (N = 1, 2, 3)
  _gap_fix_attempt_N          (N = 2, 3)

ac-verification.js:
  _ac_agent_result            (single run, no loop key needed)
  _ac_fix_attempt_N           (N = 1, 2)
```

On each new loop iteration, the previous attempt's checkpoint is still in state (useful for debugging) but the new attempt key doesn't exist yet — so the agent runs fresh.

### AC Crash Fix

Current broken pattern:
```
catch (acErr) {
  state.data._ac_verified = true;          // BUG: false positive
  state.data._ac_verification = "skipped";
}
```

Fixed pattern:
```
// AC Agent via runSingleAgent({ required: false })
const acResult = await runSingleAgent({
  name: "AC Verification Agent",
  required: false,           // Don't halt pipeline on failure
  checkpointKey: "_ac_agent_result",
  ...
});

if (!acResult) {
  // Agent failed (crash/refusal/empty) — NOT verified
  logWarn("AC Verification Agent failed — will retry on next run");
  // DO NOT set _ac_verified = true
  // On restart: _ac_agent_result is null, _ac_verified is false → retries
  return fileChanges;
}

// Agent succeeded — process result
state.data._ac_verified = true;
state.data._ac_verification = acResult;
```

Key difference: `_ac_verified` is ONLY set when the agent actually returns a valid result.

### Browser-Verify Crash Fix

Same pattern:
```
// Gap Analysis via runSingleAgent
const gapOutput = await runSingleAgent({
  name: "Gap Analysis Agent",
  required: false,
  checkpointKey: `_gap_analysis_attempt_${attempt}`,
  ...
});

if (!gapOutput) {
  // Agent failed — not the same as "no gaps found"
  logWarn("Gap Analysis Agent failed — treating as inconclusive");
  overallVerdict = "SKIP";    // Still SKIP, but...
  state.data._browser_verify_skip_reason = "agent_failure";  // ...reason is tracked
  break;
}

// Agent succeeded — parse verdict
return parseGapAnalysisVerdict(gapOutput);
```

### Data Flow: `_active_agents` → Web UI

```
  runSingleAgent("Gap Analysis Agent")
       │
       ├─ state.data._active_agents = ["Gap Analysis Agent"]
       ├─ save(state) → disk
       │
       │  ┌─ server.js /api/state (5s poll) ─┐
       │  │  reads _active_agents              │
       │  │  renders sub-stage pills:          │
       │  │  [Browser Verify ◌ pulsing]        │
       │  │  Active: Gap Analysis Agent        │
       │  └────────────────────────────────────┘
       │
       ├─ callClaude(...) runs for 2 minutes
       │
       ├─ state.data._active_agents = []
       └─ save(state) → disk
```

No UI changes needed — `server/html.js` already reads `_active_agents` and matches against sub-stage labels (lines 2028-2035).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | `runSingleAgent` delegates to `runAgentsTeam` (not a separate code path) | Single source of truth for checkpoint, timing, active tracking logic |
| D2 | Output validation added to `runAgentsTeam` Phase 2 (not `callClaude`) | Validation is caller-context-dependent (agent name for error messages); `callClaude` stays a dumb pipe |
| D3 | Attempt-scoped checkpoint keys for loop agents | Prevents stale cache from previous attempt poisoning retries |
| D4 | `required: false` returns null (not empty string) | Callers can distinguish "agent failed" (null) from "agent returned empty" ("") |
| D5 | Don't migrate `legacy-codegen.js` | Rarely used path (cfg.localRepo=false); high effort, low value |
| D6 | Validation throws on refusal, warns on empty | Refusals indicate prompt/safety issues (must fix). Short outputs may be valid (warn only). |
| D7 | Fix AC crash behavior as part of migration (not separate) | The migration naturally fixes it — removing the bad catch block is part of converting to `runSingleAgent` |
| D8 | Keep `callClaude` signature unchanged | `runSingleAgent` is the new recommended API; `callClaude` is the escape hatch for special cases |

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Output validation false positive on short valid output | LOW | `validateClaudeNotEmpty` threshold is 20 chars. Shortest known valid output is Gap Analysis "OVERALL: PASS" (~50 chars). Safe margin. |
| Checkpoint state size growth | LOW | Agent outputs are 200-5000 chars typically. 13 new keys × 5KB = 65KB worst case. State pruning handles this. |
| `_active_agents` race condition with parallel agents | NONE | `runAgentsTeam` already handles this correctly with filter-based removal (lines 67, 77). `runSingleAgent` (1 agent) has no race. |
| Breaking developer.js retry logic | LOW | Developer retry uses a fresh prompt. The retry call gets its own `runSingleAgent` with a different checkpoint key (`_dev_retry_result`). No interaction with first attempt's checkpoint. |
