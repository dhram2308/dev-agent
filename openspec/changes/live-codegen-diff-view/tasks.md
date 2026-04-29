# Tasks: Live Codegen Diff View

## Phase 1: Backend — `runAgentsTeam` Live Poller

- [x] 1.1 In `packages/agent/src/lib/agents-team.ts`, import `broadcast` from `../server/sse` (lazy-require inside the function to avoid circular-dep if needed — follow the pattern used in `server/sse.ts:193` for `agent-process`)
- [x] 1.2 Import `localGetChanges` and `localGetOriginal` from `./local-repo`
- [x] 1.3 Import `TICKET` from `./config`
- [x] 1.4 Add module constants: `LIVE_TICK_MS = 1500`, `MAX_FILES_LIVE = 40`, `MAX_FILE_BYTES_LIVE = 200_000`
- [x] 1.5 Inside `runAgentsTeam`, between the `_active_agents` save (line ~97) and the `pending.map(...)` call, detect `hasCwd = pending.some(a => a.opts?.cwd)` and capture `cwd = pending.find(a => a.opts?.cwd)?.opts?.cwd`
- [x] 1.6 If `hasCwd`, start `setInterval` loop that:
  - Calls `localGetChanges(cwd)`, caps at `MAX_FILES_LIVE`
  - For each `update` change, fetches `localGetOriginal(cwd, path)` into `originals`
  - For each change with `content`, truncates at `MAX_FILE_BYTES_LIVE` and records in `truncated.bytes` if truncated
  - Computes `hash = simpleHash(changes.map(c => [c.file_path, c.action, c.content?.length]).join('|'))`
  - If `hash !== lastHash`, calls `broadcast('codegen:live', payload)` where payload matches `CodegenLivePayload` in design.md
  - Calls `.unref()` on the interval so it never blocks process exit
- [x] 1.7 Wrap the `Promise.allSettled(promises)` + remainder of Phase 2 in `try { … } finally { if (poller) clearInterval(poller); if (hasCwd) broadcast('codegen:live-stop', { ticket, team, outcome, ts }) }`
- [x] 1.8 Compute `outcome = failures.length === 0 ? 'success' : 'failure'` for the stop broadcast (after Phase 3 check)
- [x] 1.9 Add a `simpleHash(str)` helper at module scope — use a small xor/rolling hash, no crypto dep
- [x] 1.10 Wrap `localGetChanges` / `localGetOriginal` calls in try/catch inside the interval — on error, `logDebug` and skip that tick (do NOT stop the poller)

## Phase 2: Backend — Snapshot Endpoint (for UI first-mount hydration)

- [x] 2.1 In `packages/agent/src/server/routes.ts`, add handler for `GET /api/codegen/live?ticket=…`
- [x] 2.2 Validate ticket via existing `safeTicket()`
- [x] 2.3 Resolve `state = getState(ticket)`; return `{ live: false }` if no state, or if `state.stage !== 'generate_code'`, or if no active agents
- [x] 2.4 If `cfg.localRepo` is null, return `{ live: false, reason: 'no_local_repo' }`
- [x] 2.5 Build the same `{ changes, original_files, activeAgents, team, ticket, ts }` payload as the SSE tick (extract the builder into a shared helper in `agents-team.ts` that takes `(cwd, ticket, team, activeAgents)` and returns the payload; import it in routes.ts)
- [x] 2.6 Return `{ live: true, ...payload }`
- [x] 2.7 Cap / truncate identically to the SSE tick (re-use the same helper)

## Phase 3: Shared Types

- [x] 3.1 In `packages/shared/src/types` (wherever `SseMessage` and `SseLogEntry` live), add:
  - `CodegenLivePayload` with fields from design.md §Data Shape
  - `CodegenLiveStopPayload` with fields from design.md §Data Shape
- [x] 3.2 Export both from the shared barrel
- [x] 3.3 Import types in `agents-team.ts` for the `broadcast` payload (no runtime effect, just type safety)

## Phase 4: Frontend — Store

- [x] 4.1 Create `packages/frontend/src/store/codegenLive.ts` with zustand store:
  - State: `liveByTicket: Map<string, LiveEntry>` where `LiveEntry = { team, activeAgents, changes, original_files, lastTs, stale: boolean }`
  - Actions: `setLive(ticket, patch)`, `markStale(ticket)`, `clearLive(ticket)`
  - Selector hooks: `useLiveForTicket(ticket)`, `useIsLive(ticket)`
- [x] 4.2 In the SSE connection layer (wherever the `EventSource` is created — likely `packages/frontend/src/lib/sse.ts` or similar), register listeners for `codegen:live` and `codegen:live-stop` events
- [x] 4.3 `codegen:live` handler: call `setLive(payload.ticket, payload)`, reset `stale: false`
- [x] 4.4 `codegen:live-stop` handler: call `markStale(payload.ticket)`
- [x] 4.5 On ticket stage transition to `gate_code_review` (observed via pipeline store subscription), call `clearLive(ticket)`
- [x] 4.6 On active-ticket change, call `/api/codegen/live?ticket=…` to hydrate (only if the current `liveByTicket[ticket]` is absent and stage is `generate_code`)

## Phase 5: Frontend — DiffViewer Source Routing

- [x] 5.1 In `packages/frontend/src/components/review/DiffViewer.tsx`, add optional props `source?: 'live' | 'frozen'` (default `'frozen'`) and `liveData?: LiveEntry`
- [x] 5.2 When `source === 'live'`, read `{ changes, original_files }` from `liveData` instead of `/api/review`
- [x] 5.3 When `source === 'live'`:
  - Render a `● LIVE` pulsing badge in the toolbar
  - Render a chip list of `activeAgents`
  - Hide the inline-comment form (read-only during codegen)
  - Hide approve/reject buttons (no gate active)
- [x] 5.4 When `source === 'live'` and `liveData.stale === true`, replace the pulsing badge with a neutral "Codegen complete — waiting for review gate" state (still read-only)
- [x] 5.5 Ensure `FileTree`, `DiffPane`, `DiffStatsBar`, and `PlanTabs` receive the same props in both modes — no conditional branching below this level

## Phase 6: Frontend — App Routing

- [x] 6.1 In `packages/frontend/src/App.tsx`, update the main panel switch:
  - If active ticket `stage === 'generate_code'` AND `useLiveForTicket(ticket)` returns a non-empty entry → render `<DiffViewer source="live" liveData={...} />` in the same slot the review `DiffViewer` uses
  - Else fall back to existing `WriteCodeDetail` + other generate-code panels
  - When `stage ∈ { gate_code_review, deploy_qa, … }` → continue to use existing frozen `DiffViewer` (unchanged)
- [x] 6.2 Verify `WriteCodeDetail` still renders alongside the live diff in `generate_code` (checkpoint progress tiles remain visible)

## Phase 7: Testing

- [x] 7.1 Unit test `simpleHash` stability (same input → same hash; different → different)
- [x] 7.2 Unit test the payload-builder helper: takes a fixture tmp git repo with known changes, returns the expected `{ changes, original_files, … }` shape with caps applied
- [ ] 7.3 Integration: mock `callClaude` with a function that writes 3 files to a tmp git repo and sleeps 5 s; run `runAgentsTeam` with one agent that has `opts.cwd`; assert:
  - At least 2 distinct `codegen:live` broadcasts were emitted
  - Exactly one `codegen:live-stop` broadcast was emitted
  - `outcome: 'success'`
  - De-duped broadcasts are absent (no duplicate consecutive hashes)
- [ ] 7.4 Integration: same as above but with an agent that throws; assert `codegen:live-stop` has `outcome: 'failure'` and poller was cleaned up
- [ ] 7.5 Integration: a team where NO agent has `opts.cwd` → assert zero `codegen:live` broadcasts
- [~] 7.6 Regression: run existing `agents-team-backbone` suite — no failures  _(N/A — `packages/agent/tests/` was empty; no prior suite existed for this package. This change adds the first test file under `packages/agent`.)_
- [ ] 7.7 Manual: start the pipeline on a real ticket, open the Web UI, confirm file list grows and diffs update during codegen, and confirm no flicker on transition to `gate_code_review`

### Bugfix discovered during testing

- [x] 7.8 Fix `localGetChanges` stripping the leading space of the first porcelain line. `.trim()` on the full `git status --porcelain` output ate the worktree-column space on line 1 (e.g. `" M path"` → `"M path"`), which offsets the downstream `substring(3)` path parse. Replaced with `.replace(/\n+$/, "")` so per-line leading spaces are preserved. This bug silently corrupted the first unstaged-modified path in every `localGetChanges` call; live poller would have inherited the same breakage.

## Phase 8: Docs

- [x] 8.1 Update `memory/` (or CLAUDE.md) pointer to mention the live-codegen diff view + where the poller lives
- [x] 8.2 Add a paragraph to `webui-diff-viewer.md` (referenced in MEMORY.md) explaining the two sources (live / frozen) and the transition
- [ ] 8.3 Archive this change via OpenSpec after Phase 7 manual sign-off
