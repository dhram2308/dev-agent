## 1. Types & Models (1 file)

Files: `libs/constants/src/models/BusinessContext.ts`

- [ ] 1.1 Add `is_2fa_skipped?: boolean` to `UserProps` interface alongside existing `is_2fa_enabled`, `mobile_verified`, `mode_2fa`, `phone_number`.
- [ ] 1.2 Extend the `TwoFaVerification` type (or inline type used by `twoFaRef.current` in `Signin/index.tsx`) to include `mode_2fa?: 'email' | 'mobile' | 'both'` so `VerifyOtp` can drive channel rendering.

## 2. Setup Screen — Mobile Branch (1 file)

Files: `libs/entp/src/lib/auth/TwoFactorConfirm/index.tsx`

- [ ] 2.1 Add conditional branch: when `user.mobile_verified === false`, render mobile input + "Send OTP" → 6-digit OTP entry + "Verify" flow.
- [ ] 2.2 Wire send OTP via `postDataApi('profile/auth-setting/2fa-auth/', { mobile })` and verify via `postDataApi('profile/auth-setting/2fa-auth/verify-otp/', { otp, mobile })` (copy patterns from `TwoFactorAuthSettings/PhoneVerification.tsx` — do NOT import/refactor from it).
- [ ] 2.3 On verify success, call `updateUser({ ...user, mobile_verified: true, phone_number, is_2fa_enabled: true, mode_2fa: 'both' })` and navigate to `VITE_INITIAL_URL`.
- [ ] 2.4 When `user.mobile_verified === true`, show both Email + Mobile pre-selected (Radio.Group with `mode_2fa` options matching `TwoFactorAuthSettings/index.tsx:91–100`) with a direct "Continue" button calling `putDataApi('profile/auth-setting/', { is_2fa_enabled: true, mode_2fa })`.
- [ ] 2.5 Update Skip handler to call `putDataApi('profile/auth-setting/', { is_2fa_skipped: true })` before `navigate(initialUrl)`.
- [ ] 2.6 Use existing styled wrappers from `Auth.styled.tsx` (`AuthContentWrapper`, `FormWrapper`, `TwoFaButtonRow`, `TwoFaLoginButton`, `SignFormTitle`, `TwoFaDescriptionWrapper`) — no new styled files.
- [ ] 2.7 Use `maskEmail` / `maskPhone` from `@mi/helpers/StringHelper` for all displayed identifiers.

## 3. Returning-User Verification Screen (1 file)

Files: `libs/entp/src/lib/auth/Signin/VerifyOtp.tsx`

- [ ] 3.1 Accept `mode_2fa` from `twoFaData` and conditionally render Email row, Mobile row, or both, matching the three returning-user scenarios.
- [ ] 3.2 Add a "2FA Enabled" `<Tag>` (antd) beside each active channel row. Use new i18n key `otpVerify.twoFaEnabledBadge`.
- [ ] 3.3 Confirm masking continues to use `maskEmail` / `maskPhone` (existing) — no inline string ops.
- [ ] 3.4 Keep existing `ExpireTime` ref / `useExpireTime(60)` for resend countdown; verify "Resend" is disabled until timer expires (AC#6).

## 4. Signin OTP Error-Path Reset (1 file)

Files: `libs/entp/src/lib/auth/Signin/index.tsx`

- [ ] 4.1 In `onOtpSubmit`, move `setOtp('')` and `form.resetFields(['otp'])` from the success path into the `.catch` block so all six boxes clear on incorrect OTP (AC#7).
- [ ] 4.2 Surface the BE error message via `infoViewContext.fetchError(error.message)`; fall back to i18n key `otpVerify.invalidOtp` (= "Invalid OTP. Please try again.") when BE response is empty.
- [ ] 4.3 When `token-auth/` returns `two_fa_verification`, ensure `twoFaRef.current` captures `mode_2fa` (from step 1.2) so `VerifyOtp` receives the full payload.

## 5. Routing Gate — Skip Flag & Enterprise Guard (1 file)

Files: `libs/helpers/src/lib/RouterHelper.tsx`

- [ ] 5.1 Update `checkRoutePermissionWith2FA` and `redirectInitialUrlWith2FA` so the `/enable-2fa` redirect fires when `is_2fa_enabled === false` regardless of `is_2fa_skipped` (re-prompt every login per AC#4).
- [ ] 5.2 Confirm the redirect path is gated by `VITE_PRODUCT_ID` enterprise check (defense-in-depth — already present in `loginUser` path; verify and document).
- [ ] 5.3 No changes to `loginUser()` shape; no new routes; no new contexts.

## 6. Localization (2 files)

Files: `libs/services/localization/src/locales/en_US.json`, `libs/services/localization/src/locales/ar_SA.json`

- [ ] 6.1 Add key `otpVerify.twoFaEnabledBadge` → "2FA Enabled" (en) + Arabic translation.
- [ ] 6.2 Add key `otpVerify.invalidOtp` → "Invalid OTP. Please try again." + Arabic translation (used as fallback when BE message is empty).
- [ ] 6.3 Add key `enable2FA.mobileMismatchError` → "The mobile number does not match our records. Please contact your Admin." + Arabic translation (used as FE fallback only — BE message preferred).
- [ ] 6.4 Verify all existing keys used (`enable2FA.heading`, `enable2FA.skipForNow`, `enable2FA.enableContinue`, `otpVerify.heading`, `otpVerify.resend`, `otpVerify.timerNew`, `forgotPass.backTosignIn`) are present; do not duplicate.

---QUESTIONS---
[
  {
    "id": "skip-flag-be-contract",
    "text": "How will the 2FA skip flag be persisted on the user profile?",
    "options": ["New boolean field `is_2fa_skipped` on `UserProps`, accepted by existing `PUT profile/auth-setting/` and returned by `auth-me/`", "Backend exposes a dedicated `POST profile/auth-setting/skip-2fa/` endpoint", "Frontend stores skip in localStorage/sessionStorage scoped to user id (no BE change)"],
    "recommend": 0,
    "reason": "Reusing the existing endpoint matches ticket's Backend Scope #3 (\"no new OTP backend logic\") and AC#4 (re-prompt next login implies BE persistence, not client-side state)."
  },
  {
    "id": "returning-user-otp-every-login",
    "text": "Does the backend guarantee `token-auth/` returns `two_fa_verification` for every login when `is_2fa_enabled === true`, or only on suspicious sessions?",
    "options": ["BE always returns `two_fa_verification` when 2FA is enabled — FE relies on this signal as today", "BE adds a config to force OTP every login for enterprise users — coordinate rollout", "FE adds a route guard that triggers OTP send if the BE flag is absent but `is_2fa_enabled === true`"],
    "recommend": 0,
    "reason": "AC#5 is BE-driven; the existing `two_fa_verification` envelope is the single signal and avoids FE duplicating OTP-send orchestration."
  },
  {
    "id": "2fa-status-check-api",
    "text": "What is the canonical \"2FA Status Check API\" referenced in the ticket?",
    "options": ["The existing `auth-me/` endpoint (returns `is_2fa_enabled`, `mobile_verified`, `mode_2fa`, and the new `is_2fa_skipped`) — no new endpoint needed", "A dedicated `GET profile/auth-setting/2fa-status/` endpoint to be added by BE", "The `token-auth/` response itself (via `two_fa_verification`) covers both check and verification"],
    "recommend": 0,
    "reason": "`auth-me/` already runs post-token in `RouterHelper.loginUser` and exposes every field the new flow needs once `is_2fa_skipped` is added — no new endpoint required."
  }
]
---END---