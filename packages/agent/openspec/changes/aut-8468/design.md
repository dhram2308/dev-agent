## Context

AUT-7382 introduced PAN-level Filing as a multi-step wizard in the Enterprise app. A PAN may have 1..N associated GSTINs; the wizard fetches GSTINs after PAN selection (Step 3) and threads them into Steps 4 and 5. AUT-8468 reports that selecting a PAN with exactly two GSTINs renders blank screens at Step 4 and Step 5 while leaving the "Next" control enabled — user can walk forward through empty states unimpeded.

Current state (inferred, pending source audit):
- Wizard state likely tracks a singular `selectedGstin` rather than `selectedGstins: string[]`, or Steps 4/5 read `gstins[0]` instead of mapping.
- "Next" button has no step-validity gate (always enabled).
- Step bodies are not wrapped in an error boundary, so a render throw degrades to a blank panel rather than a visible error with recovery.
- No telemetry on step transitions, so the regression escaped QA silently.

Constraints:
- Enterprise-only fix; must respect `VITE_PRODUCT_ID` enterprise constant (Z6).
- Reuse existing patterns (`@mi/components`, `@mi/hooks`, `useGetDataApi`, styled-components `.styles.ts`, `AppTable`/`AppForm`, `appLog`).
- No new test runners, state libraries, or icon sets.
- No backend contract change — align to the existing AUT-7382 API envelope.

Stakeholders: Enterprise filing users (multi-GSTIN PANs), QA, product (AUT-7382 owner), backend team (contract confirmation only).

## Goals / Non-Goals

**Goals:**
- Step 4 and Step 5 render correctly for any PAN with N≥1 GSTINs (explicit repro: N=2).
- "Next" button is disabled whenever the current step is not valid/ready.
- Render failures inside a step surface as a visible error with a "Go Back" action — never a blank panel.
- Wizard state survives step navigation; PAN re-selection resets draft cleanly.
- Telemetry captures step + GSTIN count on every transition.
- Regression test permanently prevents recurrence for the 2-GSTIN path.

**Non-Goals:**
- Redesigning the wizard, stepper chrome, or step-indicator visuals.
- Touching Steps 1–3 beyond the PAN-change reset hook.
- Changing the backend contract or adding new API endpoints.
- Replicating the fix into sibling products (`edoc`, `arap`) — those flows are out of scope unless later tickets demand it.
- Introducing Redux, Zustand, or any new state management.
- Replacing Cypress/Jest with alternate runners.

## Decisions

**D1. Store the full `selectedGstins: string[]` in the wizard slice.**
*Why*: Root cause is almost certainly a singular-GSTIN assumption. An array is the minimum faithful representation of the PAN→GSTIN relationship and directly matches the backend shape.
*Alternatives considered*:
- (a) Keep singular `selectedGstin` and render Step 4/5 per-GSTIN tabs driven by a separate fetch — rejected: duplicates state, invites drift.
- (b) Store as `Record<string, GstinDraft>` keyed by GSTIN — rejected: premature for this fix; array + selectors covers every scenario today.

**D2. Gate "Next" via per-step validity selectors (`isStep4Valid`, `isStep5Valid`).**
*Why*: Explicit selectors are testable, co-located with the slice, and reuse the pattern already present in sibling steppers in `libs/components` / `apps/enterprise`.
*Alternatives considered*:
- (a) Embed validity inside each step component and bubble via callback — rejected: scatters logic, hard to test, couples footer to step internals.
- (b) Formik/AntD Form validation only — rejected: step readiness is broader than form validity (includes data-loaded, non-empty GSTINs, etc.).

**D3. Wrap each step body in the existing enterprise `ErrorBoundary` (search `libs/components` / `apps/enterprise`).**
*Why*: Turns silent blank panels into diagnosable, recoverable errors. Using the existing boundary guarantees consistent fallback styling and telemetry.
*Alternatives considered*:
- (a) Single boundary around the whole wizard — rejected: one broken step would unmount the stepper chrome, losing "Back" and progress.
- (b) Custom boundary per step — rejected: redundant; reuse existing component.

**D4. Reset wizard draft on PAN change via a slice reducer (`panChanged`), not via component `useEffect`.**
*Why*: Matches the project rule (`/arch-api`): no `useEffect` syncing state that can be derived/reduced. Guarantees atomic reset.

**D5. Telemetry via `appLog` on step transitions; no new logger.**
*Why*: `appLog`/`appInfo` are the project-standard logging surfaces. Keeps changes minimal and aligns with `/arch-code-quality`.

**D6. Regression test uses the repo's existing Cypress `-e2e` project.**
*Why*: The repo already has `*-e2e` projects; no new runner needed. Keeps CI surface unchanged.

**D7. Defer any multi-GSTIN UX decision (tabs vs. aggregated list vs. per-GSTIN cards) until product confirms** (acceptance criteria were empty on the ticket).
*Why*: The defect is "renders nothing" — fixing the data-shape bug + empty-state is table-stakes; the visual treatment of N>1 GSTINs is a product call. Implement a safe, iterable default (`.map` over `gstins` rendering the existing per-GSTIN subcomponent) and flag in PR for product review.

## Risks / Trade-offs

- **[Backend envelope differs for N>1 GSTINs]** → Mitigation: before coding, fetch a real N=2 response in staging; diff against N=1 envelope; align slice shape to the actual response. Loop in backend owner of AUT-7382 if divergence found.
- **[ErrorBoundary masks regressions too well]** → Mitigation: boundary fallback MUST log to Sentry (existing integration) with step + PAN + GSTIN count; not a silent catch.
- **[Over-reset on PAN change destroys user work]** → Mitigation: reducer resets only Step 4+ draft; Step 3 selection survives. Add scenario test for "change PAN → earlier steps preserved".
- **[Scope creep into AUT-7382 feature]** → Mitigation: PR touches only Step 4, Step 5, store slice, step footer, and wires an existing ErrorBoundary. Any refactor of Steps 1–3 is a separate ticket.
- **[Regression in single-GSTIN path]** → Mitigation: regression matrix covers N=0 (empty state + Next disabled), N=1 (baseline), N=2 (repro), N≥3 (generalization). All must pass before merge.
- **[Product scope bleed across apps]** → Mitigation: all code gated by enterprise `VITE_PRODUCT_ID` constant per Z6; import guard checked via `@nx/enforce-module-boundaries` and reviewed in PR.

## Migration Plan

1. **Pre-work**: reproduce in staging with a test user on a 2-GSTIN PAN; capture HAR + redux/store trace at Step 3 → 4 → 5.
2. **Ship** behind existing enterprise product gate — no feature flag needed (it's a defect fix).
3. **Rollback**: single revert of the PR; store shape change is backward-compatible read (array falls back to `[]`), so in-flight drafts are not corrupted by rollback.
4. **Monitor**: Sentry + `appLog` breadcrumbs on step transitions for 48h post-deploy; watch for any new error class from the ErrorBoundary fallback.

## Open Questions

- **Q1**: How should Step 4 and Step 5 visually represent N>1 GSTINs — per-GSTIN tabs, stacked cards, or a GSTIN selector dropdown? **Owner**: product (AUT-7382 PM). **Default if unanswered**: stacked per-GSTIN subcomponents via `.map` (matches current single-GSTIN shape repeated N times).
- **Q2**: Does the backend return the same envelope for 1-GSTIN vs N-GSTIN PANs? **Owner**: backend on AUT-7382. **Blocker**: yes — must resolve before slice shape is finalized.
- **Q3**: Should Step 5 Submit be blocked if any GSTIN sub-section is invalid, or allow partial submission? **Owner**: product. **Default**: block (stricter, safer, reversible in a follow-up).
- **Q4**: Does `openspec/specs/pan-level-filing/` already exist from AUT-7382? If not, this change creates the capability spec rather than modifying it.