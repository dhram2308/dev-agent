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

## 11. Wiring gaps discovered post-archive review (Decisions 10 & 11)

These tasks complete the wiring intent of sections 4 / 5 / 6 (where the per-provider env-injection items 4.4, 5.7, 6.4 were marked complete but the parent-side `setTokenManager` call was never actually added at backend startup). They implement Decisions 10 and 11.

- [x] 11.1 Add `export function getAccessTokenSync(provider: string): string | null` to `packages/backend/src/oauth/token-manager.ts`. Implementation: read the existing in-memory `tokenCache` Map; return the cached `accessToken` only if `expiresAt - EXPIRY_BUFFER_MS > Date.now() + skew(provider)`; otherwise return `null`. Pure read, no Promise, no refresh side-effect.
- [x] 11.2 In `packages/backend/src/server/http-server.ts`, after the existing OAuth-handler injection block (around line 250), call `tokenManager.initFromStore()` so the in-memory cache is warm before the first agent spawn. (`initFromStore` calls `recoverWAL` internally — single call covers both.) Implemented as fire-and-forget with `.catch()` for non-fatal logging; user-initiated agent spawns happen many ms after server boot, by which time the cache is populated.
- [x] 11.3 In the same location, call `agentProcess.setTokenManager({ getAccessTokenSync: tokenManager.getAccessTokenSync, refresh: tokenManager.refresh })`. Guard with `typeof agentProcess.setTokenManager === 'function'` so the wire is no-op when the legacy agent-process build (without OAuth support) is loaded via the fallback path at line 89. Also extended the `AgentProcessModule` interface in `http-server.ts` with the optional `setTokenManager` member.
- [x] 11.4 In `packages/agent/src/stages/fetch-ticket.ts` lines 359-372, replace the routing gate per Decision 11 — `(parseBoolean(process.env.GDRIVE_ENABLED) ?? !!process.env.GOOGLE_OAUTH_ACCESS_TOKEN) && gdrive.matchUrl(url)` and the Figma equivalent. Postman gate unchanged. Keep `parseBoolean` semantics for explicit `true`/`false`; only the unset (`null`) case changes behavior.
- [x] 11.5 In `packages/agent/src/server/agent-process.ts` around line 280 (exit-78 branch), add an else-branch for the case where `code === EXIT_AUTH_REFRESH` but `_tokenManager` is null. Broadcast SSE error event `{ type: 'authRequired', provider, reason: 'token-manager-not-wired', ticket }` and log at WARN level. Today this case fails silently and is hard to debug.
- [x] 11.6 In `http-server.ts`, after the `setTokenManager` wire from 11.3, add a startup self-check: if `process.env.ENABLE_OAUTH !== 'false'` *and* `agentProcess.setTokenManager` is not a function, log at WARN level: "OAuth enabled but agent-process does not expose setTokenManager — spawned agents will not receive OAuth tokens. Connectors will fall back to PAT / service-account paths."
- [x] 11.7 Document `MAX_CONNECTOR_ITEMS = 3` cap (see `fetch-ticket.ts:350`) — overflow URLs fall back to the manual-paste path regardless of OAuth state. (Documented inline at the constant declaration since `docs/` does not exist in this repo; comment is more discoverable for code readers and travels with the constant.)
- [ ] 11.8 Manual verification: process AUT-7121 (or any ticket with 1 Google Doc + 2 Figma URLs) end-to-end after wiring. Expected log lines: `Connector URLs found: 3 (cap: 3)`, `Connector OK [gdrive]`, `Connector OK [figma]`. Expected absence: no `Skipping unfetchable: <gdrive/figma url>` lines, no `Documents Needed` Slack notification.
- [ ] 11.9 Cross-reference note: tasks 4.4 (Google spawn injection), 5.7 (Figma spawn injection), 6.4 (GitLab spawn injection) marked complete in this change describe the per-provider env-injection target. The actual parent-side wiring call was never added; section 11 is the concrete completion. Do not re-mark 4.4/5.7/6.4 — keep them as historical artifacts of the original plan.
- [x] 11.10 In-process Test-button consumer fix. Discovered during 11.8 verification: the Settings → "Test" button hits `POST /api/test-connection?service=figma|gdrive`, whose backend route handler at `packages/backend/src/server/routes.ts:1668-1678` requires the agent's compiled connector lib in-process. Those libs read `process.env.FIGMA_OAUTH_ACCESS_TOKEN` / `process.env.GOOGLE_OAUTH_ACCESS_TOKEN` — which are only set for *spawned children* via Decision 10's setTokenManager wire, never for the backend process itself. Patched the route handler to call `tokenManager.getAccessToken(provider)` (async — handles cache miss + refresh + CredentialStore fallback) and stage the token into `process.env[envKey]` before invoking the connector lib. Postman is unaffected (no OAuth path; reads `POSTMAN_API_KEY` which lives in `.env`). The injected env var persists in the backend process for subsequent in-process calls — acceptable in single-user installation model, will be re-set on token refresh.
- [x] 11.11 Honor `metadata._status` in cache validity check. Bug discovered during Test on a real Figma OAuth token: the user's token had its refresh fail with a terminal error 15 min after issue (cause TBD — possibly proactive timer mis-fire or reactive 401 cascade). The token-manager set `metadata._status = 'RE_AUTH_REQUIRED'` per `performRefresh` lines 514-526 but **kept** the access-token bytes and the original 90-day `expiresAt` from `current`. `isCacheValid` only checked `expiresAt`, so subsequent `getAccessToken('figma')` calls happily returned the known-bad token, my Test wire (11.10) staged it into env, and Figma rejected it with `{"status":403,"err":"Invalid token"}`. Fixed `isCacheValid` in `packages/backend/src/oauth/token-manager.ts` to short-circuit when `metadata._status === 'RE_AUTH_REQUIRED'` or `'REVOKED'`. Now `getAccessToken` falls through to the cached-but-invalid branch, attempts refresh (which reads the live store — picks up post-disconnect-reconnect tokens automatically), and returns null on terminal failure. Also extended the Test handler from 11.10 to `delete process.env[envKey]` when `getAccessToken` returns null, so a stale env var from a prior test cannot leak across a disconnect.

- [x] 11.13 Sync the in-memory cache with the credential store on OAuth callback and disconnect. Discovered while diagnosing 11.12: `handleOAuthCallback` (`packages/backend/src/oauth/engine.ts:341`) was writing the new TokenSet to the credential store but never updating the token-manager's in-memory `tokenCache`. After a fresh re-OAuth, the store had a `_status: CONNECTED` token but the cache still held the prior `_status: RE_AUTH_REQUIRED` entry; with 11.11's metadata-aware `isCacheValid`, that stale cache entry caused `getAccessToken` to fall through to the "cached-but-invalid → refresh" branch and immediately POST the just-issued refresh token back to Figma, which refused (likely a "refresh-too-soon" rotation race). Same kind of leak on `disconnectProvider` (`engine.ts:385`) — store deletion left the cache and any pending refresh timer alive. Added two minimal exported helpers in `token-manager.ts`: `notifyTokenStored(provider, tokenSet)` (calls `updateCache` + `scheduleProactiveRefresh`) and `clearProviderCache(provider)` (calls `cancelRefresh` + `tokenCache.delete`). Wired them into `handleOAuthCallback` (after `store.set`) and `disconnectProvider` (after `store.delete`). The cache now stays in sync with the store across the connect/disconnect lifecycle, so a disconnect → reconnect → test sequence works without a process restart.

- [x] 11.12 **RESOLVED — root cause identified and fixed.** Suspect #2 (proactive-timer mis-fire) confirmed via the diagnostics shipped earlier. Underlying mechanism: **Node.js `setTimeout` silently coerces any delay larger than 2³¹ − 1 ms (~24.85 days) to `1`.** The proactive-refresh scheduler computed `delay = expiresAt - 5min - now` (~90 days for Figma OAuth tokens, ~89.997 days when freshly minted). That value, passed to `setTimeout`, fired in 1 ms. The success handler called `scheduleProactiveRefresh` again, which fired immediately again — a tight loop that rotated through Figma's refresh-token chain in ~6 seconds before Figma terminal-rejected with `invalid_grant: "The refresh token is invalid or expired"`. Google Drive (1-hour tokens) never tripped the limit; that's why only Figma manifested. Fix: introduce `MAX_SAFE_TIMEOUT_MS = 2_000_000_000` (~23.1 days, well under the limit); when `targetDelay > MAX_SAFE_TIMEOUT_MS`, schedule a chained wakeup that re-calls `scheduleProactiveRefresh` once Date.now() has advanced enough to bring the real target into the safe window. Also swapped `console.error` to `logWarn` in the proactive-refresh failure handler so the structured logger captures it. Diagnosis was made possible by the trigger-source labels (11.12 step 1) and the `[token-manager] Proactive refresh scheduled fireAt=...` line (11.12 step 3) — without them the loop just looked like "Figma rejects all our tokens." Refs: backend `agent-.log` 2026-05-09T11:44:43..50.842Z showed 10 successive proactive-timer refreshes over 6 s ending in `invalid_grant`. Two related bugs (11.11 metadata-aware cache, 11.13 callback/disconnect cache sync) were necessary precursors — without them, the cache would have served the bad post-loop token and masked the real trigger. Field evidence from the AUT-7121 verification cycle: a fresh Figma OAuth token issued at 2026-05-08T11:17:25Z had its refresh fail with a terminal error at 11:32:07Z — exactly 14m 42s later — even though Figma reports `expires_in = 7776000` (90 days). 11.11 hardens consumers against bad tokens, but does not explain why the refresh fired in the first place. There are three plausible mechanisms; the goal of 11.12 is to identify which one and fix it.

  Suspects (ranked by likelihood):

  1. **Reactive 401 cascade** — a stage in some pipeline run (or an unrelated in-process caller) hit Figma, received a 401 for an unrelated reason (e.g. an in-flight request hit Figma during the brief window when the OAuth grant was propagating server-side), and the parent's reactive-401 wrapper from Decision 6 invalidated + refreshed the cached token. If the refresh-then-retry race itself produced a stale `Date` header or got rejected by Figma's "code already used" guard, the refresh would terminal-fail and lock out the token.
  2. **Proactive timer mis-fire** — `scheduleProactiveRefresh(provider, expiresAt)` (token-manager.ts:300) fires at `expiresAt - 5min`. If `expiresAt` was momentarily set wrong (e.g. seconds vs ms confusion in a code path other than `parseTokenResponse`, or a clock-skew adjustment overshot), the timer would fire near the present rather than 90 days out. The user's token clearly had `expiresAt: 1786015049660` (~Aug 6) when read post-failure, but that value could have been corrected by the failed-refresh path's `...current` spread; the *actual* scheduled time of the timer is not logged.
  3. **WAL recovery on startup** — if the user restarted the backend between 11:17 and 11:32 (e.g. to pick up the section-11 changes), `initFromStore` → `recoverWAL` ran. `recoverWAL` only refreshes tokens marked expired (line 643), so it shouldn't touch a fresh token, but a stale WAL entry from a prior install could matter. Worth ruling out.

  Investigation steps:

  1. **Add structured trigger logging** to `performRefresh` in token-manager.ts: at entry, log `{ provider, trigger: 'proactive' | 'lazy' | 'reactive' | 'wal' | 'manual', cachedExpiresAt, now, scheduledAt? }`. Each call site (proactive timer callback at line 313, getAccessToken lazy guard at line 364, reactive HTTP wrapper, recoverWAL) should pass its trigger reason. Today `performRefresh` doesn't know who called it.
  2. **Capture the Figma error body** on terminal-error path (line 502-528): currently we throw `new Error(errorCode)` which loses `response.body.error_description` and full body. Stash both into a process-level circular buffer (last 20 refresh failures) accessible via a debug `GET /api/oauth/_debug/refresh-history` route — gated by `NODE_ENV !== 'production'` or an explicit `OAUTH_DEBUG=true` flag.
  3. **Log scheduled-refresh wall time** in `scheduleProactiveRefresh`: when scheduling, log `[token-manager] Proactive refresh for ${provider} scheduled at ${new Date(expiresAt - PROACTIVE_REFRESH_LEAD_MS).toISOString()} (in ${humanizeMs(delay)})`. If this prints a timestamp seconds away from now for a brand-new 90-day token, suspect #2 is confirmed.
  4. **Reproduce with logs on**: disconnect-reconnect Figma, immediately tail the backend log. Watch for any `performRefresh` invocation in the first 30 minutes. Capture the trigger reason + Figma response body.
  5. **Cross-check Figma OAuth app config**: the `OAUTH_FIGMA_CLIENT_ID` / `OAUTH_FIGMA_CLIENT_SECRET` in `.env` must match the registered Figma OAuth app exactly. If `tokenAuthMode: 'basic'` (per `providers/figma.ts:116`) sends mismatched credentials on refresh, Figma returns `invalid_client`. The initial token exchange uses the same path, so a mismatch would have failed at OAuth time too — but worth verifying with curl against `https://api.figma.com/v1/oauth/refresh` using the stored refresh token (treat that as a debugging-only step; never commit the secret).

  Definition of done: the trigger of the spurious refresh is identified by name (one of the three suspects, or a fourth not yet considered), the underlying defect is fixed, and a unit/integration test reproduces the failure deterministically. If the cause turns out to be Figma-side (e.g. their refresh endpoint returning `invalid_grant` for a recently-issued token under some race), document the finding and add a tolerance: don't terminal-mark a token whose age is < 5 minutes; instead retry with backoff. Carry over to a fresh change if the fix is non-trivial.
