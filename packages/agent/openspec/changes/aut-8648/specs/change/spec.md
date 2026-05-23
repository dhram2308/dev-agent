## ADDED Requirements

### Requirement: Post-Password 2FA Routing Gate
The system SHALL evaluate the authenticated user's 2FA state immediately after successful password login and route to the appropriate 2FA screen before granting dashboard access.

#### Scenario: User has 2FA disabled and has not skipped
- **WHEN** `auth-me/` returns `is_2fa_enabled: false` and `is_2fa_skipped: false` after token authentication
- **THEN** the system routes the user to `/enable-2fa` (the 2FA Setup screen) and blocks navigation to the dashboard

#### Scenario: User has 2FA disabled but previously skipped
- **WHEN** `auth-me/` returns `is_2fa_enabled: false` and `is_2fa_skipped: true`
- **THEN** the system routes the user to `/enable-2fa` again (skip flag re-prompts every login per AC#4) and blocks dashboard navigation

#### Scenario: User has 2FA enabled
- **WHEN** the `token-auth/` response contains a `two_fa_verification` payload with at least one channel and `mode_2fa`
- **THEN** the `Signin` flow renders the `VerifyOtp` screen and blocks dashboard navigation until OTP verification succeeds

#### Scenario: Non-enterprise product
- **WHEN** `VITE_PRODUCT_ID` is not the enterprise product ID
- **THEN** the 2FA routing gate SHALL NOT activate and existing login flow continues unchanged

### Requirement: 2FA Setup Screen — Mobile-Not-Verified Branch
The `/enable-2fa` setup screen SHALL display a mobile-verification sub-flow when `user.mobile_verified === false`, reusing the existing Settings → 2FA mobile endpoints with no new backend logic.

#### Scenario: User enters mobile number that matches admin record
- **WHEN** the user enters a mobile number and clicks "Send OTP"
- **THEN** the system calls `POST profile/auth-setting/2fa-auth/` with the entered mobile and shows the 6-digit OTP input on success

#### Scenario: Entered mobile does not match admin-registered number
- **WHEN** `POST profile/auth-setting/2fa-auth/` returns an admin-mismatch error
- **THEN** the system displays the error message *"The mobile number does not match our records. Please contact your Admin."* (BE-provided message preferred, FE fallback otherwise) and does not advance to OTP entry

#### Scenario: User enters correct OTP
- **WHEN** the user enters the 6-digit OTP and clicks "Verify"
- **THEN** the system calls `POST profile/auth-setting/2fa-auth/verify-otp/`, on success updates `user` context with `mobile_verified: true` and `is_2fa_enabled: true`, and redirects to the initial dashboard URL

#### Scenario: User enters incorrect OTP
- **WHEN** OTP verification fails
- **THEN** the system displays *"Invalid OTP. Please try again."* and clears all six OTP input boxes

### Requirement: 2FA Setup Screen — Mobile-Already-Verified Branch
The `/enable-2fa` setup screen SHALL show both Email and Mobile as pre-selected channels with a direct "Continue" button when `user.mobile_verified === true` and `user.is_2fa_enabled === false`.

#### Scenario: User clicks Continue with both channels pre-selected
- **WHEN** the user clicks "Continue"
- **THEN** the system calls `PUT profile/auth-setting/` with `is_2fa_enabled: true` and `mode_2fa: 'both'`, updates user context, and redirects to the dashboard

#### Scenario: User deselects one channel before continuing
- **WHEN** the user keeps only one channel selected and clicks "Continue"
- **THEN** the system sends `mode_2fa: 'email'` or `mode_2fa: 'mobile'` accordingly and proceeds

### Requirement: 2FA Setup Screen — Skip Action
The 2FA Setup screen SHALL provide a Skip button that persists a skip flag against the user profile and proceeds to the dashboard.

#### Scenario: User clicks Skip
- **WHEN** the user clicks "Skip for Now"
- **THEN** the system calls `PUT profile/auth-setting/` with `is_2fa_skipped: true`, updates user context, and navigates to `VITE_INITIAL_URL`

#### Scenario: User logs in again after skipping
- **WHEN** the same user authenticates on a subsequent session
- **THEN** the 2FA Setup screen reappears (per the Post-Password 2FA Routing Gate requirement)

### Requirement: Returning-User OTP Verification Screen
The `VerifyOtp` screen SHALL render only the channels active in `mode_2fa`, display a "2FA Enabled" badge per active channel, show masked destinations, and block dashboard access until OTP succeeds.

#### Scenario: Both channels active
- **WHEN** `mode_2fa === 'both'` and the screen renders
- **THEN** both Email (masked via `maskEmail`) and Mobile (masked via `maskPhone`) are shown, each with a "2FA Enabled" badge

#### Scenario: Email-only active
- **WHEN** `mode_2fa === 'email'`
- **THEN** only the masked email row is rendered with the "2FA Enabled" badge

#### Scenario: Mobile-only active
- **WHEN** `mode_2fa === 'mobile'`
- **THEN** only the masked mobile row is rendered with the "2FA Enabled" badge

#### Scenario: Resend OTP within countdown
- **WHEN** the countdown timer (60s) has not elapsed
- **THEN** the "Resend OTP" link is disabled and the remaining time is displayed

#### Scenario: Resend OTP after countdown
- **WHEN** the timer reaches zero and the user clicks "Resend OTP"
- **THEN** the system re-issues the OTP via the existing resend endpoint and restarts the countdown

#### Scenario: Incorrect OTP submitted
- **WHEN** OTP verification fails
- **THEN** the system displays *"Invalid OTP. Please try again."* and clears all six input boxes (resets via `setOtp('')` + `form.resetFields(['otp'])` in the error path)

#### Scenario: Back to Sign In
- **WHEN** the user clicks "Back to Sign In"
- **THEN** the system returns to the password sign-in card without verifying OTP

### Requirement: OTP Input Component Behavior
The 6-digit OTP input used in both Setup and Verification screens SHALL accept numeric input only, auto-advance on entry, support backspace navigation to the previous box, and reset all boxes on incorrect OTP submission.

#### Scenario: User types a digit
- **WHEN** a digit (0–9) is entered in a box
- **THEN** focus advances to the next box automatically

#### Scenario: User types a non-digit
- **WHEN** a non-digit character is entered
- **THEN** the input rejects the character and focus does not advance

#### Scenario: User presses backspace on empty box
- **WHEN** backspace is pressed in an empty box
- **THEN** focus moves to the previous box

#### Scenario: Incorrect OTP submission
- **WHEN** verification fails
- **THEN** all six boxes are cleared and focus returns to the first box

### Requirement: Masked Channel Display
Email and mobile values SHALL always be displayed in masked format across all 2FA screens, using `maskEmail` and `maskPhone` from `@mi/helpers/StringHelper`.

#### Scenario: Email display
- **WHEN** an email is shown on any 2FA screen
- **THEN** it is rendered via `maskEmail(email)`

#### Scenario: Mobile display
- **WHEN** a mobile number is shown on any 2FA screen
- **THEN** it is rendered via `maskPhone(mobile)`

### Requirement: Settings → 2FA Page Untouched
The Settings → Two-Factor Authentication page (`libs/entp/src/lib/profile/TwoFactorAuthSettings/**`) SHALL remain functionally and visually unchanged.

#### Scenario: User opens Settings → 2FA after this change ships
- **WHEN** the user navigates to Settings → Two-Factor Authentication
- **THEN** the page renders identically to its pre-change state and all enable/disable/verify operations work as before