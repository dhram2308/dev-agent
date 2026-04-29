## Why

A critical defect (AUT-8468) blocks PAN-level Filing for any PAN associated with two or more GSTINs: Steps 4 and 5 of the wizard render a blank screen, yet the "Next" button stays enabled, allowing users to progress through broken states and potentially submit invalid data. This regresses the multi-GSTIN contract established in AUT-7382 and must be fixed before customers with multi-GSTIN PANs (a common real-world shape) can complete filing.

## What Changes

- Fix Step 4 and Step 5 rendering in the PAN-level Filing wizard to correctly iterate over the full `gstins: string[]` array (currently collapses to `gstins[0]` / singular value).
- Persist `selectedPan` **and** full `selectedGstins: string[]` in the wizard store slice; stop relying on step-local state that drops on navigation.
- Add per-step validity selectors (`isStep4Valid`, `isStep5Valid`) and wire the wizard's "Next" button `disabled` prop to `!isStepValid(currentStep)`.
- Wrap each step body in the existing enterprise `ErrorBoundary` with a visible fallback + "Go Back" action so render crashes never present as a silent blank panel again.
- Reset wizard draft state cleanly when the user changes PAN selection (prevent stale single-GSTIN state leaking into a newly selected multi-GSTIN PAN).
- Add breadcrumb logging (`appLog`) on step transitions capturing `{ step, panId, gstinCount }` for recurrence detection.
- Add a regression spec covering the PAN-with-2-GSTINs path through Step 1 → Submit.
- **Scope guard**: all changes confined to `apps/enterprise` and gated by the enterprise `VITE_PRODUCT_ID` constant; sibling products (`edoc`, `arap`) remain untouched.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `pan-level-filing`: wizard Step 4/5 MUST render for N≥1 GSTINs; "Next" MUST gate on per-step validity; wizard store MUST persist the full GSTIN array; step bodies MUST be error-bounded.

> Note: if `openspec/specs/pan-level-filing/` does not yet exist (AUT-7382 may have shipped without a spec), promote this to a **New Capability** of the same name and convert MODIFIED deltas to ADDED.

## Impact

- **Code**: `apps/enterprise/src/app/<PAN-Filing wizard path>/FilingStepper.tsx`, Step 4 & Step 5 component files, wizard store slice, per-step validity selectors, step-footer/Next button wiring.
- **Libs**: reuse existing `ErrorBoundary`, `appLog`, and any `isStepValid` pattern from sibling steppers in `libs/components` / `apps/enterprise`; extend — do not fork — the current PAN-filing service.
- **APIs**: no contract changes; verify backend returns a consistent envelope for 1-GSTIN vs N-GSTIN PANs (align with AUT-7382 SDD before coding).
- **Tests**: new regression spec using the repo's existing E2E runner (Cypress, per `-e2e` projects); no new test framework.
- **Telemetry**: non-breaking `appLog` additions only.
- **Out of scope**: Steps 1–3, sibling products, stepper redesign, backend changes.