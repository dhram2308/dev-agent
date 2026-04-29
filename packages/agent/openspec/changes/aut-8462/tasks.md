## 1. Reproduction & Scoping

- [ ] 1.1 Request reproduction details from the AUT-8462 reporter: exact step sequence, affected fields, browser, user/GSTIN, console and network logs, whether reload was involved
- [ ] 1.2 Review AUT-7382 linked PRD, Figma, and Gemini discussions for the expected per-step data-persistence contract
- [ ] 1.3 Confirm the Pan-level Filing wizard file/component location in `apps/enterprise/src/app/GSTReturn/**` and identify the stepper container and step components
- [ ] 1.4 Establish a reliable local reproduction (slow 3G throttle + rapid Next/Back + multi-GSTIN PAN) before changing any code

## 2. Root-Cause Investigation

- [ ] 2.1 Audit the stepper JSX for `key` prop stability on step containers; flag any `Math.random()`, `Date.now()`, or unstable object-identity keys
- [ ] 2.2 Identify where step form state lives (react-hook-form per step, shared RHF root, or Redux/Context slice) and document the current flow
- [ ] 2.3 Trace `onNext` and `onPrevious` handlers to confirm whether current step values are committed to shared state BEFORE the step unmounts
- [ ] 2.4 Enumerate every `useEffect` / `reset` / `defaultValues` / `setValue` call in step components; classify each as "seeds fields" and check guard logic
- [ ] 2.5 Identify async prefill fetches on step mount; check whether a late response can overwrite user-edited values or values on a different step after navigation
- [ ] 2.6 Confirm scope: verify the stepper is NOT a shared primitive consumed by IMS, Reco, or other GSTR flows. If shared, flag to AUT-7382 owner before editing
- [ ] 2.7 Narrow to the single root cause (key instability, mount reset, missing unmount commit, or late async race) and document the finding

## 3. Fix Implementation

- [ ] 3.1 If an unstable `key` is found, replace it with a stable step ID / index
- [ ] 3.2 Update `onNext` and `onPrevious` handlers to synchronously commit current step values to the shared wizard state before triggering the step transition
- [ ] 3.3 On step mount, hydrate the step form from shared wizard state via `form.reset(persistedValues)` (or equivalent) when persisted values exist
- [ ] 3.4 Remove or guard any `useEffect` that seeds fields with defaults/empty values on every mount; use existence checks or a run-once ref so it only fires on initial wizard load
- [ ] 3.5 Add `AbortController` to step-level prefill fetch effects; abort in the cleanup function so late responses cannot overwrite the next step's state
- [ ] 3.6 Ensure async-loaded dropdown options do not clear a previously selected value held in shared form state
- [ ] 3.7 Confirm `form.reset()` to empty values fires ONLY on explicit user "Reset" action or successful final submit — nowhere else

## 4. Architecture Compliance

- [ ] 4.1 Use project path aliases (`@mi/*`) for all imports — no relative imports across libs
- [ ] 4.2 Ensure no `any` or `Record<string, unknown>[]` types are introduced; reuse existing models in `libs/constants/src/models`
- [ ] 4.3 Use `appLog` (from `@mi/services`) for any diagnostic logging — no `console.log`
- [ ] 4.4 Ensure all new/modified handlers use the `on*` prefix (never `handle*`)
- [ ] 4.5 Do not add inline `style={{}}`; if any styling changes are needed, extend existing `*.styles.ts` with theme tokens
- [ ] 4.6 Do not introduce a new context provider, store slice, hook, or utility — reuse existing wizard state
- [ ] 4.7 If any enterprise-product gating is touched, use the exact `VITE_PRODUCT_ID === ENTERPRISE_PRODUCT_ID` constant (Z6)
- [ ] 4.8 Run `nx lint enterprise` and resolve any violations introduced by the fix

## 5. Testing & Verification

- [ ] 5.1 Add a Jest + RTL regression test: mount the wizard, fill Step 1, click Next, click Previous, assert Step 1 values persist
- [ ] 5.2 Extend the regression test to cover rapid Next → Back → Next clicks; assert last-entered values win
- [ ] 5.3 Manually verify: Step N → N+1 → N, values preserved (all field types: text, select, date, checkbox/radio, file reference)
- [ ] 5.4 Manually verify under slow 3G throttle that async prefill does not blank user-edited values
- [ ] 5.5 Manually verify on a multi-GSTIN PAN account that switching between steps preserves values for each GSTIN slice
- [ ] 5.6 Manually verify: navigating past a conditionally hidden step and back preserves visible-step values
- [ ] 5.7 Manually verify: async-loaded dropdown (e.g., GSTIN, period) keeps user-selected value across step remount
- [ ] 5.8 Verify the fix in both dev (React StrictMode on) and a production build
- [ ] 5.9 Run `nx test enterprise` and confirm all tests pass, including the new regression test
- [ ] 5.10 Confirm no other stepper flow (IMS, Reco, other GSTR flows) is behaviorally affected

## 6. Delivery

- [ ] 6.1 Self-review the diff: minimal surface area, matches surrounding code style, no unrelated refactors, no dead code, no commented-out code
- [ ] 6.2 Link the PR to AUT-8462 and reference parent AUT-7382; include the reproduction steps and the verified fix scenario in the PR description
- [ ] 6.3 Hand off to QA with the full verification matrix from Section 5 (slow 3G, rapid clicks, multi-GSTIN PAN, conditional steps, async dropdowns, StrictMode)