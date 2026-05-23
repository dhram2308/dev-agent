## Why

Connectors currently split their credentials by storage layer in a way that doesn't match their security profile:

- **OAuth tokens** are stored encrypted in macOS Keychain via the existing `CredentialStore` (Decision 4 of `oauth-connectors`), then injected into spawned agents via the `setTokenManager` wire (task 11.3 / Decision 10).
- **Personal Access Tokens (PATs)** for the same providers — Figma, Postman, GitLab, Jira — are still pasted into plaintext `.env` and read directly via `process.env`. The `CredentialStore` interface and `KeychainBackend` already support `kind: 'pat'`, but no code path writes or reads PATs through it.

This came up sharply during AUT-7218 verification:

- Figma OAuth completed cleanly and `Test` passed (`/v1/me` works for OAuth users).
- The agent then tried to fetch the linked design file with `/v1/files/<key>` and Figma returned `403 {"err":"Request denied"}`.
- Root cause is a Figma platform restriction: OAuth tokens can't read files outside the workspaces the OAuth grant explicitly covers, even with `file_content:read` scope. PATs inherit the user's full account access and don't have this limitation.
- The pragmatic fix is "OAuth + PAT, OAuth-first with PAT fallback on 401/403" — already wired in `figma.ts:_figmaGet` (commit landed in the `oauth-connectors` change, fallback chain). What's missing is a way to provide that PAT *without* writing it to `.env`.

The user pushed back: writing a Figma PAT to `.env` is fine for a one-off but the right place for it is alongside the OAuth token in the keychain. That's already what Decision 4 of `oauth-connectors/design.md` specifies — the implementation just stopped at OAuth.

## What Changes

- **NEW**: `POST /api/connectors/:provider/pat` route — accepts `{ token, metadata? }`, persists `{ kind: 'pat', accessToken, metadata }` to the credential store, mirrors to `process.env[envKey]` so in-process callers see it immediately. Auth-protected like other write routes.
- **NEW**: `DELETE /api/connectors/:provider/pat` route — removes the keychain entry, clears `process.env[envKey]`. Returns 404 if no PAT was stored.
- **NEW**: `PAT_PROVIDER_ENV_MAP` central mapping in `token-manager.ts`: `{ figma: 'FIGMA_TOKEN', postman: 'POSTMAN_API_KEY' }`. Single source of truth for env-key naming; future providers added by extending this object.
- **MODIFIED**: `initFromStore()` in `token-manager.ts` — already iterates `kind: 'oauth'` entries; extended to also iterate `kind: 'pat'` entries and stage their `accessToken` into `process.env[envKey]` per the mapping. Runs once at backend startup.
- **MODIFIED**: `disconnectProvider()` in `engine.ts` — when the deleted entry is `kind: 'pat'`, also clear `process.env[envKey]` (mirror behavior of the existing `clearProviderCache` for OAuth).
- **NEW**: Frontend `ConnectorCard.tsx` gains a `[Set API Token ▾]` disclosure on Figma and Postman cards. Reveals a password input + Save button; POSTs to the new route. Renders a "Connected via PAT" pill (green dot) + last-4 mask when set, and a `[Remove]` button to delete.
- **PRESERVED**: `.env` PAT path keeps working (`process.env.FIGMA_TOKEN` / `POSTMAN_API_KEY` read paths in `figma.ts` / `postman.ts` are unchanged). Users with PATs already in `.env` see no change. The new path is additive — keychain-stored PAT takes precedence on backend startup by being staged into `process.env`, but a `.env`-set PAT still works after init since `dotenv` runs before `initFromStore`.
- **PRESERVED**: All OAuth code paths from `oauth-connectors`. This change is strictly additive at the `kind: 'pat'` branch.

**Explicit non-goals:**

- Migrating existing `.env` PATs into the keychain on first run. Out of scope; users can delete the `.env` line themselves after saving via UI. A future change could add a one-shot migration prompt.
- Adding GitLab / Jira to `PAT_PROVIDER_ENV_MAP`. They already work via `.env` and `start.sh` bootstrap; their addition would require a parallel UI flow for "Set GitLab PAT" and an integration story with the existing OAuth path. Defer to a follow-up.
- Supporting `service_account` and `webhook` kinds. Different shapes (multi-line JSON for service accounts, URL for Slack webhooks) need bespoke UI; out of scope.
- Encrypting PAT in the WebSocket / SSE traffic differently. The keychain is encrypted at rest by macOS; in-transit between browser and `127.0.0.1:3000` is loopback HTTP, same surface as the rest of the API.

## Capabilities

### Modified Capabilities

- `credential-store`: Now actually used for PATs, not just OAuth. The existing `kind: 'pat'` branch in the keychain backend is exercised end-to-end.
- `connector-settings-ui`: Adds the per-card PAT input flow for Figma and Postman.

### New Capabilities

<!-- None — every concept already exists in the schema; this change wires existing parts together. -->

## Impact

**Affected code**

- `packages/backend/src/oauth/routes.ts` — two new route handlers under `/api/connectors/:provider/pat`.
- `packages/backend/src/oauth/token-manager.ts` — `PAT_PROVIDER_ENV_MAP` constant; `initFromStore` extended for `kind: 'pat'`.
- `packages/backend/src/oauth/engine.ts` — `disconnectProvider` clears `process.env[envKey]` for PATs.
- `packages/frontend/src/components/settings/ConnectorCard.tsx` — disclosure section + input + Save / Remove buttons + status pill.
- `packages/frontend/src/lib/api.ts` — typed wrappers for the new routes.
- `packages/frontend/src/store/settings.ts` — reflect PAT-from-keychain state in connection status (mirror existing OAuth status logic).

**No new dependencies. No new persisted files** beyond the existing keychain entries (a `pat.figma` / `pat.postman` row gets added to the keychain registry alongside `oauth.figma` / `oauth.google`).

**Backwards compatibility**

- Users with `FIGMA_TOKEN` in `.env` see no change.
- Users with neither OAuth nor PAT see the same "not set" error.
- Once a user saves a PAT via the new UI, the keychain entry takes effect on the next backend start; existing `.env` PATs still apply (later code reads via `process.env`, last writer wins; both writers set the same env var to the same kind of value).

**Internal GitLab (10.200.11.32) constraint**

- N/A — GitLab not in scope of this change; remains on `start.sh` bootstrap for now.

**Security posture**

- PATs move off plaintext disk into macOS Keychain (or encrypted file backend on headless). Equivalent treatment to OAuth tokens — same `CredentialStore` instance, same `kind: 'pat'` branch, same redaction filters.
- Save endpoint requires the same `x-api-token` header that all `/api/*` POSTs require. No CSRF surface beyond what already exists.
