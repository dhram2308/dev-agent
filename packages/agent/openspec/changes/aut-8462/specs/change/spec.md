## MODIFIED Requirements

### Requirement: Step Data Persistence Across Navigation

The Pan-level Filing wizard SHALL persist every field value entered on any step across Next and Previous navigation for the lifetime of the wizard session. The session ends only on successful submit, explicit cancel, or explicit reset. Step field values MUST NOT be lost due to component unmount, re-render, remount, async prefill, or rapid user navigation.

#### Scenario: Forward navigation preserves prior step values
- **WHEN** the user enters values on Step N and clicks Next to move to Step N+1
- **THEN** the wizard commits the current Step N values to the shared wizard state before Step N unmounts
- **AND** Step N+1 renders hydrated from the shared wizard state (including any values previously entered on Step N+1)
- **AND** no field on Step N+1 renders blank if a value for that field exists in shared state

#### Scenario: Backward navigation preserves entered values
- **WHEN** the user is on Step N and clicks Previous to return to Step N-1
- **THEN** Step N's current values are committed to shared state before Step N unmounts
- **AND** Step N-1 re-renders with the exact values the user last entered on Step N-1
- **AND** no default value, empty value, or async-fetched placeholder overwrites the user's previously entered value

#### Scenario: Rapid Next then Back does not blank fields
- **WHEN** the user enters values on Step N, clicks Next, and clicks Previous in rapid succession
- **THEN** Step N renders with the values the user last entered
- **AND** no in-flight async request from Step N+1 can overwrite Step N's state

#### Scenario: Step remount does not reset populated fields
- **WHEN** a step component remounts (due to key change, parent re-render, or navigation)
- **AND** the shared wizard state already contains values for that step
- **THEN** the step form hydrates from shared state via `reset(persistedValues)` (or equivalent)
- **AND** `defaultValues` / initial seed effects do NOT overwrite the hydrated values

#### Scenario: Async prefill does not overwrite user-edited values
- **WHEN** a step fetches prefill data asynchronously on mount
- **AND** the user has already edited one or more fields (form is dirty) or values exist in shared state
- **THEN** the async response MUST NOT overwrite those fields
- **AND** if the user navigates away before the response resolves, the fetch is aborted via `AbortController` and its result is discarded

#### Scenario: Step skipped by business rule retains visible step values
- **WHEN** a step is conditionally hidden by a business rule
- **AND** the user navigates past it and returns to a visible step
- **THEN** the visible step renders with all previously entered values intact

#### Scenario: Async-loaded dropdown options preserve user selection
- **WHEN** a step includes a dropdown whose options are loaded asynchronously (e.g., GSTIN list, period list)
- **AND** the user has previously selected a value from that dropdown
- **THEN** on remount, the selected value is preserved from shared state
- **AND** reloading the options list does NOT clear the user's selection

#### Scenario: Form reset only fires on explicit reset or successful submit
- **WHEN** the wizard mounts, a step mounts, or a step remounts
- **THEN** `form.reset()` to empty / default values MUST NOT fire automatically
- **AND** `form.reset(persistedValues)` with hydrated state MAY fire to rehydrate
- **AND** empty reset fires ONLY on an explicit user "Reset" action or successful final submit

#### Scenario: Stepper uses stable keys for step containers
- **WHEN** the wizard renders its step containers
- **THEN** each step container uses a stable key (step ID or index)
- **AND** no key is derived from `Math.random()`, `Date.now()`, or unstable object identity
- **AND** React does not unintentionally remount a step between renders

#### Scenario: Validation errors do not accompany blank fields for pre-filled values
- **WHEN** the user navigates to a step that was previously filled and validated
- **THEN** fields render with their previously entered values
- **AND** required-field errors are not shown for fields the user already filled

#### Scenario: Regression test verifies persistence contract
- **WHEN** an automated test mounts the Pan-level Filing wizard, fills Step 1 fields, clicks Next, then clicks Previous
- **THEN** Step 1 renders with all filled values present
- **AND** the test fails if any field on Step 1 is blank after the round-trip