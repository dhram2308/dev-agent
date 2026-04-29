## 1. Pre-work & Backend Contract Confirmation

- [ ] 1.1 Confirm with backend owner: does code `INT` fire only for note-type (CN↔DN) deltas, or also for regular-invoice vs CN/DN? Record the answer in the PR description.
- [ ] 1.2 Confirm backend consolidated-report XLSX (`reconciliation/set_download_metadata/` consumer) will include `INT` and full multi-reason list in the downloaded sheet. Link backend ticket in PR description.
- [ ] 1.3 Grep the repo for `mismatchStatusFields.INT`, `mismatchStatusCodeName.INT`, `mismatch_status === 'INT'`, and `'Invoice Type Difference'` to build a consumer inventory for QA.

## 2. Label Updates (Dictionaries & Filter Options)

- [ ] 2.1 Update `libs/constants/src/db/reco/RecoConst.tsx` — change the `INT` entry in `mismatchStatusFields` from `'Invoice Type Difference'` to `'Note Type Mismatch'` (around line 284).
- [ ] 2.2 Update `libs/entp/src/lib/reconcile/Ledger/LedgerData.tsx` — change the `INT` entry in `mismatchStatusCodeName` from `'Invoice Type Difference'` to `'Note Type Mismatch'` (around line 38).
- [ ] 2.3 Update `libs/constants/src/db/reco/bucketFilterData.tsx` — change the label for the `INT` option in `commonMismatch` (around line 1431) to `'Note Type Mismatch'`.
- [ ] 2.4 Update `libs/constants/src/db/reco/bucketFilterData.tsx` — change the label for the `INT` option in the `NoteType` array (around line 1474) to `'Note Type Mismatch'`.
- [ ] 2.5 Update `libs/constants/src/db/reco/bucketFilterData.tsx` — change the third `INT` occurrence (around line 1797) to `'Note Type Mismatch'`.
- [ ] 2.6 Search `bucketFilterData.tsx` for any remaining `'Note Type'` / `'Note type'` labels tied to `value: 'INT'` and align to `'Note Type Mismatch'`.

## 3. Renderer Hardening

- [ ] 3.1 In `libs/entp/src/lib/reconcile/DocumentView/Buckets/BucketTable/RecoColumns/index.tsx` (`mismatch_status` column, ~lines 4011–4031): normalize input via `Array.isArray(v) ? v : v ? [v] : []`.
- [ ] 3.2 Dedupe the normalized array (preserve first-occurrence order) before mapping.
- [ ] 3.3 Map each code to `mismatchStatusFields[code] ?? code` (fallback to raw code), filter out empty values, and join with `', '`.
- [ ] 3.4 Confirm `apps/enterprise/src/app/IMS/ListView/columns.tsx` (~lines 510–529) already uses the same `mismatchStatusFields[ele]` join; if it does not dedupe/normalize, apply the same pattern for consistency.
- [ ] 3.5 Grep for other callers doing `mismatch_status === 'INT'` style equality checks — either normalize at the boundary or add a shared helper `getMismatchLabels(status)` in `libs/helpers` and refactor callers to use it.

## 4. Type & Helper Alignment

- [ ] 4.1 Verify `MisMatchKeysTypes = keyof typeof mismatchStatusFields` (in `RecoConst.tsx` ~line 333) still compiles after the label change — it is typed on keys, not values, so no change expected.
- [ ] 4.2 Verify `MismatchStatusCodeNameKeyTypes` in `Ledger/LedgerData.tsx` still compiles.
- [ ] 4.3 If step 3.5 produced a shared helper, export it from `libs/helpers/src/reco/getMismatchLabels.ts` and re-export via the appropriate barrel.

## 5. QA Matrix (to include in PR description)

- [ ] 5.1 GSTR-2B vs PR bucket — row with only `INT` → cell reads `Note Type Mismatch`.
- [ ] 5.2 GSTR-2B vs PR bucket — row with `['TVD', 'TRD', 'INT']` → cell reads `Taxable Value Mismatch, Tax Amount Mismatch, Note Type Mismatch`.
- [ ] 5.3 GSTR-2B vs PR bucket — row with `mismatch_status === []` or null → cell is blank; matched row (`M`) still reads `Matched`.
- [ ] 5.4 IMS vs PR (`IMS/ListView`) — same three scenarios as 5.1–5.3 render correctly.
- [ ] 5.5 Ledger / Mismatched Document View — `INT` row displays `Note Type Mismatch`.
- [ ] 5.6 Mismatch Type filter dropdown (bucket view) — the `INT` option reads `Note Type Mismatch`; selecting it filters rows correctly.
- [ ] 5.7 Row with an unknown backend code — cell renders the raw code (fallback validated).
- [ ] 5.8 Row with `mismatch_status: 'INT'` as a plain string (legacy shape) — cell still renders `Note Type Mismatch`.

## 6. Verification & Merge

- [ ] 6.1 `nx lint enterprise` passes.
- [ ] 6.2 `nx test enterprise` passes (plus any affected shared libs).
- [ ] 6.3 `nx build enterprise --configuration=production` succeeds.
- [ ] 6.4 Manually verify downloaded consolidated XLSX in dev/staging contains `Note Type Mismatch` and multi-reason strings — if not, file/link backend dependency ticket and note in PR that FE portion of AUT-8046 is complete pending BE.
- [ ] 6.5 PR description lists: affected files, QA matrix results, backend dependency status, rollback plan (revert single commit).