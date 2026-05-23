## Context

The Data Import module on Enterprise (`apps/enterprise/src/app/Import/index.tsx`) currently delegates GSTR1/GSTR2 import listings to `@mi/smb/import-data` (`SMBImportImportHistory`, `SMBImportViewData`). The Invalid Invoice tab uses a paginated table fed by `import/logs/`. Today, "fixing" an invalid row forces the user out of the app: download Excel → edit → re-upload. The PRD (linked in ticket) introduces an in-app correction surface — an Edit drawer that is structurally equivalent to the existing Add Invoice form, pre-filled with the invalid record and decorated with per-field error state.

Two upstream gaps shape this design:
1. **No "Update & Validate Invoice" backend endpoint exists today**, and there is no agreed error-payload contract. Rishabh Karnwal's 2025-12-22 comment suggests reusing the Add Invoice APIs.
2. **The Invalid/Valid/Duplicate listings and the AddInvoice form live in `libs/smb`** — but project rule #7 limits this work to the enterprise product (`VITE_PRODUCT_ID === 'enterprises'`). Modifying SMB shared code is a rule violation; forking is duplication.

Ticket is currently **on hold** (anjushahi, 2026-05-22). This document is design-only.

## Goals / Non-Goals

**Goals:**
- Eliminate the Excel round-trip for invalid-invoice correction.
- Reuse the existing AddInvoice form schema, field renderer, and total-calculation helpers — do not reinvent.
- Drive error UI (red border, tooltip, Submit-gate, EC-03/04/05 disable) from a **single error map** keyed by field path, hydrated from server response.
- Gate everything behind `VITE_PRODUCT_ID === 'enterprises'` so SMB users are unaffected at runtime.
- Keep listing column re-sequencing parameterized so SMB can keep its own order.

**Non-Goals:**
- Building the backend `Update & Validate Invoice` endpoint (separate child ticket).
- Building the backend `Smart Assist suggestions` aggregation endpoint (separate child ticket).
- Replacing the Excel upload path (it stays as the primary bulk-correction flow).
- Re-architecting SMB import-data — we will isolate enterprise-only behavior behind feature gates / new component props.
- Client-side mirroring of all server validation rules (we let the server re-validate on submit; AC #9 already accepts updated-error reflection).

## Decisions

### D1. **Enterprise-owned correction module, SMB code untouched at runtime.**
Build the Invalid-Invoice correction drawer and Error Log view as an **enterprise-only feature module** at `apps/enterprise/src/app/Import/InvalidInvoice/` (or `libs/entp/src/lib/EinvImportData/`). The shared SMB listing component (`SMBImportViewData`) gets a new optional prop — `renderInvalidActions?: (record) => ReactNode` and a `columnOrder?: 'sales' | 'purchase' | 'smb-default'` prop — that defaults to today's behavior. Enterprise wires its own action renderer + re-ordered columns; SMB stays on defaults.

**Alternatives considered:**
- (a) Fork SMB code into enterprise → massive duplication, drift risk. Rejected.
- (b) Modify SMB shared code directly → violates rule #8 and breaks SMB UX. Rejected.
- (c) Render-prop / column-order prop on the shared component → minimal, non-breaking, parameterized. **Chosen.**

### D2. **Reuse AddInvoice form schema; layer an `errorsByPath` state on top.**
The drawer renders the same dynamic field set as Add Invoice (driven by Invoice Category). A new `useInvoiceErrors(invoiceId)` hook holds `Record<string /*field_path*/, ValidationError>`. A new `<ErrorField path="..." />` wrapper subscribes to this map and applies: red border, tooltip, dropdown of suggestions, manual input. This is the **only** new field primitive; everything else is existing Add Invoice infra.

**Alternative considered:** Inline `style={{ border: 'red' }}` + per-field `<Tooltip>` overrides → violates styling rule #2 (no inline styles), and noisy.

### D3. **Single canonical error contract from the server — frontend assumes it.**
Frontend expects:
```ts
type ValidationError = {
  field_path: string;        // e.g., "buyer_gstin" or "items[0].cgst_amount"
  level: 'invoice' | 'item';
  code: string;              // e.g., 'GSTIN_INVALID', 'SUPPLIER_NOT_IN_ACCOUNT'
  message: string;           // human-readable, localizable key
  expected_value?: unknown;  // for EC-02 auto-fill
  suggestions?: string[];    // line-item-derived suggestions
};
```
- EC-02 auto-fill keys off `expected_value`, not regex on `message`.
- EC-03 / EC-04 / EC-05 Edit-disable keys off `code` ∈ `{SUPPLIER_GSTIN_NOT_IN_ACCOUNT, SUPPLIER_GSTIN_INVALID_TYPE, BUYER_GSTIN_NOT_IN_ACCOUNT, BUYER_GSTIN_INVALID_TYPE, INVOICE_CATEGORY_MISSING, INVOICE_CATEGORY_INVALID}`, not string matching.
- A constant `EDIT_DISABLING_ERROR_CODES` lives in `libs/constants/src/db/import/errorCodes.ts`.

**Alternative considered:** String-match `message` → fragile. Rejected.

**If backend cannot deliver this contract in time:** ship a thin adapter layer (`mapLegacyErrorToValidationError`) that converts current free-form errors into the same shape, isolating fragility to one file.

### D4. **Invoice Category → field schema is in code, frozen from the Excel.**
Create `libs/constants/src/db/import/invoiceCategoryFields.ts`:
```ts
export const INVOICE_CATEGORY_FIELDS: Record<InvoiceCategory, FieldDescriptor[]> = {
  TAX_INVOICE: [...],
  BILL_OF_SUPPLY: [...],
  // ...
};
```
The Field Segregation sheet is the source-of-truth at write time, but the schema is committed to the repo and reviewed in code. Avoids runtime drift.

### D5. **MI Smart Assist toggle is feature-flag-gated.**
Behind `VITE_FEATURE_SMART_ASSIST` (default `false`). When the backend suggestions endpoint ships, flip the flag. Toggle UI is built but its data source returns `[]` until the endpoint is live; the per-invoice line-item-derived suggestions work today without backend changes.

### D6. **Submit pipeline: optimistic client, authoritative server.**
- Submit button is enabled when `Object.keys(errorsByPath).length === 0` **OR** the user has touched every error field at least once (whichever the PRD requires — confirm with PM). Default to "all errors cleared from map" to match AC #7 strictly.
- On `200 OK`: optimistically remove row from Invalid list, increment Valid counter, decrement Invalid counter, close drawer, toast success.
- On `4xx with error payload`: replace `errorsByPath` with server's new map, do not close drawer, scroll to first error, toast generic failure.
- On `5xx / network`: surface error toast, keep drawer state, allow retry.
- `invoice_status: "add"` is injected by a single `buildSubmitPayload(invoice)` helper — never user-editable (EC-01).

### D7. **Listing column re-sequence is a per-tenant, per-product configuration, not a hardcode.**
The Sales and Purchase column orders are defined as constants in `libs/constants/src/db/import/columnOrders.ts` and consumed by the SMB component via a new `columnOrder` prop (see D1). Enterprise passes the AUT-7121 ordering; SMB passes `'smb-default'` (= today's order).

### D8. **Cross-tab state coherence via a `useImportSummary(importId)` hook.**
Parent import-details screen subscribes; on Submit-success, the hook invalidates and re-fetches the Valid/Invalid/Duplicate counts. Avoids per-tab manual prop drilling.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Backend contract for `ValidationError` not agreed → frontend ships against a fiction | File a backend child ticket NOW, block frontend "Submit" task on its delivery; ship adapter layer (D3) as bridge |
| SMB component prop additions inadvertently change SMB UX | Default new props to preserve current behavior; add a snapshot test for SMB import-data screen |
| Invoice Category schema drifts vs. Excel source-of-truth | Code review checklist line item; comment in the constant file linking to the Excel; revisit when categories change |
| Submit button gate over-blocks if user can't clear an error (e.g., system-side rule) | Provide an "override / submit anyway" affordance only when no client-side errors remain but the user has not touched a server-only error — confirm with PM |
| `invoice_status="add"` injection misuse on a *correction* (this is technically an edit) | Backend must accept `add` semantics on a row that was previously invalid; confirm with backend that this is the contract |
| EC-02 expected-value auto-fill could silently override user intent | Show a one-time inline banner: "We pre-filled `<field>` from a system suggestion. Edit if incorrect." |
| `INVOICE_CATEGORY_*` errors disable Edit (EC-05) but category itself is what needs fixing → user stuck | Surface a CTA: "Re-upload corrected Excel for this invoice" linking back to the upload step; matches PRD tooltip wording |
| Drawer with many error fields → tooltip noise / a11y | Use a single `<ErrorField>` wrapper that focus-shows the message inline (not just tooltip) for keyboard users |
| Optimistic Invalid→Valid list update diverges from server pagination | After optimistic update, also call `useImportSummary` to reconcile counts on the next tick |
| Story-point estimate likely undercounts (Vikash Anand, 2026-05-05) | Re-estimate after design freeze; flag in standup |

## Migration Plan

Not applicable — pure addition. No data migration. Rollout:
1. Ship behind `VITE_PRODUCT_ID === 'enterprises'` gate (already required by rule #7).
2. Smart Assist toggle behind `VITE_FEATURE_SMART_ASSIST` flag (default off).
3. Backend deploys `Update & Validate Invoice` + error contract first; frontend follows.
4. Rollback: feature is gate-controlled; setting the env flag off restores Excel-only flow with zero data impact.

## Open Questions

1. **Backend contract for ValidationError** — does the team commit to D3 shape, or do we ship the adapter layer?
2. **Smart Assist endpoint timeline** — in scope of AUT-7121 or separate? PRD implies in-scope, ticket scope is silent.
3. **Submit-gate semantics** — block on "errors map empty" or "all error fields touched"? PRD AC #7 implies the former; confirm with PM.
4. **Duplicate-on-Submit semantics** — if corrected invoice now matches a Valid row's (number, date) tuple, does Submit overwrite, error, or move to Duplicate?
5. **SMB ownership decision** — product owner confirmation needed on D1 (prop-based parameterization) vs. fork.
6. **Hold status** — Jira comment 2026-05-22 puts this on hold. Confirm before any code is written.