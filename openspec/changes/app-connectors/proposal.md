## Why

When Jira tickets link to Google Docs, Figma designs, or Postman collections, the agent silently drops those URLs (matched by the `UNFETCHABLE` regex in `fetch-ticket.js`) and asks users to paste content manually. This creates a broken feedback loop — the most context-rich artifacts are the ones the agent can't read. Authenticated connector fetches would close this gap and let the pipeline consume design specs, API contracts, and requirements documents automatically.

## What Changes

- **Three new connector modules** (`lib/gdrive.js`, `lib/figma.js`, `lib/postman.js`) that authenticate and fetch content from Google Drive, Figma, and Postman APIs
- **URL router in `fetch-ticket.js`** that intercepts known connector URLs *before* the UNFETCHABLE filter and routes them to the appropriate connector module
- **New `connectorContents[]` state field** with a 15 KB per-item budget, bypassing the existing 3–5 KB attachment/URL truncation caps that would destroy connector content
- **Summarization layer** to condense raw API responses (Figma node trees, full Google Docs) into developer-relevant summaries within the 15 KB budget
- **Config schema additions** (`lib/config-schema.js`): three new groups (`gdrive`, `figma`, `postman`) with env vars for credentials and feature toggles
- **Test connection endpoints** (`server/routes.js`): extend the existing test framework to support `gdrive`, `figma`, and `postman` service validation
- **UI connector card activation** (`server/html.js`): change Google Drive, Figma cards from "Coming Soon" to active with configuration fields; add Postman card

## Capabilities

### New Capabilities
- `gdrive-connector`: Google Drive integration — Service Account JWT auth, Google Docs export to markdown, Google Sheets export to CSV, permission/share validation
- `figma-connector`: Figma integration — PAT auth, file/node tree extraction with text content, frame screenshot export via Figma Image API + Anthropic Vision summarization
- `postman-connector`: Postman integration — API Key auth, collection fetch and flatten to endpoint summary, JSON attachment detection for zero-auth import path
- `connector-routing`: URL routing layer in fetch-ticket.js that intercepts connector URLs before the UNFETCHABLE filter and dispatches to authenticated modules
- `connector-budget`: New `connectorContents[]` state category with 15 KB per-item budget and summarization to fit prompt constraints

### Modified Capabilities
<!-- No existing specs to modify -->

## Impact

- **Pipeline stages affected**: `fetch-ticket` (URL routing + connector dispatch), `explore-plan` (prompt budget for connectorContents), `generate-code` (connector content in developer prompt)
- **New files**: `lib/gdrive.js`, `lib/figma.js`, `lib/postman.js`
- **Modified files**: `stages/fetch-ticket.js`, `stages/explore-plan.js`, `stages/generate-code/index.js`, `lib/config-schema.js`, `server/routes.js`, `server/html.js`
- **New dependencies**: None — Google Drive JWT auth uses native `crypto` and `https`; Figma and Postman use plain HTTPS with static tokens
- **New env vars**: `GDRIVE_SERVICE_ACCOUNT_JSON`, `GDRIVE_ENABLED`; `FIGMA_TOKEN`, `FIGMA_ENABLED`; `POSTMAN_API_KEY`, `POSTMAN_ENABLED`
- **Failure scenarios**: Each connector degrades gracefully — if auth fails or API is unreachable, the URL falls through to the existing UNFETCHABLE path (user paste instructions). No connector failure blocks the pipeline.
- **Internal GitLab constraint**: Connectors call external APIs (googleapis.com, api.figma.com, api.getpostman.com) — no impact on internal GitLab server at `10.200.11.32`
