## 1. Implementation

- [x] 1.1 In `packages/frontend/src/store/settings.ts:384`, change the `POSTMAN_API_KEY` field descriptor: `frozen: true` → `frozen: false`.
- [x] 1.2 In the same descriptor, update `description` from `'Postman API key for fetching collections'` to a longer string that points users at `https://www.postman.com/settings/me/api-keys` for obtaining a key. Mention that the key is required if any Jira ticket references a Postman collection URL.
- [x] 1.3 Rebuild the frontend (`npm run build:frontend`) and confirm typecheck passes for `packages/frontend`. (Verified — `tsc --noEmit` clean and `vite build` succeeded in 1.22s, output in `packages/frontend/dist/`.)

## 2. Verification

- [ ] 2.1 Open Settings → Connectors → Postman. Confirm the API Key field no longer shows the FROZEN badge and that the description text references the postman.com URL.
- [ ] 2.2 Paste a test key, click Save, reload the page. Confirm the value is persisted (re-renders with the masked password). Confirm `.env` was updated atomically (check `cat .env | grep POSTMAN_API_KEY`).
- [ ] 2.3 Toggle `POSTMAN_ENABLED` to true and save. Confirm both values are persisted.
- [ ] 2.4 Run a synthetic Jira ticket whose description contains a Postman collection URL (`https://www.postman.com/<workspace>/collection/<id>`). Confirm the agent log shows `Connector OK [postman]` instead of `Skipping unfetchable` or `POSTMAN_API_KEY not set`.

## 3. Rollout

- [ ] 3.1 Archive this change via `openspec archive unfreeze-postman-api-key-field --date $(date +%Y-%m-%d)` (or move the directory under `openspec/changes/archive/<date>-<name>/` manually if the CLI is unavailable).
