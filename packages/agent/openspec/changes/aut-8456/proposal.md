## Why

Currently, `GstinAuthentication` wraps all tab content in every GST return page, blocking users from viewing **any** tab when OTP is not verified. Step 1 tabs (overview, prepare, import-data) are purely for reviewing and preparing data and should be accessible without OTP. OTP verification should only gate Step 2+ actions (upload, payment, filing).

## What Changes

- Modify `GstinAuthentication` component to accept a `skipOtpCheck` prop that bypasses OTP enforcement when `true` (while still enforcing GSTIN registration check)
- Update all 8 GST return pages to pass `skipOtpCheck` based on whether the active tab is a Step 1 (data review) tab
- Define Step 1 tab keys per return type so each page knows which tabs are OTP-free

## Capabilities

### New Capabilities
- `conditional-otp-gating`: Conditional OTP enforcement per tab — Step 1 tabs (data review/prepare) bypass OTP checks while Step 2+ tabs (upload/payment/filing) require OTP verification

### Modified Capabilities
(none — no existing spec files)

## Impact

- **Component**: `libs/smb/src/lib/gst/GstinAuthentication/index.tsx` — new optional prop, backward compatible
- **Pages**: 8 GST return page files in `apps/enterprise/src/app/GSTReturn/` — minimal change per file (add `skipOtpCheck` prop)
- **Risk**: Low — additive prop with default behavior unchanged. No API, data model, or dependency changes.