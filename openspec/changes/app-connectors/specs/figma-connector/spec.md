## ADDED Requirements

### Requirement: Figma authentication via Personal Access Token
The system SHALL authenticate to the Figma API using a PAT sent as the `X-Figma-Token` header on every request. No token caching or refresh logic is needed — the PAT is static.

#### Scenario: Valid PAT
- **WHEN** `FIGMA_ENABLED=true` and `FIGMA_TOKEN` is set
- **THEN** all Figma API requests include the `X-Figma-Token: <token>` header

#### Scenario: Expired or invalid PAT
- **WHEN** the Figma API returns 403
- **THEN** the module returns `{ ok: false, error: "Figma token expired or invalid — generate a new PAT at figma.com/developers" }`

### Requirement: Figma file and node extraction
The system SHALL fetch Figma file data via `GET /v1/files/{fileKey}` and extract developer-relevant content: page names, frame names, component names, and text node content. The node tree SHALL be traversed to a maximum depth of 4 to avoid processing very large files.

#### Scenario: Figma file URL without node ID
- **WHEN** a URL matching `figma.com/design/{fileKey}` or `figma.com/file/{fileKey}` is detected
- **THEN** the module fetches the entire file, extracts the top-level structure (pages → frames → components), and collects all text node content

#### Scenario: Figma URL with node-id parameter
- **WHEN** the URL contains a `node-id` query parameter
- **THEN** the module calls `GET /v1/files/{fileKey}/nodes?ids={nodeId}` to fetch only the specified subtree, reducing response size and latency

#### Scenario: Large Figma file (500+ nodes)
- **WHEN** the file tree contains more than 500 nodes
- **THEN** the module stops traversal at depth 4 and appends a note: `[Tree truncated at depth 4 — {N} additional nodes omitted]`

### Requirement: Figma frame image export via Vision (optional)
When `FIGMA_VISION_ENABLED=true`, the system SHALL export key frame images via the Figma Image API and describe them using `callAnthropicVision()` from `lib/jira.js`.

#### Scenario: Vision enabled with exportable frames
- **WHEN** `FIGMA_VISION_ENABLED=true` and the file contains frames
- **THEN** the module exports up to 3 top-level frame images (PNG, 2x scale), sends each to `callAnthropicVision()`, and appends the descriptions to the connector content

#### Scenario: Vision disabled
- **WHEN** `FIGMA_VISION_ENABLED=false` or not set
- **THEN** the module skips image export and relies only on text/structure extraction

#### Scenario: Image export fails
- **WHEN** the Figma Image API returns an error for a frame
- **THEN** the module logs a warning and continues with text extraction only — no pipeline failure

### Requirement: Figma content summarization
The system SHALL produce a structured summary from the extracted Figma data that fits within the 15 KB connector budget.

#### Scenario: Summary format
- **WHEN** Figma content is successfully extracted
- **THEN** the summary includes: file name, page list, frame hierarchy with component names, all text content grouped by frame, and optional vision descriptions

### Requirement: Test connection for Figma
The system SHALL validate the PAT by calling `GET /v1/me` (returns user info).

#### Scenario: Successful test
- **WHEN** `POST /api/config/test` with `{ "service": "figma" }` and PAT is valid
- **THEN** returns `{ ok: true, message: "Figma connected — user: <handle>" }`

#### Scenario: Failed test
- **WHEN** the PAT is invalid or expired
- **THEN** returns `{ ok: false, error: "Figma authentication failed — check your Personal Access Token" }`
