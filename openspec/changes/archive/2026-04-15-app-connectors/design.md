## Context

The MI Dev Agent pipeline fetches Jira ticket context in `stages/fetch-ticket.js`. URLs found in ticket descriptions, acceptance criteria, and comments are extracted via `adfExtractUrls()` and fetched in parallel. However, URLs matching the `UNFETCHABLE` regex (line ~345) — including `figma.com`, `docs.google.com`, `drive.google.com`, `postman.com` — are silently dropped. Users must manually paste content from these services, breaking the automated pipeline flow.

The existing connector UI (`server/html.js`) already defines placeholder cards for Google Drive, Figma, and others with `active: false`. The config system (`lib/config-schema.js`) supports grouped env vars with validation, sensitivity masking, and hot-reload. Test connection endpoints in `server/routes.js` currently handle `jira`, `gitlab`, and `slack`.

Current prompt budget constraints:
- `explore-plan.js`: 3 KB/attachment, 10 KB total attachments, 5 KB/URL, 10 KB total URLs
- `generate-code/index.js`: 5 KB per attachment/URL content in developer prompt
- These caps would destroy connector content (a Google Doc can be 50+ KB, a Figma tree 200+ KB)

## Goals / Non-Goals

**Goals:**
- Automatically fetch and process content from Google Drive, Figma, and Postman when linked in Jira tickets
- Graceful degradation — connector failure never blocks the pipeline; falls back to user paste instructions
- Fit connector content into prompts without exceeding token limits via summarization
- Reuse existing config, test connection, and UI infrastructure
- Zero new npm dependencies — use Node.js native `https`, `crypto` modules

**Non-Goals:**
- Writing back to these services (no uploads, edits, or comments)
- OAuth2 user-delegated flows (too complex for a server-side agent; use service accounts/API keys)
- Real-time sync or webhooks from these services
- Confluence or Notion connectors (listed in UI but deferred)
- Modifying the existing URL/attachment budget caps (connector content gets its own budget)

## Decisions

### D1: URL Router — intercept before UNFETCHABLE filter

**Decision**: Insert a connector URL router in `fetch-ticket.js` that runs *before* the UNFETCHABLE regex test. Known connector URL patterns are matched first; if a connector is enabled and auth succeeds, the content is fetched via the connector module. Only unmatched or failed URLs continue to the UNFETCHABLE filter.

**Why not after**: The UNFETCHABLE regex silently drops URLs. There's no recovery point after it runs. Routing before it means connectors get first crack at URLs they can handle.

**Alternative considered**: Remove connector domains from UNFETCHABLE entirely. Rejected because unauthenticated fetches to these domains would fail with 401/403 errors, adding noise to logs and slowing the pipeline.

### D2: Separate `connectorContents[]` state field with 15 KB per-item budget

**Decision**: Connector results are stored in `state.data.ticket.connectorContents[]` (not in `fetchedUrlContents` or `attachmentContents`). Each item has a 15 KB budget after summarization.

**Why separate**: The existing `fetchedUrlContents` has a 5 KB per-URL cap in the prompt. Connector content is richer (design specs, API contracts) and warrants more space. A dedicated field also makes it easy to track, log, and cap connector-specific budget without touching existing caps.

**Why 15 KB**: A Google Doc requirement spec summarizes to ~8–12 KB. A Figma design with 20 frames summarizes to ~5–10 KB. A Postman collection with 30 endpoints flattens to ~6–8 KB. 15 KB covers 95% of real-world cases.

### D3: Google Drive — Service Account with domain-wide delegation

**Decision**: Use a GCP Service Account with a JSON key file. The agent generates a JWT, exchanges it for an access token via Google's OAuth2 token endpoint, and caches the token for its 1-hour lifetime.

**Why not OAuth2 user flow**: Requires browser redirect, user consent, and refresh token management. Too complex for a headless server-side agent.

**Why not API key**: Google Drive API doesn't support API keys for file content access — only metadata. Service Account is the simplest path that can read file content.

**Token caching**: JWT→token exchange takes ~200ms. Cache the access token in-memory with expiry tracking. On crash recovery, a fresh token is generated (stateless — no persistence needed).

### D4: Figma — Personal Access Token (PAT)

**Decision**: Use a static PAT passed via `FIGMA_TOKEN` env var. Sent as `X-Figma-Token` header.

**Why PAT over OAuth2**: PATs are simpler, no refresh flow needed. The tradeoff is a 90-day expiry — but the test connection endpoint will surface expiry errors immediately, and the UI will show a clear "token expired" message.

### D5: Postman — API Key + JSON attachment fallback

**Decision**: Two paths:
1. **URL path**: Postman collection URLs are parsed for collection ID, fetched via `api.getpostman.com` with `X-API-Key` header
2. **Attachment path**: JSON attachments already downloaded by fetch-ticket.js are scanned for Postman collection schema (`info._postman_id` or `info.schema` containing `collection`). No API key needed.

**Why dual path**: Many teams export Postman collections as JSON and attach them to Jira tickets directly. This zero-config path should work without any Postman API key.

### D6: Summarization via structured extraction, not LLM

**Decision**: Each connector module includes a `summarize()` function that extracts developer-relevant content:
- **Google Docs**: Export as markdown (Google's built-in export), truncate to 15 KB
- **Google Sheets**: Export as CSV, take first 100 rows
- **Figma**: Extract text content from nodes, list component names, frame hierarchy
- **Postman**: Flatten to method + path + description per endpoint

**Why not LLM summarization**: Adds latency (another Claude call), cost, and a dependency on the Claude CLI/API during fetch-ticket stage. Structured extraction is deterministic, fast, and free.

**Exception — Figma Vision**: For Figma frames with minimal text, optionally export frame images and use `callAnthropicVision()` (already exists in `lib/jira.js`) to describe the visual design. This is opt-in via `FIGMA_VISION_ENABLED=true`.

### D7: Config schema — three new groups

**Decision**: Add `gdrive`, `figma`, `postman` groups to `lib/config-schema.js` with these entries:

| Group | Env Var | Type | Sensitive | Default |
|-------|---------|------|-----------|---------|
| gdrive | `GDRIVE_SERVICE_ACCOUNT_JSON` | string | true | — |
| gdrive | `GDRIVE_ENABLED` | boolean | false | false |
| figma | `FIGMA_TOKEN` | string | true | — |
| figma | `FIGMA_ENABLED` | boolean | false | false |
| figma | `FIGMA_VISION_ENABLED` | boolean | false | false |
| postman | `POSTMAN_API_KEY` | string | true | — |
| postman | `POSTMAN_ENABLED` | boolean | false | false |

All default to disabled. Enabling requires setting credentials first.

## Risks / Trade-offs

**[Google Drive token exchange adds latency]** → First call per agent run adds ~200ms for JWT→token exchange. Mitigated by caching token for its 1-hour lifetime. Subsequent calls use cached token.

**[Figma PAT expires every 90 days]** → Test connection endpoint will detect 403 and return "Token expired — generate a new PAT in Figma settings." No silent failure.

**[Large Figma files can be slow]** → Figma API returns entire file tree. For files with 500+ nodes, response can take 5–10s and be 1+ MB. Mitigated by requesting specific node IDs when URL contains node-id parameter, and by truncating node tree traversal at depth 4.

**[Service Account JSON is a large credential]** → Unlike single-line tokens, the GCP JSON key is a multi-line JSON blob (~2.5 KB). Stored as a single env var (base64-encoded or raw JSON string). The Settings UI textarea input handles this.

**[Postman API rate limits]** → Free tier: 60 requests/minute. Agent typically makes 1–3 calls per ticket. No risk of hitting limits in normal operation.

**[Connector content inflates prompt size]** → Each connector item adds up to 15 KB. With 3 connectors active, worst case is 45 KB additional prompt content. The existing 5-level truncation strategy in `lib/utils.js` handles prompt overflow, and connector content is lower priority than code context — truncated first.

**[Crash recovery]** → Connector results stored in `state.data.ticket.connectorContents[]` and persisted to state JSON file. On resume, fetch-ticket checks if connectorContents already populated and skips re-fetch. Same pattern as existing `fetchedUrlContents`.
