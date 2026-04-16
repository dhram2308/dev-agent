## 1. Modify GstinAuthentication Component

- [ ] 1.1 Add optional `skipOtpCheck?: boolean` prop to the `Props` type in `libs/smb/src/lib/gst/GstinAuthentication/index.tsx`
- [ ] 1.2 Update the component logic: when `skipOtpCheck` is `true`, skip the OTP modal and alert rendering blocks (lines 36-78) and render children directly, while preserving the `'na'` → `RegisterGst` check

## 2. Update GST Return Pages

- [ ] 2.1 Update GSTR-1 (`apps/enterprise/src/app/GSTReturn/Gstr1/index.tsx`): add `STEP_ONE_TABS = ['overview', 'prepare']` constant, compute `isStepOneTab`, pass `skipOtpCheck={isStepOneTab}` to `GstinAuthentication`
- [ ] 2.2 Update GSTR-1A (`apps/enterprise/src/app/GSTReturn/Gstr1A/index.tsx`): add `STEP_ONE_TABS = ['overview', 'prepare']`, pass `skipOtpCheck`
- [ ] 2.3 Update GSTR-3B (`apps/enterprise/src/app/GSTReturn/3B/index.tsx`): add `STEP_ONE_TABS = ['overview', 'prepare']`, pass `skipOtpCheck`
- [ ] 2.4 Update GSTR-6 (`apps/enterprise/src/app/GSTReturn/Gstr6/index.tsx`): add `STEP_ONE_TABS = ['import-data', 'overview', 'prepare']`, pass `skipOtpCheck`
- [ ] 2.5 Update GSTR-7 (`apps/enterprise/src/app/GSTReturn/Gstr7/index.tsx`): add `STEP_ONE_TABS = ['overview', 'prepare']`, pass `skipOtpCheck`
- [ ] 2.6 Update GSTR-9 (`apps/enterprise/src/app/GSTReturn/Gstr9/index.tsx`): add `STEP_ONE_TABS = ['auto-populate', 'prepare', 'gst-portal-overview']`, pass `skipOtpCheck`
- [ ] 2.7 Update GSTR-9C (`apps/enterprise/src/app/GSTReturn/Gstr9C/index.tsx`): add `STEP_ONE_TABS = ['import-data', 'auto-populate', 'prepare', 'overview']`, pass `skipOtpCheck`
- [ ] 2.8 Update ITC-04 (`apps/enterprise/src/app/GSTReturn/Itc04/index.tsx`): add `STEP_ONE_TABS = ['import-data', 'overview', 'prepare']`, pass `skipOtpCheck`

## 3. Verification

- [ ] 3.1 Run lint check: `nx lint enterprise` to ensure no lint errors
- [ ] 3.2 Run build check: `nx build enterprise` to ensure successful compilation