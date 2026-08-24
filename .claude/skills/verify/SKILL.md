---
name: verify
description: Drive the running MI Dev Agent app (frontend + backend) to observe a change's actual runtime behavior.
---

# Verifying this repo

Dev servers are usually already running (`task status` to check; `task start` to launch). Frontend on :5173, backend (API only) on :3000. Frontend proxies `/api/*` to the backend.

## Gotcha: cross-package changes need a manual rebuild

The backend imports agent-package code from **compiled dist**, not source:
`packages/backend/src/server/routes.ts` does `require('../../../agent/dist/lib/config-schema')`.
`tsx watch` on `packages/backend/dev-boot.js` only recompiles backend TS on save — it does **not** rebuild `packages/agent`. So editing anything under `packages/agent/src/**` (config-schema.ts, health-monitor.ts, stages/*.ts, server/agent-process.ts, etc.) has **zero effect on the running backend** until you:

```bash
npm run build:agent
task restart-backend
```

Confirm the backend actually picked it up: `.run/backend.log`'s `[ConfigWatcher] Watching N hot-reloadable config keys` line — N changes when a config-schema.ts edit lands. Also directly diff `packages/agent/dist/lib/config-schema.js` against the source you edited if in doubt.

Frontend-only changes (`packages/frontend/src/**`) hot-reload via Vite automatically — no rebuild needed.

## Getting a browser handle

No `@playwright/test` project dependency, but `npx playwright install` has already cached a Chromium binary once (check `~/Library/Caches/ms-playwright/`) and the `playwright` package itself is npx-cached, not in this repo's `node_modules`. Find it and require by absolute path:

```bash
find ~/.npm/_npx -maxdepth 4 -iname playwright -type d
```

```js
const { chromium } = require('/absolute/path/to/_npx/<hash>/node_modules/playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
```

`npx playwright install chromium` prints a "run npm install first" warning and exits 0 without downloading if a cached browser already satisfies it — that's not a failure, just check the cache directory first.

## Navigating the app

- Left sidebar: Dashboard / Settings / Review / Playground nav, plus a ticket list (paused tickets show a colored dot + "Xd ago").
- Settings has 4 sub-tabs rendered as `<button>` elements at the top of the page: Configuration, Notifications, Connectors, Automation. `getByRole('button', { name: 'Automation' })` can flake (timed out in testing even when visible) — prefer `page.locator('text="Automation"').last().click()` (exact-text match; `.last()` skips the tab-icon `<div>` that also matches non-exact `text=Automation`).
- A **paused** ticket clicked from the sidebar shows `ResumeDialog` (Resume/Start Fresh/Delete), not the live pipeline view — `GateApproval`/`StuckPopup`/stage panels only mount for an actively **running** ticket. You cannot observe those without a real running pipeline (needs live Jira/GitLab credentials this environment doesn't have).
- Automation tab fields use `aria-label` matching their visible label exactly (e.g. `select[aria-label="Development Mode"]`, `select[aria-label="Pre-Prod Gate"]`) — reliable, prefer over text matching for form controls.

## Verifying config changes end-to-end

`GET /api/config` returns the full `CONFIG_SCHEMA` (agent package) key set with current values — the fastest way to confirm a new schema key exists and check its default, no browser needed:

```bash
TOKEN=$(cat .run/api-token)
curl -s http://localhost:3000/api/config -H "X-Api-Token: $TOKEN" | python3 -m json.tool
```

To confirm a Settings-tab save round-trips through the real backend (not just client state): change a field, click Save, wait for the toast, then reload the page and re-read the field — a client-state-only bug would still show the old value disappearing on refresh.

**Leave the environment as you found it** — if you change and save a real config value while verifying (e.g. `AUTO_APPROVE_*` gate policies), revert it and save again before finishing. These are live values other work in the session may depend on.

## `/api/state` needs a ticket param but not a real one

`GET /api/state?ticket=AUT-0000` returns a clean `{running: false, state: null, ...}` shape for any syntactically valid, non-existent ticket — good for checking response shape without needing a real pipeline.
