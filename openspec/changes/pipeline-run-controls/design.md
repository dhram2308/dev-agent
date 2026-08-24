## Context

Two gaps were found by directly reading the pipeline and its UI, not by assumption:

1. **Stuck-stage detection is currently four independent, inconsistent implementations**: `health-monitor.ts` (30-minute threshold on `_lastStageChange`), `escalation.ts` (30-minute cooldown rule engine whose 4 rules don't match a plain `ETIMEDOUT`), a dead inline 10-minute calculation in `/api/state` (fetched by the frontend but never read — confirmed zero consumers), and `StuckBanner.tsx`'s own client-side per-stage-threshold recompute. None of the first three reach a real cause; only `StuckBanner.tsx` is what users actually see, and it has no actions, just text. `health-monitor.ts`'s `_serviceHealth` map is the one place that already preserves a real error message (`recordServiceFailure(name, err)`), but only from startup validation — mid-stage retries (e.g. `fetch-ticket.ts`'s own GitLab retry loop) never report into it.
2. **`explore_plan` unconditionally scaffolds OpenSpec** for every ticket via a single call, `scaffoldOpenSpec(TICKET)` at `packages/agent/src/stages/explore-plan.ts:728` — no flag, no opt-out. Auto-approval of gates already exists today as a frontend-only countdown timer (`GateApproval.tsx`) driven by four `AUTO_APPROVE_*` config keys with a real third state (`playground_validated`), not just on/off.

Both features were scoped after confirming, by reading the literal source, what already exists (reuse) versus what's genuinely missing (build).

## Goals / Non-Goals

**Goals:**
- Turn a stalled stage into an actionable decision (Keep Waiting / Retry Stage / Switch Model & Retry) driven by a real cause, not raw elapsed time.
- Let an operator choose, per install, whether `explore_plan` produces formal OpenSpec artifacts or a lighter direct plan — and see which mode is active everywhere it matters.
- Reuse every existing mechanism that already works (auto-approve countdown, `ConfirmDialog`, the `enum` config type, `/api/reset-stage`, `/api/reset` + `/api/start`) rather than building parallel new ones.
- Preserve today's behavior exactly by default — `DEVELOPMENT_ADVANCE_MODE` defaults to `openspec`, and Development Mode's "auto" preset never reaches the two production money gates.

**Non-Goals:**
- Fixing the pre-existing `mi:config-changed` dead SSE listener (cross-tab/external-edit config propagation) — same-tab propagation already works today via the existing Zustand store, which covers this change's primary UI-reflects-config requirement.
- A per-ticket override for Development Advance Mode — global-only in v1; deferred because the concurrency capability (`MAX_CONCURRENT_AGENTS`) is real but demand for *mixed-mode* concurrent tickets is unmeasured, and the plumbing touches a security field allow-list, not just a route.
- Porting or touching `packages/backend/src/pipeline/*` — confirmed dead via full production entry-point trace (the real dispatch is `packages/agent/src/server/agent-process.ts` spawning `run-agent.js`); its only importer anywhere in the repo is one integration-test mock, and it documents its own incompleteness inline.
- Extending Playground's `runExplorePlanLite()` to respect Advance Mode — it is already, by its own existing design comment, permanently OpenSpec-free; wiring in a mode toggle would mean building the exact machinery that sandbox exists to skip.
- Any change to Claude Code CLI's own `--permission-mode` flags — Development Mode stays a pipeline-level concept, decoupled from the CLI's own tool-permission gating.

## Decisions

**D1 — Cause classification lives on `health-monitor.ts`'s `_serviceHealth`, not `escalation.ts`'s rule engine.**
Alternative considered: extend `escalation.ts` (it already has a `pipeline_stuck` rule). Rejected — its 4 rules don't match a plain `ETIMEDOUT`, and its 30-minute cooldown can't re-fire responsively as retries happen. `_serviceHealth` already stores the raw error message per external service (`recordServiceFailure`); the only real gap is that it's fed only at startup, not from mid-stage retry loops. This is genuine new instrumentation (`fetch-ticket.ts`'s retry catch block must call `recordServiceFailure`), not free reuse.

**D2 — Switch Model & Retry is a per-ticket override, injected at spawn time, never a live hot-swap.**
`config-watcher.ts` only diffs `process.env` in the backend process and pushes an SSE event to the browser — it has no IPC into an already-running agent child process. A stuck child's model cannot change without killing it. So "Switch Model & Retry" is necessarily compound: write `state.data._modelOverride`, `POST /api/reset` (kill), `POST /api/start` with `mode: resume` (respawn with the override folded into the child's env at `agent-process.ts`'s `spawn()` call). Scoped per-ticket, not global `CLAUDE_MODEL`, so it doesn't affect other concurrently running tickets.

**D3 — Development Mode is a UI-only preset, not a new backend schema key.**
Alternative considered: a `DEVELOPMENT_MODE` config-schema key that `GateApproval.tsx`'s policy lookup falls back to. Rejected — the live policy lookup (`AUTO_APPROVE_CONFIG_KEY`) is a flat, direct map with zero precedent anywhere in the schema for a composite/fallback key, and introducing one invents a precedence question that doesn't need to exist ("what wins if the preset says auto but one granular key says manual?"). The preset simply calls the same generic field-writer (`updateField`) every other Automation-tab control already uses, writing exactly two of the four existing `AUTO_APPROVE_*` keys.

**D4 — Development Mode's "auto" never touches the two money gates.**
`AUTO_APPROVE_GATE_PREPROD_APPROVAL` / `AUTO_APPROVE_GATE_DUAL_APPROVAL` already exist, already default to `manual`, and are already independently settable — this change does not introduce the capability to auto-approve them, it inherits it, and deliberately keeps Development Mode's blast radius to the two non-production gates only.

**D5 — Development Advance Mode forks at exactly one call site, reusing the existing Architect Agent.**
Alternative considered: a new, separate "Direct Planner Agent." Rejected after reading the Architect Agent's prompt — the earlier Requirements Agent alone produces only a bullet list, not a usable standalone plan, whereas the existing Architect Agent already handles both structured and unstructured output (see the existing `artifacts ? ... : ...` fallback at `explore-plan.ts:824-840`, which already handles OpenSpec-parse-failure by falling back to raw prose). Direct mode reuses that exact Architect Agent, just without the 4-marker output contract, and without the `scaffoldOpenSpec()` call. This keeps the diff to the fork point, not a second agent implementation.

**D6 — Reuse the `explore_openspec = null` sentinel for Direct mode; disambiguate via the new `advanceMode` field, not a new sentinel shape.**
A non-empty sentinel (e.g. `{mode: 'direct'}`) would be a bug: it would satisfy `GateApproval.tsx`'s existing `openspecData && Object.keys(openspecData).length > 0` guard and render empty OpenSpec tabs for a ticket that never scaffolded any. `null` already means "nothing to show" everywhere it's read; the new `advanceMode` field is what distinguishes "Direct, by design" from "OpenSpec attempted, parse failed" in the UI and in Slack copy.

**D7 — Comparison direction: `=== 'direct'`, never `!== 'openspec'`.**
```js
if (state.data.advanceMode === 'direct') {
  // light path — skip scaffoldOpenSpec
} else {
  // today's unconditional OpenSpec path, byte-for-byte unchanged
}
```
An opt-in comparison means `undefined`, `null`, a typo, or any pre-existing ticket's state safely falls through to the already-proven OpenSpec path. The inverted form would silently activate the new, less-tested path for every ticket that predates this feature.

## Risks / Trade-offs

- **[Risk] Direct-mode plans may lack the `##` heading groups `generate_code`'s `parseTaskGroups()` looks for, losing parallel codegen** → **Mitigation**: this falls through to the existing single-agent sequential path, which is already a proven, non-crashing fallback (not new code) — worst case is slower codegen, not a broken one. The Direct-mode prompt keeps the "TASK GROUP SIZING" guidance that produces those headings, independent of the OpenSpec 4-marker contract that gets dropped.
- **[Risk] Killing and respawning a ticket for "Switch Model & Retry" loses any exploration-agent progress made so far in the killed process** → **Mitigation**: `POST /api/start mode: resume` picks up from the last persisted `state.stage`/`state.data`, same as any other resume; only in-memory work since the last state write is lost, which is already true of every crash/restart today.
- **[Risk] A ticket resumed after a later global `DEVELOPMENT_ADVANCE_MODE` config change could, in principle, see a different mode than it started with** → **Mitigation**: `state.data.advanceMode` is seeded once by `fetch_ticket` and is architecturally a one-shot stage (its handler never runs again for that ticket); every downstream reader must consult the persisted field, never `process.env`, directly — this is an implementation discipline enforced by review, not the runtime.
- **[Risk] The money-gate `riskLevel: "DANGEROUS"` badge fix could be read as implying those gates are newly dangerous** → **Mitigation**: proposal and UI copy make clear this exposes existing, already-possible-today risk (the keys and their default `manual` value are unchanged), not a new capability.
- **[Trade-off] No per-ticket Advance Mode override in v1** means an operator who wants two concurrently running tickets in different modes must change the global setting and start them sequentially. Accepted for v1 given no measured demand; the fork point (`explore-plan.ts:728`) and seeding site (`fetch-ticket.ts`) are exactly where a future per-ticket override would plug in, so this isn't a one-way door.

## Migration Plan

- `DEVELOPMENT_ADVANCE_MODE` ships with `default: "openspec"` and `hotReload: true` — existing installs see zero behavior change until an operator explicitly switches it.
- No database/state migration needed: `state.data.advanceMode` is additive and optional; tickets already in flight when this ships simply have it seeded on their next `fetch_ticket` pass (which, per D7's fallback direction, only ever happens once per ticket going forward — in-flight tickets past `fetch_ticket` at deploy time behave exactly as `openspec` mode, since the field stays `undefined` and every check defaults safely).
- The stuck-stage popup replaces `StuckBanner.tsx`'s render output at the same mount point (`App.tsx`) and the same trigger condition's data source is being upgraded (from raw `_lastActivity` to classified `_health.progress`) — rollback is reverting the component and the `health-monitor.ts` instrumentation independently, since they're separable.
- Rollback for Development Mode/Advance Mode: remove the two new Automation-tab controls and the `DEVELOPMENT_ADVANCE_MODE` schema key; the fork in `explore-plan.ts` is a single `if` block that can be reverted without touching any other stage.

## Open Questions

- Should Development Mode's "auto" preset gain a third state to match the real `playground_validated` policy, or stay a deliberate simplification over just the two extremes (`always`/`manual`)? This design assumes the latter — `playground_validated` remains a per-gate, power-user-only choice.
- Should the stuck-stage popup's "Switch Model & Retry" option be hidden entirely (not just de-emphasized) when the classified cause is `network`, since no model change fixes an unreachable GitLab host? This design assumes context-aware graying/hiding is a UI-layer decision, not a spec-level requirement.
