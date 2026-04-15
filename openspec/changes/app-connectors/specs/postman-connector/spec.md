## ADDED Requirements

### Requirement: Postman authentication via API Key
The system SHALL authenticate to the Postman API using an API key sent as the `X-API-Key` header.

#### Scenario: Valid API key
- **WHEN** `POSTMAN_ENABLED=true` and `POSTMAN_API_KEY` is set
- **THEN** all Postman API requests include the `X-API-Key: <key>` header

#### Scenario: Invalid API key
- **WHEN** the Postman API returns 401
- **THEN** the module returns `{ ok: false, error: "Postman API key invalid — generate a new key at postman.co/settings" }`

### Requirement: Postman collection fetch via URL
The system SHALL fetch Postman collections by extracting the collection ID from URLs and calling the Postman API.

#### Scenario: Postman collection URL
- **WHEN** a URL matching `postman.com/collections/{collectionId}` or `app.getpostman.com/collections/{collectionId}` is detected and POSTMAN is enabled
- **THEN** the module extracts the collection ID and calls `GET /collections/{collectionId}` via `api.getpostman.com`

#### Scenario: Postman workspace URL with collection
- **WHEN** a URL contains a Postman workspace path with a collection reference
- **THEN** the module attempts to extract the collection ID from the URL path segments

#### Scenario: Collection not found
- **WHEN** the API returns 404 for the collection ID
- **THEN** the module returns `{ ok: false, error: "Collection not found — verify the URL and API key permissions" }`

### Requirement: Postman JSON attachment detection (zero-auth path)
The system SHALL detect Postman collection JSON files in Jira attachments without requiring an API key. Detection SHALL check for `info._postman_id` or `info.schema` containing `collection/v2` in the parsed JSON.

#### Scenario: Postman JSON attached to Jira ticket
- **WHEN** a Jira attachment has content type `application/json` and the parsed JSON contains `info._postman_id` or `info.schema` matching `*collection*`
- **THEN** the module processes the attachment as a Postman collection — no API key required

#### Scenario: JSON attachment that is not a Postman collection
- **WHEN** a JSON attachment does not contain Postman schema markers
- **THEN** the module ignores it and lets it be processed by the existing attachment pipeline

### Requirement: Postman collection flattening
The system SHALL flatten a Postman collection into a structured endpoint summary: method, path, description, and request/response body schemas.

#### Scenario: Collection with folders and requests
- **WHEN** a collection contains nested folders with requests
- **THEN** the module flattens to a list of `METHOD /path — description` entries, grouped by folder, with request body JSON schema (keys + types, not full examples)

#### Scenario: Collection with variables
- **WHEN** the collection uses Postman variables (e.g., `{{baseUrl}}`)
- **THEN** the module resolves variables from the collection's `variable` array and replaces them in paths

#### Scenario: Flattened output exceeds 15 KB
- **WHEN** the flattened summary exceeds the connector budget
- **THEN** the module truncates by omitting request/response body details, keeping only `METHOD /path — description` lines

### Requirement: Test connection for Postman
The system SHALL validate the API key by calling `GET /me` on the Postman API.

#### Scenario: Successful test
- **WHEN** `POST /api/config/test` with `{ "service": "postman" }` and key is valid
- **THEN** returns `{ ok: true, message: "Postman connected — user: <name>" }`

#### Scenario: Failed test
- **WHEN** the key is invalid
- **THEN** returns `{ ok: false, error: "Postman API key invalid — check your key at postman.co/settings" }`
