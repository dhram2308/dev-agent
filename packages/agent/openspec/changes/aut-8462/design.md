## Context

AUT-8462 is an intermittent defect on the Pan-level Filing wizard introduced under AUT-7382. Users report that on Next/Previous navigation, one or more fields on the destination step render blank. The non-deterministic nature points to a state-lifecycle race rather than deterministic logic error.

Current state (to be confirmed via code exploration):
- Wizard likely uses step components that mount/unmount on navigation.
- Form state likely managed via react-hook-form at step level, with a shared wizard store (Redux slice / Context / form root) at the parent.
- One or more of the following is the likely root cause:
  1. Step `useEffect`/`reset`/`defaultValues` overwriting hydrated values with empty defaults on remount.
  2. `onNext`/`onPrevious` not committing current field values to the store before unmount.
  3. Async prefill fetch resolving after step change and blanking the newly active step.
  4. Unstable `key` prop on the step container causing remount on unrelated re-renders.
  5. Multi-GSTIN PAN context where the active GSTIN is read before slice hydration.

Constraints:
- Diff must be minimal and match surrounding code style.
- Must not introduce new context providers, new store slices, new utilities, or new persistence mechanisms.
- Must not refactor any shared stepper primitive that other flows (IMS, Reco, GSTR1/3B) consume.
- Must follow project architecture rules (types in `libs/constants/src/models`, helpers in `libs/helpers`, hooks in `libs/hooks`, `@mi/*` aliases, `appLog` logger, no `any`, no `style={{}}`, etc.).
- Must use `VITE_PRODUCT_ID === ENTERPRISE_PRODUCT_ID` constant for any enterprise product gating (Z6).

Stakeholders: AUT-7382 owner, GST Filing squad QA, Enterprise app frontend team.

## Goals / Non-Goals

**Goals:**
- Zero data loss across any Next/Previous navigation sequence inside the Pan-level Filing wizard.
- Deterministic, reproducible behavior (no "random" blanking) under slow network, rapid clicks, and multi-GSTIN PANs.
- Minimal, surgical diff — change only the broken state-lifecycle logic.
- Regression test that codifies the contract.

**Non-Goals:**
- Redesigning the wizard, the store, or the form library.
- Introducing sessionStorage/localStorage draft persistence (out of scope; page-refresh recovery is already handled by existing draft restore or not supported — do not add new behavior).
- Fixing or refactoring other stepper flows (IMS, Reco, GSTR1/3B).
- Changing validation rules, API payload schemas, or field names.
- Adding a new wizard-state context provider or hoisting state beyond what already exists.

## Decisions

**D1: Fix at the state-lifecycle layer of the existing wizard — not at a new abstraction.**
- Chosen: Locate the existing wizard store/form root; correct mount-hydration, unmount-commit, and effect guards in-place.
- Alternatives rejected:
  - *New WizardStateContext provider* — violates reuse rule; adds surface area; risks coupling other steppers.
  - *sessionStorage draft layer* — out of scope; band-aid over the real race.
  - *setTimeout / defensive refetch loops* — explicitly prohibited by the approach guidance; hides the bug.

**D2: Commit-on-navigate, hydrate-on-mount, guard-on-effect.**
- `onNext` / `onPrevious` call `form.getValues()` (or equivalent) and dispatch to the wizard store BEFORE calling the step-change action.
- On step mount, if the store already has values for that step, call `form.reset(persistedValues)` (RHF) to rehydrate; otherwise use `defaultValues` once.
- Any `useEffect` that seeds fields from async data MUST check "is this field already populated / is form dirty" and MUST short-circuit if so. Use a run-once ref where the effect is meant to fire only on first mount of the wizard.
- Alternative rejected: *Keep all steps mounted with `display:none`* — suggested in analysis, but constitutes a structural change to the wizard; prefer the minimal per-step hydration fix first. Revisit only if hydration fix proves insufficient.

**D3: Abort in-flight fetches on step change.**
- Step-level fetch effects that seed fields MUST use `AbortController`; on cleanup, abort the request so a late response cannot overwrite the next step's state.
- Alternative rejected: *Ignore response if step changed* via ref — more code, same effect; `AbortController` is idiomatic and already used elsewhere in the codebase.

**D4: Audit `key` props before anything else.**
- First investigation step: confirm the step container's `key` is stable (step ID or index). If an unstable key is found (e.g., derived object identity, `Date.now()`), that alone may be the root cause and the other fixes become defensive hardening.

**D5: Regression test at the RTL level, not E2E.**
- Chosen: Jest + `@testing-library/react` test that mounts the wizard, fills step 1, clicks Next, clicks Back, asserts step 1 values are present.
- Alternative rejected: *Cypress E2E* — slower feedback, flakier, not needed to prove the lifecycle contract.

**D6: Respect project architecture rules during the fix.**
- No `any`, no `Record<string, unknown>[]`; reuse existing models in `libs/constants/src/models`.
- No inline `style={{}}`; no new styled-components unless rendering UI.
- Logging via `appLog` only; no `console.log`.
- Handlers use `on*` prefix (never `handle*`).
- Any enterprise-product gate uses the exact `VITE_PRODUCT_ID === ENTERPRISE_PRODUCT_ID` check (Z6).

## Risks / Trade-offs

- **[Risk] Reproduction gap — "random" symptom with no repro steps.** → Mitigation: before coding, request from reporter the exact sequence, affected fields, browser, GSTIN, and console/network logs. Review parent AUT-7382 PRD/Figma/Gemini links. Establish a reliable local repro (slow 3G + rapid Next/Back, multi-GSTIN PAN) before committing a fix.
- **[Risk] Fix masks the bug instead of resolving it** (e.g., defensive guard papers over a stale closure). → Mitigation: identify the single root cause (`key`, mount reset, unmount commit, or late async) and fix that; add guards only where a race is proven, not prophylactically.
- **[Risk] Touching shared stepper primitive breaks IMS/Reco/GSTR flows.** → Mitigation: scope changes strictly to Pan-level Filing wizard files; if a shared primitive needs change, audit all consumers and flag to the AUT-7382 owner first.
- **[Risk] React StrictMode double-invoke hides the bug in dev.** → Mitigation: verify fix in both dev (StrictMode on) and a production build.
- **[Risk] Rapid Next/Back clicks still blank a field if commit is async.** → Mitigation: commit step values synchronously (dispatch store update / `setValue` in shared form) before triggering the step transition; do not await anything before the transition.
- **[Risk] Async dropdown options remount with a user-selected value not in the reloaded list.** → Mitigation: keep the selected value as controlled form state regardless of options list; only clear on explicit user action.
- **[Trade-off] No sessionStorage persistence** means page-refresh still loses progress. Out of scope per analysis; document as known limitation for product.

## Migration Plan

- No data migration. Behavioral fix only.
- Deploy path: merge to `enterprise-ts` → standard Enterprise release.
- Rollback: revert the PR; no schema, API, or store-shape changes, so rollback is trivial.
- Feature flag: not required — fix corrects broken behavior with no user-visible surface change.

## Open Questions

- **Q1**: Which file/component is the Pan-level Filing wizard container? Likely `apps/enterprise/src/app/GSTReturn/**`; confirm via code exploration or with AUT-7382 owner before editing.
- **Q2**: Is step form state owned by react-hook-form per step, a shared RHF form at the wizard root, or a Redux/Context slice? The fix shape (RHF `reset` vs. store dispatch) depends on this.
- **Q3**: Does the wizard currently support draft-restore on reload? If yes, the fix should integrate with it; if no, refresh behavior stays out of scope.
- **Q4**: Is the specific field(s) that blank reported anywhere (e.g., period, GSTIN, amount)? Narrows the suspect effect.
- **Q5**: Are there known unstable `key` props in the stepper JSX? First thing to check.