## ADDED Requirements

### Requirement: Google Drive authentication via Service Account JWT
The system SHALL authenticate to Google Drive API using a GCP Service Account JSON key. The module SHALL generate a JWT signed with RS256, exchange it for an access token via `https://oauth2.googleapis.com/token`, and cache the token in-memory until expiry (1 hour).

#### Scenario: Successful token exchange
- **WHEN** `GDRIVE_ENABLED=true` and `GDRIVE_SERVICE_ACCOUNT_JSON` contains a valid JSON key
- **THEN** the module exchanges a JWT for an access token and caches it with its expiry timestamp

#### Scenario: Token reuse within expiry window
- **WHEN** a cached token exists and has more than 60 seconds until expiry
- **THEN** the module reuses the cached token without making a new token exchange request

#### Scenario: Token refresh after expiry
- **WHEN** the cached token has expired or has less than 60 seconds remaining
- **THEN** the module generates a new JWT and exchanges it for a fresh access token

#### Scenario: Invalid service account JSON
- **WHEN** `GDRIVE_SERVICE_ACCOUNT_JSON` is malformed or missing required fields (`client_email`, `private_key`)
- **THEN** the module returns an error `{ ok: false, error: "Invalid service account JSON: missing <field>" }` and the URL falls through to UNFETCHABLE handling

### Requirement: Google Docs export to markdown
The system SHALL export Google Docs content as markdown using the Google Drive export API (`mimeType=text/markdown`). The exported content SHALL be truncated to the 15 KB connector budget.

#### Scenario: Successful Google Doc fetch
- **WHEN** a URL matching `docs.google.com/document/d/{fileId}` is detected and GDRIVE is enabled
- **THEN** the module extracts the file ID, calls `GET /drive/v3/files/{fileId}/export?mimeType=text/markdown`, and returns the markdown content

#### Scenario: Google Doc exceeds budget
- **WHEN** the exported markdown exceeds 15 KB
- **THEN** the module truncates at the nearest paragraph boundary before 15 KB and appends `\n\n[Content truncated — original document continues]`

#### Scenario: Google Doc not shared with service account
- **WHEN** the Drive API returns 404 or 403 for the file ID
- **THEN** the module returns `{ ok: false, error: "File not accessible — share it with <service_account_email>" }` with the service account email from the JSON key

### Requirement: Google Sheets export to CSV
The system SHALL export Google Sheets as CSV using the Drive export API (`mimeType=text/csv`). Only the first sheet is exported, limited to the first 100 rows.

#### Scenario: Successful Google Sheet fetch
- **WHEN** a URL matching `docs.google.com/spreadsheets/d/{fileId}` or `sheets.google.com` is detected and GDRIVE is enabled
- **THEN** the module exports as CSV and returns the first 100 rows

#### Scenario: Sheet with specific gid parameter
- **WHEN** the URL contains a `gid` parameter
- **THEN** the module exports the specific sheet identified by the gid

### Requirement: Test connection for Google Drive
The system SHALL provide a test connection endpoint that validates the service account credentials by listing files (scope-limited call).

#### Scenario: Successful test connection
- **WHEN** `POST /api/config/test` with `{ "service": "gdrive" }` is called and credentials are valid
- **THEN** the endpoint returns `{ ok: true, message: "Google Drive connected — service account: <email>" }`

#### Scenario: Failed test connection
- **WHEN** the JWT exchange fails (invalid key, network error)
- **THEN** the endpoint returns `{ ok: false, error: "<specific error message>" }`
