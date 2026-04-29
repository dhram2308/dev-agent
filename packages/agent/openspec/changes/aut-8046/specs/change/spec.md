## MODIFIED Requirements

### Requirement: Mismatch remarks column SHALL display all detected mismatch reasons

The consolidated reconciliation sheet's "Mismatch Remarks" column SHALL render every mismatch reason detected for a record. When the backend returns one or more mismatch codes on a record, the UI SHALL map each code to its human-readable label via the canonical `mismatchStatusFields` dictionary and concatenate the labels as a comma-separated string. The column SHALL apply consistently across all reconciliation types that use the bucket table or IMS list view (GSTR-2B vs PR, IMS vs PR, 2A vs PR, and any other reconciliation surface consuming the same column pattern).

#### Scenario: Record with a single mismatch reason
- **WHEN** the backend returns `mismatch_status: 'INT'` (or `['INT']`) for a row
- **THEN** the "Mismatch Remarks" cell renders `Note Type Mismatch`

#### Scenario: Record with multiple mismatch reasons
- **WHEN** the backend returns `mismatch_status: ['TVD', 'TRD', 'INT']`
- **THEN** the "Mismatch Remarks" cell renders `Taxable Value Mismatch, Tax Amount Mismatch, Note Type Mismatch` (comma-separated, deduplicated, backend order preserved)

#### Scenario: Record with duplicate codes from backend
- **WHEN** the backend returns `mismatch_status: ['INT', 'INT', 'TVD']`
- **THEN** the cell renders `Note Type Mismatch, Taxable Value Mismatch` (duplicates collapsed)

#### Scenario: Record with no mismatches
- **WHEN** `mismatch_status` is empty, `null`, `undefined`, or an empty array
- **THEN** the "Mismatch Remarks" cell is blank (preserves existing repo convention; code `M` continues to render `Matched` for matched rows)

#### Scenario: Record with an unknown backend code
- **WHEN** the backend returns a code not present in `mismatchStatusFields` (e.g., `mismatch_status: ['NEWCODE']`)
- **THEN** the cell renders the raw code `NEWCODE` (fallback) rather than silently dropping it, so operators can detect backend additions

#### Scenario: Backend returns a plain string rather than an array
- **WHEN** the backend returns `mismatch_status: 'INT'` as a string (legacy shape)
- **THEN** the renderer normalizes it to `['INT']` and produces the same output as the array form

### Requirement: Backend code `INT` SHALL map to the label "Note Type Mismatch"

The canonical label for backend mismatch code `INT` SHALL be `Note Type Mismatch` across every surface that consumes the mismatch-code dictionaries: the consolidated bucket/reco column, the Ledger view, the Mismatched Document view, bucket badges, and the Mismatch Type filter dropdowns. The dictionaries `mismatchStatusFields` (in `libs/constants/src/db/reco/RecoConst.tsx`) and `mismatchStatusCodeName` (in `libs/entp/src/lib/reconcile/Ledger/LedgerData.tsx`) SHALL both carry the label `Note Type Mismatch` for key `INT`. The `bucketFilterData` option arrays (`commonMismatch`, `NoteType`, and any other occurrence) SHALL use the label `Note Type Mismatch` for `value: 'INT'`.

#### Scenario: Consolidated column reads the new label
- **WHEN** a reconciliation row contains code `INT`
- **THEN** the "Mismatch Remarks" column displays `Note Type Mismatch` (not `Invoice Type Difference`)

#### Scenario: Ledger view reads the new label
- **WHEN** a Ledger/Mismatched Document screen renders a row with code `INT`
- **THEN** the screen displays `Note Type Mismatch`

#### Scenario: Mismatch-type filter dropdown reads the new label
- **WHEN** the user opens the Mismatch Type filter in a bucket view
- **THEN** the option whose underlying value is `INT` is labeled `Note Type Mismatch`

#### Scenario: Filter selection and column display agree
- **WHEN** the user selects `Note Type Mismatch` from the filter
- **THEN** the filtered rows show `Note Type Mismatch` in their Mismatch Remarks cell

### Requirement: Mismatch-remarks renderer SHALL be defensive against input shape and unknown codes

The renderer for the `mismatch_status` column SHALL normalize input defensively and SHALL NOT throw or silently drop data when the input is null, undefined, a single string, an empty array, contains duplicates, or contains codes unknown to the dictionary.

#### Scenario: Null or undefined input
- **WHEN** `mismatch_status` is `null` or `undefined`
- **THEN** the renderer produces an empty cell and does not throw

#### Scenario: Mixed known and unknown codes
- **WHEN** `mismatch_status: ['INT', 'UNKNOWN_CODE', 'TVD']`
- **THEN** the cell renders `Note Type Mismatch, UNKNOWN_CODE, Taxable Value Mismatch`