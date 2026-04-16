## Context

After the TS/React migration, the React UI and the new backend HTTP/SSE stack replaced a single server-rendered `html.ts` UI. The audit (see session notes above this file and the archived `unified-ts-migration` change) identified the regressions grouped below. Fixes must be small, independently revertable, and shippable on `enterprise-ts-AUT-8457` as a single feature branch.

## Goals

- **Correctness first.** Approvals, refines, skip-stage, and SSE review events all work end-to-end.
- **No leaks.** EventSource listeners and global `hashchange`/`error-overlay` timers clean up.
- **Parity with the legacy UI** for the features operators use every day (agent activity, sub-stage progress, `f` shortcut, diff file search, log export).
- **Safety on large diffs.** Warn before the React renderer tries to display 50 000+ line diffs.
- **Keep the diff small.** Prefer editing existing components and stores over introducing new abstractions.

## Non-Goals

- Full rewrite of the audit's 12 medium-priority items (timer reset, ConnectorCard validation, etc.) — defer to follow-up changes
- Re-designing the settings page, notification matrix, or connector UX — out of scope for AUT-8457
- Wiring in the 11 dead endpoints — we delete them instead, to match the actual UI surface
- Porting CSP / CSRF hardening — tracked separately

## Decisions

### D1: API sanitizer schemas get new optional fields rather than loosening validation
Adding `mode: { type: 'string', allowed: ['resume', 'fresh'] }` to `/api/start` and `confirm: { type: 'boolean', required: true }` to `/api/skip-stage` keeps sanitizer coverage strong. The frontend is updated to always send `confirm: true` for skip-stage (the UI already confirms with a modal), and we document that `/api/refine` requires `gate` from the active gate.

Rejected alternative: drop strict validation and let handlers cope. That was the pre-sanitizer failure mode; it leaked into the review flow and is why the bug exists today.

### D2: SSE listeners are tracked in a ref and removed on close
The existing `useSSE.ts` attaches via `es.addEventListener('log', handler)` and never removes. We collect the `(event, handler)` pairs into a ref array and iterate it in `closeEventSource()`. This is the minimal fix — no hook refactor needed — and it eliminates reconnect-time accumulation.

### D3: `review` SSE event drives a lightweight invalidation, not a re-fetch
The backend already broadcasts the full new state via `state` events after approve/reject/refine. The new `review` listener only calls `pipelineStore.clearActiveGate(ticket)` and forwards the payload to any currently-mounted `GateApproval` so the modal closes immediately without waiting for the (potentially same-tick) `state` rebroadcast.

### D4: Sub-stage progress is data-driven, not hard-coded
`AgentStatus` reads `state.data._sub_stage` (already set by `stages/generate-code`) and maps it to a horizontal pill strip (`write → review → fix`). If `_sub_stage` is missing we render nothing — no layout shift.

### D5: Large-diff warning threshold = 5 000 lines total
Across all hunks of all files. Below threshold we render immediately. At/above we render a skeleton + modal offering "Render anyway" (stores the user's choice per-ticket in sessionStorage so it doesn't nag on tab-switch). Threshold chosen to match the legacy `html.ts:6420` behavior.

### D6: Log export is a client-side blob download
No backend changes. `LogViewer` serializes the currently-filtered log buffer to text and triggers a `<a download>` click. Filename: `{ticket}-logs-{timestamp}.txt`.

## Risks

- **Sanitizer change rollout.** Adding fields to `/api/start` + `/api/skip-stage` schemas is additive; no existing caller is rejected. Low risk.
- **SSE ref in React strict mode.** `useEffect` fires twice in dev with strict mode; the close path must be idempotent. We already handle this (null-check + close only if non-null).
- **Large-diff modal regression.** If a real MR sits just under 5 000 lines the modal won't appear; we can dial the threshold down if operators report jank.
- **Sub-stage field absence on older agent runs.** Resumed pipelines from before `_sub_stage` was set will render the base stage only. Acceptable.

## Rollout

1. Contract fixes (D1) — ship together in one commit so the sanitizer and the FE callers land atomically
2. SSE fixes (D2, D3) — second commit
3. State-store dedup / monotonic guard — third commit
4. UI parity (activity bar, sub-stage, shortcut, file search, log export, large-diff warning) — one commit per component to keep the revert blast radius small
5. Dead endpoint deletion — last commit after all UI changes land, so reverting the UI work is easy

## Open Questions

- **None blocking.** Resolved during the audit: dead endpoints are truly unreferenced by the React UI; frontend `api.ts` exports `getState` / `getReviewData` for debug purposes and is kept.
