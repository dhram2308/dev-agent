## Context

The MI Dev Agent currently authenticates every external service with a static credential placed in `.env` (GitLab PAT, Figma PAT, Google Drive service-account JSON, Jira PAT, Slack webhook URL, Postman API key, Anthropic API key / Claude CLI login). Prior design in the archived `app-connectors` change explicitly rejected OAuth because the agent was a one-shot CLI process — adding a refresh loop to a process that exits after a single ticket made no sense.

Two things have changed since then:

1. The runtime is now a **long-lived parent HTTP server** (`packages/backend`) that spawns **ephemeral agent children** (`packages/agent`) per ticket. The server already outlives individual agent invocations.
2. The pipeline already has **checkpoint-based resume** (`state-unified.ts` phases), so "kill and respawn with new state" is a cheap operation.

Given those, parent-owned OAuth refresh becomes architecturally natural. The constraints that remain:

- **Internal GitLab at `http://10.200.11.32`** — the OAuth app must be registered on that instance; its base URL must be persisted alongside tokens.
- **Node.js CommonJS + native `http/https`** — no Express, no `node-fetch`, no Passport; we build on the existing request pipeline.
- **Single-user installation** — one OAuth-app-registration per provider, one connected identity per installation; no multi-tenant token families.
- **Backwards compatibility** — every connector must continue to support its current PAT/API-key path; OAuth is additive, never mandatory.
- **Atlassian 3LO has no PKCE** — Jira cannot cleanly OAuth today; it stays on PAT.
- **Slack redirect requires HTTPS** — loopback won't work; Slack stays on webhook.

The core insight driving this design: **put the refresh loop in the parent, give the child only access tokens**. This keeps the child agent stateless and short-lived (matching its existing model) while making token lifetime invisible to it.

## Goals / Non-Goals

**Goals:**

- Replace the 90-day Figma PAT pain with invisible OAuth refresh.
- Let non-technical users connect Google Drive by clicking a browser button (no JSON key generation).
- Modernize GitLab auth to PKCE OAuth while preserving PAT for CI / headless / air-gapped usage.
- Move disk-stored credentials off plaintext `.env` onto OS keychain (or AES-256-GCM encrypted file when keychain is unavailable).
- Add a well-defined re-authentication lifecycle so revoked / expired-refresh tokens surface as a UI prompt rather than pipeline crashes.
- Ship a generic OAuth engine + `CredentialStore` abstraction that makes future providers (Notion, Confluence, Linear, etc.) a config-only addition.

**Non-Goals:**

- Jira OAuth 3LO (Atlassian ECO-283 unresolved; no PKCE).
- Slack OAuth (HTTPS-only redirect; webhook covers our needs).
- Postman OAuth (provider doesn't offer it).
- Bring-your-own OAuth app UI (phase 2 — ship shared MasterIndia-owned apps first).
- Multi-tenant / per-user credential isolation (installation-scoped is sufficient).
- Mid-pipeline RPC for token refresh (exit-78 + respawn is simpler and reuses existing checkpoint machinery).
- Replacing Claude CLI auth (it already does its own OAuth via `claude-code`).

## Decisions

### Decision 1 — Parent owns the refresh loop; child only sees access tokens

**Choice:** The backend server runs a long-lived `TokenManager` daemon that holds refresh tokens. When spawning an agent child process, the parent injects **only short-lived access tokens** (plus expiry timestamps) as environment variables. The child never receives, stores, or refreshes refresh tokens.

**Alternatives considered:**

- **Child-local refresh** — Each agent loads refresh tokens from disk and refreshes itself. Rejected: rotating-refresh-token providers (GitLab, Atlassian, Slack-with-rotation) guarantee a race when two child processes are alive (e.g., retry after crash), and disk writes from a child crashing mid-refresh corrupt the token file.
- **Mid-pipeline IPC over a local socket** — Child calls the parent via `http://127.0.0.1:3000/internal/token` before every external API call. Rejected: doubles every API call's latency, requires a new IPC protocol, and fails badly if the parent restarts during a long pipeline.
- **Shared token file with file locks** — Child and parent coordinate via `flock`. Rejected: the existing `state-lock.ts` could support this, but it ties crash recovery and refresh atomicity together — two hard problems we'd rather keep separate.

**Rationale:** Parent-owned refresh has the smallest attack surface (refresh tokens never cross process boundaries), reuses the existing parent-spawns-child model, and matches Claude Code's own MCP OAuth architecture (which is our reference implementation). The child stays exactly as stateless as it is today.

### Decision 2 — Exit-code-78 (AUTH_REFRESH_NEEDED) sentinel protocol

**Choice:** When the agent child encounters a 401 that survives its one in-request refresh retry (i.e., the provider says the access token is bad and we have no way to fix it from inside the child), the child calls `process.exit(78)` with the provider name written to `state.data._authFailure`. The parent detects exit-78, calls `TokenManager.refresh(provider)`, and respawns the agent from the last completed checkpoint (which the agent already persists to `state-unified.ts` before starting any network call).

**Alternatives considered:**

- **Throw and crash to exit-1** — Rejected: parent can't distinguish "auth" from "genuine bug" and either ignores real bugs or respawns on real bugs.
- **Signal-based (SIGUSR1)** — Rejected: signals can't carry the provider name; exit-code is simpler.
- **Write to a well-known file** — Rejected: needs fsync + atomic-rename handling; exit-code is free.

**Rationale:** POSIX exit codes 64–78 are sysexits.h reserved; 78 (`EX_CONFIG`) is semantically close to "configuration/credential problem". Using a sentinel code lets the parent pattern-match without inspecting state files. The checkpoint-resume mechanism already exists and is free.

### Decision 3 — Stable callback URL `http://127.0.0.1:3000/oauth/:provider/callback`

**Choice:** One fixed loopback URL per provider, registered once in each provider's OAuth app console.

**Alternatives considered:**

- **Ephemeral ports per flow** — Spin up a random free-port listener for each OAuth start. Rejected: Figma and Atlassian demand **exact** redirect URL match, so ephemeral ports won't work for those providers. Supporting ephemeral for some and stable for others doubles the code paths.
- **Custom URL scheme (`midevagent://oauth/callback`)** — Requires OS-level scheme registration, blocked by Google for new apps since 2022, and brittle on Linux. Rejected.
- **A public hosted relay (`oauth.mastersindia.co/callback` → local)** — Adds a server we'd have to operate and trust. Rejected as scope creep.

**Rationale:** A single stable URL works for every provider in scope (Google, GitLab, Figma all accept `http://127.0.0.1:3000/...` when PKCE is used). Conflict at port 3000 surfaces as a clean startup error. If a user ever moves the server off port 3000 they re-register the redirect URL — a one-time action with clear UX.

### Decision 4 — Three-backend `CredentialStore` auto-selected at boot

**Choice:** `CredentialStore` is an interface with three implementations selected at startup:

| Environment                              | Backend            | Mechanism                                                   |
|------------------------------------------|--------------------|-------------------------------------------------------------|
| macOS / Windows / Linux-with-GUI         | `KeychainBackend`  | `cross-keychain` (macOS Keychain / DPAPI / Secret Service)  |
| Linux headless / Docker without keychain | `EncryptedFileBackend` | AES-256-GCM, key from `sha256(machine-id ‖ $CRED_ENC_KEY)`  |
| Cloud / CI (tokens pre-provisioned)      | `EnvVarBackend`    | Read-only, token bundle in `$MI_DEV_AGENT_OAUTH_TOKENS`      |

Selection order: try keychain (probe `getPassword` on a canary entry); fall back to encrypted file; fall back to env-var if `$MI_DEV_AGENT_OAUTH_TOKENS` is set.

**Alternatives considered:**

- **Keychain-only** — Rejected: breaks Docker and headless Linux.
- **Encrypted-file-only** — Rejected: laptops benefit materially from OS keychain (survives `rm -rf ~/.config`, integrates with OS user login).
- **`keytar`** — Rejected: deprecated / unmaintained; `cross-keychain` is the modern fork.

**Rationale:** Covers every environment the agent runs in today (dev laptops, QA runners, internal servers, planned Docker/cloud) with graceful degradation. The encrypted-file key derivation uses `machine-id` by default and allows `$CRED_ENC_KEY` override for reproducible deployments.

### Decision 5 — PAT/API-key fallback is first-class, not deprecated

**Choice:** Every connector that grows an OAuth path keeps its PAT/API-key path. ConnectorCard shows `[Connect]` (OAuth) prominently, with a collapsible `[Use API token instead ▾]` disclosure that reveals the existing text input + `[Test]` button. Config persists `authMode: 'oauth' | 'pat'` per connector.

**Alternatives considered:**

- **Deprecate PAT after OAuth ships** — Rejected: breaks headless / CI / air-gapped installations; Atlassian-style single-user PATs are still the best choice for some users.
- **Hide PAT behind "Advanced"** — Rejected: makes "Settings ≠ what I see" and confuses users who already depend on PAT.

**Rationale:** OAuth and PAT solve different problems. OAuth is better for interactive users; PAT is better for automation, air-gapped runs, and providers where OAuth adds friction (e.g., a CI job that only needs read access).

### Decision 6 — TokenManager refresh policy: proactive @ −5 min, lazy @ −30 s, reactive on 401

**Choice:** The TokenManager refreshes in three layers:

1. **Proactive**: A single timer per connected provider fires at `expires_at - 5 min`. If the refresh succeeds, the cached access token and next timer are updated. If it fails with a transient error (network, 5xx), retry with exponential backoff (1 s / 3 s / 10 s). If it fails with `invalid_grant` or similar terminal error, mark the connector `RE_AUTH_REQUIRED` and stop retrying.
2. **Lazy guard**: Every call to `getAccessToken(provider)` re-checks `now > expiresAt - 30 s`; if so, it blocks on an in-flight refresh (single-flight promise) before returning.
3. **Reactive 401**: The parent's HTTP-client wrapper, on a 401 from any OAuth-backed provider, invalidates the cached token, refreshes once, retries the call once. Child agents don't do reactive refresh themselves — they exit-78 so the parent can do it.

Clock skew is compensated by tracking the rolling average of `(serverDate − localDate)` observed from every response's `Date` header.

**Alternatives considered:**

- **Pure lazy refresh** — Refresh only when a token is observed expired. Rejected: the first request after expiry pays the refresh latency, and if that request is time-sensitive (e.g., Figma 30-sec auth-code exchange) it misses.
- **Pure proactive refresh** — Rejected: timers drift under system sleep and NTP adjustments.

**Rationale:** Azure SDK, gcloud, and GitHub's Octokit all use this three-layer approach. Lazy is cheap insurance; proactive is correctness; reactive is the "we got it wrong" safety net.

### Decision 7 — Write-ahead log for interrupted refreshes

**Choice:** Before calling a provider's token endpoint for a refresh, TokenManager writes `~/.config/mi-dev-agent/refresh-wal.json` with `{ provider, startedAt }`. On successful refresh, the WAL entry is deleted atomically with the new token write. On startup, any WAL entry older than 60 s triggers a health check against the provider: if the access token still works, clear the WAL; otherwise mark the provider `RE_AUTH_REQUIRED` (we assume the refresh token was invalidated server-side).

**Alternatives considered:**

- **No crash handling** — Rejected: rotating refresh tokens mean a crash mid-refresh is unrecoverable without user intervention; at least surface it cleanly.
- **Grace-period replay** — Some providers allow a recently-used refresh token to be replayed within 30–60 s. Rejected: Atlassian / GitLab / Figma don't document this, so we can't rely on it cross-provider.

**Rationale:** A 60-byte JSON WAL is cheap and turns "mystery-auth-failure after crash" into "clear UI prompt to re-auth".

### Decision 8 — Figma 30-second authorization-code mitigations

**Choice:** Figma expires auth codes in 30 seconds; we guard the exchange with three mitigations:

1. **Pre-warm TLS to `api.figma.com`** at the moment the authorize URL is generated (in `/api/oauth/figma/start`), so the code exchange pays zero handshake time.
2. **Synchronous exchange inside the callback handler** — `/oauth/figma/callback` performs the exchange **before** writing to the credential store or broadcasting SSE. This keeps the critical path to < 2 seconds.
3. **Single-use retry guard** — If the exchange fails, the UI shows "Authorization failed. Click to try again." Never retry the same code; always restart the flow.

**Alternatives considered:**

- **Retry with same code** — Rejected: Figma rejects replay; wastes the 30-second window.
- **Exchange in background after showing success page** — Rejected: user could close the browser before exchange completes.

**Rationale:** Makes the critical path as short as physically possible and fails loudly when it misses.

### Decision 9 — `PAUSED_AUTH_REQUIRED` as a distinct pipeline phase

**Choice:** Add `PAUSED_AUTH_REQUIRED` to the phase enum in `state-unified.ts` (sibling of `PAUSED_AWAITING_APPROVAL`). When a child exits-78, the parent writes this phase + provider name to state, emits an `authRequired` SSE event, and waits for either (a) user clicks re-auth and the connector returns to `CONNECTED`, or (b) the configurable timeout (`AUTH_TIMEOUT_MIN`, default 120) elapses and the pipeline transitions to `FAILED`.

**Alternatives considered:**

- **Reuse `PAUSED_AWAITING_APPROVAL`** — Rejected: conflates two different UX flows (gate approval vs. credential fix).
- **Just set `FAILED`** — Rejected: loses work done; re-running from scratch wastes Claude tokens.

**Rationale:** The pipeline already has pause semantics; adding one more terminal-pause phase is the minimal change that preserves work and communicates intent.

### Decision 10 — Wire `setTokenManager` into agent-process at backend HTTP startup

**Choice:** In `packages/backend/src/server/http-server.ts`, after the existing OAuth-handler injection block (around line 250), call `agentProcess.setTokenManager({ getAccessTokenSync, refresh })` with a thin adapter exposing the backend's `TokenManager` to the agent-spawning module. At the same site, call `await tokenManager.initFromStore()` and `await tokenManager.recoverWAL()` once at startup so the in-memory token cache is warm before the first agent spawn.

The adapter requires a new export on `token-manager.ts`: `getAccessTokenSync(provider): string | null`. This reads only the existing in-memory `tokenCache` Map (already maintained by the proactive-refresh timer from Decision 6) and returns `null` if the entry is missing or inside the 30-second pre-expiry guard. It never blocks, never refreshes, never returns a Promise.

**Alternatives considered:**

- **Make `agent-process.startAgent()` async and `await tokenManager.getAccessToken()` per spawn.** Rejected: every caller of `startAgent` must change (UI POST handler, OAuth resume handler, internal respawn-on-exit-78 path), and per-spawn refresh adds latency to a hot path. The cache + exit-78 fallback already covers staleness.
- **Mid-pipeline IPC (child reaches back to parent for fresh tokens).** Rejected — same reasoning as Decision 1.

**Rationale:**

- The `setTokenManager(tm)` hook in `packages/agent/src/server/agent-process.ts:95` was always intended to be called by the parent process. The original implementation work (tasks 4.4 / 5.7 / 6.4) added the receiver but never added the caller. Decision 10 documents the missing line.
- Keeping `startAgent` synchronous preserves the existing fire-and-forget pattern at all call sites (verified: UI HTTP route awaits the wrapper, OAuth resume handler ignores the return, internal respawn happens in an async context).
- Sync access is correct because the cache is *already* the source of truth — the proactive timer keeps it within `expiresAt − 5min`, the lazy-guard returns null near expiry, and exit-78 handles the case where the captured token expires mid-pipeline.

**Cross-reference:** Tasks 4.4 (Google), 5.7 (Figma), 6.4 (GitLab) describe per-provider env-injection but the actual `setTokenManager` call was never wired. Section 11 of `tasks.md` adds the concrete steps that complete those three tasks.

### Decision 11 — Connector enable-flag falls back to OAuth-token presence

**Choice:** Change the per-URL routing gate in `packages/agent/src/stages/fetch-ticket.ts:359-372` so that an unset enable flag (the default) is interpreted as "enabled iff an OAuth token is present in env":

```
// before
parseBoolean(process.env.GDRIVE_ENABLED) && gdrive.matchUrl(url)

// after
(parseBoolean(process.env.GDRIVE_ENABLED) ?? !!process.env.GOOGLE_OAUTH_ACCESS_TOKEN) && gdrive.matchUrl(url)
```

…and the equivalent for `FIGMA_ENABLED` / `FIGMA_OAUTH_ACCESS_TOKEN`. Postman is unchanged — its provider does not offer OAuth.

**Semantics:**

| `*_ENABLED` value | OAuth token in env | Routing decision |
|-------------------|--------------------|------------------|
| `true` (explicit) | any                | enabled          |
| `false` (explicit)| any                | disabled (kill switch preserved) |
| unset             | present            | enabled (new fallback) |
| unset             | absent             | disabled (today's behavior preserved) |

**Alternatives considered:**

- **Option A — OAuth callback flips the enable flag to `true`.** Rejected: couples authorization to fetching, persists silent settings changes the user did not explicitly request, complicates the "is the connector enabled?" question in a future multi-tenant model. Magic.
- **Option C — status quo: user must Connect *and* toggle the boolean.** Rejected: this is the five-click UX path that produced the AUT-7121 escalation. Users complete OAuth and reasonably assume the connector is now usable; they should not have to discover a separate Manage modal toggle.

**Rationale:**

- Completing browser OAuth is the strongest possible signal of intent to use a connector. Treating that signal as an implicit enable removes a step that is visibly broken in real user flows.
- Explicit `true` and explicit `false` both still win, so power users keep their kill switch and their pre-OAuth-era explicit-enable workflows.
- The fallback fires when `GOOGLE_OAUTH_ACCESS_TOKEN` is in the spawned agent's env — which only happens when Decision 10 is wired. So Decision 10 and 11 deploy together; deploying Decision 11 alone does nothing.

**Cross-reference:** This decision exists *only* because Decision 10 reveals the trap. With Decision 10 wired but Decision 11 absent, the agent has fresh tokens it never uses. Both must ship.

## Risks / Trade-offs

- **[Risk] Port 3000 conflict prevents OAuth start.** → Mitigation: startup health check; OAuth start endpoint returns a human-friendly error naming the conflicting process. Callback URL is documented as part of server identity, not ephemeral.
- **[Risk] Figma client_secret must be shipped.** → Mitigation: scope the Figma OAuth app to read-only + comments; treat the secret as low-value (PKCE still protects auth-code interception). Document that users can register their own OAuth app if they prefer (phase 2).
- **[Risk] User revokes tokens in provider UI; pipeline discovers mid-stage.** → Mitigation: `TokenManager.refresh` distinguishes `invalid_grant` from transient errors and sets `RE_AUTH_REQUIRED`; child exits-78; parent pauses pipeline in `PAUSED_AUTH_REQUIRED` and surfaces UI banner with one-click re-auth.
- **[Risk] Rotating refresh tokens lost to crash mid-write.** → Mitigation: WAL + atomic rename; startup health check clears stale WAL or marks `RE_AUTH_REQUIRED`.
- **[Risk] Clock skew causes premature expiry or stale-token use.** → Mitigation: 5-minute buffer + rolling skew tracker from `Date` headers; logs warn at > 2-minute observed skew.
- **[Risk] Two-process race — user triggers a manual refresh from UI while TokenManager proactively refreshes.** → Mitigation: single-flight map keyed by provider; UI refresh just joins the existing promise.
- **[Risk] Keychain probe fails on some Linux distros (no Secret Service).** → Mitigation: probe at boot is non-fatal; falls back to encrypted file, logs chosen backend at INFO level.
- **[Risk] Internal GitLab (10.200.11.32) OAuth app must be provisioned by an admin.** → Mitigation: document prerequisite; gracefully show "OAuth not configured for this GitLab instance — use PAT" if `OAUTH_GITLAB_CLIENT_ID` is missing.
- **[Risk] Exit-78 infinite loop (refresh keeps failing, child keeps exiting).** → Mitigation: parent limits respawns to 3 per provider per pipeline run; further exit-78s transition pipeline to `FAILED` with clear error.
- **[Trade-off] Docker / cloud deploys can't use OS keychain.** → Accepted: `EncryptedFileBackend` or `EnvVarBackend` handles these; operator responsibility to inject `$CRED_ENC_KEY` or pre-populated tokens.
- **[Trade-off] OAuth requires a browser open on the machine running the server.** → Accepted: for strictly-headless installs, PAT remains the supported path.
- **[Risk] Token captured at agent spawn becomes stale mid-pipeline.** → Mitigation: the exit-78 protocol (Decision 2) handles this once Decision 10 is wired. Section 11 task 11.5 adds a diagnostic SSE event + warning log so a future regression where `_tokenManager` is null does not silently swallow the recovery.
- **[Risk] Decision 11 fallback fires for OAuth tokens injected by an operator (CI / Docker pre-loaded env) without going through the in-process OAuth flow.** → Accepted as desired behavior: operator-injected token implies operator-authorized fetch. The single-user installation model (see Context) makes this safe; multi-tenant operators set explicit `*_ENABLED=false` to opt out.
- **[Risk] `setTokenManager` is not exposed by some loaded agent-process module variant (e.g., very old build).** → Mitigation: the wire in Decision 10 is guarded by `typeof agentProcess.setTokenManager === 'function'`; missing exposure logs a startup warning (task 11.6) and the agent falls back to PAT/service-account paths the connectors already support.

## Migration Plan

1. **Phase 1 — Credential store skeleton**
   - Ship `CredentialStore` + three backends behind a feature flag (`ENABLE_CREDENTIAL_STORE=false` by default).
   - Existing `.env` reads continue to win; new `CredentialStore.get()` calls fall back to env vars.
   - No user-visible change.

2. **Phase 2 — GitLab OAuth as the pilot connector**
   - Wire OAuth routes (`/api/oauth/gitlab/*`), provider adapter, TokenManager.
   - ConnectorCard gains `[Connect]` button for GitLab only.
   - Existing GitLab PAT users are unaffected (PAT continues to work).
   - Ship exit-78 plumbing in agent + parent; verify with synthetic 401.

3. **Phase 3 — Figma + Google Drive**
   - Add provider adapters; add connector cards + tabs.
   - 30-second race mitigations for Figma.
   - Scope: `drive.file` for Google (non-sensitive, no verification).

4. **Phase 4 — Hardening**
   - Enable `ENABLE_CREDENTIAL_STORE=true` by default.
   - Migrate existing GitLab PATs from `.env` into the credential store on first run (with user opt-in prompt).
   - Document the bring-your-own-OAuth-app flow for next phase.

**Rollback strategy:** Feature flag `ENABLE_OAUTH=false` disables OAuth routes and the `[Connect]` button; agent falls back to PAT from `.env`. Because PAT path is never removed, rollback is instantaneous.

## Open Questions

1. **Where does the OAuth client_secret for Figma live on disk?** Likely shipped compiled-in plus overridable via `OAUTH_FIGMA_CLIENT_SECRET` env var; decide whether to commit a shipped default or require env override always.
2. **Should we support a "remove connector" path that also revokes server-side?** Google and GitLab expose `/oauth/revoke`; Figma does not. Decide whether to call revoke best-effort-on-disconnect or skip.
3. **What happens if the user disconnects a connector mid-pipeline?** Current thinking: pipeline exits-78 on next API call and pauses; UI re-auth prompt re-enables the flow. Needs explicit spec scenario.
4. **Do we migrate the Jira PAT out of `.env` into the credential store too**, even though Jira stays on PAT? Probably yes for uniformity, but requires a one-way migration that the user consents to.
5. **How do we test OAuth in CI without real providers?** Likely a mock OAuth server shipped in `packages/backend/test/oauth-mock/`; finalize in tasks.