## Why

The `WriteCodeDetail` panel in the Web UI has seven tabs — Developer, Review, Build, Tests, Browser, AC, Create MR — but nowhere to see the **actual code changes** the developer agent produced. Users today wait until `gate_code_review` to click through to the `/review` page for a GitHub-style diff. During `generate_code` there is an always-on `LiveCodegenDiff` strip above the panel, but it is ambient and disappears once the pipeline moves past `generate_code`. The result: a user looking at the Write Code panel at any time — while running, after finishing but before the gate, or reviewing a cached ticket — cannot inspect the diff from within the panel, even though the `DiffViewer` component already renders GitHub-style diffs and the data (`state.data.codeChanges`) is already on disk.

## What Changes

- Add a new **"Changes"** tab to `WriteCodeDetail.tsx`, positioned between **Developer** and **Review**, rendering `DiffViewer` inline with a file list + split diff.
- Add a dedicated backend endpoint **`GET /api/changes?ticket=<id>`** returning `{ source, changes, summary, original_files, ts }`, where `source` is one of `live` / `state` / `git` / `none`, selected by the server based on the current state of the ticket.
- The Changes tab's data-source routing: during a running `generate_code` stage it reads from the existing `useCodegenLiveStore` (SSE-fed), otherwise it hydrates from `/api/changes`. This yields a durable surface that works across the entire lifecycle: pre-run, live, post-run, cached resume, and after `gate_code_review`.
- The existing always-on `LiveCodegenDiff` strip above `WriteCodeDetail` **remains unchanged** — the Changes tab is additive. While `generate_code` is running, both surfaces render (the strip is the ambient "it's happening" feel; the tab is the durable "I want to inspect file X" surface).
- Handle the zero-change / developer-refusal case gracefully: render an explanatory empty-state instead of an error.

## Capabilities

### New Capabilities
- `write-code-changes-view`: Structured per-ticket diff-viewing surface embedded in the `generate_code` stage card. Defines the new SSE-unaffected endpoint contract (`/api/changes`), its four source modes, and the frontend requirement that `WriteCodeDetail` renders a Changes tab driven by this data.

### Modified Capabilities
<!-- None — the existing DiffViewer component keeps its contract unchanged; /api/review is not modified. -->

## Impact

- **Affected code**:
  - `packages/agent/src/server/routes.ts` — add `/api/changes` handler right after `/api/review` (≈ line 345). Uses existing `getState()`, `safeTicket()`, and the same `/api/*` token auth applied upstream.
  - `packages/agent/src/lib/local-repo.ts` — reuse existing `localGetChanges()` / `localGetOriginal()`; no changes.
  - `packages/frontend/src/components/WriteCodeDetail.tsx` — add `{ key: 'changes', label: 'Changes' }` to `TABS`, extend `deriveTabStatus()` for the new key, render `<ChangesTab d={d} />` in the switch.
  - `packages/frontend/src/components/write-code/ChangesTab.tsx` (new) — thin wrapper that picks the data source (live store vs. `/api/changes`) and renders `<DiffViewer />`.
- **Affected pipeline stage**: `generate_code` only. Other stages continue to use the existing `/review` route and the current `/api/review` endpoint.
- **No state schema changes** — the endpoint reads existing `state.data.codeChanges` / `state.data.original_files`.
- **No SSE changes** — the live path continues to use `codegen:live`; the new endpoint is request/response only.
- **No changes to `DiffViewer`** — it already accepts `source: 'live' | 'frozen'` and a `liveData` prop; the new tab uses both modes as-is.
- **No external GitLab / Jira impact.**
