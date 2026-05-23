## Why

Enterprise users currently must download invalid invoices as Excel, fix them offline, and re-upload — a slow, error-prone loop that compounds when only a handful of records need fixing. AUT-7121 introduces an in-app correction workflow on the Invalid Invoice listing so users can view per-field errors, edit invoice + line-item fields directly, and re-submit for instant re-validation without ever leaving the Data Import screen.

> **⚠️ Status flag:** Jira comment (2026-05-22) by anjushahi puts this task **on hold**. Confirm with Vikash Anand / Anjushahi before implementation. This plan is design-ready but not implementation-cleared.

## What Changes

- Add a **per-row "Error Log / Edit" action column** to the Invalid Invoice listing screen (last column).
- Re-sequence the columns of the **Valid / Invalid / Duplicate** listings to match the Field Segregation sheet (separate orders for Sales vs. Purchase).
- Add a **read-only Error Log view** that lists invoice-level and item-level validation errors in a structured layout.
- Add a **right-side Edit Invoice drawer** that renders invoice-level fields (dynamic per Invoice Category) at the top and an editable line-item table at the bottom.
- Surface a **total error count** banner at the top of the Edit drawer.
- Highlight every error field with a **red border** and a **hover tooltip** showing the validation message.
- Provide **suggestion dropdowns on error fields**, sourced either from the invoice's own conflicting line-item values (default) or **MI Smart Assist** org-historical frequency-ranked values (toggle).
- Support **Add Line Item** / **Edit row** / **Delete row** inside the drawer with automatic invoice-total recalculation.
- Wire **Submit** to the Update & Validate Invoice API — auto-inject `invoice_status = "add"` (EC-01), parse per-field server errors back into the form on failure, optimistically remove the row from Invalid and refresh Valid/Invalid/Duplicate counts on success.
- **Conditionally disable** the Edit icon for EC-03/EC-04/EC-05 error codes (Supplier-GSTIN / Buyer-GSTIN / Invoice-Category fatal errors); Error Log remains accessible read-only.
- **BREAKING (UX-level):** Listing column order changes for Valid / Invalid / Duplicate tabs. Out of an abundance of caution, ship behind a feature flag if SMB also consumes the shared component (see Design).
- Gate the entire feature behind `VITE_PRODUCT_ID === 'enterprises'` per project rule.

## Capabilities

### New Capabilities
- `invalid-invoice-correction`: In-drawer view-error / edit-invoice / submit-and-revalidate workflow for invalid invoices from Data Import, including Error Log view, Edit drawer (dynamic by Invoice Category), error highlighting + tooltips, MI Smart Assist suggestions, in-drawer line-item CRUD, and Submit → re-validate pipeline.
- `import-listing-columns`: Re-sequenced column ordering for Valid / Invalid / Duplicate import-data tabs (Sales vs. Purchase orderings), and the new Error Log / Edit action column on the Invalid tab.

### Modified Capabilities
- None (no existing OpenSpec capability for this surface; everything is additive to the import-data flow).

## Impact

- **Code (frontend):** `apps/enterprise/src/app/Import/**`, `libs/smb/src/lib/gst/ImportData/ViewData/**` (or a new enterprise-only fork — see Design), `libs/components/src/lib/AppDrawer/**` (reuse), `libs/constants/src/**` (new category→fields map, new error-code constants), `libs/helpers/src/hooks/APIHooks.ts` (reuse), localization strings.
- **APIs (backend, NOT in this ticket — file separate child tickets):**
  - `Update & Validate Invoice` endpoint (likely reuses Add-Invoice infra; payload must accept `invoice_status="add"`; response must return structured per-field errors).
  - `Smart Assist Suggestions` endpoint: `GET /import/suggestions?field=<name>&context=<...>` → `[{value, count}]` sorted desc.
  - Backend must emit a **machine-readable error contract** (`{field_path, level, code, message, expected_value?, suggestions?}`) to kill EC-02 string-parsing and to make EC-03/04/05 code-based.
- **Dependencies:** No new npm packages; reuse `AppDrawer`, `AppForm`, `AppTable`, `useGetDataApi`, `postDataApi`, `putDataApi`, existing AddInvoice form schema and `calculateAddTotal` / `cleanAddTableData` helpers.
- **Product gating:** Feature lives behind `import.meta.env['VITE_PRODUCT_ID'] === 'enterprises'`.
- **Cross-tab state:** Submit success path must refresh Valid / Invalid / Duplicate counters on the parent import-details screen.