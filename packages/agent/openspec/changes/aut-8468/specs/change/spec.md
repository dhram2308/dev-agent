## MODIFIED Requirements

### Requirement: Wizard supports PANs with multiple GSTINs
The PAN-level Filing wizard SHALL correctly render every step for any PAN associated with one or more GSTINs. The wizard store SHALL persist the full list of GSTINs associated with the selected PAN as `selectedGstins: string[]`, and all downstream steps SHALL read from this shared slice rather than from step-local state.

#### Scenario: PAN with two GSTINs renders Step 4
- **WHEN** a user selects a PAN associated with exactly two GSTINs and advances to Step 4
- **THEN** Step 4 renders content for both GSTINs (no blank screen)
- **AND** the wizard store contains `selectedGstins` with both GSTIN values

#### Scenario: PAN with two GSTINs renders Step 5
- **WHEN** a user has completed Step 4 for a 2-GSTIN PAN and advances to Step 5
- **THEN** Step 5 renders content for both GSTINs (no blank screen)

#### Scenario: PAN with three or more GSTINs is supported
- **WHEN** a user selects a PAN with three or more associated GSTINs
- **THEN** Steps 4 and 5 each render content for every GSTIN in `selectedGstins`

#### Scenario: PAN with one GSTIN continues to work (no regression)
- **WHEN** a user selects a PAN with exactly one GSTIN
- **THEN** Steps 4 and 5 render the single-GSTIN content as before

#### Scenario: PAN with zero GSTINs shows empty state
- **WHEN** a user reaches Step 4 with `selectedGstins.length === 0`
- **THEN** Step 4 displays a visible empty-state message
- **AND** the wizard does NOT display a blank panel

### Requirement: Next button is gated by step validity
The wizard SHALL disable the "Next" button whenever the current step is not valid. Each step SHALL expose a validity selector (e.g., `isStep4Valid`, `isStep5Valid`) and the step-footer "Next" control SHALL bind its `disabled` prop to `!isStepValid(currentStep)`.

#### Scenario: Blank/empty step disables Next
- **WHEN** the current step has no rendered content or required data is missing
- **THEN** the "Next" button is disabled
- **AND** the user cannot advance to the following step

#### Scenario: Valid step enables Next
- **WHEN** the current step has loaded required data and all validation predicates return true
- **THEN** the "Next" button is enabled

#### Scenario: Zero-GSTIN PAN keeps Next disabled on Step 4
- **WHEN** a user reaches Step 4 with `selectedGstins.length === 0`
- **THEN** "Next" is disabled until the user returns to an earlier step and selects a PAN with at least one GSTIN

### Requirement: Step bodies are wrapped in an error boundary
Each step body in the PAN-level Filing wizard SHALL be rendered inside the enterprise `ErrorBoundary` component. A render failure inside a step SHALL display a visible error fallback with a "Go Back" action and SHALL log the failure to the project-standard telemetry (Sentry + `appLog`). The wizard chrome (step indicator, Back, Next) SHALL remain functional during a step-level error.

#### Scenario: Step render crash shows a visible fallback
- **WHEN** a step body throws during render
- **THEN** the error boundary displays a visible error message with a "Go Back" action
- **AND** the error is reported via the project's Sentry integration
- **AND** the wizard's Back and step-indicator controls remain operable

#### Scenario: Error fallback does not silently render blank
- **WHEN** any step encounters a render error
- **THEN** the UI MUST NOT present as an empty/blank panel

### Requirement: Changing PAN selection resets downstream wizard state
When a user navigates back to Step 3 and selects a different PAN, the wizard SHALL reset all Step-4-and-later draft state atomically via a slice reducer (not via component `useEffect`). Earlier step selections (Step 1–3) SHALL be preserved.

#### Scenario: Switching PAN clears stale multi/single-GSTIN state
- **WHEN** a user returns to Step 3 and selects a different PAN (e.g., switching from a 1-GSTIN PAN to a 2-GSTIN PAN)
- **THEN** `selectedGstins` is replaced with the new PAN's GSTIN list
- **AND** any Step 4 and Step 5 draft fields from the previous selection are cleared

#### Scenario: Earlier step selections survive PAN change
- **WHEN** a user changes the PAN at Step 3
- **THEN** selections made in Steps 1 and 2 remain intact

### Requirement: Step transitions are instrumented
The wizard SHALL emit an `appLog` breadcrumb on each step transition containing at minimum `{ step: number, panId: string | null, gstinCount: number }`.

#### Scenario: Step entry emits a log breadcrumb
- **WHEN** the user advances to any step in the wizard
- **THEN** an `appLog` entry is recorded with the step index, current PAN id, and GSTIN count

### Requirement: Fix is scoped to the enterprise product
All changes introduced by this capability SHALL be confined to the enterprise app and gated by the enterprise `VITE_PRODUCT_ID` constant. Sibling products (`edoc`, `arap`, etc.) SHALL NOT be modified.

#### Scenario: Non-enterprise builds are unaffected
- **WHEN** a non-enterprise product build runs
- **THEN** no code paths introduced by this change execute
- **AND** no sibling-product files are modified in this change