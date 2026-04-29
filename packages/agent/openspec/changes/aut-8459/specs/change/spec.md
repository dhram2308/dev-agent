## MODIFIED Requirements

### Requirement: Pan-level Filing Step 2 to Step 3 progression

The Pan-level Filing wizard SHALL unlock and allow progression to Step 3 whenever the current PAN list state satisfies the existing completion predicate (each required PAN having `selected === true` AND `reviewed === true`), regardless of the order in which the user performs the selection and review actions.

The completion predicate MUST be a derived, reactive value computed from the PAN list state on every render. Individual action handlers (checkbox toggle, "Mark as Reviewed" click) MUST only mutate the shared PAN list state and MUST NOT imperatively trigger step advancement.

The predicate MUST re-evaluate in both directions: if the user un-ticks or un-reviews a PAN after Step 3 became available, Step 3 MUST re-lock synchronously.

#### Scenario: User ticks PAN checkbox first, then marks reviewed
- **WHEN** the user selects (ticks) a PAN checkbox on Step 2
- **AND** then clicks "Mark as Reviewed" on the same PAN
- **THEN** Step 3 SHALL become enabled and the user SHALL be able to proceed

#### Scenario: User marks reviewed first, then ticks PAN checkbox
- **WHEN** the user clicks "Mark as Reviewed" on a PAN on Step 2
- **AND** then selects (ticks) the PAN checkbox
- **THEN** Step 3 SHALL become enabled and the user SHALL be able to proceed

#### Scenario: User un-ticks a PAN after Step 3 became available
- **WHEN** Step 3 is enabled because the predicate is satisfied
- **AND** the user un-ticks (deselects) the PAN that satisfied the predicate
- **THEN** Step 3 SHALL re-lock and the user SHALL NOT be able to proceed until the predicate is re-satisfied

#### Scenario: User un-reviews a PAN after Step 3 became available
- **WHEN** Step 3 is enabled because the predicate is satisfied
- **AND** the user toggles the reviewed state back to false on the PAN that satisfied the predicate
- **THEN** Step 3 SHALL re-lock and the user SHALL NOT be able to proceed until the predicate is re-satisfied

#### Scenario: Multiple PANs with mixed states
- **WHEN** the PAN list contains multiple rows with varying combinations of `selected` and `reviewed` values
- **THEN** the completion predicate SHALL evaluate against the full list and reflect the existing threshold rule established in AUT-7382 (unchanged by this fix)
- **AND** toggling one PAN's state SHALL NOT corrupt the evaluation of the other PANs

#### Scenario: Rapid successive toggles in the same render tick
- **WHEN** the user performs both a tick toggle and a review toggle that are batched by React into a single render cycle
- **THEN** the predicate SHALL resolve to the correct value based on the final post-batch state
- **AND** Step 3 availability SHALL reflect that final resolved value

#### Scenario: Returning to Step 2 from navigation
- **WHEN** the user navigates away and returns to Step 2 with persisted PAN list state
- **THEN** the completion predicate SHALL re-evaluate on mount using the rehydrated state
- **AND** Step 3 availability SHALL reflect the rehydrated predicate value without requiring a further user action