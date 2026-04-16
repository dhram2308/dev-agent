## ADDED Requirements

### Requirement: Manage button on every connector card
Every connector card SHALL display a "Manage" button in the footer section, alongside the existing Test and Configure actions. The button MUST be present for all connector types: PAT-based, OAuth, and coming-soon.

#### Scenario: Manage button visible on connected PAT connector
- **WHEN** a PAT-based connector (e.g., Jira) has status "connected"
- **THEN** the card footer shows [Test], [Manage], and [Configure] actions

#### Scenario: Manage button visible on disconnected connector
- **WHEN** a connector has status "disconnected"
- **THEN** the card footer still shows the [Manage] button

#### Scenario: Manage button visible on coming-soon connector
- **WHEN** a connector has status "coming_soon"
- **THEN** the card footer shows the [Manage] button (Test and Configure are hidden/disabled per existing behavior)

### Requirement: Manage modal opens on click
Clicking the "Manage" button SHALL open a modal dialog overlaying the page. The modal MUST use a fixed overlay with backdrop blur, support closing via Esc key, and support closing via click on the overlay background.

#### Scenario: Open manage modal
- **WHEN** user clicks the [Manage] button on any connector card
- **THEN** a modal opens with the connector name in the header and connection status details in the body

#### Scenario: Close modal via Esc key
- **WHEN** the manage modal is open
- **WHEN** user presses the Esc key
- **THEN** the modal closes

#### Scenario: Close modal via overlay click
- **WHEN** the manage modal is open
- **WHEN** user clicks the backdrop overlay (outside the modal content)
- **THEN** the modal closes

#### Scenario: Close modal via X button
- **WHEN** the manage modal is open
- **WHEN** user clicks the [X] close button in the modal header
- **THEN** the modal closes

### Requirement: Modal shows PAT connector status
For PAT/Token-based connectors, the modal SHALL display: connection status (connected/disconnected), auth type ("PAT / Personal Access Token"), and last test result (if available).

#### Scenario: PAT connector connected with test result
- **WHEN** the manage modal opens for a connected PAT connector (e.g., Jira)
- **WHEN** the connector has a previous test result (passed)
- **THEN** the modal shows Status: "Connected", Auth: "PAT (Personal Access Token)", Last Test: "Passed" with the test message

#### Scenario: PAT connector connected without test result
- **WHEN** the manage modal opens for a connected PAT connector
- **WHEN** no test has been run yet
- **THEN** the modal shows Status: "Connected", Auth: "PAT (Personal Access Token)", Last Test: "Not tested"

#### Scenario: PAT connector disconnected
- **WHEN** the manage modal opens for a disconnected PAT connector
- **THEN** the modal shows Status: "Disconnected", Auth: "—", Last Test: "Not tested" or last result

### Requirement: Modal shows OAuth connector status
For OAuth connectors, the modal SHALL display: connection status (mapped from oauthStatus), auth type ("OAuth 2.0"), account email (from metadata), token expiry countdown, and last test result.

#### Scenario: OAuth connector fully connected
- **WHEN** the manage modal opens for an OAuth connector with oauthStatus "CONNECTED"
- **THEN** the modal shows Status: "Connected", Auth: "OAuth 2.0", Account: email from metadata, Expiry: countdown to expiresAt, Last Test: result or "Not tested"

#### Scenario: OAuth connector requires re-authorization
- **WHEN** the manage modal opens for an OAuth connector with oauthStatus "RE_AUTH_REQUIRED"
- **THEN** the modal shows Status: "Re-auth Required" with warning styling

#### Scenario: OAuth connector revoked
- **WHEN** the manage modal opens for an OAuth connector with oauthStatus "REVOKED"
- **THEN** the modal shows Status: "Revoked" with error styling

#### Scenario: OAuth connector not connected
- **WHEN** the manage modal opens for an OAuth connector with oauthStatus "NOT_CONNECTED"
- **THEN** the modal shows Status: "Not Connected"

### Requirement: Modal shows coming-soon connector status
For coming-soon connectors, the modal SHALL display a minimal view with status "Coming Soon" and a message indicating the connector is not yet available.

#### Scenario: Coming-soon connector modal
- **WHEN** the manage modal opens for a coming-soon connector (e.g., Confluence)
- **THEN** the modal shows Status: "Coming Soon", Auth: "—", and a message "This connector is not yet available."
- **THEN** no action buttons (Test Now, Configure, Disconnect) are shown

### Requirement: Modal quick actions
The modal SHALL include action buttons that reuse existing handler functions. Available actions depend on connector type.

#### Scenario: Test Now action in modal
- **WHEN** the manage modal is open for a connected or disconnected (non-coming-soon) connector
- **WHEN** user clicks [Test Now]
- **THEN** the existing test connection flow executes (same as clicking Test on the card)
- **THEN** the test result updates in the modal in real-time

#### Scenario: Configure action in modal
- **WHEN** the manage modal is open for a connector that has a configuration group
- **WHEN** user clicks [Configure]
- **THEN** the modal closes
- **THEN** the Settings page navigates to the Config tab scrolled to the connector's config group

#### Scenario: Disconnect action for OAuth connector
- **WHEN** the manage modal is open for an OAuth connector with oauthStatus "CONNECTED"
- **WHEN** user clicks [Disconnect]
- **THEN** the existing OAuth disconnect flow executes
- **THEN** the modal status updates to reflect disconnection

#### Scenario: No Disconnect for PAT connectors
- **WHEN** the manage modal is open for a PAT-based connector
- **THEN** no [Disconnect] button is shown (PAT removal is done via Config tab)
