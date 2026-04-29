## 1. Backend — `/api/changes` endpoint

- [x] 1.1 In `packages/agent/src/server/routes.ts`, add a new `if (url.pathname === "/api/changes")` branch placed immediately after the `/api/review` block (around current line 346). Use `safeTicket()` to validate the `ticket` query param; respond 400 with `{ error: "Invalid ticket format" }` when invalid — match the behavior of `/api/review`.
- [x] 1.2 Call `getState(ticket)`. If missing, respond 200 with `{ source: "none", changes: [], summary: "", original_files: {}, ts: Date.now(), reason: "no_state" }`.
- [x] 1.3 Implement the 4-way source selection exactly as specified in the design:
  1. `"live"` when `state.stage === 'generate_code'` AND `state.data._active_team` is truthy — call `localGetChanges(cfg.localRepo)` and lazily populate `original_files` using `localGetOriginal(cfg.localRepo, path)` for each changed file (mirror the logic already in `buildLiveSnapshot`).
  2. `"state"` when `state.data.codeChanges?.changes?.length > 0`.
  3. `"git"` when `cfg.localRepo` is non-null and `localGetChanges(cfg.localRepo)` returns a non-empty array.
  4. `"none"` otherwise, with `reason` chosen from `{ "no_state", "no_local_repo", "no_changes_yet" }` as appropriate.
- [x] 1.4 When `source === "git"`, filter out any `changes` entry whose `file` path matches the sensitive-file exclusion patterns already used by `localResetRepo` in `local-repo.ts:188`: `.env`, `.env.*`, `.api-token`, `.state-secret`, `.debug`. Do NOT apply this filter to the `"state"` or `"live"` sources.
- [x] 1.5 Serialize the response with `res.writeHead(200, { "Content-Type": "application/json" })` + `JSON.stringify(result)`. Wrap the handler in a try/catch; on error respond 500 with `{ source: "none", changes: [], summary: "", original_files: {}, ts: Date.now(), reason: "error", error: e.message.slice(0, 500) }`.
- [x] 1.6 Import any helpers not already in scope: `localGetChanges` and `localGetOriginal` from `../lib/local-repo`. `cfg` is likely already used via `require("../lib/config")` in the `/api/codegen/live` block — reuse that pattern.
- [x] 1.7 Verify the `/api/*` token check at `routes.ts:173` applies to the new route before the per-path branches; if a handler-local auth is needed, mirror `/api/codegen/live`.

## 2. Backend — tests

- [ ] 2.1 Add unit tests for `/api/changes` in `packages/agent/tests/` (create a new `routes-changes.test.ts` or append to an existing routes test file if one exists — grep `packages/agent/tests/` first). Cover all four source branches plus the 400 / unknown-ticket cases.
- [ ] 2.2 Test the sensitive-file filter for `source: "git"`: construct a `localGetChanges` mock that returns `[ { file: ".env.local", ... }, { file: "src/App.tsx", ... } ]`; assert the response `changes` has length 1.
- [ ] 2.3 Run `npx vitest run` under `packages/agent` and confirm all existing tests still pass.

## 3. Frontend — `DiffViewer` prop extension

- [x] 3.1 In `packages/frontend/src/components/review/DiffViewer.tsx`, add an optional `frozenData?: ReviewData | null` prop to `DiffViewerProps` (around line 222). Update the JSDoc to document both modes.
- [x] 3.2 In the component body at line 231, accept the new prop with default `null` and include it in the destructuring.
- [x] 3.3 In the `useEffect` that calls `fetchData()` (around line 280), add a guard: if `!isLive && frozenData !== null` → `setLoading(false); setError(null);` and skip the fetch. In the memo that picks `reviewData` (line 262), prefer `frozenData` over `frozenReviewData` when non-null.
- [x] 3.4 Verify the existing `/review` page (`ReviewPage` in `App.tsx`) renders `<DiffViewer />` without the new prop and still fetches `/api/review` as before. No regression expected.

## 4. Frontend — `ChangesTab` component

- [x] 4.1 Create `packages/frontend/src/components/write-code/ChangesTab.tsx`. Props: `{ d: Record<string, unknown> }` matching the other tab-content components; also read `useActiveTicketState()` + `usePipelineStore(s => s.activeTicket)` internally.
- [x] 4.2 Determine live-vs-frozen mode: `isLive = ticketState?.stage === 'generate_code' && ticketState.isRunning && useLiveForTicket(activeTicket) != null` (import from `../../store/codegenLive`).
- [x] 4.3 When `isLive`, render `<DiffViewer source="live" liveData={liveEntry} />`.
- [x] 4.4 When not live, fetch `/api/changes?ticket=<activeTicket>&token=<…>` with the same auth-token pattern used by `codegenLive.ts` hydration. Store the response in local `useState` as `{ source, changes, summary, original_files, reason }`. Convert it to `ReviewData` shape: `{ gate: 'gate_code_review', changes: changes.map(c => ({ file: c.file_path ?? c.file, action: c.action, content: c.content })) }` — check which field name the endpoint returns and align.
- [x] 4.5 Re-fetch when (a) component mounts, (b) `activeTicket` changes, (c) `ticketState?.stage` transitions into or out of `generate_code`, (d) an SSE `codegen:live-stop` event fires for this ticket. Listen by subscribing to `useCodegenLiveStore` (or a dedicated event) — mirror how `AgentSwimLanes` handles store-driven reactions.
- [x] 4.6 Render empty states per the spec: "Working…", "No file changes — Developer agent returned a summary without modifying…", "No changes yet", or retry-on-error. Key off `{ source, reason, stage, isRunning }`.
- [x] 4.7 When data is available, render `<DiffViewer source="frozen" frozenData={reviewData} />` inside a height-capped container (suggest `max-height: 70vh; overflow: auto`). Add a small "live" pill to the tab header when `source === 'live'` — gives the user a visual cue the diff is evolving.
- [x] 4.8 Match the styling of the other tabs in `WriteCodeDetail.tsx` (glass container, `--text-*`, `--glass-bg`, etc.).

## 5. Frontend — `WriteCodeDetail` wiring

- [x] 5.1 In `packages/frontend/src/components/WriteCodeDetail.tsx`, import `ChangesTab` from `./write-code/ChangesTab`.
- [x] 5.2 Extend `TabKey` type (near line 25) to include `'changes'`. Insert `{ key: 'changes', label: 'Changes' }` into the `TABS` array between `developer` and `review`.
- [x] 5.3 In `deriveTabStatus()` (around line 268), add a `case 'changes':` branch implementing the spec's status rules:
  - `'in_progress'` when `isGen` (already a parameter).
  - `'failed'` when `d._codegen_failed === true`.
  - `'done'` when the stage is past `generate_code` OR `(d.codeChanges as any)?.changes?.length > 0`.
  - `'pending'` otherwise.
- [x] 5.4 In the tab-content switch (around line 690), add `{activeTab === 'changes' && <ChangesTab d={d} />}` between the Developer and Review branches.
- [x] 5.5 Verify the default `activeTab` initial state logic doesn't need to change — it should still land on `'developer'` or whatever the current default is.

## 6. Frontend — tests

- [ ] 6.1 Add or extend a frontend test for `WriteCodeDetail.tsx` asserting the Changes tab appears at the expected position.
- [ ] 6.2 Add a frontend test for `ChangesTab.tsx` covering: live mode picks up store data; frozen mode fetches `/api/changes`; empty-state copy for each of the three `source === 'none'` reasons.
- [x] 6.3 Run `npx tsc --noEmit -p packages/frontend` — clean.
- [ ] 6.4 Run `npx vitest run` under `packages/frontend` — all pass.

## 7. Verification

- [ ] 7.1 Start the dev server and open the Web UI at `http://localhost:3000`. Pick a ticket currently in `generate_code` (or start one).
- [ ] 7.2 While the stage is running, click the new Changes tab. Confirm it renders the same diff as the ambient `LiveCodegenDiff` strip above. Confirm the "live" pill is visible.
- [ ] 7.3 Wait until `generate_code` completes but before the gate is posted (brief window). Refresh the page and click Changes — confirm the diff is still visible, and that the "live" pill is gone (source should now be `state`).
- [ ] 7.4 Navigate to a ticket already past `gate_code_review`. Confirm Changes shows the final diff from `/api/changes` → source `state`.
- [ ] 7.5 Trigger a developer-refusal scenario (ticket where the developer returns only text). Confirm Changes renders the empty-state copy: "No file changes — the developer agent returned a summary without modifying any files. See the Developer tab for the reasoning."
- [ ] 7.6 Reload a cached ticket with an intact local repo but no `state.data.codeChanges` — confirm source is `git` and the sensitive-file filter excludes any `.env`, `.api-token`, etc.
- [ ] 7.7 Confirm the existing `/review` page still renders unchanged (regression check for the `DiffViewer` prop change).
- [ ] 7.8 Confirm `LiveCodegenDiff` above `WriteCodeDetail` still renders during live runs.
