## Why

Operators running tickets through the pipeline have no way to intervene when a stage stalls (e.g. ticket AUT-9773's `fetch_ticket` stage hung for 5+ minutes on an unreachable GitLab host) beyond reading raw logs by hand, and no way to choose a lighter-weight planning flow for tickets that don't need formal OpenSpec artifacts — every ticket unconditionally goes through the full OpenSpec scaffold in `explore_plan`, and a stuck stage only ever shows a passive, non-actionable banner. Both gaps were confirmed by direct reads of `packages/agent/src/stages/explore-plan.ts`, `packages/frontend/src/components/StuckBanner.tsx`, and the pipeline health-monitoring code — not assumed.

## What Changes

- Replace the text-only stuck-stage banner with an actionable popup offering **Keep Waiting**, **Retry Stage**, and **Switch Model & Retry**, gated on a real cause classification (network/timeout vs. slow-but-alive vs. waiting-on-a-gate) instead of raw elapsed time.
- Unify stage-health signal onto `health-monitor.ts`'s `_serviceHealth` map (extended to also record failures from mid-stage retry loops, not just startup validation) as the single source of truth; retire the dead, zero-consumer `/api/state` `stuck`/`stuckMinutes` field and `StuckBanner.tsx`'s independent client-side threshold calculation.
- Wire up the existing but currently-uncalled `POST /api/reset-stage` endpoint as the "Retry Stage" action, behind a confirmation dialog.
- Add a per-ticket model override (`state.data._modelOverride`) so "Switch Model & Retry" only affects the affected ticket, not the global `CLAUDE_MODEL` setting — implemented as a kill (`POST /api/reset`) + respawn (`POST /api/start`, `mode: resume`) with the override injected into the child process's env, since no live hot-swap of a running child's model is possible.
- Add a **Development Mode** preset (`auto`/`plan`) to the Settings → Automation tab — a UI-only convenience that writes the two existing `AUTO_APPROVE_EXPLORE_PLAN` / `AUTO_APPROVE_GATE_CODE_REVIEW` config keys, deliberately never touching the two production money gates (`AUTO_APPROVE_GATE_PREPROD_APPROVAL` / `AUTO_APPROVE_GATE_DUAL_APPROVAL`), which stay independently settable.
- Add a **Development Advance Mode** setting (`direct`/`openspec`, new global config key, default `openspec`) that forks pipeline behavior at the single unconditional `scaffoldOpenSpec(TICKET)` call in `explore-plan.ts`. `openspec` mode is today's exact behavior, byte-for-byte unchanged. `direct` mode skips the OpenSpec CLI scaffold and reuses the existing Architect Agent (minus its 4-marker output contract) to produce a plain-text plan.
- Surface both settings' effect in the UI: a governance pill ("Auto"/"Plan") on every gate, a plan-mode badge ("Direct plan"/"OpenSpec plan") on the `explore_plan` gate, and a mode row in the stage-overview panel — reusing existing visibility guards and badge patterns rather than inventing new ones.
- Fix a pre-existing bug surfaced during investigation: `GateApproval.tsx`'s `explore_plan` gate description is a hardcoded string that always says "...and OpenSpec artifacts," which becomes false in Direct mode.
- Fix a second pre-existing gap surfaced during investigation: the two money-gate config keys are already tagged `riskLevel: "DANGEROUS"` in the schema, but that metadata is silently dropped by `ConfigField.tsx` today with no visual warning — add a visible badge.

No **BREAKING** changes — `DEVELOPMENT_ADVANCE_MODE` defaults to `openspec`, which is byte-for-byte identical to current unconditional behavior, and the stuck-stage popup only replaces a passive banner with an actionable one on the same trigger condition.

## Capabilities

### New Capabilities
- `stuck-stage-recovery`: Cause-classified detection of a stalled pipeline stage, and an actionable popup (Keep Waiting / Retry Stage / Switch Model & Retry) driven by that classification, with a per-ticket model override mechanism.
- `development-run-modes`: Two Settings-driven controls — Development Mode (gate auto-approve preset) and Development Advance Mode (direct vs. OpenSpec planning) — including how each is configured, propagated, and reflected in the pipeline and gate UI.

### Modified Capabilities
(none — no existing `openspec/specs/` capability covers pipeline stage behavior or gate approval today; both are net-new)

## Impact

- **Backend**: `packages/agent/src/lib/health-monitor.ts` (extended failure recording), `packages/agent/src/stages/fetch-ticket.ts` (mid-stage failure reporting, `advanceMode` seeding), `packages/agent/src/stages/explore-plan.ts` (the direct/openspec fork), `packages/agent/src/server/agent-process.ts` (per-ticket env overrides for both `_modelOverride` and `advanceMode`), `packages/agent/src/lib/config-schema.ts` (new `DEVELOPMENT_ADVANCE_MODE` key), `packages/backend/src/server/routes.ts` (wiring up `/api/reset-stage`, no changes needed to `/api/start`'s existing `mode: resume` path).
- **Frontend**: `packages/frontend/src/components/StuckBanner.tsx` → new `StuckPopup.tsx` (built on `ConfirmDialog.tsx`'s existing pattern), `packages/frontend/src/components/GateApproval.tsx` (governance pill, plan-mode badge, mode-aware description), `packages/frontend/src/components/settings/AutomationTab.tsx` (Development Mode preset, Development Advance Mode select), `packages/frontend/src/components/StageOverviewSection.tsx` (mode row), `packages/frontend/src/components/settings/ConfigField.tsx` (dangerous-risk badge).
- **Explicitly not touched**: `packages/backend/src/pipeline/*` (confirmed dead — unreachable from the real production entry point, alive only in one integration test), `packages/agent/src/playground-runner.ts`'s lite explore-plan (intentionally OpenSpec-free by existing design, independent of this change), the `mi:config-changed` SSE listener gap (pre-existing, affects only a second open browser tab or an external `.env` edit — same-tab propagation already works via the existing settings store).
- **GitLab constraint**: the stuck-stage classification's "network" cause is tuned around this environment's internal GitLab server (`http://10.200.11.32`), which is known to be prone to `ECONNRESET`/`ETIMEDOUT` — the real trigger case for this proposal.
