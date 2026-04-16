### specs/conditional-otp-gating/spec.md

## ADDED Requirements

### Requirement: GstinAuthentication supports conditional OTP bypass
The `GstinAuthentication` component SHALL accept an optional `skipOtpCheck` boolean prop. When `skipOtpCheck` is `true`, the component SHALL render children directly without showing OTP verification modals or warning alerts, regardless of `otp_status` value. When `skipOtpCheck` is `false` or not provided, the component SHALL behave identically to the current implementation.

#### Scenario: skipOtpCheck is true and otp_status is verify-otp
- **WHEN** `skipOtpCheck` is `true` and `currentBusiness.otp_status` is `'verify-otp'`
- **THEN** the component SHALL render children without showing the OTP modal

#### Scenario: skipOtpCheck is true and otp_status is null
- **WHEN** `skipOtpCheck` is `true` and `currentBusiness.otp_status` is `null`
- **THEN** the component SHALL render children without showing the warning Alert or OTP modal

#### Scenario: skipOtpCheck is false (default behavior preserved)
- **WHEN** `skipOtpCheck` is `false` or not provided and `currentBusiness.otp_status` is `'verify-otp'`
- **THEN** the component SHALL show the blocking OTP modal as it does today

#### Scenario: GSTIN registration always enforced regardless of skipOtpCheck
- **WHEN** `currentBusiness.otp_status` is `'na'` regardless of `skipOtpCheck` value
- **THEN** the component SHALL render `<RegisterGst />` and SHALL NOT render children

### Requirement: Step 1 tabs bypass OTP verification in all GST return pages
Each GST return page SHALL pass `skipOtpCheck={true}` to `GstinAuthentication` when the active tab is a Step 1 (data review/prepare) tab, and `skipOtpCheck={false}` when the active tab is a Step 2+ (upload/payment/filing) tab.

#### Scenario: User views GSTR-1 overview tab without OTP
- **WHEN** user navigates to GSTR-1 with active tab `'overview'` or `'prepare'` and OTP is not verified
- **THEN** the tab content SHALL be visible without OTP modal or warning alert

#### Scenario: User navigates to GSTR-1 upload tab without OTP
- **WHEN** user navigates to GSTR-1 with active tab `'upload-data'` or `'file-return'` and OTP is not verified
- **THEN** the OTP verification flow SHALL be enforced (modal or alert shown)

#### Scenario: User views GSTR-3B prepare tab without OTP
- **WHEN** user navigates to GSTR-3B with active tab `'overview'` or `'prepare'` and OTP is not verified
- **THEN** the tab content SHALL be visible without OTP enforcement

#### Scenario: User navigates to GSTR-3B payment tab without OTP
- **WHEN** user navigates to GSTR-3B with active tab `'pay-returns'` or `'file-return'` and OTP is not verified
- **THEN** the OTP verification flow SHALL be enforced

### Requirement: Step 1 tab classification per return type
The following tabs SHALL be classified as Step 1 (OTP-free) for each return type:

| Return | Step 1 Tabs |
|--------|-------------|
| GSTR-1 | `overview`, `prepare` |
| GSTR-1A | `overview`, `prepare` |
| GSTR-3B | `overview`, `prepare` |
| GSTR-6 | `import-data`, `overview`, `prepare` |
| GSTR-7 | `overview`, `prepare` |
| GSTR-9 | `auto-populate`, `prepare`, `gst-portal-overview` |
| GSTR-9C | `import-data`, `auto-populate`, `prepare`, `overview` |
| ITC-04 | `import-data`, `overview`, `prepare` |

All other tabs in each return type SHALL be classified as Step 2+ and SHALL require OTP verification.

#### Scenario: All Step 1 tabs bypass OTP across all return types
- **WHEN** the active tab matches any Step 1 tab key for its return type
- **THEN** `skipOtpCheck` SHALL be `true` and OTP enforcement SHALL be bypassed

#### Scenario: All Step 2+ tabs enforce OTP across all return types
- **WHEN** the active tab does not match any Step 1 tab key for its return type
- **THEN** `skipOtpCheck` SHALL be `false` and OTP enforcement SHALL apply