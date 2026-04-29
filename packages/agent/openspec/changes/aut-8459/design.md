## Context

AUT-7382 introduced a multi-step Pan-level Filing wizard under the enterprise GST Return module. Step 2 requires the user to both (a) select PAN rows via checkbox and (b) mark each selected PAN as reviewed before Step 3 unlocks. The current implementation appears to evaluate the "advance" condition imperatively inside the `onReviewClick` handler, which means toggling selection *after* review does not re-run the guard — leaving the wizard stalled.

The repo uses the standard enterprise patterns: React Context + hooks for wizard state, `useGetDataApi`/`postDataApi` for API, styled-components for styling, and feature-local state hooks for step-specific data. No Redux.

## Goals / Non-Goals

**Goals:**
- Step-2 → Step-3 progression works regardless of the order of tick vs. review actions.
- Predicate is reactive in both directions (unticking or un-reviewing re-locks Step 3).
- Fix is localized to the Pan-level Filing Step-2 container/hook; no changes to shared stepper primitives.
- Existing state shape, component hierarchy, and styling remain unchanged.

**Non-Goals:**
- No UI/visual redesign of Step 2.
- No new wizard utilities or abstractions.
- No changes to shared components in `libs/components` (unless the root cause is proven to live there — which the analysis rules out).
- No changes to API contracts or server-side "reviewed" status handling.
- No changes to other wizard steps (Step 1, Step 3, Step 4 if any).

## Decisions

**Decision 1: Derived `useMemo` over imperative handler call.**
Replace any `goToStep(3)` / `setCanProceed(true)` call embedded inside `onReviewClick` with a `useMemo` that reads the PAN list and returns `canProceedToStep3 = panList.some(p => p.selected && p.reviewed)` (or whatever the existing threshold rule is — to be confirmed in-repo).
*Alternatives considered*: (a) duplicating the check into `onToggleSelect` too — rejected because it keeps the imperative smell and risks missing future handlers; (b) a `useEffect` watching `[panList]` — rejected because effects for derived values are an anti-pattern and slower than `useMemo`.

**Decision 2: Handlers become pure state mutators.**
Both `onToggleSelect(panId)` and `onMarkReviewed(panId)` only dispatch their respective state updates. Neither calls the wizard-advance API. The Next button / step indicator reads `canProceedToStep3` directly.
*Rationale*: Single source of truth, symmetric behavior, no stale-closure risk.

**Decision 3: Reuse the existing AUT-7382 state hook.**
Do not introduce a new hook or state slice. Locate the hook created in AUT-7382 (likely `usePanLevelFilingStep2` or similar) and modify it in place.
*Rationale*: Matches existing conventions; avoids parallel state sources.

**Decision 4: No changes to the shared wizard stepper.**
The shared stepper component in `libs/components` or the feature's stepper consumer should already accept a `canProceed` prop. The fix passes the new derived value to that prop. If the stepper imperatively calls `goToStep`, the fix lives in the consumer that owns the predicate — never in the shared primitive.

## Risks / Trade-offs

- **[Risk] Reverse-direction regression (untick after review, un-review after tick)** → Mitigation: predicate is a pure function of current state, so it naturally re-locks Step 3 when state degrades. Add explicit test cases for both reverse paths.
- **[Risk] Step-3 entry side-effects double-firing** → Mitigation: audit Step 3's `useEffect` init for idempotence; guard one-shot work (API preload, analytics) by checking it has already run, or key it on the first entry. Confirm "step_advanced" analytics fires exactly once per forward transition.
- **[Risk] Multi-PAN threshold ambiguity** → Mitigation: inspect the AUT-7382 implementation for the exact rule ("at least one", "all selected", etc.). Preserve it verbatim — do not invent a new rule.
- **[Risk] Shared stepper is actually the owner of the bug** → Mitigation: verify by reading the stepper's code before modifying the consumer. If shared, escalate before patching shared code.
- **[Trade-off] Derived re-computation on every render** → Acceptable; PAN list is small (tens of rows) and the predicate is O(n).

## Migration Plan

- No data migration. Pure client-side code change.
- Rollback strategy: revert the single PR. State shape is unchanged, so no reverse-migration needed.
- Deploy with existing enterprise release process; no feature flag required for a defect fix of this scope.

## Open Questions

- **Q1**: What is the exact threshold rule for Step 3 unlock — "at least one PAN selected + reviewed" or "all selected PANs reviewed"? Must be confirmed from AUT-7382 code before implementation.
- **Q2**: Does Step 3 entry trigger an API call or one-shot initialization that must remain single-fire? Needs to be audited for idempotence.
- **Q3**: Does the wizard persist step-2 state across refresh/navigation (localStorage, URL param, server)? If yes, confirm rehydration path triggers the derived predicate on mount.
- **Q4**: Is there an explicit "Next" CTA, or does Step 3 auto-open when the predicate becomes true? Impacts whether analytics fires on predicate change or on CTA click.