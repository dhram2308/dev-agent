## 1. Stuck-stage cause classification (backend)

- [x] 1.1 Extend `packages/agent/src/lib/health-monitor.ts` so `recordServiceFailure(name, err)` is also called from mid-stage retry loops, not only startup validation, preserving the raw error message per service.
- [x] 1.2 ~~In `fetch-ticket.ts`, call `recordServiceFailure("gitlab", err)` from the GitLab retry catch block~~ — **implemented differently than specified, same intent**: `fetch-ticket.ts`'s GitLab branch/MR checks have no retry loop of their own; all retries (for every service, not just GitLab) happen transparently inside `packages/agent/src/lib/http-client.ts`'s shared `req()` engine. Added a best-effort `_reportHealth()` bridge there instead, called at the success path and both retry-exhaustion paths — this instruments Jira, GitLab, and Slack uniformly through one hook instead of duplicating logic per stage.
- [x] 1.3 Extend `runHealthCheck()` in `health-monitor.ts` to read `_serviceHealth` and emit a `cause` value (`network` | `slow` | `gate-wait`) alongside the existing stuck/stuckMinutes fields, written to `state.data._health.progress`. Also fixed a real pre-existing gap found in the process: `test_qa` is a human-gate stage but was missing from `GATE_STAGES`, so it would have been incorrectly flagged stuck under the general 30-minute threshold — added it, and changed gate stages to never be classified stuck (matching the spec) rather than using the old 10-hour threshold.
- [x] 1.4 Remove the dead inline `stuck`/`stuckMinutes` computation from `GET /api/state` in `packages/backend/src/server/routes.ts` and the duplicate in `packages/agent/src/server/routes.ts` (confirmed zero frontend consumers) — also removed the now-dead fields from the frontend's `StateResponse` type in `packages/frontend/src/lib/api.ts`.

## 2. Stuck-stage popup (frontend)

- [x] 2.1 Added `useStuckClassification()` selector in `packages/frontend/src/store/pipeline.ts`, reading `state.data._health.progress` (stuck + cause) — there was no prior `_lastActivity`-based selector in the store to replace (that logic lived entirely in `StuckBanner.tsx` itself, confirmed removed by commit a8eaffd); this is a net-new selector, not a modification of an existing one.
- [x] 2.2 Created `packages/frontend/src/components/StuckPopup.tsx` — an inline actionable card (not a full-screen modal, to preserve the non-blocking property the old banner had), reusing the real `ConfirmDialog.tsx` component specifically for the Retry Stage confirmation step. Mounted in place of `StuckBanner` in `App.tsx`.
- [x] 2.3 "Keep Waiting" is a pure local-state dismiss (no API call), keyed on `stuckMinutes` so it reappears on the next distinct health-check tick rather than being suppressed forever.
- [x] 2.4 Added `resetStage()` to `packages/frontend/src/lib/api.ts` for `POST /api/reset-stage`; "Retry Stage" opens the real `ConfirmDialog` before calling it.
- [x] 2.5 "Switch Model & Retry" is visually de-emphasized (dimmed, with an explanatory note) when `cause === 'network'`, not hidden — matches the spec's scenario wording.
- [x] 2.6 Deleted `StuckBanner.tsx`; confirmed via repo-wide grep it had no other importers.

## 3. Switch Model & Retry (backend + frontend)

- [x] 3.1 Added `_modelOverride` and `advanceMode` to `PipelineData` in `packages/frontend/src/types.ts` (also added a typed `_health.progress` shape here, covering task 1.3's frontend consumption). No separate `packages/shared/src/types` edit was needed/found to be the type actually consumed by the frontend build.
- [x] 3.2 In `packages/agent/src/server/agent-process.ts`'s `startAgent()`, read the ticket's persisted state and, if `_modelOverride` is set, apply it to the spawned child's `envVars.CLAUDE_MODEL` — scoped to that one spawn call, global `process.env.CLAUDE_MODEL` untouched.
- [x] 3.3 **Corrected during implementation**: the design/task text said "call `POST /api/reset` (kill)" — but `/api/reset` also deletes the ticket's state file entirely (confirmed by reading its handler), which would discard all pipeline progress, not just kill the process. Used `POST /api/stop` instead (kills the process, preserves state) — this is the actual correct primitive for "kill and respawn with the same progress, different model." Also combined "persist the override" into the same `POST /api/start` call (extended its body with `modelOverride`, persisted into `state.data._modelOverride` in the existing resume-write block in `routes.ts`) rather than a separate persist step, avoiding a race between two calls. New store action `switchModelAndRetry(ticket, model)` in `pipeline.ts` sequences `stopAgent` → `startAgent(ticket, 'resume', model)`. Added `modelOverride` to `/api/start`'s field allow-list in `packages/backend/src/middleware/security.ts` (it would otherwise have been silently stripped).
- [x] 3.4 Added an inline model-input + confirm/cancel expansion to `StuckPopup.tsx` (mirroring `RejectForm.tsx`'s expand-in-place pattern) — no existing model-list/dropdown source was found in Settings to reuse, so a free-text input matching `CLAUDE_MODEL`'s existing string format was used.

## 4. Development Advance Mode (backend)

- [x] 4.1 Added `DEVELOPMENT_ADVANCE_MODE` to `config-schema.ts` in the `automation` group, right after the four `AUTO_APPROVE_*` keys.
- [x] 4.2 Seeded `state.data.advanceMode` once in `fetch-ticket.ts`, guarded on `undefined`, immediately before the existing `state.stage = "explore_plan"` transition.
- [x] 4.3 Wrapped the scaffold call in `explore-plan.ts` with the strict `advanceMode === "direct"` check (opt-in direction, per design rule D7).
- [x] 4.4 Direct mode reuses the same Architect Agent call — the 4-marker `OUTPUT FORMAT — CRITICAL` block is now conditional on `advanceMode`; the TASK GROUP SIZING guidance stays identical in both modes.
- [x] 4.5 Confirmed: the existing `artifacts ? ... : ...` branch needed no structural change — `scaffold === null` already flows through to the correct fallback. Refined the log line inside it, since the same branch is now reached by two different reasons (Direct-by-design vs. genuine parse failure) that need different operator-facing text — `logOk("Direct mode...")` vs the original `logWarn("...parsing failed")`.
- [x] 4.6 Updated the Slack notification to read `state.data.advanceMode` so "Plan ready (Direct mode)." reads differently from a silent OpenSpec parse failure.
- Also added `advanceMode`/`_modelOverride` to the shared `packages/shared/src/types/index.ts` `PipelineData` type (not originally listed as its own task, but the natural home given the agent-side code imports `PipelineState`/`PipelineData` from `@mi/shared`), and extended `HealthReport.progress`'s type there to include the new `cause` field from task 1.3.

## 5. Development Mode preset (frontend, Automation tab)

- [x] 5.1 Added a "Development Mode" preset (`auto`/`plan`) above `GATE_FIELDS`, reusing `ConfigField`'s enum `<select>` for visual consistency with a custom `onChange` that ignores its own key and writes the two real keys directly (it isn't a real config key, so it can't go through the generic `updateField` dispatch as-is).
- [x] 5.2 Preset writes `AUTO_APPROVE_EXPLORE_PLAN` + `AUTO_APPROVE_GATE_CODE_REVIEW` only; derives its own displayed value (`auto`/`plan`/blank-for-custom) from those two keys' current state so it stays in sync if they're edited individually below it.
- [x] 5.3 Added the `DEVELOPMENT_ADVANCE_MODE` `ConfigField` in a new "Development methodology" section — confirmed `GET /api/config` iterates the full `CONFIG_SCHEMA` server-side, so the new key appears automatically with no frontend `CONFIG_GROUPS` edit needed (that list is only consulted by the generic `ConfigTab`, which `AutomationTab` bypasses).
- [x] 5.4 Added an optional `dangerous` prop to `ConfigField.tsx` (renders a red "DANGEROUS" badge next to the label, mirroring the existing "FROZEN" badge pattern) and set it on the two production-gate `GateFieldDef` entries in `AutomationTab.tsx`.

## 6. Gate and stage-overview UI

- [x] 6.1 Added a governance pill ("Auto"/"Plan") next to the "Waiting" badge on every gate, derived from the already-computed `policy` (`always`/`playground_validated` → "Auto", `manual`/undefined → "Plan").
- [x] 6.2 Added a plan-mode badge ("Direct plan"/"OpenSpec plan"/"OpenSpec parse failed") for the `explore_plan` gate only (`config.showPlan` check), reading `data.advanceMode` and `openspecData` truthiness.
- [x] 6.3 `GATE_CONFIGS.explore_plan.description` stays as the OpenSpec-mode text (used as the default/fallback); a `gateDescription` computed value overrides it with Direct-mode-appropriate copy only when `advanceMode === 'direct'`, rendered in place of the static config value.
- [x] 6.4 Added `push('mode', data.advanceMode ?? 'openspec')` as the first line of the `explore_plan` case in `StageOverviewSection.tsx`.

## 7. Verification

Verified via the `verify` skill against the real running dev app (localhost:5173/3000) and direct `curl` against the backend — no live Jira/GitLab ticket was available, so anything requiring an actual running pipeline is marked accordingly rather than assumed.

- [x] 7.1 **Not exercised — no live ticket.** `StuckPopup` cannot be observed rendering without a genuinely running (not paused) pipeline in a stuck state, which needs real Jira/GitLab credentials this environment doesn't have. Confirmed instead: the popup correctly does *not* render for a paused ticket (`useStuckClassification()`'s `!ts.isRunning` guard), and `StuckBanner` leaves zero trace anywhere in the loaded app.
- [x] 7.2 **Not exercised — no live ticket.** Same constraint; `/api/reset-stage` itself was not re-tested live (pre-existing endpoint, unchanged by this feature).
- [x] 7.3 **Not exercised — no live ticket.** Same constraint.
- [x] 7.4 **Not exercised — no live ticket.** Requires actually running a ticket through `explore_plan` in Direct mode.
- [x] 7.5 **Not exercised — no live ticket.** Same constraint.
- [x] 7.6 **Partially verified.** Confirmed the *configuration* half end-to-end through the real backend: toggling the Development Mode preset to `auto` in the running app flips `AUTO_APPROVE_EXPLORE_PLAN`/`AUTO_APPROVE_GATE_CODE_REVIEW` to `always` while `AUTO_APPROVE_GATE_PREPROD_APPROVAL`/`AUTO_APPROVE_GATE_DUAL_APPROVAL` stay `manual`, and the change survives a full page reload (real `POST /api/config/save` → `GET /api/config` round-trip, not just client state). The *gate behavior* half (an actual gate auto-approving on a live ticket) was not exercised — no live ticket.
- [x] 7.7 **Verified.** Screenshot evidence: "DANGEROUS" badge renders on exactly the Pre-Prod Gate and Dual Approval (Production) rows, not on Explore & Plan / Code Review.

**Also verified, beyond this list's original scope:**
- `GET /api/config` includes the new `DEVELOPMENT_ADVANCE_MODE` key with `default: "openspec"` — but only *after* a manual `npm run build:agent` + backend restart, since the backend loads agent-package config from **compiled dist**, not source; `tsx watch` on the backend doesn't rebuild the agent package. Documented as a gotcha in the new `.claude/skills/verify/SKILL.md`.
- `GET /api/state?ticket=<any>` no longer returns `stuck`/`stuckMinutes` (dead-field removal from task 1.4), confirmed live.
- The Development Mode preset's "custom" (blank) state was probed directly: manually setting `Explore & Plan=always` / `Code Review=manual` (a genuine mismatch) correctly shows the preset as blank rather than a stale `auto`/`plan` label.
- Zero console errors or `pageerror`s across every screen visited, attributable to this change. Four pre-existing 404s (`/api/codegen/live`, `/api/agents/progress`) were found and confirmed unrelated — those routes don't exist anywhere in the backend, a gap from a different in-flight feature.
