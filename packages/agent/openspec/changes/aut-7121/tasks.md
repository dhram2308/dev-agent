## 1. Constants, Types, and Error Codes

Files: `libs/constants/src/db/import/columnOrders.ts`, `libs/constants/src/db/import/invoiceCategoryFields.ts`, `libs/constants/src/db/import/errorCodes.ts`, `libs/constants/src/models/import/ValidationError.ts`, `libs/constants/src/models/import/InvoiceCategoryField.ts`

- [ ] 1.1 Create `ValidationError` and `InvoiceCategoryField` types in `libs/constants/src/models/import/` per Design D3
- [ ] 1.2 Create `EDIT_DISABLING_ERROR_CODES` constant in `libs/constants/src/db/import/errorCodes.ts` (per EC-03/04/05)
- [ ] 1.3 Create `INVOICE_CATEGORY_FIELDS` constant in `libs/constants/src/db/import/invoiceCategoryFields.ts` mirroring the Field Segregation sheet (Tax-Invoice category first; remaining categories TODO-commented for follow-up)
- [ ] 1.4 Create `SALES_COLUMN_ORDER` and `PURCHASE_COLUMN_ORDER` constants in `libs/constants/src/db/import/columnOrders.ts`

## 2. Shared SMB Component Parameterization (non-breaking)

Files: `libs/smb/src/lib/gst/ImportData/ViewData/index.tsx`, `libs/smb/src/lib/gst/ImportData/ViewData/columns.ts` (or equivalent)

- [ ] 2.1 Add optional `columnOrder?: 'sales' | 'purchase' | 'smb-default'` prop to `SMBImportViewData`; default `'smb-default'` so SMB UX is unchanged
- [ ] 2.2 Add optional `renderInvalidActions?: (record) => ReactNode` render-prop to `SMBImportViewData`; when present, append as the last column on the Invalid tab
- [ ] 2.3 Wire `columnOrder` through the column definitions in the shared component to re-order using `SALES_COLUMN_ORDER` / `PURCHASE_COLUMN_ORDER`

## 3. Enterprise Wiring & Product Gate

Files: `apps/enterprise/src/app/Import/index.tsx`, `apps/enterprise/src/app/Import/InvalidInvoice/InvalidInvoiceActions.tsx`

- [ ] 3.1 In `apps/enterprise/src/app/Import/index.tsx`, pass `columnOrder` (sales/purchase derived from import type) and `renderInvalidActions` to `SMBImportViewData`, guarded by `import.meta.env['VITE_PRODUCT_ID'] === 'enterprises'`
- [ ] 3.2 Create `InvalidInvoiceActions.tsx` rendering Error Log + Edit icons per row, using `EDIT_DISABLING_ERROR_CODES` to compute disabled state and tooltip text

## 4. Error Log View

Files: `apps/enterprise/src/app/Import/InvalidInvoice/ErrorLogView/index.tsx`, `apps/enterprise/src/app/Import/InvalidInvoice/ErrorLogView/ErrorLogView.styles.ts`

- [ ] 4.1 Build `ErrorLogView` component: groups `ValidationError[]` by `level` and item index; renders read-only list
- [ ] 4.2 Add accompanying `*.styles.ts` for styled-components (theme-aware, light + dark)

## 5. Edit Drawer Shell & State Hooks

Files: `apps/enterprise/src/app/Import/InvalidInvoice/EditInvoiceDrawer/index.tsx`, `apps/enterprise/src/app/Import/InvalidInvoice/hooks/useInvoiceErrors.ts`, `apps/enterprise/src/app/Import/InvalidInvoice/hooks/useImportSummary.ts`

- [ ] 5.1 Create `useInvoiceErrors` hook holding `errorsByPath` keyed by field_path, hydrated from server, with `setErrors`, `clearErrorAt(path)`, `replaceErrors(response)` API
- [ ] 5.2 Create `useImportSummary(importId)` hook wrapping `useGetDataApi` for the import counters; expose `refresh()` for post-Submit reconciliation
- [ ] 5.3 Build `EditInvoiceDrawer` shell using `@mi/components/AppDrawer`: total-error banner, MI Smart Assist toggle, slots for invoice-level form and item table, Submit footer

## 6. Dynamic Invoice-Level Field Renderer

Files: `apps/enterprise/src/app/Import/InvalidInvoice/EditInvoiceDrawer/InvoiceFields.tsx`, `apps/enterprise/src/app/Import/InvalidInvoice/EditInvoiceDrawer/ErrorField.tsx`, `apps/enterprise/src/app/Import/InvalidInvoice/EditInvoiceDrawer/ErrorField.styles.ts`

- [ ] 6.1 Build `<ErrorField path />` wrapper component that subscribes to `errorsByPath`, applies red border, hover/focus tooltip with message, and renders suggestion dropdown when present
- [ ] 6.2 Build `InvoiceFields` component that reads `INVOICE_CATEGORY_FIELDS[category]` and renders each field through `<ErrorField>` (text, number, date, select per `FieldDescriptor.type`)
- [ ] 6.3 Apply EC-02 expected-value auto-fill on mount (read `expected_value` from `errorsByPath` and seed the form); show one-time inline "Pre-filled..." notice

## 7. Item-Level Editable Table

Files: `apps/enterprise/src/app/Import/InvalidInvoice/EditInvoiceDrawer/ItemTable.tsx`, `apps/enterprise/src/app/Import/InvalidInvoice/EditInvoiceDrawer/ItemTable.columns.ts`

- [ ] 7.1 Build `ItemTable` using `@mi/components/AppTable` editable mode with `ErrorField` per cell where applicable; columns defined in `*.columns.ts` using project column helpers
- [ ] 7.2 Wire Add Line Item / Delete row; call existing `calculateAddTotal` from SMB AddInvoice helpers to refresh invoice-level totals on every change; on row delete, re-index `items[i].*` keys in `errorsByPath`

## 8. MI Smart Assist Suggestions

Files: `apps/enterprise/src/app/Import/InvalidInvoice/hooks/useSuggestions.ts`, `apps/enterprise/src/app/Import/InvalidInvoice/EditInvoiceDrawer/ErrorField.tsx` (extension)

- [ ] 8.1 Create `useSuggestions(fieldPath, mode, invoice)` hook: when `mode='per-invoice'` returns distinct values from the invoice's line items for that path; when `mode='smart-assist'` calls `GET /import/suggestions` via `useGetDataApi` (gated by `VITE_FEATURE_SMART_ASSIST`)
- [ ] 8.2 Plumb hook output into `ErrorField` dropdown options; render `{value} [used {count} times]` for smart-assist mode

## 9. Submit Pipeline

Files: `apps/enterprise/src/app/Import/InvalidInvoice/EditInvoiceDrawer/submit.ts`, `apps/enterprise/src/app/Import/InvalidInvoice/EditInvoiceDrawer/index.tsx` (wiring)

- [ ] 9.1 Implement `buildSubmitPayload(invoice)` injecting `invoice_status: "add"` (EC-01); add unit-test-style sanity check that the field is always present in the output
- [ ] 9.2 Wire Submit handler: disable when `errorsByPath` non-empty; on click call `postDataApi`/`putDataApi` (Update & Validate endpoint); on 200 → call `useImportSummary.refresh()`, optimistically remove row, close drawer, success toast; on 4xx with ValidationError[] → `replaceErrors(response)`, scroll to first error, failure toast

## 10. Localization & Theme Tokens

Files: `libs/services/src/localization/locales/en_US/Import.json` (or per-project locale path), `libs/constants/src/db/global/theme.tsx`

- [ ] 10.1 Add localization keys for Error Log heading, total-error banner, MI Smart Assist toggle label, EC-03/04/05 tooltip text, success/failure toasts, "Pre-filled from system suggestion" notice
- [ ] 10.2 Add error-field red-border token (light + dark variants) to the theme if not already present; consume via `${({theme}) => theme...}` in `ErrorField.styles.ts`

---QUESTIONS---
[
  {
    "id": "smb-vs-enterprise-ownership",
    "text": "How should we resolve the SMB-vs-Enterprise ownership conflict, given that the Invalid Invoice listing lives in libs/smb but project rule #7 limits this work to the enterprise product?",
    "options": ["Parameterize the shared SMB component with optional columnOrder and renderInvalidActions props (default SMB behavior unchanged); build the drawer as an enterprise-only module that supplies the props", "Fork the SMB Invalid Invoice components into libs/entp and keep enterprise/SMB independent going forward", "Lift rule #7 for this ticket and modify SMB shared code directly so both products get the new flow"],
    "recommend": 0,
    "reason": "Prop-based parameterization preserves rule #7, avoids duplication, and leaves SMB UX byte-identical at runtime."
  },
  {
    "id": "backend-error-contract",
    "text": "Will the backend ship the structured ValidationError contract (field_path, level, code, expected_value, suggestions) needed for EC-02/03/04/05 to work without string-parsing, or do we ship a frontend adapter layer in the interim?",
    "options": ["Backend commits to the structured ValidationError contract before frontend Submit work begins (blocks task 9)", "Frontend ships a mapLegacyErrorToValidationError adapter that converts current free-form server errors into the structured shape, isolating fragility to one file", "Defer the entire ticket until the backend contract is agreed and the on-hold status is lifted"],
    "recommend": 1,
    "reason": "Adapter layer unblocks frontend work today while keeping the rest of the codebase clean, and converts to native contract trivially when backend catches up."
  },
  {
    "id": "submit-gate-semantics",
    "text": "When exactly should the Submit button become enabled in the Edit drawer?",
    "options": ["Enable only when errorsByPath is fully empty (strict reading of AC #7)", "Enable when every error field has been touched/edited at least once, regardless of whether errors remain in the map", "Always enabled; rely on the server to re-validate and re-populate errors on failure"],
    "recommend": 0,
    "reason": "Strict empty-map gate matches AC #7 wording and avoids submitting known-bad payloads; the failure path (D6) already handles re-hydration cleanly."
  }
]
---END---