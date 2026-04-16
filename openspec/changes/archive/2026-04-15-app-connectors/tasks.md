## 1. Config Schema & Environment

- [x] 1.1 Add `gdrive` group to `lib/config-schema.js` with `GDRIVE_SERVICE_ACCOUNT_JSON` (string, sensitive) and `GDRIVE_ENABLED` (boolean, default false)
- [x] 1.2 Add `figma` group to `lib/config-schema.js` with `FIGMA_TOKEN` (string, sensitive), `FIGMA_ENABLED` (boolean, default false), `FIGMA_VISION_ENABLED` (boolean, default false)
- [x] 1.3 Add `postman` group to `lib/config-schema.js` with `POSTMAN_API_KEY` (string, sensitive), `POSTMAN_ENABLED` (boolean, default false)
- [x] 1.4 Add `groupLabels` entries for gdrive ("Google Drive"), figma ("Figma"), postman ("Postman") in `server/html.js`
- [x] 1.5 Verify new config groups render correctly in Settings UI at localhost:3000

## 2. Google Drive Connector Module

- [x] 2.1 Create `lib/gdrive.js` with JWT generation using native `crypto.createSign('RSA-SHA256')` and `https` token exchange to `oauth2.googleapis.com/token`
- [x] 2.2 Implement in-memory token caching with expiry tracking (reuse if >60s remaining)
- [x] 2.3 Implement `fetchGoogleDoc(fileId)` — export via `/drive/v3/files/{fileId}/export?mimeType=text/markdown`, truncate at 15 KB paragraph boundary
- [x] 2.4 Implement `fetchGoogleSheet(fileId, gid?)` — export via CSV mimeType, limit to first 100 rows
- [x] 2.5 Implement `testConnection()` — JWT exchange + `GET /drive/v3/about?fields=user` to validate credentials and return service account email
- [x] 2.6 Export `{ fetchGoogleDoc, fetchGoogleSheet, testConnection, matchUrl }` — `matchUrl` returns `{ type: 'doc'|'sheet', fileId, gid? }` or null

## 3. Figma Connector Module

- [x] 3.1 Create `lib/figma.js` with PAT auth via `X-Figma-Token` header on all requests
- [x] 3.2 Implement `fetchFigmaFile(fileKey, nodeId?)` — calls `/v1/files/{fileKey}` or `/v1/files/{fileKey}/nodes?ids={nodeId}`, traverses node tree to depth 4, extracts text content, frame names, component names
- [x] 3.3 Implement `summarizeFigmaContent(fileData)` — produces structured summary (file name, pages, frames, text content) within 15 KB
- [x] 3.4 Implement optional Vision path — export up to 3 frame images via `/v1/images/{fileKey}`, call `callAnthropicVision()` from `lib/jira.js`, append descriptions (gated by `FIGMA_VISION_ENABLED`)
- [x] 3.5 Implement `testConnection()` — `GET /v1/me` with PAT, return user handle
- [x] 3.6 Export `{ fetchFigmaFile, testConnection, matchUrl }` — `matchUrl` parses fileKey and optional nodeId from URL

## 4. Postman Connector Module

- [x] 4.1 Create `lib/postman.js` with API Key auth via `X-API-Key` header
- [x] 4.2 Implement `fetchCollection(collectionId)` — calls `GET /collections/{collectionId}` on `api.getpostman.com`, returns raw collection JSON
- [x] 4.3 Implement `flattenCollection(collection)` — recursive folder traversal, resolves `{{variables}}`, outputs `METHOD /path — description` per request, includes request body schema (keys + types), truncates at 15 KB
- [x] 4.4 Implement `detectPostmanAttachment(jsonContent)` — checks for `info._postman_id` or `info.schema` containing `collection`, returns boolean
- [x] 4.5 Implement `testConnection()` — `GET /me` on Postman API, return user name
- [x] 4.6 Export `{ fetchCollection, flattenCollection, detectPostmanAttachment, testConnection, matchUrl }`

## 5. Connector URL Router in fetch-ticket.js

- [x] 5.1 Add connector URL pattern matching function that maps URLs to connector modules (gdrive/figma/postman) using the patterns from connector-routing spec
- [x] 5.2 Insert router call BEFORE the `UNFETCHABLE` regex test — matched connector URLs are separated into `connectorUrls[]`, remaining URLs continue to UNFETCHABLE filter
- [x] 5.3 Implement parallel connector fetch using `Promise.allSettled` with `URL_FETCH_TIMEOUT`, respecting `FETCH_CONCURRENCY` limit
- [x] 5.4 Store successful results in `state.data.ticket.connectorContents[]` with `{ source, url, title, content, sizeBytes }` structure
- [x] 5.5 Route failed connector fetches to `authRequiredUrls` with connector-specific error messages
- [x] 5.6 Enforce 3-item cap — if more than 3 connector URLs found, process first 3, add rest to authRequiredUrls
- [x] 5.7 Add crash recovery check — skip connector fetch if `connectorContents` already populated on resume

## 6. Postman Attachment Detection in fetch-ticket.js

- [x] 6.1 After existing attachment download loop, scan JSON attachments using `detectPostmanAttachment()` from `lib/postman.js`
- [x] 6.2 For detected Postman attachments, run `flattenCollection()` and store in `connectorContents[]` (counts toward the 3-item cap)

## 7. Prompt Integration

- [x] 7.1 In `stages/explore-plan.js`, add `## Connector Documents` section after URL content — iterate `connectorContents[]`, render each as `### <title> (source: <source>)\n<content>`
- [x] 7.2 In `stages/generate-code/index.js`, add same `## Connector Documents` section to `devFullContext`, each item capped at 15 KB
- [x] 7.3 Update prompt truncation priority in `lib/utils.js` — connector content truncated BEFORE code files but AFTER regular URL content

## 8. Test Connection Endpoints

- [x] 8.1 In `server/routes.js`, extend the service allowlist to include `"gdrive"`, `"figma"`, `"postman"`
- [x] 8.2 Add gdrive test handler — call `gdrive.testConnection()`, return ok/error response
- [x] 8.3 Add figma test handler — call `figma.testConnection()`, return ok/error response
- [x] 8.4 Add postman test handler — call `postman.testConnection()`, return ok/error response

## 9. UI Connector Cards

- [x] 9.1 In `server/html.js`, update Google Drive connector card: set `active: true`, update description to reflect actual capability
- [x] 9.2 Update Figma connector card: set `active: true`, update description
- [x] 9.3 Add Postman connector card to the connectors array with icon, description, `active: true`
- [x] 9.4 Verify all 3 new connector cards show config fields and test connection buttons in Settings UI at localhost:3000

## 10. End-to-End Verification

- [x] 10.1 Test Google Drive: create a test Google Doc, share with service account, run agent with a mock ticket linking to the doc — verify content appears in connectorContents
- [x] 10.2 Test Figma: use a test Figma file URL, verify file structure and text extraction
- [x] 10.3 Test Postman: attach a Postman collection JSON to a test, verify detection and flattening
- [x] 10.4 Test graceful degradation: disable a connector, verify URL falls through to UNFETCHABLE with paste instructions
- [x] 10.5 Test Settings UI: verify test connection works for all 3 new services, verify config save/load
