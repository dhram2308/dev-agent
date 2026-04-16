## 1. Setup and prerequisites

- [x] 1.1 Add `cross-keychain` dependency to `packages/backend/package.json`
- [ ] 1.2 Register OAuth apps in provider consoles: Google Cloud (Desktop client, `drive.file` scope), Figma (Developer portal, S256 PKCE), internal GitLab at `http://10.200.11.32` (admin-provisioned, PKCE enabled)
- [x] 1.3 Document `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_FIGMA_CLIENT_ID`, `OAUTH_FIGMA_CLIENT_SECRET`, `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET` (optional), `CRED_ENC_KEY`, `MI_DEV_AGENT_OAUTH_TOKENS`, `AUTH_TIMEOUT_MIN` in `.env.example` and `docs/config.md`
- [x] 1.4 Add feature flags `ENABLE_CREDENTIAL_STORE=false` and `ENABLE_OAUTH=false` defaulted off for safe rollout
- [x] 1.5 Bind backend HTTP server to `127.0.0.1:3000` (not `0.0.0.0`) in `packages/backend/src/server/http-server.ts` for loopback-only OAuth redirect compliance, with env override for reverse-proxy deployments

## 2. Credential store (capability `credential-store`)

- [x] 2.1 Create `packages/backend/src/credentials/types.ts` defining `TokenSet`, `ProviderStatus`, `CredentialStore` interface
- [x] 2.2 Implement `packages/backend/src/credentials/keychain-backend.ts` using `cross-keychain` (service name `mi-dev-agent`, accounts `oauth:<provider>` / `pat:<provider>`)
- [x] 2.3 Implement `packages/backend/src/credentials/encrypted-file-backend.ts` — AES-256-GCM, key from `sha256(machine-id ‖ CRED_ENC_KEY)`, file at `~/.config/mi-dev-agent/credentials.enc` mode `0600`, atomic write via temp + fsync + rename
- [x] 2.4 Implement `packages/backend/src/credentials/env-backend.ts` read-only, parsing `$MI_DEV_AGENT_OAUTH_TOKENS` (base64 JSON)
- [x] 2.5 Implement `packages/backend/src/credentials/index.ts` auto-selection logic with keychain probe → encrypted-file → env-var fallback chain; log chosen backend at INFO
- [x] 2.6 Add `packages/backend/src/credentials/redaction.ts` helper enforcing `****last4` masking; wire into existing `lib/redaction.ts`
- [x] 2.7 Write unit tests for each backend (write/read/delete/list + atomic-interrupt + different-machine decryption failure)
- [x] 2.8 Write a CI guard test that scans logs/SSE output for full-token leaks

## 3. OAuth engine and TokenManager (capability `connector-oauth-flow`)

- [x] 3.1 Create `packages/backend/src/oauth/pkce.ts` helpers for `generateVerifier()`, `challengeFromVerifier()`, `generateState()`
- [x] 3.2 Create `packages/backend/src/oauth/provider.ts` defining the `ProviderAdapter` interface
- [x] 3.3 Create `packages/backend/src/oauth/engine.ts` implementing `start()`, `handleCallback()`, with 10-minute state TTL stored in memory
- [x] 3.4 Create `packages/backend/src/oauth/token-manager.ts` with single-flight `Map<provider, Promise<TokenSet>>`, `getAccessToken()`, `refresh()`, proactive timer at `expiresAt - 5min`, lazy guard at `-30s`
- [x] 3.5 Implement write-ahead log at `~/.config/mi-dev-agent/refresh-wal.json` + startup recovery check
- [x] 3.6 Implement clock-skew tracker reading `Date` response headers and maintaining rolling average
- [x] 3.7 Implement reactive-401 wrapper for parent-side HTTP client: invalidate → refresh → retry-once
- [x] 3.8 Add routes in `packages/backend/src/server/routes.ts`: `POST /api/oauth/:provider/start`, `GET /oauth/:provider/callback`, `POST /api/oauth/:provider/disconnect`
- [x] 3.9 Return minimal self-closing success/failure HTML pages from the callback handler (no separate template file needed)
- [x] 3.10 Write unit tests covering single-flight, proactive fire, lazy guard, WAL recovery, state mismatch rejection, reactive 401 retry

## 4. Google Drive OAuth (capability `connector-google-drive`)

- [x] 4.1 Create `packages/backend/src/oauth/providers/google.ts` — adapter with `drive.file` scope, `access_type=offline`, `prompt=consent`
- [x] 4.2 Register the Google adapter in the provider registry in `engine.ts`
- [x] 4.3 Modify `packages/agent/src/lib/gdrive.ts` to read `GOOGLE_OAUTH_ACCESS_TOKEN` from env when `authMode === 'oauth'` (keep service-account JWT path for `authMode === 'service_account'`)
- [x] 4.4 Wire parent-spawn env injection in `packages/backend/src/pipeline/agent-process.ts` (or equivalent spawner) to call `TokenManager.getAccessToken('google')` before spawn and inject the token
- [x] 4.5 Implement revoke step in disconnect handler (POST `https://oauth2.googleapis.com/revoke`)
- [ ] 4.6 Add integration test stubbing Google endpoints to verify the flow end-to-end

## 5. Figma OAuth (capability `connector-figma`)

- [x] 5.1 Create `packages/backend/src/oauth/providers/figma.ts` — adapter with S256-only PKCE enforcement, required `clientSecret`
- [x] 5.2 Register the Figma adapter in the provider registry
- [x] 5.3 Implement TLS pre-warm: open a keep-alive connection to `api.figma.com:443` in `start()` and hold for 2 minutes
- [x] 5.4 Ensure the Figma callback handler performs token exchange synchronously (before any DB/SSE side effects)
- [x] 5.5 Render "Authorization failed. Try again." page with single retry action on any exchange failure (no code retry)
- [x] 5.6 Modify `packages/agent/src/lib/figma.ts` to use `Authorization: Bearer <FIGMA_OAUTH_ACCESS_TOKEN>` when `authMode === 'oauth'` (keep `X-Figma-Token` for PAT)
- [x] 5.7 Wire parent-spawn env injection for Figma token
- [x] 5.8 Document in UI the manual revoke URL `https://www.figma.com/settings → Connected apps`
- [ ] 5.9 Integration test with mock Figma server verifying < 3 s critical path

## 6. GitLab OAuth (capability `connector-gitlab`)

- [x] 6.1 Create `packages/backend/src/oauth/providers/gitlab.ts` — adapter parameterized by `baseUrl`, public-client mode when `clientSecret` absent
- [x] 6.2 Persist `metadata.baseUrl` in stored TokenSet so refreshes go to the original instance
- [x] 6.3 Modify `packages/agent/src/lib/gitlab.ts` to use `Authorization: Bearer <GITLAB_OAUTH_ACCESS_TOKEN>` when `authMode === 'oauth'` (keep `PRIVATE-TOKEN` for PAT)
- [x] 6.4 Wire parent-spawn env injection for GitLab token
- [x] 6.5 Add self-hosted URL validation: HEAD `${baseUrl}/api/v4/version` before starting the flow
- [x] 6.6 Implement revoke step on disconnect (POST `${baseUrl}/oauth/revoke`)
- [x] 6.7 Add config-schema field `gitlab.authMode: 'oauth' | 'pat'` with default `'pat'` for backward compatibility
- [ ] 6.8 Integration test against a mock GitLab instance verifying OAuth flow + refresh + reactive 401

## 7. Re-auth lifecycle (capability `connector-reauth-lifecycle`)

- [x] 7.1 Add `PAUSED_AUTH_REQUIRED` phase to `packages/agent/src/lib/state-unified.ts` phase enum
- [x] 7.2 Modify `packages/agent/src/lib/http-client.ts` so that on 401 from an OAuth-mode provider, the agent writes `state.data._authFailure = { provider, ts }` and calls `process.exit(78)` instead of throwing
- [x] 7.3 Keep current PAT-mode escalation path untouched (Jira 401 still triggers Slack alert + Jira comment)
- [x] 7.4 In `packages/backend/src/pipeline/agent-process.ts` detect child exit code 78, read `state.data._authFailure.provider`, call `TokenManager.refresh(provider)`, respawn the agent from the persisted phase
- [x] 7.5 Track `state.data._authRespawnCount[provider]`, cap at 3, transition to `FAILED` when exceeded
- [x] 7.6 On `TokenManager.refresh()` terminal failure (or after respawn cap), transition pipeline to `PAUSED_AUTH_REQUIRED` and broadcast SSE `{ type: 'authRequired', provider, reason, authorizeUrl }`
- [x] 7.7 Implement `AUTH_TIMEOUT_MIN` (default 120 minutes) countdown; transition to `FAILED` on expiry
- [x] 7.8 Implement resume path: when a connector returns to `CONNECTED` and the pipeline is `PAUSED_AUTH_REQUIRED`, restore previous phase and respawn
- [ ] 7.9 End-to-end test: synthesize a 401 mid-pipeline, verify exit-78 → refresh → respawn → continue

## 8. Settings UI (capability `connector-settings-ui`)

- [x] 8.1 Extend `packages/frontend/src/components/settings/ConnectorCard.tsx` with status pill, Connect / Disconnect / Re-auth buttons, expiry countdown, account-identity display
- [x] 8.2 Add `OAuthLauncher` helper hook that POSTs to `/api/oauth/:provider/start` and opens `authorizeUrl` in a new tab
- [x] 8.3 Implement collapsible `[Use API token instead ▾]` disclosure that renders the existing PAT input + Test button
- [x] 8.4 Add `PATMode` toggle in card state — pill reads "Connected via PAT" when active
- [x] 8.5 Expose Figma, Google Drive, Postman as individual tabs in `packages/frontend/src/components/settings/ConnectorsTab.tsx`
- [x] 8.6 Add amber dot badge on tab when its connector is `RE_AUTH_REQUIRED`
- [x] 8.7 Add top-of-page `AuthRequiredBanner` component listening for SSE `authRequired` events with `[Re-authorize <provider>]` button
- [x] 8.8 Wire `hooks/useSSE.ts` to handle new event types: `connectorConnected`, `connectorDisconnected`, `connectorError`, `authRequired`
- [x] 8.9 Wire `config-schema` hot-reload SSE so UI reflects credential-store changes live (address the gap noted in proposal)
- [x] 8.10 Write Vitest component tests for ConnectorCard states (not-connected / connected / refreshing / re-auth / revoked / PAT)

## 9. Verification via Web UI (localhost:3000)

- [ ] 9.1 Verify Google Drive: click `[Connect Google Drive]`, complete browser flow, confirm card shows "Connected as <email>", expiry countdown updates
- [ ] 9.2 Verify Figma: click `[Connect Figma]`, measure callback → exchange latency < 3 s, confirm 90-day `expiresAt` stored
- [ ] 9.3 Verify GitLab (gitlab.com): switch mode to OAuth, click Connect, confirm pipeline push/merge stages succeed with Bearer token
- [ ] 9.4 Verify GitLab (internal 10.200.11.32): same as above against the internal instance; confirm `metadata.baseUrl` persists and refresh targets internal URL
- [ ] 9.5 Verify exit-78 flow: set a short expiry (1 minute test mode), let pipeline hit 401, confirm agent exits 78, parent refreshes, pipeline resumes
- [ ] 9.6 Verify PAUSED_AUTH_REQUIRED: revoke GitLab access mid-pipeline via GitLab UI, confirm banner appears, re-auth from UI, pipeline resumes
- [ ] 9.7 Verify PAT fallback: set `gitlab.authMode='pat'`, paste a PAT, run a pipeline end-to-end
- [ ] 9.8 Verify keychain backend on macOS/Windows/Linux-GUI; verify encrypted-file backend on headless Linux (disable keychain probe)
- [ ] 9.9 Verify env-var backend in a Docker container with `$MI_DEV_AGENT_OAUTH_TOKENS` preloaded
- [ ] 9.10 Verify log redaction: grep the entire log dir for any known token prefix; CI must fail if any full token appears

## 10. Rollout and documentation

- [ ] 10.1 Flip `ENABLE_CREDENTIAL_STORE=true` in dev; run one full pipeline end-to-end
- [ ] 10.2 Flip `ENABLE_OAUTH=true` in dev; verify all 3 OAuth providers
- [ ] 10.3 Update `CLAUDE.md` memory with OAuth-mode notes and the exit-78 protocol
- [ ] 10.4 Update `docs/config.md` with the full OAuth setup guide (per-provider app registration, redirect URL, scopes)
- [ ] 10.5 Add a `docs/oauth-troubleshooting.md` covering: port 3000 conflict, keychain probe failures, clock skew, mid-pipeline re-auth
- [ ] 10.6 Archive this change via `openspec archive oauth-connectors --date $(date +%Y-%m-%d)`
