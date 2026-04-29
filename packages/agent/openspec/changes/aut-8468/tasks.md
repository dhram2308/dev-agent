## 1. Pre-implementation Investigation

- [ ] 1.1 Confirm whether `openspec/specs/pan-level-filing/` exists from AUT-7382; if absent, convert capability to ADDED in proposal/specs
- [ ] 1.2 Locate the PAN-level Filing wizard entry point in `apps/enterprise/src/app/` (likely under a PAN-Filing / GSTReturn folder); identify `FilingStepper.tsx`, Step 4, Step 5, and the wizard store slice
- [ ] 1.3 Audit Step 4 and Step 5 source for singular-GSTIN assumptions (`gstins[0]`, `selectedGstin`, destructuring that ignores index 1+)
- [ ] 1.4 Reproduce the bug in staging with a test user whose PAN has exactly two GSTINs; capture a HAR + store/redux trace at Step 3 → 4 → 5
- [ ] 1.5 Diff the backend envelope for a 1-GSTIN PAN vs a 2-GSTIN PAN at the Step 3 fetch endpoint; confirm with AUT-7382 backend owner whether the shape is identical
- [ ] 1.6 Locate the existing enterprise `ErrorBoundary` (search `libs/components` / `apps/enterprise`) and the existing step-validity pattern in sibling steppers; confirm names and import paths
- [ ] 1.7 Confirm (or resolve with product) Open Question Q1: UX for N>1 GSTINs (tabs vs. stacked cards vs. selector); default to stacked `.map` if unanswered
- [ ] 1.8 Verify the repo's existing E2E runner for the enterprise app and the location of existing `*-e2e` specs

## 2. Wizard Store Slice Changes

- [ ] 2.1 Update the wizard slice to persist `selectedPan` and `selectedGstins: string[]` (replace any singular `selectedGstin`)
- [ ] 2.2 Add a `panChanged` reducer that replaces `selectedGstins` and clears Step 4+ draft state atomically; preserve Step 1–3 selections
- [ ] 2.3 Add selectors `isStep4Valid` and `isStep5Valid` that return `false` when required slice data is missing/empty and `true` when all preconditions are met
- [ ] 2.4 Add a generic `isStepValid(step)` dispatcher used by the step footer
- [ ] 2.5 Add types/models for slice shape in `libs/constants/src/models` per `/arch-types` (no `any`)

## 3. Step 4 Fix

- [ ] 3.1 Refactor Step 4 to read `selectedGstins` from the wizard slice (no step-local state for GSTIN list)
- [ ] 3.2 Replace any `gstins[0]` / singular access with `.map(gstin => …)` over `selectedGstins`
- [ ] 3.3 Add explicit empty-state render for `!selectedGstins?.length`
- [ ] 3.4 Ensure per-GSTIN data fetches either accept a GSTIN array or are invoked per-GSTIN via the existing project API-hook pattern (no `useEffect` syncing — follow `/arch-api`)
- [ ] 3.5 Handle loading vs. empty vs. error states distinctly (no collapse to blank)
- [ ] 3.6 Move any inline styles to `Step4.styles.ts` using theme tokens per `/arch-styling`

## 4. Step 5 Fix

- [ ] 4.1 Refactor Step 5 to read `selectedGstins` from the wizard slice
- [ ] 4.2 Replace singular-GSTIN render paths with iteration over `selectedGstins`
- [ ] 4.3 Add empty-state render for zero GSTINs
- [ ] 4.4 Ensure Submit is blocked when any required per-GSTIN subsection is invalid (pending Open Question Q3 — default strict)
- [ ] 4.5 Move any inline styles to `Step5.styles.ts` using theme tokens per `/arch-styling`

## 5. Next-Button Gating

- [ ] 5.1 Locate the step footer / Next button component used by `FilingStepper.tsx`
- [ ] 5.2 Wire the Next button's `disabled` prop to `!isStepValid(currentStep)` using the slice selector
- [ ] 5.3 Rename any `handleNext` handlers to `onNext` per `/arch-code-quality` if encountered
- [ ] 5.4 Verify Back button and step-indicator behavior are unchanged

## 6. Error Boundary Integration

- [ ] 6.1 Wrap each step body rendered by `FilingStepper.tsx` in the existing enterprise `ErrorBoundary`
- [ ] 6.2 Ensure the boundary fallback shows a visible error message and a "Go Back" action
- [ ] 6.3 Confirm the boundary reports errors to Sentry (existing project integration)
- [ ] 6.4 Verify wizard chrome (step indicator, Back, Next) remains functional when a step body throws

## 7. Telemetry

- [ ] 7.1 Add `appLog` breadcrumbs on step entry with `{ step, panId, gstinCount }`
- [ ] 7.2 Add `appLog` on PAN change with `{ fromPanId, toPanId, toGstinCount }`
- [ ] 7.3 Verify log volume is reasonable and does not duplicate per render

## 8. Product Scope Guard

- [ ] 8.1 Confirm all modified files live under `apps/enterprise/` (no edits in `apps/edoc`, `apps/arap`, etc.)
- [ ] 8.2 Verify any runtime product check uses the enterprise `VITE_PRODUCT_ID` constant (Z6) — no magic strings
- [ ] 8.3 Run `nx lint enterprise` and confirm `@nx/enforce-module-boundaries` passes

## 9. Regression Tests

- [ ] 9.1 Add unit tests for `isStep4Valid` and `isStep5Valid` covering N=0, N=1, N=2, N=3 GSTIN cases
- [ ] 9.2 Add unit tests for the `panChanged` reducer (resets Step 4+ state, preserves Step 1–3)
- [ ] 9.3 Add component tests for Step 4 and Step 5 rendering with N=0 (empty state), N=1 (baseline), N=2 (repro), N≥3 (generalization)
- [ ] 9.4 Add component tests verifying Next is disabled when a step is invalid and enabled when valid
- [ ] 9.5 Add a Cypress E2E spec in the enterprise `-e2e` project: select a PAN with 2 GSTINs → progress Step 1 → Submit; assert no blank screens, correct GSTIN count rendered, Next gating behavior
- [ ] 9.6 Add a test covering the ErrorBoundary fallback path (simulate a throw in a step body; assert fallback + Back still work)

## 10. Verification and Rollout

- [ ] 10.1 Run `nx test enterprise` and `nx lint enterprise`; all green
- [ ] 10.2 Run E2E against the enterprise `-e2e` project; new spec passes
- [ ] 10.3 Manually verify in local HTTPS dev server (`nx serve enterprise`) with fixture PANs of 0, 1, 2, and 3 GSTINs
- [ ] 10.4 Run `/update-arch` (or the relevant sub-skills `/arch-styling`, `/arch-api`, `/arch-types`, `/arch-components`, `/arch-code-quality`) across changed files; address findings
- [ ] 10.5 Deploy to staging; monitor Sentry + `appLog` breadcrumbs for 48h; watch for any new ErrorBoundary-fallback error class
- [ ] 10.6 Close AUT-8468 with a link to the merged PR, regression spec, and the staging verification evidence