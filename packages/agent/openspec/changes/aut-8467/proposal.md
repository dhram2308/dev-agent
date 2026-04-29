## Why

QA/Product observed that on the Compare Screen Step 3, the triple-dot action menu currently renders `View Data` before `Fetch Data`, which contradicts the intended workflow order (users fetch first, then view). Defect ticket AUT-8467 requires the two menu options to be reordered so users encounter actions in their natural sequence.

## What Changes

- Reorder the two items inside the triple-dot (kebab) action menu on Compare Screen — Step 3 so that `Fetch Data` renders first and `View Data` renders second.
- Preserve all existing props on both items: `onClick` handlers, `icon`, `disabled` conditions, permission guards, `key`, `aria-label`, and any `VITE_PRODUCT_ID` enterprise gating.
- Apply the reorder at the **caller** (Compare Step 3 container) — do not modify any shared menu component used by Step 1, Step 2, or other PAN-level Filing screens.
- Update any Compare Step 3 test selectors that rely on positional indexing (`nth-child`, `[0]`, `.first()`) to text-based queries so ordering changes remain decoupled from test stability.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `compare-screen-step3`: The triple-dot row action menu requirement changes to specify `Fetch Data` as the first option and `View Data` as the second option.

## Impact

- **Code**: One caller file inside `apps/enterprise/src/app/**/Compare/**` (Step 3 container) that defines the triple-dot menu items array / JSX.
- **Tests**: Any Cypress/Jest/RTL specs covering Compare Step 3 triple-dot menu that use positional selectors.
- **APIs**: None — no endpoint, payload, or field change.
- **State**: None — no store/reducer/hook changes.
- **Dependencies**: None.
- **Product gating**: Enterprise-only (`VITE_PRODUCT_ID`) — must remain unchanged.