## ADDED Requirements

### Requirement: ConnectorCard Connect/Disconnect/Re-auth controls

The `ConnectorCard` component SHALL, for every OAuth-capable provider, display primary controls `[Connect]`, `[Disconnect]`, and `[Re-auth]` whose visibility depends on the connector's current status.

#### Scenario: Card for a not-yet-connected OAuth provider

- **WHEN** the connector for `figma` has no stored credential
- **THEN** the card SHALL show `[Connect with Figma]` as the primary action
- **AND** SHALL show a collapsible `[Use API token instead ▾]` disclosure

#### Scenario: Card for a connected OAuth provider

- **WHEN** the connector for `figma` has a valid stored OAuth credential
- **THEN** the card SHALL show account identity (e.g., "yogendra@mastersindia.co")
- **AND** SHALL show `[Disconnect]` and `[Re-auth]` as secondary actions
- **AND** SHALL show an expiry countdown where applicable

#### Scenario: Card for a connector needing re-auth

- **WHEN** the connector for `figma` is in state `RE_AUTH_REQUIRED`
- **THEN** the card SHALL show a warning badge "Re-auth required"
- **AND** the primary action SHALL be `[Re-authorize Figma]`

### Requirement: Status pill

Every ConnectorCard SHALL display a status pill with one of the following states and colors:

| State                 | Label               | Color  |
|-----------------------|---------------------|--------|
| `CONNECTED`           | "Connected"         | green  |
| `REFRESHING`          | "Refreshing…"       | blue   |
| `RE_AUTH_REQUIRED`    | "Re-auth required"  | amber  |
| `REVOKED`             | "Revoked"           | red    |
| `NOT_CONNECTED`       | "Not connected"     | gray   |
| `PAT`                 | "Connected via PAT" | green  |

#### Scenario: Pill updates on SSE event

- **WHEN** the backend broadcasts SSE `{ type: 'connectorConnected', provider: 'gitlab' }`
- **THEN** the GitLab card's status pill SHALL transition to "Connected" within 1 second

#### Scenario: Pill reflects RE_AUTH_REQUIRED

- **WHEN** the backend broadcasts SSE `{ type: 'authRequired', provider: 'figma' }`
- **THEN** the Figma card's status pill SHALL transition to "Re-auth required" with amber color

### Requirement: OAuth flow launcher

Clicking `[Connect]` on a ConnectorCard SHALL POST to `/api/oauth/:provider/start`, receive the `authorizeUrl`, and open it in a new browser tab using `window.open(url, '_blank')`. The UI SHALL display a progress indicator until the callback returns.

#### Scenario: User clicks Connect

- **WHEN** the user clicks `[Connect]` for GitLab
- **THEN** the frontend SHALL POST to `/api/oauth/gitlab/start`
- **AND** on a 200 response SHALL open `authorizeUrl` in a new tab
- **AND** SHALL show a "Waiting for authorization…" spinner on the card

#### Scenario: Start endpoint returns an error

- **WHEN** the start request returns HTTP 400 with `OAUTH_NOT_CONFIGURED`
- **THEN** the card SHALL show an inline error: "OAuth not configured. Set OAUTH_GITLAB_CLIENT_ID or use a PAT."
- **AND** SHALL automatically expand the `[Use API token instead ▾]` disclosure

### Requirement: PAT fallback disclosure

Every OAuth-capable connector card SHALL include a collapsible `[Use API token instead ▾]` section that reveals the existing text input + `[Test]` button for PAT/API-key configuration.

#### Scenario: Expanding the disclosure

- **WHEN** the user clicks `[Use API token instead ▾]`
- **THEN** the disclosure SHALL expand to show the token input, a help link, and a `[Test]` button
- **AND** the OAuth controls SHALL remain visible above the disclosure

#### Scenario: Saving a PAT

- **WHEN** the user enters a token and clicks `[Save]`
- **THEN** the token SHALL be stored via `CredentialStore.set(provider, { kind: 'pat', accessToken: <token> })`
- **AND** the status pill SHALL transition to "Connected via PAT"

### Requirement: Expiry countdown

For connectors in OAuth mode with a known `expiresAt`, the ConnectorCard SHALL display a human-friendly expiry label: "Refreshes in 45 min" while fresh, "Refreshing…" during active refresh, and "Expired — reconnecting" after expiry.

#### Scenario: Refresh countdown updates

- **WHEN** a token expires in 45 minutes
- **THEN** the card SHALL display "Refreshes in 45 min"
- **AND** the label SHALL update at least once per minute

#### Scenario: Active refresh shows transient state

- **WHEN** `TokenManager` starts a refresh for a provider
- **THEN** the card SHALL display "Refreshing…"
- **AND** SHALL return to a countdown label after refresh completes

### Requirement: New tabs for Figma, Google Drive, Postman

The Connectors tab (`ConnectorsTab.tsx`) SHALL expose individual tabs for Figma, Google Drive, and Postman. These tabs SHALL each render a `ConnectorCard` with the appropriate OAuth or API-key controls.

#### Scenario: Tabs rendered

- **WHEN** the user navigates to Settings → Connectors
- **THEN** the tab list SHALL include at minimum: Jira, GitLab, Slack, Figma, Google Drive, Postman, Claude
- **AND** each tab SHALL render a card with the correct primary auth control

#### Scenario: Tab badge reflects connector status

- **WHEN** any connector enters `RE_AUTH_REQUIRED`
- **THEN** its tab SHALL display an amber dot badge
- **AND** the badge SHALL persist until the connector returns to `CONNECTED` or `PAT`

### Requirement: Mid-pipeline re-auth prompt

When the parent broadcasts `{ type: 'authRequired', provider, reason }` because a pipeline paused on auth, the UI SHALL display a top-of-page banner with a `[Re-authorize <provider>]` button that launches the OAuth flow.

#### Scenario: Banner appears on authRequired SSE

- **WHEN** the frontend receives SSE `{ type: 'authRequired', provider: 'gitlab', reason: 'refresh-failed' }`
- **THEN** a persistent banner SHALL appear at the top of the page
- **AND** the banner SHALL include the provider name, the reason, and a `[Re-authorize GitLab]` button

#### Scenario: Banner auto-dismisses after successful re-auth

- **WHEN** the user re-auths from the banner and the connector returns to `CONNECTED`
- **THEN** the banner SHALL disappear
- **AND** a transient toast SHALL confirm "GitLab reconnected, resuming pipeline…"
