## Why

In the Pan-level Filing wizard (Step 2), the transition to Step 3 is order-dependent: it only works when the user clicks "Mark as Reviewed" first and then ticks the PAN checkbox. The reverse order (tick first, then review) leaves the wizard stuck on Step 2, blocking users from completing their filing workflow. This is a regression from AUT-7382 caused by the step-advance check being coupled to a single handler instead of being a derived reactive computation.

## What Changes

- Convert the "can proceed to Step 3" check from an imperative call inside the `onReviewClick` handler into a derived value (`useMemo`) computed from the PAN list state on every render.
- Ensure both the checkbox `onChange` handler and the "Mark as Reviewed" `onClick` handler only mutate the shared PAN list state — neither triggers step advancement directly.
- Make the Step-3 unlock reactive in both directions: unticking or un-reviewing after the predicate became true must re-lock Step 3.
- Preserve all existing gating rules (both `selected === true` AND `reviewed === true` required); no new validation introduced.

## Capabilities

### New Capabilities
<!-- None — this is a bug fix inside an existing feature -->

### Modified Capabilities
- `pan-level-filing`: Step-2 → Step-3 progression predicate becomes order-independent and reactive to all PAN-row state changes.

## Impact

- **Affected code**: Pan-level Filing Step 2 container and its state hook/reducer inside the enterprise app (`apps/enterprise/src/app/GSTReturn/.../PanLevelFiling/Step2/` or the AUT-7382 feature folder — exact path to be confirmed during implementation).
- **Affected APIs**: None. Client-side state defect only.
- **Affected dependencies**: None.
- **Affected users**: All enterprise users filing via Pan-level Filing flow (AUT-7382).
- **Product scope**: Enterprise only (VITE_PRODUCT_ID = enterprise). No multi-product branching.
- **Telemetry**: Verify "step_advanced" analytics event is emitted exactly once per transition after the fix (not double-fired from both handlers).