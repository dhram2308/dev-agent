## 1. Investigation

- [ ] 1.1 Locate the Pan-level Filing Step 2 container and its state hook/reducer in the enterprise app (search under `apps/enterprise/src/app/GSTReturn/` for Pan-level Filing / AUT-7382 feature files).
- [ ] 1.2 Identify the current "can proceed to Step 3" evaluation — confirm whether it lives in `onReviewClick`, a `useEffect` with incomplete deps, or elsewhere.
- [ ] 1.3 Read the AUT-7382 PR / commits to confirm the exact threshold rule (e.g., "at least one PAN", "all selected PANs") and the exact shape of the per-PAN state (`{ selected, reviewed }` or similar).
- [ ] 1.4 Verify whether the shared wizard stepper component (in `libs/components` or feature folder) owns the advance logic or only renders step UI driven by a `canProceed` prop from the consumer.
- [ ] 1.5 Audit Step 3 entry for one-shot side-effects (API preload, analytics, state init) and confirm idempotence or key them appropriately before changing the advance trigger.

## 2. Core Fix

- [ ] 2.1 In the Step-2 container / hook, add a `useMemo` that computes `canProceedToStep3` from the PAN list using the exact threshold rule confirmed in task 1.3.
- [ ] 2.2 Remove the imperative step-advance call from `onReviewClick` (or wherever it currently lives inside a handler).
- [ ] 2.3 Ensure `onToggleSelect` and `onMarkReviewed` only mutate the PAN list state — no calls to wizard-advance APIs.
- [ ] 2.4 Wire the derived `canProceedToStep3` value into the Next CTA's `disabled` prop or the stepper's `canProceed` prop (whichever pattern the existing screen uses).
- [ ] 2.5 Confirm the predicate re-locks Step 3 when state degrades (user un-ticks or un-reviews after the predicate was satisfied).

## 3. Side-effect and Telemetry Hardening

- [ ] 3.1 Verify "step_advanced" analytics event (if present) emits exactly once per forward transition — not duplicated across both action paths.
- [ ] 3.2 Confirm Step 3's mount-time side effects remain single-fire per entry (gate by existing idempotence checks or add one if missing).
- [ ] 3.3 If Pan-level Filing state persists across refresh, confirm rehydration on Step-2 mount correctly triggers the derived predicate.

## 4. Verification

- [ ] 4.1 Manual test — tick first → review second: Step 3 unlocks.
- [ ] 4.2 Manual test — review first → tick second: Step 3 unlocks (the previously broken path).
- [ ] 4.3 Manual test — after Step 3 unlocks, un-tick: Step 3 re-locks.
- [ ] 4.4 Manual test — after Step 3 unlocks, un-review: Step 3 re-locks.
- [ ] 4.5 Manual test — multiple PANs with mixed selected/reviewed states: predicate matches the established threshold rule.
- [ ] 4.6 Manual test — rapid tick + review clicks (batched render): predicate resolves correctly.
- [ ] 4.7 Manual test — navigate away from Step 2 and back: predicate reflects rehydrated state on mount.
- [ ] 4.8 Confirm no regressions in Step 1 and Step 3 flows, and no visual/layout changes on Step 2.
- [ ] 4.9 Run `nx lint enterprise` and `nx test enterprise` — both pass.
- [ ] 4.10 Build check: `nx build enterprise --configuration=production` succeeds.

## 5. Release

- [ ] 5.1 Link the fix commit/PR to AUT-8459 and reference parent AUT-7382.
- [ ] 5.2 Include the 7 manual test cases from section 4 in the PR description for QA verification.
- [ ] 5.3 Note in the PR that the fix is enterprise-only (VITE_PRODUCT_ID = enterprise), no flag, no migration.