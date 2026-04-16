## ADDED Requirements

### Requirement: Google Drive OAuth provider adapter

The system SHALL provide a `GoogleDriveProviderAdapter` plugged into `OAuthEngine` with these fixed values:

| Field              | Value                                                                 |
|--------------------|-----------------------------------------------------------------------|
| `name`             | `google`                                                              |
| `authorizeUrl`     | `https://accounts.google.com/o/oauth2/v2/auth`                        |
| `tokenUrl`         | `https://oauth2.googleapis.com/token`                                 |
| `revokeUrl`        | `https://oauth2.googleapis.com/revoke`                                |
| `defaultScopes`    | `['https://www.googleapis.com/auth/drive.file', 'openid', 'email']`   |
| `clientId`         | `process.env.OAUTH_GOOGLE_CLIENT_ID`                                  |
| `clientSecret`     | `process.env.OAUTH_GOOGLE_CLIENT_SECRET` (optional with PKCE)         |
| `extraAuthorizeParams` | `{ access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }` |

#### Scenario: Adapter uses drive.file scope by default

- **WHEN** `OAuthEngine.start('google')` is invoked without custom scopes
- **THEN** the authorize URL SHALL include `scope=https%3A//www.googleapis.com/auth/drive.file+openid+email`
- **AND** Google SHALL NOT prompt for security review (drive.file is non-sensitive)

#### Scenario: Adapter requests offline access for refresh token

- **WHEN** `OAuthEngine.start('google')` builds the authorize URL
- **THEN** the URL SHALL include `access_type=offline&prompt=consent` so Google returns a `refresh_token` on first authorization

### Requirement: Google Drive token exchange and refresh

The adapter SHALL implement token exchange and refresh per Google's documented payload, using `code_verifier` (PKCE) and optionally `client_secret` when configured.

#### Scenario: Exchanging an authorization code

- **WHEN** `adapter.exchange(code, codeVerifier)` is called
- **THEN** a `POST https://oauth2.googleapis.com/token` SHALL be made with form body `{ grant_type: 'authorization_code', code, code_verifier, client_id, redirect_uri, client_secret? }`
- **AND** the response SHALL be parsed into `TokenSet { accessToken, refreshToken, expiresAt: now+expires_in*1000, scopes }`

#### Scenario: Refreshing an expiring access token

- **WHEN** `TokenManager` invokes `adapter.refresh(refreshToken)` for Google
- **THEN** a `POST https://oauth2.googleapis.com/token` SHALL be made with form body `{ grant_type: 'refresh_token', refresh_token, client_id, client_secret? }`
- **AND** the returned token set SHALL preserve the existing `refreshToken` if Google does not return a new one

#### Scenario: Refresh returns invalid_grant

- **WHEN** Google responds to a refresh with `{ error: 'invalid_grant' }`
- **THEN** the adapter SHALL classify this as terminal
- **AND** the provider SHALL be marked `RE_AUTH_REQUIRED`

### Requirement: Google Drive connector consumes access token from env

The existing Google Drive connector (`lib/gdrive.ts`) SHALL, when configured in OAuth mode, read its access token from `process.env.GOOGLE_OAUTH_ACCESS_TOKEN` injected by the parent at spawn time, rather than loading a service-account JSON key.

#### Scenario: Agent spawned with OAuth access token

- **WHEN** the parent spawns an agent child and `google` is configured in OAuth mode
- **THEN** the child SHALL be launched with `GOOGLE_OAUTH_ACCESS_TOKEN=<current access token>` in its environment
- **AND** `gdrive.ts` SHALL use this token for Drive API requests with `Authorization: Bearer <token>`

#### Scenario: Agent spawned with neither OAuth nor service account

- **WHEN** the parent spawns an agent and `google` is not configured at all
- **THEN** no Google-related env vars SHALL be injected
- **AND** any pipeline stage that requires Google Drive SHALL skip gracefully with a warning

### Requirement: Service-account fallback is preserved

The existing service-account-JWT authentication path SHALL remain functional for users who do not migrate to OAuth. The connector's `authMode` setting (`'oauth' | 'service_account'`) determines which path is used.

#### Scenario: Service-account mode still works

- **WHEN** `google.authMode === 'service_account'` in config
- **AND** `GDRIVE_SA_JSON` is populated
- **THEN** `gdrive.ts` SHALL continue to produce a JWT and exchange it for an access token exactly as it does today
- **AND** the OAuth provider adapter SHALL NOT be invoked

### Requirement: Drive-only read/write guarded by scope

All Google Drive calls SHALL be restricted to files the user has granted access to via the `drive.file` scope — the connector SHALL NOT attempt to list / read files outside that scope.

#### Scenario: Listing files via drive.file

- **WHEN** the connector lists files
- **THEN** requests SHALL use the Drive v3 `files.list` endpoint with default parameters (no `spaces=drive` override)
- **AND** only files created by or shared with the agent SHALL be returned

#### Scenario: Attempted access to an unshared file returns 403

- **WHEN** a pipeline references a Google Drive file ID not granted to the agent
- **AND** the Drive API returns 403
- **THEN** the 403 SHALL be surfaced to the UI with actionable text: "Share this file with the agent or use a different scope"
