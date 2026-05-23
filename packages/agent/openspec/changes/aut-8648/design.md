## Context

The enterprise app already contains all the building blocks for a login-time 2FA flow:

- **Setup screen scaffold**: `libs/entp/src/lib/auth/TwoFactorConfirm/index.tsx` (route `/enable-2fa`) already supports Email-only enable + a "Skip For Now" button. It is reached today via `RouterHelper.checkRoutePermissionWith2FA` when `user.is_2fa_enabled === false`.
- **Returning-user OTP screen**: `libs/entp/src/lib/auth/Signin/VerifyOtp.tsx` already exists. `Signin/index.tsx` flips to it when `token-auth/` returns `two_fa_verification: { mobile?, email? }`. It uses `react-otp-input` (auto-advance + backspace), `maskEmail`/`maskPhone` from `@mi/helpers/StringHelper`, and `ExpireTime` for the resend countdown.
- **Settings → 2FA endpoints**: `profile/auth-setting/`, `profile/auth-setting/2fa-auth/`, `profile/auth-setting/2fa-auth/verify-otp/`. Mobile send/verify logic lives in `TwoFactorAuthSettings/PhoneVerification.tsx`.
- **Auth state**: `useAuthUser()` / `updateUser()` on `AuthContextProvider`. `UserProps` (`libs/constants/src/models/BusinessContext.ts`) carries `is_2fa_enabled`, `mobile_verified`, `mode_2fa`, `phone_number`.

The work is **extension, not greenfield**. Two pieces of new contract are needed: (a) a `is_2fa_skipped` field on user profile to persist skip state, and (b) confirmation that returning users with `is_2fa_enabled === true` will always receive `two_fa_verification` in the `token-auth/` response.

## Goals / Non-Goals

**Goals:**
- Make the `/enable-2fa` setup screen handle the mobile-not-verified branch using the existing Settings → 2FA mobile endpoints.
- Surface mode-specific channels with a "2FA Enabled" badge on `VerifyOtp` for returning users.
- Persist skip flag through the existing `PUT profile/auth-setting/` call.
- Keep all 2FA enforcement behind enterprise `VITE_PRODUCT_ID`.
- Zero regressions in Settings → Two-Factor Authentication page.

**Non-Goals:**
- New routes, new contexts, new shared OTP component, new icon assets.
- Refactoring `TwoFactorAuthSettings/**` to share code with the login flow.
- New OTP backend logic (explicit ticket constraint).
- Cross-product changes (SMB / GST / TaxPro / accounts apps stay untouched).

## Decisions

**1. Extend `TwoFactorConfirm` rather than create a new "TwoFactorSetup" screen.**
The route `/enable-2fa` is already registered, already reached via `RouterHelper`, already supports Email-only enable, and already has a Skip button. Creating a parallel screen would duplicate route wiring, localization, and styled wrappers (`AuthBoxWrapper`, `FormWrapper`, `TwoFaButtonRow`, etc.).
*Alternative considered*: separate `TwoFactorSetup` component → rejected; doubles surface area for the same UX with no architectural gain.

**2. Reuse `Signin → VerifyOtp` for returning-user OTP, do not add a new route.**
The OTP step already happens inside the `token-auth/` response cycle. The server signals it via `two_fa_verification`; the client flips a card. Adding a `/verify-2fa` route would require duplicating IV/encryption, countdown, and OTP reset logic.
*Alternative considered*: new `/verify-2fa` route → rejected; the BE contract already drives the screen flip and a route would split state across two trees.

**3. Pipe `mode_2fa` into `VerifyOtp` to drive channel visibility + badge.**
`twoFaData` (currently `{ mobile?, email? }`) becomes `{ mobile?, email?, mode_2fa? }`. The component renders only channels present in `mode_2fa`, plus a `<Tag>` "2FA Enabled" beside each. Single source of truth from BE.
*Alternative considered*: client-side inference from presence of `mobile` vs `email` → rejected; ambiguous when BE returns both for fallback purposes.

**4. Move OTP reset from success-path to error-path of `onOtpSubmit`.**
AC#7 mandates clearing all boxes on incorrect OTP. Today the reset only fires on success. The fix is a 4-line change in `Signin/index.tsx` (move `setOtp('')` + `form.resetFields(['otp'])` into the `.catch` block).
*Alternative considered*: reset inside `VerifyOtp` via `useEffect` on error prop → rejected; adds a prop and indirection for a 4-line move.

**5. Persist skip via `is_2fa_skipped` on existing `PUT profile/auth-setting/`.**
Backend Scope #3 says "store and maintain the skip flag against the user profile" — no new endpoint. Frontend sends `{ is_2fa_skipped: true }` to the same endpoint that toggles `is_2fa_enabled`. `auth-me/` returns it; `RouterHelper.checkRoutePermissionWith2FA` consults it.
*Alternative considered*: session-only skip (sessionStorage) → rejected; AC#4 requires re-prompt on **next login**, not next page load, which means BE persistence.

**6. Gate behind `VITE_PRODUCT_ID` enterprise check at the routing layer, not at the screen.**
`RouterHelper.checkRoutePermissionWith2FA` already runs only in enterprise paths. Adding the gate in `TwoFactorConfirm` itself would risk other apps importing the screen and triggering the flow.
*Alternative considered*: per-screen `if (productId !== ENTERPRISE) return` → rejected; defense-in-depth is fine but the routing gate is the canonical enforcement point.

## Risks / Trade-offs

- **[HIGH] No `is_2fa_skipped` field today** → Mitigation: block development on FE until BE confirms field name + endpoint shape. Question raised in QUESTIONS block.
- **[HIGH] Returning-user OTP every login is a behavior change** → Mitigation: confirm with BE that `token-auth/` returns `two_fa_verification` whenever `is_2fa_enabled === true`. If today's behavior is "OTP only on suspicious login," AC#5 implies BE change too.
- **[MED] "2FA Status Check API" wording in the ticket** → Mitigation: clarify that `auth-me/` (already called post-token) is the source of truth for `is_2fa_enabled`, `mobile_verified`, `mode_2fa`, `is_2fa_skipped`. No separate endpoint needed unless BE creates one.
- **[MED] Admin-mobile-mismatch validation** → Mitigation: rely on BE response from `POST profile/auth-setting/2fa-auth/` and surface via `infoViewContext.fetchError(error.message)`. Only fall back to a hard-coded i18n string if BE message is empty.
- **[LOW] OTP reset move could regress success-path UX** → Mitigation: success path navigates away (`navigate(initialUrl)`), so resetting form fields there is a no-op being deleted. Verified safe.
- **[LOW] Skip flag stale after user enables 2FA via Settings** → Mitigation: when Settings → 2FA enables a channel, BE should clear `is_2fa_skipped`. Confirm with BE; otherwise FE patches it during enable flow inside Settings (would violate AC#8). BE-side cleanup is the correct fix.