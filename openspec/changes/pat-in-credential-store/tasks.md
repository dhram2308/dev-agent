## 1. Backend — central env-key mapping + write/read API

- [x] 1.1 Add `PAT_PROVIDER_ENV_MAP: Record<string, string>` in `packages/backend/src/oauth/token-manager.ts`. Initial entries: `{ figma: 'FIGMA_TOKEN', postman: 'POSTMAN_API_KEY' }`. Export so route handlers and disconnect path can read it.
- [x] 1.2 Extend `initFromStore()` in `token-manager.ts`. After the existing `kind === 'oauth'` loop, add a parallel loop for `kind === 'pat'`: read each entry, look up its env key in `PAT_PROVIDER_ENV_MAP`, and set `process.env[envKey] = tokenSet.accessToken`. Skip providers without a mapping (log at debug level).
- [x] 1.3 In `packages/backend/src/oauth/routes.ts`, add `POST /api/connectors/:provider/pat` handler. Body shape: `{ token: string, metadata?: Record<string,string> }`. Validate provider name against `PAT_PROVIDER_ENV_MAP`. Apply `x-api-token` auth check (same pattern as existing routes). Call `store.set(provider, { kind: 'pat', accessToken: token, metadata: metadata ?? {} })`. Set `process.env[envKey]` immediately. Return `{ ok: true }` on success, redacted error otherwise.
- [x] 1.4 In the same file, add `DELETE /api/connectors/:provider/pat` handler. Same auth and provider validation. Call `store.delete(provider)`. Clear `process.env[envKey]` (set to `undefined`, then `delete`). Return 404 if `store.get` was already null pre-delete; 200 otherwise.
- [x] 1.5 In `packages/backend/src/oauth/engine.ts:disconnectProvider`, after the existing `clearProviderCache(providerName)` call (which is OAuth-cache-only), check if the provider was a `kind: 'pat'` entry — if so, look up `PAT_PROVIDER_ENV_MAP[provider]` and clear `process.env[envKey]`. Without this, the OAuth disconnect path silently leaves a stale env-staged PAT alive.

## 2. Frontend — Set API Token UI

- [x] 2.1 In `packages/frontend/src/lib/api.ts`, add typed wrappers `savePat(provider, token, metadata?)` and `removePat(provider)` that POST/DELETE to the new routes. Mirror error handling from existing `testConnection`.
- [x] 2.2 In `packages/frontend/src/components/settings/ConnectorCard.tsx`, add an `[Set API Token ▾]` disclosure section visible only on cards whose `id` is in a `PAT_CAPABLE` set (initial members: `'figma'`, `'postman'`). Inside: a password-type input + `[Save]` button. On save, call `savePat(provider, token)`. On success, show a "Connected via PAT" pill (green dot) and the last-4 mask of the token; show a `[Remove]` button.
- [x] 2.3 In `packages/frontend/src/store/settings.ts`, extend the connector-status logic so a `kind: 'pat'` entry from `/api/oauth/status` (which already returns PATs in its provider list) is reflected as `connected` for Figma and Postman. Don't break the existing `has(envVar)` check — combine the signals.
- [x] 2.4 Render the PAT disclosure as **collapsed by default**. Users who only want OAuth should not see a giant "paste a token here" input dominating the card.
- [x] 2.5 Show a one-line hint inside the disclosure for Figma specifically: *"OAuth handles most files; a PAT covers files in workspaces your OAuth grant doesn't reach."*

## 3. Verification via Web UI (localhost:3000)

- [ ] 3.1 Save a Figma PAT via the new UI flow. Confirm a keychain row exists at `pat.figma` (`security find-generic-password -s "mi-dev-agent" -a "pat.figma"`). Confirm `_registry` keychain entry now contains `figma: 'pat'` *or* maintains both `figma: 'oauth'` and `pat.figma` separately, depending on registry semantics — verify which and document.
- [ ] 3.2 Restart the backend. On startup, the log should show the `[token-manager] initFromStore` activity for PAT entries. After startup, `process.env.FIGMA_TOKEN` should be set inside the backend (verifiable indirectly: clicking Test → "Figma connected via PAT" if you also disconnect OAuth).
- [ ] 3.3 Run a synthetic ticket whose description references a Figma file in a workspace not covered by the OAuth grant (the AUT-7218 GST design). Confirm: (a) `Connector OK [figma]: <title>` instead of 403, (b) the OAuth-first/PAT-fallback path triggers (visible in `agent-.log` `[token-manager]` lines if we wire trigger logging there too — optional).
- [ ] 3.4 Click `[Remove]` on the PAT disclosure. Confirm the keychain row is gone and a subsequent Test on a cross-workspace file 403s again.
- [ ] 3.5 Verify backwards compat: with `FIGMA_TOKEN` in `.env` and no keychain PAT, the agent still works (existing path).

## 5. UX polish — auto-prompt + visible disclosure

Added in response to user feedback "we need to auto capture on figma verification and auto save why we are need to do it manually." Figma's API does **not** expose a way to programmatically create a PAT — the user must manually generate one at `figma.com/developers`. What we *can* do is make the prompt impossible to miss: bigger button + auto-open right after OAuth completes when no PAT is yet saved.

- [x] 5.1 In `ConnectorCard.tsx`, add `patAutoOpen?: boolean` prop. Initialize the existing `patExpanded` state from it on mount; if the prop flips to true later (e.g. OAuth just completed), open the disclosure unless the user has manually toggled it (tracked via `patUserToggled` state). Once the user clicks the toggle their choice wins permanently for that mount.
- [x] 5.2 In `ConnectorCard.tsx`, bump the `patToggle` button style: padding `sp-2 sp-3`, full-width, subtle elevated background, `text-secondary` color, 12px font, left-aligned. The previous styling (transparent, tertiary text, 11px) made the button look like incidental decoration. Reword label to lead with the chevron and a benefit-oriented caption ("▾ Use API token (covers cross-workspace files)" for OAuth providers, "▾ Set API token" for PAT-only).
- [x] 5.3 In `ConnectorsTab.tsx`, compute `patAutoOpen` for the Figma card: true iff `oauthInfo.oauthStatus === 'CONNECTED'` AND `!patAlreadyStored`. Pass through to `ConnectorCard`. Effect: the moment the user completes Figma OAuth the disclosure pops open showing the input + hint, so the user lands on the PAT step directly without hunting for the toggle.

**Note for follow-up changes:** a "proactive probe" approach (post-OAuth, hit a known file to detect 403, only auto-prompt when access is actually limited) was considered and rejected — Figma exposes no general "list my files" or "test full access" endpoint, so there's no reliable file to probe with just the user identity. Instead a future change could record agent-side 403s in a per-connector `needsAttention` flag and surface that via SSE to drive the prompt only when truly needed. For now, always-prompting after Figma OAuth is the right tradeoff: zero false negatives, false positives cost only a glance.

## 4. Documentation + rollout

- [ ] 4.1 Update `oauth-connectors/design.md` with a brief note pointing readers at this change for the PAT-in-keychain story.
- [ ] 4.2 Archive once tasks 1–3 are done via the standard openspec archive flow.
