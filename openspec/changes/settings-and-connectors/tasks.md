# Tasks

## Phase 1: Backend — Config API + Notification Config

- [x] 1. Create `lib/notification-config.js` — load/save per-gate notification preferences from `notification-config.json`
- [x] 2. Create config schema export in `lib/config-schema.js` — returns all env vars with metadata (type, default, description, category, sensitive, howToGet)
- [x] 3. Add `GET /api/config` endpoint — returns current config values (secrets masked) + schema
- [x] 4. Add `POST /api/config/save` endpoint — validates, writes to `.env` atomically, reloads config
- [x] 5. Add `POST /api/config/test/:service` endpoint — tests Jira/GitLab/Slack connectivity
- [x] 6. Add `GET /api/notification-config` + `POST /api/notification-config` endpoints

## Phase 2: Frontend — Settings Page

- [x] 7. Build Settings page with tabs: API Keys, Notifications, Connectors
- [x] 8. Build .env form UI — grouped inputs with info tooltips, masked passwords, validation
- [x] 9. Build gate notification toggle grid — per-gate Slack/Jira/UI toggles
- [x] 10. Build app connector cards — status, test, configure for each service
- [x] 11. Add save/test/reset buttons with toast feedback

## Phase 3: Integration — Wire Notification Config into Stages

- [x] 12. Wire `isChannelEnabled()` checks into all 10 stage files (fetch-ticket, explore-plan, push-code, gate-code-review, deploy-qa, test-qa, gate-preprod, gate-dual, deploy-prod, done)
- [x] 13. Fix UI↔API data mapping: gate key alignment, nested↔flat conversion, config items array→map
