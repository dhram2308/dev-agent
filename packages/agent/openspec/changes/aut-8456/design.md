## Context

`GstinAuthentication` (libs/smb/src/lib/gst/GstinAuthentication/index.tsx) currently wraps `<GstTabs>` in every GST return page. It checks `currentBusiness.otp_status` and:
- `'na'` → Renders `<RegisterGst />` instead of children (full block)
- `'verify-otp'` → Shows blocking OTP modal + renders children behind it
- `null` → Shows warning Alert with "Verify Now" button + renders children
- Other → Renders children normally

All 8 return pages follow the identical pattern: `<GstinAuthentication><GstTabs .../></GstinAuthentication>`. Each page tracks `activeTab` state synced with URL params via `useParams()`.

## Goals / Non-Goals

**Goals:**
- Allow users to view/interact with Step 1 tabs (overview, prepare, import-data, auto-populate, gst-portal-overview) without OTP verification
- Enforce OTP verification only when user navigates to Step 2+ tabs (upload-data, pay-returns, itc-distribution, file-return)
- Maintain GSTIN registration check (`'na'` status) for all tabs — registration always required
- Backward-compatible change — existing behavior preserved when `skipOtpCheck` is not passed

**Non-Goals:**
- Changing the OTP verification flow itself (VerifyOtp, RegisterGst components)
- Modifying how `otp_status` is set or managed in BusinessContext
- Adding new UI elements or tab disable states
- Changing the return step configuration (returnConfig.ts)

## Decisions

### Decision 1: Add `skipOtpCheck` prop to `GstinAuthentication` (vs. moving wrapper per-tab)

**Chosen**: Add optional `skipOtpCheck?: boolean` prop to `GstinAuthentication`.

**Alternative considered**: Move `GstinAuthentication` inside individual tab children for Step 2+ tabs only. Rejected because it would require duplicating the wrapper in every Step 2+ tab across 8 pages (~20+ tab children), increasing maintenance burden.

**Rationale**: A single prop on the existing wrapper is the minimal change. When `skipOtpCheck=true`, the component skips OTP modal/alert rendering but still enforces GSTIN registration (`'na'` check). Default is `false` for backward compatibility.

### Decision 2: Define Step 1 tab keys inline in each return page (vs. centralized config)

**Chosen**: Define a `STEP_ONE_TABS` constant array at the top of each return page file.

**Alternative considered**: Add step-to-tab mappings in `returnConfig.ts`. Rejected because tab keys are already defined inline in each page's `getItems`/`items` array, and returnConfig.ts uses step *display names* not tab keys. Adding a mapping would create a coupling that doesn't exist today.

**Rationale**: Each return page already owns its tab key definitions. Keeping step 1 tab keys co-located with the tab definitions is the clearest approach. The constant is trivial (2-4 string literals) and self-documenting.

### Decision 3: Behavior when `skipOtpCheck=true` and status is `'na'`

**Chosen**: Still render `<RegisterGst />` (block all content). Only OTP verification is skipped, not registration.

**Rationale**: Without GSTIN registration, no return operations are possible — not even data review. The ticket says "Step 1 which is all about reviewing data, it should not be for prepare and data viewing" — this refers to OTP, not registration.

## Risks / Trade-offs

- **[Risk]** A developer could forget to add `skipOtpCheck` when creating a new return page → **Mitigation**: Default is `false` (current behavior), so omission is safe — it just means OTP is enforced on all tabs (stricter, not permissive).
- **[Risk]** Tab key strings could drift between `STEP_ONE_TABS` and actual tab `key` values → **Mitigation**: Both are defined in the same file; TypeScript won't catch string mismatches, but the impact is minimal (worst case: OTP shown on a step 1 tab, which is the current behavior).