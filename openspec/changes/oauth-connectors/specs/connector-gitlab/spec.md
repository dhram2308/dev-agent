## ADDED Requirements

### Requirement: GitLab OAuth provider adapter

The system SHALL provide a `GitLabProviderAdapter` plugged into `OAuthEngine` with these fixed values per GitLab instance:

| Field              | Value                                                                                  |
|--------------------|----------------------------------------------------------------------------------------|
| `name`             | `gitlab`                                                                               |
| `authorizeUrl`     | `${gitlab.baseUrl}/oauth/authorize`                                                    |
| `tokenUrl`         | `${gitlab.baseUrl}/oauth/token`                                                        |
| `revokeUrl`        | `${gitlab.baseUrl}/oauth/revoke`                                                       |
| `defaultScopes`    | `['api', 'read_user']`                                                                 |
| `clientId`         | `process.env.OAUTH_GITLAB_CLIENT_ID`                                                   |
| `clientSecret`     | `process.env.OAUTH_GITLAB_CLIENT_SECRET` (optional — PKCE covers public-client auth)   |

`gitlab.baseUrl` SHALL come from config (e.g., `http://10.200.11.32` for the internal instance, or `https://gitlab.com` for public). The base URL SHALL be persisted in the `TokenSet.metadata` so refresh always targets the same instance.

#### Scenario: Adapter uses instance-specific base URL

- **WHEN** `OAuthEngine.start('gitlab')` is called with `gitlab.baseUrl = 'http://10.200.11.32'`
- **THEN** the authorize URL SHALL begin with `http://10.200.11.32/oauth/authorize`
- **AND** the stored token set SHALL include `metadata.baseUrl = 'http://10.200.11.32'`

#### Scenario: Refresh targets the stored base URL

- **WHEN** `TokenManager.refresh('gitlab')` is invoked
- **THEN** the POST SHALL be sent to `${metadata.baseUrl}/oauth/token`
- **AND** switching `gitlab.baseUrl` in config SHALL NOT redirect refreshes of existing tokens

### Requirement: PKCE public-client mode without client_secret

When `OAUTH_GITLAB_CLIENT_SECRET` is unset, the adapter SHALL operate as a public client using PKCE only, omitting `client_secret` from all token-endpoint requests.

#### Scenario: Public client code exchange

- **WHEN** the adapter exchanges a code and no `clientSecret` is configured
- **THEN** the token-endpoint POST body SHALL contain `grant_type, code, code_verifier, redirect_uri, client_id` but SHALL NOT contain `client_secret`
- **AND** GitLab SHALL accept the request (PKCE validates the client)

#### Scenario: Confidential client code exchange

- **WHEN** `OAUTH_GITLAB_CLIENT_SECRET` is set
- **THEN** the token-endpoint POST body SHALL include `client_secret`
- **AND** PKCE parameters SHALL still be sent

### Requirement: 2-hour access token with rotating refresh

GitLab OAuth tokens expire after 2 hours and refresh tokens are rotated on each use. The adapter SHALL align with this.

#### Scenario: Access token expiresAt

- **WHEN** the token endpoint returns `expires_in=7200`
- **THEN** `expiresAt = now + 7_200_000` ms SHALL be persisted

#### Scenario: Rotating refresh token persisted atomically

- **WHEN** a refresh succeeds and returns a new `refresh_token`
- **THEN** both `access_token` and `refresh_token` SHALL be persisted in one atomic `CredentialStore.set` call
- **AND** the old refresh token SHALL be treated as invalid from that point

### Requirement: GitLab connector consumes access token from env

The existing GitLab connector (`lib/gitlab.ts`) SHALL, when `authMode === 'oauth'`, read its bearer token from `process.env.GITLAB_OAUTH_ACCESS_TOKEN` injected by the parent at spawn.

#### Scenario: OAuth mode

- **WHEN** `gitlab.authMode === 'oauth'` and `GITLAB_OAUTH_ACCESS_TOKEN` is set
- **THEN** GitLab API calls SHALL use `Authorization: Bearer <token>`
- **AND** the `PRIVATE-TOKEN` header SHALL NOT be set

#### Scenario: PAT mode

- **WHEN** `gitlab.authMode === 'pat'` and `GITLAB_TOKEN` is set
- **THEN** GitLab API calls SHALL continue using `PRIVATE-TOKEN: <token>` as today

### Requirement: Self-hosted vs gitlab.com detection

The settings UI SHALL let the user pick between "gitlab.com" and "Self-hosted (custom URL)" when configuring GitLab OAuth. The selection SHALL populate `gitlab.baseUrl` in config.

#### Scenario: User selects gitlab.com

- **WHEN** the user selects "gitlab.com" and clicks Connect
- **THEN** `gitlab.baseUrl` SHALL be set to `https://gitlab.com`
- **AND** the OAuth flow SHALL use `https://gitlab.com/oauth/*` endpoints

#### Scenario: User selects self-hosted

- **WHEN** the user selects "Self-hosted" and enters `http://10.200.11.32`
- **THEN** the value SHALL be validated as a reachable GitLab instance (HEAD `/api/v4/version`)
- **AND** on success, `gitlab.baseUrl` SHALL be persisted and the OAuth flow started

### Requirement: Revoke on disconnect

Disconnect for GitLab SHALL call the revoke endpoint best-effort before deleting the local credential.

#### Scenario: Disconnect succeeds end-to-end

- **WHEN** the user clicks "Disconnect" for GitLab
- **AND** `${baseUrl}/oauth/revoke` returns 200
- **THEN** `CredentialStore.delete('gitlab')` SHALL be called
- **AND** any active refresh timer for GitLab SHALL be cleared

#### Scenario: Revoke endpoint unreachable

- **WHEN** the revoke endpoint times out or returns an error
- **THEN** `CredentialStore.delete('gitlab')` SHALL still be called
- **AND** the UI SHALL display a warning that server-side revocation may have failed, with a link to GitLab's Applications page
