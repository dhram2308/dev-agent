## MODIFIED Requirements

### Requirement: Compare Screen Step 3 Triple-Dot Action Menu Order

The Compare Screen — Step 3 per-row (and per-section, where applicable) triple-dot action menu SHALL render `Fetch Data` as the first option and `View Data` as the second option. All other existing properties of both options — `onClick` handler, icon, label text, `disabled` condition, permission guard, `VITE_PRODUCT_ID` enterprise gating, `key`, and `aria-label` — MUST remain unchanged. The reorder MUST be applied at the Compare Step 3 caller and MUST NOT modify any shared menu component used by other screens.

#### Scenario: Menu renders with both options visible and enabled
- **WHEN** a user opens the triple-dot menu on a Compare Step 3 row where both actions are permitted and enabled
- **THEN** the first menu item is `Fetch Data` and the second menu item is `View Data`
- **AND** clicking `Fetch Data` invokes the existing fetch-data handler with the unchanged API call, payload, loading, toast, and error behavior
- **AND** clicking `View Data` invokes the existing view-data handler opening the same screen/modal with the same props and state

#### Scenario: Menu renders in pre-fetch state
- **WHEN** a user opens the triple-dot menu on a Compare Step 3 row before data has been fetched
- **THEN** `Fetch Data` is the first menu item and is enabled
- **AND** `View Data` is the second menu item and its existing disabled/hidden condition is preserved exactly as before the reorder

#### Scenario: Menu renders in post-fetch state
- **WHEN** a user opens the triple-dot menu on a Compare Step 3 row after data has been fetched
- **THEN** `Fetch Data` is the first menu item with its existing state (enabled or conditionally disabled per prior rules)
- **AND** `View Data` is the second menu item and is enabled

#### Scenario: Menu renders with one option hidden by permission or feature flag
- **WHEN** a user opens the triple-dot menu on a Compare Step 3 row where permission/feature-flag logic hides one of the two options
- **THEN** the remaining visible option renders with its existing visibility rule unchanged
- **AND** no empty or placeholder menu slot is introduced by the reorder

#### Scenario: Keyboard navigation follows new visual order
- **WHEN** a user opens the triple-dot menu and uses Tab or arrow-key navigation
- **THEN** focus lands on `Fetch Data` first and then moves to `View Data`
- **AND** the screen reader announces `Fetch Data` before `View Data` using the existing unchanged `aria-label`s

#### Scenario: Enterprise product-ID gating is preserved
- **WHEN** the Compare Step 3 triple-dot menu is rendered in a non-enterprise product context
- **THEN** the existing `VITE_PRODUCT_ID` enterprise gating hides the menu exactly as it did before the reorder, with no new code path introduced

#### Scenario: Shared menu component used by other screens is unaffected
- **WHEN** the triple-dot menu is rendered on Compare Step 1, Compare Step 2, or any other PAN-level Filing screen
- **THEN** its item order remains whatever it was prior to this change
- **AND** no file inside a shared menu component is modified by this change