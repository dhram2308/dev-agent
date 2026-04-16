## ADDED Requirements

### Requirement: Generic OAuth 2.0 PKCE flow engine

The system SHALL provide a generic OAuth 2.0 Authorization Code with PKCE flow engine that is parameterized by a `ProviderAdapter` exposing `{ name, authorizeUrl, tokenUrl, revokeUrl?, defaultScopes, clientId, clientSecret?, buildAuthorizeParams, parseTokenResponse }`. This engine SHALL be the single implementation used by all OAuth-backed connectors.

#### Scenario: Engine generates PKCE verifier and challenge

- **WHEN** `OAuthEngine.start(provider)` is called
- **THEN** a cryptographically random `code_verifier` (43–128 chars, URL-safe) SHALL be generated
- **AND** `code_challenge` SHALL be `base64url(sha256(code_verifier))`
- **AND** `code_challenge_method=S256` SHALL be set in the authorize URL

#### Scenario: Engine returns authorize URL with all required parameters

- **WHEN** `OAuthEngine.start(provider)` is called
- **THEN** the returned authorize URL SHALL include `client_id`, `redirect_uri=http://127.0.0.1:3000/oauth/<provider>/callback`, `response_type=code`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`

#### Scenario: State parameter prevents CSRF

- **WHEN** the engine generates a flow
- **THEN** a random `state` value SHALL be included in the authorize URL and stored server-side with a 10-minute TTL
- **AND** the callback handler SHALL reject any callback whose `state` does not match a stored, unexpired value

### Requirement: OAuth start endpoint

The backend SHALL expose `POST /api/oauth/:provider/start` that initiates a flow and responds with `{ authorizeUrl }`. The UI opens this URL in the user's default browser.

#### Scenario: Starting a flow for a supported provider

- **WHEN** a `POST /api/oauth/gitlab/start` request is received
- **AND** `gitlab` has a registered provider adapter and configured `client_id`
- **THEN** the endpoint SHALL return HTTP 200 with `{ authorizeUrl: '<gitlab authorize URL with all PKCE params>' }`

#### Scenario: Starting a flow for an unconfigured provider

- **WHEN** a start request is received for a provider whose `OAUTH_<PROVIDER>_CLIENT_ID` is not set
- **THEN** the endpoint SHALL return HTTP 400 with error code `OAUTH_NOT_CONFIGURED`
- **AND** the response SHALL include instructions to set the env var

### Requirement: OAuth callback endpoint

The backend SHALL expose `GET /oauth/:provider/callback` (loopback, not under `/api` so it does not require the API token header) that receives `?code=...&state=...`, validates `state`, exchanges the code for tokens, persists the token set via `CredentialStore`, and returns an HTML success / failure page that auto-closes the browser tab after 2 seconds.

#### Scenario: Successful callback

- **WHEN** the callback is invoked with a valid `code` and matching `state`
- **THEN** the engine SHALL POST to the provider's token endpoint with `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id`
- **AND** on success SHALL persist `{ accessToken, refreshToken?, expiresAt, scopes }` via `CredentialStore.set(provider, ...)`
- **AND** SHALL broadcast SSE `{ type: 'connectorConnected', provider }`
- **AND** SHALL return a success HTML page that closes itself

#### Scenario: Callback with invalid state

- **WHEN** the callback arrives with a `state` that does not match any stored flow
- **THEN** the endpoint SHALL return HTTP 400 with a human-readable error page
- **AND** SHALL NOT attempt a token exchange

#### Scenario: Callback with provider error

- **WHEN** the callback arrives with `?error=access_denied` or similar
- **THEN** the endpoint SHALL render an error page indicating the user denied the flow
- **AND** SHALL broadcast SSE `{ type: 'connectorError', provider, error }`

### Requirement: TokenManager with single-flight refresh

The system SHALL provide a `TokenManager` that wraps `CredentialStore` and handles refresh. The manager SHALL serialize refreshes per provider using an in-memory `Map<provider, Promise<TokenSet>>` so that only one refresh is ever in flight per provider at a time.

#### Scenario: Two concurrent callers during refresh

- **WHEN** caller A and caller B both call `TokenManager.getAccessToken('gitlab')` while the cached access token is expired
- **THEN** only one provider token-endpoint request SHALL be made
- **AND** both callers SHALL receive the same refreshed access token

#### Scenario: Single-flight cleanup after completion

- **WHEN** an in-flight refresh resolves or rejects
- **THEN** the entry SHALL be removed from the single-flight map
- **AND** the next call after that point SHALL start a new refresh if the token is again expired

### Requirement: Proactive refresh timer

For every OAuth-backed provider with a valid refresh token, the `TokenManager` SHALL schedule a refresh to fire at `expiresAt - 5 minutes`. Timers SHALL be rescheduled after every successful refresh.

#### Scenario: Timer fires before expiry

- **WHEN** a token's `expiresAt` is reached minus 5 minutes
- **THEN** `TokenManager` SHALL invoke the provider adapter's refresh
- **AND** on success update the cached token and reschedule the timer
- **AND** on transient failure retry with backoff `[1s, 3s, 10s]` before giving up until the next request

#### Scenario: Timer cancellation on disconnect

- **WHEN** a connector is disconnected via `POST /api/oauth/:provider/disconnect`
- **THEN** the associated refresh timer SHALL be cleared
- **AND** no further refreshes SHALL be attempted for that provider

### Requirement: Lazy guard on getAccessToken

Before returning an access token, `TokenManager.getAccessToken(provider)` SHALL check whether the token is within 30 seconds of its `expiresAt`. If so, it SHALL await an in-flight refresh or initiate one.

#### Scenario: Token is near expiry at call time

- **WHEN** `TokenManager.getAccessToken('gitlab')` is called and `now > expiresAt - 30s`
- **THEN** the call SHALL block on a refresh (single-flight) before returning
- **AND** SHALL return the new access token

#### Scenario: Token is far from expiry

- **WHEN** `TokenManager.getAccessToken('gitlab')` is called and `now < expiresAt - 30s`
- **THEN** the cached token SHALL be returned immediately without any network call

### Requirement: Reactive 401 handling at the parent

The parent backend's HTTP client wrapper SHALL, on receiving a 401 from a request tagged with an OAuth-backed provider, invalidate the cached access token, trigger a refresh via `TokenManager`, and retry the original request exactly once with the new token.

#### Scenario: 401 on first attempt, success on retry

- **WHEN** a parent-initiated request to GitLab returns HTTP 401
- **AND** the provider is OAuth-backed
- **THEN** the cached access token SHALL be invalidated
- **AND** a refresh SHALL be triggered
- **AND** the original request SHALL be retried exactly once with the new token
- **AND** if the retry succeeds, the response SHALL be returned normally

#### Scenario: 401 on retry also

- **WHEN** the retry after refresh also returns 401
- **THEN** the provider SHALL be marked `RE_AUTH_REQUIRED`
- **AND** the error SHALL bubble up to the caller
- **AND** SSE `{ type: 'authRequired', provider }` SHALL be broadcast

### Requirement: Write-ahead log for crash recovery

Before calling a provider token endpoint for a refresh, `TokenManager` SHALL write `~/.config/mi-dev-agent/refresh-wal.json` with `{ provider, startedAt }`. On success, the WAL entry SHALL be cleared atomically with the new token persist.

#### Scenario: Refresh completes normally

- **WHEN** a refresh completes successfully
- **THEN** the WAL entry SHALL be deleted in the same write operation that persists the new token set

#### Scenario: Crash between endpoint call and persist

- **WHEN** the process crashes after the token endpoint returns new tokens but before `CredentialStore.set()` completes
- **AND** the process restarts and reads `refresh-wal.json`
- **AND** the WAL entry is older than 60 s
- **THEN** a health check SHALL be performed against the provider with the old access token
- **AND** if the check fails with 401, the connector SHALL be marked `RE_AUTH_REQUIRED`
- **AND** the WAL entry SHALL be cleared regardless

### Requirement: Clock-skew tracking

`TokenManager` SHALL maintain a rolling average of `(serverDate - localDate)` computed from the `Date` response header of each provider call. This offset SHALL be applied when evaluating `expiresAt`.

#### Scenario: Clock skew is detected

- **WHEN** 5 consecutive provider responses show `|serverDate - localDate| > 120 seconds`
- **THEN** a log line `ClockSkew: provider=<name> skewMs=<n>` SHALL be emitted at WARN level
- **AND** the skew SHALL be applied when evaluating `expiresAt` until it is recomputed

### Requirement: Revoke endpoint

The backend SHALL expose `POST /api/oauth/:provider/disconnect` that, for providers exposing a revoke endpoint, performs best-effort server-side revocation and then deletes the credential from `CredentialStore`.

#### Scenario: Disconnect a provider that supports revoke

- **WHEN** disconnect is called for `google`
- **THEN** a POST to `https://oauth2.googleapis.com/revoke` with the current access token SHALL be attempted
- **AND** regardless of the revoke outcome, `CredentialStore.delete('google')` SHALL be called
- **AND** SSE `{ type: 'connectorDisconnected', provider: 'google' }` SHALL be broadcast

#### Scenario: Disconnect a provider without a revoke endpoint

- **WHEN** disconnect is called for `figma` (no documented revoke endpoint)
- **THEN** no revoke network call SHALL be made
- **AND** `CredentialStore.delete('figma')` SHALL be called
- **AND** the UI SHALL display guidance for manually revoking at the provider's website
