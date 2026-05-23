## Why

The Postman connector is the one connector in this codebase with no OAuth alternative — Postman as a provider does not offer OAuth (see `oauth-connectors` proposal non-goals). To use it, a user must paste a `POSTMAN_API_KEY` somewhere. There are two places this could happen:

1. `start.sh` bootstrap — but that script only prompts for `ANTHROPIC_API_KEY`, `JIRA_TOKEN`, `JIRA_EMAIL`, `GITLAB_TOKEN`, `SLACK_WEBHOOK`. Postman is never mentioned.
2. The Settings → Connectors → Postman card — where the field exists but is labeled with a `FROZEN` badge.

The `FROZEN` badge is purely cosmetic in `ConfigField.tsx` — the input is still editable. But the badge signals "this is bootstrapped once and should not be edited from the UI", which is the convention for credentials handled by `start.sh` (Jira / GitLab / Slack / etc.). Postman fits **neither** half of that convention: it isn't bootstrapped by `start.sh`, and it has no OAuth flow either. Users who try to use Postman from a Jira ticket today see a `Skipping unfetchable` log line, look in Settings, and find a field that looks read-only.

## What Changes

- **MODIFIED**: `packages/frontend/src/store/settings.ts` — flip `POSTMAN_API_KEY` from `frozen: true` to `frozen: false` in the Postman connector field array (line 384). Update the description to point users at where they can obtain a key (`https://www.postman.com/settings/me/api-keys`).
- **PRESERVED**: All other connector credential fields keep `frozen: true`. They have either OAuth alternatives (Figma, Google Drive, GitLab) or are bootstrapped by `start.sh` (Jira, Slack), so the FROZEN convention still holds.
- **PRESERVED**: `POSTMAN_API_KEY` remains `sensitive: true` (rendered as a password input with show/hide).
- **PRESERVED**: `POSTMAN_ENABLED` toggle is unchanged — users still need to flip it on.

**Explicit non-goals:**

- Revisiting the FROZEN convention for other connectors. That is a separate broader UX discussion.
- Building an OAuth flow for Postman. Postman doesn't offer one.
- Auto-enabling `POSTMAN_ENABLED` when an API key is saved. Decision 11 of `oauth-connectors` already addresses the "connect implies use" question for OAuth providers; Postman is API-key only and the symmetric auto-enable would be magic without comparable signal-of-intent.

## Impact

**Affected code**

- `packages/frontend/src/store/settings.ts:384` — single field-descriptor edit. No new types, no schema change, no backend route change. The save flow (`POST /api/config/save` → atomic `.env` write) already supports the field; only the UI cue changes.

**No new dependencies. No new persisted files. No new env variables.**

**Backwards compatibility**

- Users who already set `POSTMAN_API_KEY` in `.env` see no change.
- Users who relied on the FROZEN badge as documentation lose that signal — replaced by clearer description text. No persisted state changes.

**Out of scope but worth noting**

- The Postman connector is still gated by `POSTMAN_ENABLED` (default `false`). Decision 11 of `oauth-connectors` does not auto-enable Postman because there is no OAuth-token signal of intent. Users must still explicitly toggle the boolean. That two-step (paste key + flip toggle) is acceptable because the "paste key" step is itself the signal of intent — symmetric to "complete OAuth" in Decision 11.
