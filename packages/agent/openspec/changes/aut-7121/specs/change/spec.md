### specs/invalid-invoice-correction/spec.md

## ADDED Requirements

### Requirement: Error Log Action on Invalid Invoice Row
The system SHALL display an "Error Log" action on every row of the Invalid Invoice listing screen. Clicking it SHALL open a read-only structured view of all validation errors for that invoice, grouped into invoice-level errors and item-level errors (per line-item index).

#### Scenario: User opens Error Log for an invalid invoice
- **WHEN** the user clicks the Error Log icon on an invalid invoice row
- **THEN** the system displays a modal or panel showing every validation error grouped as "Invoice Errors" and "Line Item N Errors", each error showing field name and message
- **AND** no editing affordances are available in this view

#### Scenario: Error Log is always available even when Edit is disabled
- **WHEN** an invoice has an error whose code is in `EDIT_DISABLING_ERROR_CODES` (see EC-03 / EC-04 / EC-05)
- **THEN** the Edit icon for that row is disabled with a tooltip "Please convert this invoice to valid through the upload."
- **AND** the Error Log icon remains enabled and clickable

### Requirement: Edit Invoice Drawer
The system SHALL open a right-side drawer when the user clicks Edit on an invalid invoice row. The drawer SHALL display, top-to-bottom: total error count banner, MI Smart Assist toggle, invoice-level fields (dynamic per Invoice Category), editable item-level table, and a Submit button.

#### Scenario: User opens Edit drawer for an invalid invoice
- **WHEN** the user clicks the Edit icon on an invalid invoice row whose error codes are NOT in `EDIT_DISABLING_ERROR_CODES`
- **THEN** the system opens a right-side drawer pre-filled with the invoice data
- **AND** the drawer header shows "Total Errors: N" where N is the count of errors in `errorsByPath`
- **AND** invoice-level fields are rendered in the order defined by `INVOICE_CATEGORY_FIELDS[invoice.category]`
- **AND** an editable line-item table is rendered below the invoice-level fields

#### Scenario: Edit icon is disabled for fatal error codes (EC-03 / EC-04 / EC-05)
- **WHEN** an invoice has at least one error with code in `EDIT_DISABLING_ERROR_CODES`
- **THEN** the Edit icon on that row is disabled
- **AND** hovering it shows the tooltip "Please convert this invoice to valid through the upload."

### Requirement: Error Field Visual Treatment and Suggestions
The system SHALL highlight every field present in `errorsByPath` with a red border and display the error message as a tooltip on hover and on keyboard focus. Error fields SHALL support both manual text input and a suggestion dropdown.

#### Scenario: Error field shows red border and tooltip
- **WHEN** a field's `field_path` is present in `errorsByPath`
- **THEN** the field is rendered with a red border
- **AND** hovering the field shows a tooltip with the error message
- **AND** keyboard-focusing the field surfaces the same message inline for a11y

#### Scenario: Error field suggestion dropdown (per-invoice mode)
- **WHEN** an error field is rendered and MI Smart Assist is OFF
- **THEN** the dropdown shows distinct values for that field path collected from across the invoice's own line items
- **AND** the user can also type a free-form manual value

#### Scenario: Error field suggestion dropdown (Smart Assist mode)
- **WHEN** MI Smart Assist toggle is ON and the suggestions endpoint is available
- **THEN** the dropdown shows org-wide historical values for that field ranked by descending usage frequency
- **AND** each option displays "{value} [used {count} times]"
- **AND** the user can also type a free-form manual value

### Requirement: Line Item Management Inside Drawer
The system SHALL allow the user to add new line items, edit existing items, and delete items from within the Edit drawer. Invoice totals SHALL recalculate on every change.

#### Scenario: User adds a new line item
- **WHEN** the user clicks "Add Line Item" inside the drawer
- **THEN** a new empty row is appended to the item table
- **AND** invoice-level totals (taxable, CGST, SGST, IGST, CESS, invoice_value) are recalculated

#### Scenario: User deletes a line item
- **WHEN** the user clicks the Delete icon on a line item row
- **THEN** the row is removed
- **AND** invoice-level totals are recalculated
- **AND** any errors keyed on `items[<deletedIndex>].*` are removed from `errorsByPath`; remaining item errors are re-indexed

### Requirement: EC-01 Auto-injected Invoice Status on Submit
The system SHALL inject `invoice_status = "add"` into the Update & Validate Invoice payload on every Submit. This field MUST NOT be user-editable.

#### Scenario: Submit payload contains injected invoice_status
- **WHEN** the user clicks Submit
- **THEN** the request payload includes `invoice_status: "add"` regardless of any UI state
- **AND** no UI control exposes `invoice_status` to the user

### Requirement: EC-02 Auto-fill from Expected Value
When the server returns a `ValidationError` with a non-null `expected_value`, the system SHALL pre-populate the corresponding field with that value on drawer open. The field SHALL remain editable, and a one-time inline notice SHALL inform the user of the auto-fill.

#### Scenario: Server returns expected_value, frontend auto-fills field
- **WHEN** the drawer opens and `errorsByPath["items[0].sgst_amount"]` has `expected_value = 18.0`
- **THEN** the field is pre-populated with `18.0`
- **AND** an inline notice reads "Pre-filled from system suggestion. Edit if incorrect."
- **AND** the field remains editable

### Requirement: Submit Pipeline
The system SHALL enable the Submit button only when `errorsByPath` is empty. On click, it SHALL call the Update & Validate Invoice API. On success, it SHALL optimistically remove the row from the Invalid listing, refresh the Valid/Invalid/Duplicate summary, close the drawer, and show a success toast. On failure with a structured error payload, it SHALL replace `errorsByPath` with the server response, keep the drawer open, scroll to the first error, and show a failure toast.

#### Scenario: Submit button is gated by error map
- **WHEN** `errorsByPath` has at least one entry
- **THEN** the Submit button is disabled

#### Scenario: Successful submission moves invoice to Valid
- **WHEN** the user clicks Submit and the API returns 200
- **THEN** the row is optimistically removed from the Invalid listing
- **AND** the Valid/Invalid/Duplicate counters on the parent screen are refreshed via `useImportSummary`
- **AND** the drawer closes and a success toast is shown

#### Scenario: Failed submission re-hydrates error map
- **WHEN** the user clicks Submit and the API returns 4xx with a `ValidationError[]` body
- **THEN** the drawer stays open
- **AND** `errorsByPath` is replaced by the server's response
- **AND** the view scrolls to the first error field
- **AND** the invoice remains in the Invalid listing

### Requirement: Enterprise Product Gating
The feature SHALL be available only when `import.meta.env['VITE_PRODUCT_ID'] === 'enterprises'`. On any other product, the Invalid Invoice listing SHALL render without the Error Log / Edit action column.

#### Scenario: Feature is hidden on non-enterprise products
- **WHEN** `VITE_PRODUCT_ID !== 'enterprises'`
- **THEN** the Invalid Invoice listing does not render the Error Log / Edit action column
- **AND** the Edit Invoice drawer module is not loaded

---

### specs/import-listing-columns/spec.md

## ADDED Requirements

### Requirement: Re-sequenced Column Order for Valid / Invalid / Duplicate Tabs
The system SHALL render the column order on the Valid, Invalid, and Duplicate tabs of the Data Import view per the Field Segregation source-of-truth. Sales and Purchase imports SHALL use their respective orderings as defined in `libs/constants/src/db/import/columnOrders.ts`.

#### Scenario: Sales import tabs render in Sales order
- **WHEN** the user opens the Valid, Invalid, or Duplicate tab for a Sales import
- **THEN** columns appear in the order: Supplier GSTIN, Customer GSTIN, Customer Name, Invoice/Note Number, Invoice/Note Date, Invoice Category, Invoice Type, Invoice Value, Taxable Value, CGST, SGST/UTGST, IGST, CESS

#### Scenario: Purchase import tabs render in Purchase order
- **WHEN** the user opens the Valid, Invalid, or Duplicate tab for a Purchase import
- **THEN** columns appear in the order: Buyer GSTIN, Supplier GSTIN, Supplier Name, Invoice/Note Number, Invoice/Note Date, Invoice Category, Invoice Type, Invoice Value, Taxable Value, CGST, SGST/UGST, IGST, CESS

#### Scenario: SMB callers retain their default column order
- **WHEN** the shared component is consumed with `columnOrder="smb-default"` or no `columnOrder` prop
- **THEN** the existing SMB column order is preserved with no UX change

### Requirement: Error Log / Edit Action Column on Invalid Tab
The Invalid Invoice listing SHALL render a final "Action" column containing the Error Log and Edit icons for every row, with conditional Edit-disable per EC-03 / EC-04 / EC-05.

#### Scenario: Action column is the last column on the Invalid tab
- **WHEN** the user opens the Invalid tab
- **THEN** the rightmost column is "Action" containing Error Log and Edit icons for each row

#### Scenario: Edit icon disabled state
- **WHEN** a row has at least one error with code in `EDIT_DISABLING_ERROR_CODES`
- **THEN** the Edit icon is disabled and tooltipped per EC-03/04/05
- **AND** the Error Log icon remains enabled