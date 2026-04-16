# connector-routing Specification

## Purpose
TBD - created by archiving change app-connectors. Update Purpose after archive.
## Requirements
### Requirement: URL router intercepts connector URLs before UNFETCHABLE filter
The system SHALL route URLs matching known connector patterns to their respective connector modules BEFORE the `UNFETCHABLE` regex test in `stages/fetch-ticket.js`. URLs handled by connectors SHALL NOT reach the UNFETCHABLE filter.

#### Scenario: Google Docs URL with GDrive enabled
- **WHEN** a URL matches `docs.google.com/document/d/*` and `GDRIVE_ENABLED=true`
- **THEN** the URL is routed to `lib/gdrive.js` for authenticated fetch and removed from the general URL list

#### Scenario: Figma URL with Figma enabled
- **WHEN** a URL matches `figma.com/design/*` or `figma.com/file/*` and `FIGMA_ENABLED=true`
- **THEN** the URL is routed to `lib/figma.js` for authenticated fetch

#### Scenario: Postman URL with Postman enabled
- **WHEN** a URL matches `postman.com/collections/*` or `app.getpostman.com/*` and `POSTMAN_ENABLED=true`
- **THEN** the URL is routed to `lib/postman.js` for authenticated fetch

#### Scenario: Connector URL but connector disabled
- **WHEN** a URL matches a connector pattern but the connector's `*_ENABLED` flag is `false`
- **THEN** the URL continues to the UNFETCHABLE filter and is handled normally (dropped with paste instructions)

#### Scenario: Connector fetch fails
- **WHEN** a connector module returns `{ ok: false }` for a URL (auth failure, network error, file not found)
- **THEN** the URL is added to `authRequiredUrls` with the connector's error message, and paste instructions are generated via `getDocPasteInstructions()`

### Requirement: Connector results stored in connectorContents
The system SHALL store successful connector fetch results in `state.data.ticket.connectorContents[]`. Each entry SHALL include: `source` (gdrive/figma/postman), `url` (original URL), `title` (document/file name), `content` (summarized text), `sizeBytes` (content length).

#### Scenario: Successful connector fetch
- **WHEN** a connector module returns `{ ok: true, title, content }` for a URL
- **THEN** the result is appended to `state.data.ticket.connectorContents[]` with source metadata

#### Scenario: Multiple connector URLs in one ticket
- **WHEN** a ticket contains URLs for multiple connectors (e.g., a Google Doc + a Figma design)
- **THEN** each URL is routed to its respective connector and results are stored as separate entries in `connectorContents[]`

### Requirement: Connector URL pattern matching
The system SHALL recognize the following URL patterns for routing:

| Connector | URL Patterns |
|-----------|-------------|
| gdrive | `docs.google.com/document/d/*`, `docs.google.com/spreadsheets/d/*`, `sheets.google.com/*`, `drive.google.com/file/d/*` |
| figma | `figma.com/design/*`, `figma.com/file/*`, `figma.com/proto/*` |
| postman | `postman.com/collections/*`, `app.getpostman.com/collections/*`, `postman.com/*/workspace/*/collection/*` |

#### Scenario: URL matches connector pattern
- **WHEN** a URL hostname and path match a pattern in the table above
- **THEN** the URL is identified for routing to the corresponding connector module

#### Scenario: URL does not match any connector
- **WHEN** a URL does not match any connector pattern
- **THEN** the URL proceeds through the existing UNFETCHABLE → fetchable → fetch pipeline unchanged

### Requirement: Parallel connector fetches
The system SHALL fetch connector URLs in parallel (using `Promise.allSettled`) alongside regular URL fetches, respecting the existing `FETCH_CONCURRENCY` limit.

#### Scenario: Multiple connector URLs
- **WHEN** 3 connector URLs are identified (1 GDrive, 1 Figma, 1 Postman)
- **THEN** all 3 are fetched in parallel, each with its own timeout (`URL_FETCH_TIMEOUT`)

