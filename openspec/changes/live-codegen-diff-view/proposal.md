# Proposal: Live Codegen Diff View (via agents-team)

## Problem

During `stageGenerateCode`, the Developer Agent runs for 5–15 minutes writing files directly to `cfg.localRepo` via Claude's Write/Edit tools. The Web UI shows only a yellow "Running…" dot in `WriteCodeDetail > Developer`. The user has no visibility into which files are being touched or what the code looks like *until the whole stage finishes* and the `gate_code_review` screen opens.

The GitHub-style diff viewer (`DiffViewer` + `FileTree` + `DiffPane`) already exists and already renders from `{ changes, original_files }`. The data it needs **also already exists on disk** — the agent is writing it in real time. We just aren't reading it until the agent is done.

## Solution

Make `runAgentsTeam()` the single place that observes and broadcasts live file changes. When any agent in the team has `opts.cwd` set (i.e. it writes files), the team starts a lightweight git-poll loop that:

1. Runs `localGetChanges(cwd)` every 1500 ms
2. Fetches `localGetOriginal(cwd, path)` for each updated file
3. Broadcasts a new SSE event `codegen:live` with `{ ticket, team, activeAgents, changes, original_files, ts }`
4. De-dupes by content hash — no broadcast if the changeset is unchanged since last tick
5. Stops on team completion (success, failure, or error)

The existing `DiffViewer` is re-pointed to accept a **live source** (from SSE) during `generate_code`, and falls back to the existing `/api/review` data during `gate_code_review` and later. Same component, same controls, same keybindings — just a different data source per stage.

### What Changes

| Layer | Change |
|-------|--------|
| `packages/agent/src/lib/agents-team.ts` | Start/stop live-diff poller around Phase 2 when any agent has `opts.cwd` |
| `packages/agent/src/lib/local-repo.ts` | No change — `localGetChanges` + `localGetOriginal` already exist |
| `packages/agent/src/server/sse.ts` | No change — `broadcast()` supports arbitrary event names |
| `packages/agent/src/server/routes.ts` | Optional `GET /api/codegen/live?ticket=…` fallback for UI on first mount (before first SSE tick arrives) |
| `packages/frontend/src/store/pipeline.ts` (or new `codegenLive.ts`) | Subscribe to `codegen:live` SSE events; store `liveReview` per ticket |
| `packages/frontend/src/components/review/DiffViewer.tsx` | Accept `source: 'live' \| 'frozen'` prop; select data accordingly; render a "● LIVE" badge + active-agent chips in live mode |
| `packages/frontend/src/App.tsx` | Mount `DiffViewer` during `generate_code` when `liveReview` exists (same pane as gate review) |

### What Doesn't Change

- `callClaude()` and the CLI output format (`--output-format text`) — untouched
- The agent prompt layer — untouched
- `/api/review` — still authoritative for frozen review at `gate_code_review`
- The existing 3 `runAgentsTeam` callers (explore-plan, developer, reviewer) continue to work; only Developer currently passes `opts.cwd`, so only it triggers the poller — same behavior for the rest
- The `WriteCodeDetail` panel's tab structure and checkpoint fields

## Scope

- **In scope**: git-poll loop inside `runAgentsTeam`, new `codegen:live` SSE event, UI live-source routing for `DiffViewer`, live toolbar badge
- **Out of scope**: streaming Claude tool calls (Read/Grep events), stream-json output format, per-agent file attribution, inline token streaming, file-watcher (`fs.watch`/`chokidar`), legacy JSON codegen mode (no `cwd`)

## Risks

| Risk | Mitigation |
|------|------------|
| Poller fires while Claude is mid-write → corrupt snapshot | `git status` + `git show HEAD:path` only read committed + working-tree-at-tick state; a half-written file is a self-consistent text blob at the instant `execFileSync` runs. Worst case: one tick shows an intermediate string that the next tick corrects. |
| Bandwidth: full payload every 1.5 s × 5 files × 6 KB ≈ 20 KB/s | Content-hash de-dupe: no broadcast when unchanged. Cap `MAX_FILES_LIVE = 40` and `MAX_FILE_BYTES_LIVE = 200_000` in the broadcast (UI can expand on demand via `/api/review` or a future endpoint). |
| `git status` contention with a parallel `git` call elsewhere | `localGetChanges` already uses `execFileSync` with a 15 s timeout and is called post-agent anyway. Concurrent invocations are safe — git locks only writes. |
| Poller leaks on unhandled team error | `try { … } finally { clearInterval; broadcast codegen:live-stop }`. The team's existing Phase 4 (`state.data._active_agents = []`) is the same reset window. |
| Multiple teams run concurrently for the same repo (shouldn't happen, but defensively) | Key live-state by `teamName` so broadcasts are distinguishable; UI keeps a per-team map and merges by file path (last write wins). |
| First mount after stage starts misses earlier ticks | Optional `GET /api/codegen/live?ticket=…` returns the *current* `{ changes, original_files }` snapshot computed on-demand from `cfg.localRepo`. UI calls this once on mount; SSE patches from there. |
| `_active_agents` already exists — conceptual overlap | `_active_agents` is a name list for the tab indicator. `codegen:live` carries the actual diff payload. They are complementary, not duplicative. |

## Success Criteria

1. While the Developer Team runs on AUT-XXXX, the user can open the UI and see the file list + diffs growing, updating at roughly 1.5 s cadence.
2. On transition from `generate_code` → `gate_code_review`, the viewer does not flicker: the live data and `/api/review` data show the same files and diffs.
3. When `cfg.localRepo` is null (legacy mode), no `codegen:live` events are emitted and the UI falls back to the old "Running…" indicator — no regression.
4. Reviewer/Security/Fixer teams (which don't write files) do not trigger the poller even though they go through `runAgentsTeam` — opt-in is by `opts.cwd` presence on at least one agent.
5. A 15-minute Developer Agent run produces no more than ~600 SSE events (one per 1.5 s), of which the vast majority are de-duped and not sent.
