## Context

Today, the Mismatch Remarks column for consolidated reconciliation sheets is rendered in `libs/entp/src/lib/reconcile/DocumentView/Buckets/BucketTable/RecoColumns/index.tsx` (`mismatch_status` column, lines 4011–4031). It iterates `record.mismatch_status` and joins the human labels via the `mismatchStatusFields` dictionary in `libs/constants/src/db/reco/RecoConst.tsx`. The identical pattern is also used in `apps/enterprise/src/app/IMS/ListView/columns.tsx:510-529` with `MisMatchKeysTypes`.

Two problems:
1. The dictionary label for backend code `INT` is `"Invoice Type Difference"`. Per Anish Sharma's 2026-04-22 comment, the agreed display copy is `"Note Type Mismatch"`. A second, duplicate dictionary (`mismatchStatusCodeName` in `Ledger/LedgerData.tsx`) carries the same stale label and must be kept in sync.
2. `BucketsDataProps.mismatch_status` is typed as `string | string[]`. Some existing code paths perform equality checks against a single string (`mismatch_status === 'INT'`) that will silently fail when the backend starts returning arrays with multiple codes — which is exactly what AC-3 and AC-4 require.

The filter-dropdown data (`bucketFilterData.tsx` `commonMismatch` and `NoteType` arrays) uses `"Note Type"` / `"Note type"` for the INT option — also misaligned with the new copy.

The consolidated sheet download itself is generated server-side (`libs/entp/src/lib/reconcile/RecoDownloadReports/ConsolidateIndDownload/index.tsx` posts to `reconciliation/set_download_metadata/`). Frontend cannot influence the content of the XLSX — backend is the owner of AC-1/AC-4 for the downloaded file.

## Goals / Non-Goals

**Goals:**
- Align the frontend "Mismatch Remarks" column, filter dropdown, and Ledger views to display `"Note Type Mismatch"` for backend code `INT`.
- Ensure existing multi-reason concatenation (`mismatchStatusFields[code]` comma-join) works robustly when backend returns either a single code or an array of codes.
- Keep the three mapping sites (RecoConst, LedgerData, bucketFilterData) in lockstep — a single PR must touch all three so Ledger, Bucket, and filter surfaces stay consistent.
- Add a defensive fallback in the renderer so unknown backend codes are not silently dropped (prevents silent regressions when backend adds new mismatch reasons).

**Non-Goals:**
- Changing the server-side XLSX generation (backend team).
- Adding i18n/react-intl translation keys for these labels (existing labels in the dictionary are hardcoded English; changing that is a separate, larger effort).
- Introducing a "No Mismatch" textual literal — current convention uses code `M → 'Matched'` for matched rows and an empty cell for non-evaluated rows; we preserve that convention (AC-6: "blank or 'No Mismatch'" — we pick blank to match existing behavior).
- Expanding scope to historical consolidated reports already logged in `recoConsolidatedDownload` (AC-7 scopes to "newly generated").
- Introducing a product-ID gate — this is an enterprise-only surface.

## Decisions

**1. Update the label in the canonical dictionary, not only at the render site.**
- _Why_: `mismatchStatusFields` is the single source of truth consumed by multiple screens (Ledger, MismatchedDocumentView, BucketTable). Scoping the rename only to the consolidated-sheet renderer would reintroduce drift and require a third mapping.
- _Alternative considered_: Override the label locally in `RecoColumns/index.tsx`. Rejected — creates a third parallel label source and defeats the existing dictionary pattern.

**2. Rename in both `RecoConst.tsx` and `LedgerData.tsx` in the same change.**
- _Why_: `LedgerData.tsx` carries a TODO indicating its dictionary is a duplicate pending consolidation. Updating only one causes inconsistent copy between ledger and bucket screens — high-visibility divergence.
- _Alternative considered_: Consolidate the two dictionaries into one in this PR. Rejected — scope creep; ledger consolidation is a separate refactor with its own blast radius.

**3. Update all three `bucketFilterData.tsx` option sites at once.**
- _Why_: The mismatch-type filter dropdown must read the same as the column it filters. A user seeing "Note Type" in the filter and "Note Type Mismatch" in the column would be confused.

**4. Defensive normalization in the renderer: `Array.isArray(v) ? v : v ? [v] : []`.**
- _Why_: `mismatch_status` is typed `string | string[]`. AC-3 requires multiple reasons per record; we must not assume array-only or string-only. Normalizing at the boundary prevents every downstream consumer from reimplementing the check.
- _Alternative considered_: Require backend to always return an array. Rejected — cross-team coordination risk; defensive FE is cheaper and backward-compatible.

**5. Fallback to raw code for unknown dictionary keys.**
- _Why_: AC-1 says "all types of mismatches" must be surfaced. If the backend adds a new code (e.g., `POS`, `RATE`) before we ship a FE update, the column must still show _something_ (the raw code) rather than silently drop it. Code pattern: `codes.map(c => mismatchStatusFields[c] ?? c).filter(Boolean).join(', ')`.

**6. Dedupe before join.**
- _Why_: If the backend accidentally emits `['INT', 'INT']` or the array contains duplicates from a merge step, we render it once. Cheap safety.

**7. Preserve the existing "blank when matched" convention (AC-6).**
- _Why_: Repo today renders an empty cell for rows without mismatch codes and `"Matched"` (from code `M`) for matched rows. Introducing a new `"No Mismatch"` literal creates a third state that conflicts with `M`. Staying blank keeps existing QA baselines valid.

## Risks / Trade-offs

- **[Risk] Semantic narrowing of `INT`** → Today `INT` ("Invoice Type Difference") may fire for any invoice-type delta (regular vs credit-note vs debit-note), not only CN↔DN. Renaming to "Note Type Mismatch" is narrower wording.
  → **Mitigation**: Confirm with backend before merge that `INT` is only emitted for note-type deltas. If it also fires for regular vs CN/DN, either (a) keep the code wording "Invoice/Note Type Mismatch" or (b) ask backend to split the code.

- **[Risk] Global label blast radius** → `mismatchStatusFields.INT` is read by Ledger, MismatchedDocumentView, bucket badges, and filter dropdowns. Rename affects every screen at once.
  → **Mitigation**: Grep all consumers (`rg "mismatchStatusFields|mismatchStatusCodeName|'INT'"`) and sanity-check each screen in QA. Include a QA matrix in `tasks.md` covering bucket, ledger, mismatched-doc view.

- **[Risk] Backend-owned XLSX not updated** → Frontend label change does not touch the downloaded sheet. AC-4/AC-7 for downloads are backend responsibility.
  → **Mitigation**: Call out backend dependency explicitly in the PR description and confirm backend ticket parity before closing AUT-8046.

- **[Risk] `mismatch_status` type ambiguity (`string | string[]`)** → Existing equality checks (`=== 'INT'`) elsewhere may break when backend switches to arrays.
  → **Mitigation**: Grep for `mismatch_status === '` and `mismatch_status ===` to find fragile callers; fix or normalize at the boundary.

- **[Trade-off] No i18n in this change** → Labels remain hardcoded English strings. Translation is out of scope; flagging as tech debt.

- **[Trade-off] Duplicate dictionary not consolidated** → We update both copies but don't remove the duplicate. The TODO in `LedgerData.tsx` remains; consolidation is a separate refactor.

## Migration Plan

1. Ship the four file changes together in one PR — label update + defensive renderer are atomic.
2. No database/backend migration required on FE side.
3. **Rollback**: Revert the single commit. No data migration, no schema change, no new dependency — rollback is trivial.
4. **Coordination**: Confirm backend ticket (parent epic) is either shipping `INT` in the consolidated download sheet already, or is shipping in the same release window. If backend is lagging, FE change still improves the UI/ledger/bucket-badge screens and is safe to ship alone.

## Open Questions

- Does backend emit `INT` solely for CN↔DN note-type mismatches, or also for regular invoice vs CN/DN? _(Needed to finalize copy.)_
- Is there an existing in-app table that shows the consolidated sheet rows directly? If not, AC-7 "UI view" reduces to the bucket/ledger screens (which this PR covers) plus the downloaded file (backend).
- Parent epic status — is any backend dependency still "To Do"? If yes, should FE merge anyway (safe) or wait for bundled release?
- Should we dedupe/sort the reasons in a stable priority order (e.g., GSTIN → Invoice Number → Date → Taxable Value → Tax Amount → Note Type), or preserve backend order? Current design: dedupe + preserve backend order.