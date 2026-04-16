## Why

Today every connector uses a static credential pasted into `.env` (GitLab PAT, Figma PAT, Google Drive service-account JSON, etc.). This hurts in three concrete ways: (1) Figma PATs expire every 90 days and silently break pipelines mid-run, (2) non-developer users cannot realistically generate service-account keys or PATs — they just want to click "Connect Google Drive", and (3) credentials sit in plaintext `.env` with no rotation, no revocation tracking, and no per-user separation. The prior `app-connectors` design explicitly rejected OAuth as "too complex for headless agent" — that was correct **for the one-shot agent model**, but the codebase now has long-lived parent server + checkpointed agent children, so the constraint no longer holds.

## What Changes

- **NEW**: Browser-based OAuth 2.0 PKCE flow for **GitLab**, **Figma**, and **Google Drive** connectors.
- **NEW**: `CredentialStore` abstraction with three auto-selected backends: OS keychain (laptops), AES-256-GCM encrypted file (headless/Docker), plain env vars (cloud/CI).
- **NEW**: `TokenManager` daemon in the parent server process — single-flight refresh, proactive refresh at `expires_at - 5min`, write-ahead log, atomic persistence, clock-skew tracking.
- **NEW**: Stable OAuth callback URL `http://127.0.0.1:3000/oauth/:provider/callback` + routes (`/api/oauth/:provider/start`, `/callback`, `/disconnect`).
- **NEW**: Exit-code-78 (`AUTH_REFRESH_NEEDED`) sentinel protocol — child agent exits cleanly on terminal 401, parent refreshes, respawns from last checkpoint.
- **NEW**: `PAUSED_AUTH_REQUIRED` pipeline state + SSE event for mid-pipeline re-auth prompt in the UI.
- **NEW**: ConnectorCard gains `[Connect]` / `[Disconnect]` / `[Re-auth]` buttons, status pill (Connected / Refreshing / Re-auth Required / Revoked), expiry countdown, and collapsible `[Use API token instead ▾]` PAT disclosure.
- **NEW**: Figma, Google Drive, Postman become first-class tabs in the Settings Connectors grid (code exists but UI is not wired).
- **MODIFIED**: `http-client.ts` 401 classification — no longer `retry:false, immediate:true`; instead the parent is notified so it can refresh-once-then-retry-once. The agent still treats terminal 401 as exit-78.
- **MODIFIED**: `config-schema` hot-reload is wired to SSE broadcast so UI reflects credential changes live.
- **PRESERVED**: PAT / API-key auth remains a first-class fallback on every connector card. Nothing currently working stops working.

**Explicit non-goals:**

- Jira OAuth 3LO — Atlassian has **no PKCE** support (ECO-283 is still open); keep Basic-auth PAT.
- Slack OAuth — requires HTTPS redirect, cannot use loopback; keep incoming-webhook model.
- Postman OAuth — provider offers no OAuth; keep API key.
- Bring-your-own OAuth app (phase 2); ship a shared central MasterIndia OAuth app first.
- Mid-pipeline IPC for token refresh — use exit-78 + checkpoint respawn instead.

## Capabilities

### New Capabilities

- `credential-store`: Abstract secrets store with three pluggable backends (OS keychain / encrypted file / env vars); used by every connector.
- `connector-oauth-flow`: Generic OAuth 2.0 PKCE engine — authorize / callback / exchange / refresh / revoke, plus the `TokenManager` refresh daemon with single-flight, proactive refresh, write-ahead log, clock-skew compensation.
- `connector-google-drive`: Google Drive OAuth specifics — `drive.file` scope (non-sensitive, no Google verification), loopback redirect, rotating refresh token handling.
- `connector-figma`: Figma OAuth specifics — S256-only PKCE, exact-match redirect URI, 30-second authorization-code race mitigations, 90-day access token + rotating refresh.
- `connector-gitlab`: Adds OAuth PKCE mode to the existing GitLab connector while preserving PAT; 2-hour access token refresh; gitlab.com vs self-hosted base URL handling.
- `connector-reauth-lifecycle`: Exit-78 sentinel from agent → parent, `PAUSED_AUTH_REQUIRED` pipeline state, SSE `authRequired` event, parent-initiated respawn from last checkpoint in `state-unified.ts`.
- `connector-settings-ui`: Connect / Disconnect / Re-auth buttons on ConnectorCard, status pill, expiry countdown, OAuth flow launcher component, PAT fallback disclosure, Figma / Google Drive / Postman tabs in the Connectors grid.

### Modified Capabilities

<!-- None — the existing settings-and-connectors change owns the UI skeleton and config plumbing; this change strictly adds new capabilities. Any touch-points on existing modules are implementation details, not spec-level requirement changes. -->

## Impact

**Affected code**
- `packages/backend/src/server/routes.ts` — adds `/api/oauth/*` routes.
- `packages/backend/src/server/http-server.ts` — binds to `127.0.0.1:3000` for OAuth callbacks (loopback-only redirect requirement).
- `packages/agent/src/lib/http-client.ts` — 401 classification becomes parent-aware; agent exits with code 78 on terminal auth failure instead of throwing.
- `packages/agent/src/lib/config.ts` + `config-schema.ts` — reads access tokens from env injected by parent; no more refresh tokens in agent process.
- `packages/agent/src/lib/state-unified.ts` — adds `PAUSED_AUTH_REQUIRED` phase; existing checkpoint logic preserved and reused.
- `packages/agent/src/lib/{gitlab,figma,gdrive}.ts` — switch from static token constants to env-injected access tokens; OAuth-specific flows live in new `packages/backend/src/oauth/` modules.
- `packages/frontend/src/components/settings/ConnectorCard.tsx` — adds Connect button, status pill, expiry countdown, PAT disclosure.
- `packages/frontend/src/components/settings/ConnectorsTab.tsx` — exposes Figma, Google Drive, Postman tabs.
- `packages/frontend/src/hooks/useSSE.ts` — handles `authRequired` event.

**New dependencies**
- `cross-keychain` (OS keychain wrapper; replaces deprecated `keytar`).
- No new dependency for AES-256-GCM (Node `crypto` builtin).
- No new dependency for PKCE / HTTP (builtins suffice).

**New persisted files**
- `~/.config/mi-dev-agent/credentials.enc` (encrypted-file backend fallback only).
- `~/.config/mi-dev-agent/refresh-wal.json` (write-ahead log for interrupted refreshes).

**New environment variables**
- `CRED_ENC_KEY` (optional; overrides machine-id-derived key for encrypted file backend).
- `MI_DEV_AGENT_OAUTH_TOKENS` (optional; Docker/CI pre-loaded token bundle).
- `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_FIGMA_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_ID` (shipped defaults, overridable).
- `OAUTH_FIGMA_CLIENT_SECRET` (Figma requires client_secret even with PKCE).

**Pipeline stages affected**
- Every stage that calls GitLab (`push-code`, `create-preprod-mr`, `deploy-qa`, `deploy-prod`) — now uses env-injected access token.
- `explore-plan` and `generate-code` for Figma attachments — same env-injection pattern.
- `generate-code` for Google Drive attachments — same.
- No stage logic changes; the change is entirely in how credentials arrive.

**Internal GitLab (10.200.11.32) constraint**
- Self-hosted GitLab requires its OAuth app to be configured against this exact host; the connector persists `gitlab.baseUrl` alongside tokens so refresh goes to the right endpoint.
- OAuth flow itself runs over the user's browser → internal network, same path as existing UI traffic; no new network exposure.

**Security posture**
- Refresh tokens never leave the parent server process.
- Child agent only sees short-lived access tokens (1–2 h) injected via env.
- Disk-stored credentials are AES-256-GCM encrypted with machine-ID-derived key (or OS keychain where available).
- No client_secret for Google / GitLab (PKCE covers it). Figma's required client_secret is shipped but protected by OAuth app scoping.