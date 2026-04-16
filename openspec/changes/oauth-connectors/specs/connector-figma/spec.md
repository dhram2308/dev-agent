## ADDED Requirements

### Requirement: Figma OAuth provider adapter

The system SHALL provide a `FigmaProviderAdapter` plugged into `OAuthEngine` with these fixed values:

| Field              | Value                                                              |
|--------------------|--------------------------------------------------------------------|
| `name`             | `figma`                                                            |
| `authorizeUrl`     | `https://www.figma.com/oauth`                                      |
| `tokenUrl`         | `https://api.figma.com/v1/oauth/token`                             |
| `refreshUrl`       | `https://api.figma.com/v1/oauth/refresh`                           |
| `revokeUrl`        | `null` (Figma has no documented revoke endpoint)                   |
| `defaultScopes`    | `['file_content:read', 'file_comments:read', 'current_user:read']` |
| `clientId`         | `process.env.OAUTH_FIGMA_CLIENT_ID`                                |
| `clientSecret`     | `process.env.OAUTH_FIGMA_CLIENT_SECRET` (required — Figma mandates)|

The adapter SHALL use `response_type=code`, `code_challenge_method=S256` only.

#### Scenario: Adapter rejects non-S256 PKCE method

- **WHEN** the engine attempts to build an authorize URL for Figma with `code_challenge_method=plain`
- **THEN** the adapter SHALL throw at URL construction time
- **AND** only `S256` SHALL be acceptable for Figma

#### Scenario: Adapter requires client_secret at configuration time

- **WHEN** `OAUTH_FIGMA_CLIENT_ID` is set but `OAUTH_FIGMA_CLIENT_SECRET` is not
- **AND** a start request for Figma is received
- **THEN** the start endpoint SHALL return HTTP 400 with code `FIGMA_CLIENT_SECRET_MISSING`

### Requirement: 30-second authorization-code race mitigations

The callback path for Figma SHALL be optimized for the 30-second authorization-code expiry enforced by Figma. The mitigations below SHALL be in place before the OAuth flow ships.

#### Scenario: TLS pre-warm at flow start

- **WHEN** `POST /api/oauth/figma/start` is invoked
- **THEN** the server SHALL open a keep-alive TLS connection to `api.figma.com` before returning the authorize URL
- **AND** the connection SHALL be kept open for at least 2 minutes

#### Scenario: Synchronous code exchange in callback handler

- **WHEN** `/oauth/figma/callback` receives a code
- **THEN** the token exchange SHALL be performed before any credential-store write or SSE broadcast
- **AND** the exchange SHALL complete within 3 seconds on a healthy network
- **AND** only after a successful exchange SHALL the token set be persisted and SSE broadcast emitted

#### Scenario: Exchange fails within 30-second window

- **WHEN** the token exchange fails with any error (network, non-2xx, malformed response)
- **THEN** the callback handler SHALL render an error page with a single "Try again" button that re-initiates the flow
- **AND** the same authorization code SHALL NEVER be retried (Figma rejects replay)

### Requirement: 90-day access token + rotating refresh

Figma access tokens expire 90 days after issuance and refresh tokens are rotated on each use. The adapter SHALL handle both correctly.

#### Scenario: Access token expiry calculation

- **WHEN** Figma returns a successful token response containing `expires_in`
- **THEN** the adapter SHALL compute `expiresAt = now + expires_in * 1000` — typically 90 days in the future
- **AND** store this as part of the `TokenSet`

#### Scenario: Refresh rotates the refresh token

- **WHEN** `adapter.refresh(oldRefreshToken)` is called and succeeds
- **THEN** the response SHALL contain new `access_token` and new `refresh_token` values
- **AND** the entire new token set SHALL be persisted atomically via `CredentialStore.set('figma', ...)` (see credential-store spec)
- **AND** the old refresh token SHALL never be used again

#### Scenario: Refresh with stale refresh token returns error

- **WHEN** `adapter.refresh(staleRefreshToken)` is called with a refresh token that has already been rotated
- **THEN** Figma returns an error response
- **AND** the adapter SHALL classify the error as terminal (`RE_AUTH_REQUIRED`)

### Requirement: Figma connector consumes access token from env

The existing Figma connector (`lib/figma.ts`) SHALL, when configured in OAuth mode, use the access token injected into its env as `FIGMA_OAUTH_ACCESS_TOKEN` rather than reading `FIGMA_TOKEN` (which is PAT mode).

#### Scenario: OAuth mode uses bearer header

- **WHEN** `figma.authMode === 'oauth'` and `FIGMA_OAUTH_ACCESS_TOKEN` is set
- **THEN** API calls SHALL use `Authorization: Bearer <token>`

#### Scenario: PAT mode uses X-Figma-Token header

- **WHEN** `figma.authMode === 'pat'` and `FIGMA_TOKEN` is set
- **THEN** API calls SHALL continue to use `X-Figma-Token: <token>` as they do today

### Requirement: Disconnect shows manual revoke guidance

Because Figma does not expose a revoke endpoint, disconnect SHALL delete the credential locally and display guidance for manual server-side revocation.

#### Scenario: Disconnect Figma in UI

- **WHEN** the user clicks "Disconnect" for Figma
- **THEN** `CredentialStore.delete('figma')` SHALL be invoked
- **AND** the UI SHALL display: "To fully revoke access, visit https://www.figma.com/settings → Connected apps and remove the MI Dev Agent entry"
