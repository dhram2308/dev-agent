## Why

The "Mismatch Remarks" column in consolidated reconciliation sheets does not clearly surface all detected mismatches — most critically, when the backend returns `INT` (note type difference like Credit Note vs Debit Note), the frontend renders it as the confusing label "Invoice Type Difference" rather than "Note Type Mismatch". This hurts transparency, increases manual investigation effort, and reduces auditability for compliance users. The existing multi-reason concatenation pattern is already in place; only the label mapping (and its duplicates) need to be aligned with the agreed terminology.

## What Changes

- Rename the `INT` backend-code label from `"Invoice Type Difference"` → `"Note Type Mismatch"` in the single source of truth dictionary `mismatchStatusFields` (`libs/constants/src/db/reco/RecoConst.tsx`).
- Update the duplicate dictionary `mismatchStatusCodeName` in `libs/entp/src/lib/reconcile/Ledger/LedgerData.tsx` to keep Ledger and Bucket screens consistent.
- Update the filter-dropdown option labels for `value: 'INT'` in `libs/constants/src/db/reco/bucketFilterData.tsx` (three occurrences) so the "Mismatch Type" filter reads the same as the column.
- Harden the existing column renderer (`BucketTable/RecoColumns/index.tsx` `mismatch_status` column) to defensively normalize `string | string[]` into an array, dedupe, and fall back to the raw code if the dictionary lacks an entry — so any new backend codes surface rather than silently drop.
- No new components, no new API hooks, no new types. Existing comma-join + `mismatchStatusFields` mapping already satisfies multi-reason concatenation (AC-3, AC-4) and cross-reco consistency (AC-5).
- **Note**: AC-4/AC-7 for downloadable Excel/CSV reports is **backend-owned** (server-side XLSX generation); this change covers the UI/frontend rendering path only.

## Capabilities

### New Capabilities
_None._

### Modified Capabilities
- `reconciliation-mismatch-remarks`: Label for backend code `INT` changes to `Note Type Mismatch`; renderer becomes defensive against `string | string[]` shape and unknown codes. (If a spec folder does not yet exist under `openspec/specs/reconciliation-mismatch-remarks/`, create it as part of this change using the delta below as the initial spec.)

## Impact

- **Code**
  - `libs/constants/src/db/reco/RecoConst.tsx` (dictionary label)
  - `libs/entp/src/lib/reconcile/Ledger/LedgerData.tsx` (duplicate dictionary label)
  - `libs/constants/src/db/reco/bucketFilterData.tsx` (filter option labels, 3 sites)
  - `libs/entp/src/lib/reconcile/DocumentView/Buckets/BucketTable/RecoColumns/index.tsx` (`mismatch_status` column renderer — defensive normalization only)
- **APIs**: No API contract change required on the FE side. Relies on backend populating `mismatch_status` (array or string) with code `INT` when note type differs.
- **Screens affected by label change** (blast radius of dictionary rename): all consolidated reco views (2B-PR, 2A-PR, IMS-PR), Ledger, MismatchedDocumentView, Bucket badges, mismatch-type filter dropdowns.
- **Not in scope (backend-owned)**: Server-side XLSX/CSV generation for consolidated report (`reconciliation/set_download_metadata/`); confirmed backend must emit full mismatch list into downloaded sheet.
- **Not in scope**: VITE_PRODUCT_ID gating — enterprise-only surface; no product gate needed.
- **Dependencies**: None added.