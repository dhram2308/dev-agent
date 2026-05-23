## Why

Today, after password login, users are routed straight to the dashboard regardless of 2FA state. Most users skip Settings → Two-Factor Authentication entirely, leaving GST/tax compliance accounts unprotected. AUT-8648 closes this gap by inserting a mandatory 2FA gate (setup for new users, OTP verification for returning users) into the login flow, while leaving the Settings 2FA page untouched.

## What Changes

- Extend the existing `/enable-2fa` setup screen (`TwoFactorConfirm`) with a **mobile verification branch** that activates when `user.mobile_verified === false` — reuses Settings → 2FA mobile send/verify endpoints.
- Extend the existing `Signin → VerifyOtp` returning-user screen to display a **"2FA Enabled" badge** per active channel and render only channels active in `mode_2fa` (`email` / `mobile` / `both`).
- Move OTP reset (`setOtp('')` + `form.resetFields(['otp'])`) in `Signin/index.tsx` from the success path to the error path of `onOtpSubmit` to satisfy AC#7 (clear boxes on incorrect OTP).
- Persist the **skip flag** via the existing `PUT profile/auth-setting/` endpoint (new `is_2fa_skipped` field) and consult it in the post-login redirect (`checkRoutePermissionWith2FA`) — same prompt reappears on next login.
- Add localization strings for the "2FA Enabled" badge and the admin-mobile-mismatch error fallback (en_US + ar_SA).
- Gate the entire flow behind enterprise `VITE_PRODUCT_ID` — **no changes to Settings → Two-Factor Authentication page** (AC#8).

## Capabilities

### New Capabilities
- `login-2fa-flow`: Login-time 2FA enforcement covering post-password routing, setup screen (mobile-verification branch), returning-user OTP verification, skip-flag persistence, and dashboard route gating.

### Modified Capabilities
_(none — Settings 2FA page is explicitly out of scope per AC#8; no existing capability specs in `openspec/specs/` cover login-time 2FA enforcement.)_

## Impact

- **Code touched**: `libs/entp/src/lib/auth/TwoFactorConfirm/index.tsx`, `libs/entp/src/lib/auth/Signin/{index,VerifyOtp}.tsx`, `libs/helpers/src/lib/RouterHelper.tsx`, `libs/constants/src/models/BusinessContext.ts` (UserProps), `libs/services/localization/src/locales/{en_US,ar_SA}.json`.
- **Code NOT touched**: `libs/entp/src/lib/profile/TwoFactorAuthSettings/**` (AC#8 hard constraint).
- **Backend contract**: requires `is_2fa_skipped` boolean on `auth-me/` response + accepted by `PUT profile/auth-setting/`. Backend team must confirm existence/naming.
- **Reused endpoints**: `profile/auth-setting/`, `profile/auth-setting/2fa-auth/`, `profile/auth-setting/2fa-auth/verify-otp/`, `auth-me/`, `token-auth/`. No new OTP backend logic.
- **Behavior change**: returning users with 2FA enabled will be challenged for OTP every login (today this depends on backend `two_fa_verification` payload in `token-auth/`) — needs explicit BE confirmation.