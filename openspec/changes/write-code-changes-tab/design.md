## Context

The `WriteCodeDetail` component (`packages/frontend/src/components/WriteCodeDetail.tsx`) is the primary stage panel during `generate_code`. It already has seven tabs driven by a `TABS` array (lines 25–32) and renders under the ambient `LiveCodegenDiff` strip mounted by `App.tsx:197-210`.

The codebase already has a complete GitHub-style diff renderer: `packages/frontend/src/components/review/DiffViewer.tsx`. It accepts a `source: 'live' | 'frozen'` prop:
- `'frozen'` fetches from `/api/review` which only returns `changes` when `stage` is one of `{ gate_code_review, deploy_qa, gate_preprod_approval, gate_dual_approval }` (see `routes.ts:298-342`).
- `'live'` receives a `liveData: LiveEntry` prop that the caller sources from `useCodegenLiveStore`.

Three real data shapes already exist for a ticket's file changes:
1. **Live snapshot** — `useCodegenLiveStore.liveByTicket` (SSE-fed by the `codegen:live` poller inside `runAgentsTeam`), already converted to `ReviewData` shape by the live branch of `DiffViewer`.
2. **Persisted summary** — `state.data.codeChanges: { changes: FileChange[]; summary?: string; test_notes?: string }` + `state.data.original_files: Record<string,string>`. Written by `stageGenerateCode` on success.
3. **Disk** — the local clone at `cfg.localRepo`. `packages/agent/src/lib/local-repo.ts` already exposes `localGetChanges(clonePath)` (parses `git status --porcelain` + `git diff --name-status`) and `localGetOriginal(clonePath, filePath)` (recovers the pre-change file content via `git show HEAD:path`).

The semantic gap: between "`generate_code` finished" and "gate posted" there is no HTTP route that serves `state.data.codeChanges`. A cached resume (same state file, same local repo) has the same problem. `DiffViewer` has the *renderer*; the *data plumbing* is missing for the Write Code stage specifically.

Constraints:
- Must not modify `DiffViewer` or `/api/review` (both are load-bearing for the existing `/review` page and `gate_code_review`).
- Must not change the SSE payloads (`codegen:live` and `agent:progress` are stable contracts).
- Must not alter `state.data.codeChanges` shape — callers of `getState()` / `/api/state` depend on it.
- No new runtime dependencies.

## Goals / Non-Goals

**Goals:**
- A user looking at the Write Code panel can click **Changes** and see a GitHub-style diff of what the developer agent produced, regardless of whether the stage is running, complete, cached-resumed, or already past the code-review gate.
- The tab works identically for a fresh live run and a ticket reloaded five minutes later — same component, same `DiffViewer`, routed through the right source automatically.
- Zero-change runs (developer refusal, empty diff) render an explanatory empty-state, not an error.
- Existing `LiveCodegenDiff` and `/review` flows are untouched.

**Non-Goals:**
- Replacing or re-architecting the always-on `LiveCodegenDiff` strip above `WriteCodeDetail`. It stays as-is.
- Extending `/api/review` to cover more stages. We add a *new* endpoint specifically to decouple the diff-data surface from the gate concept.
- Showing per-hunk inline comments, blame, or any functionality beyond `DiffViewer`'s existing capabilities.
- Surfacing tool-call trace, token usage, or cost. Those are separate proposals.

## Decisions

### 1. A new endpoint `/api/changes` rather than extending `/api/review`
The `/api/review` endpoint is semantically gate-oriented — it returns the `gate` field as its primary key and only populates `changes` for stages where the gate has been posted (see its explicit `state.stage === "gate_code_review" && d.code_mr_iid` branch at `routes.ts:315`). Overloading it to also serve `generate_code` would blur its contract. A new route makes the diff-data surface an orthogonal concern.

Response shape:
```ts
GET /api/changes?ticket=<id> → {
  source: 'live' | 'state' | 'git' | 'none',
  changes: Array<{ file: string; action: 'added' | 'modified' | 'deleted' | 'renamed'; content?: string }>,
  summary: string,
  original_files: Record<string, string>,
  ts: number,
  reason?: string   // present when source === 'none'
}
```

**Why:** A single endpoint abstracting three backing sources (live, state, git) is the minimum surface the frontend needs. It mirrors the shape `DiffViewer` already consumes for its frozen path, so the new Changes tab component is thin.

**Alternatives considered:** (a) widening `/api/review` — rejected, overloads an already gate-scoped route; (b) three separate endpoints for each source — rejected, pushes source-selection logic into the client where it doesn't belong.

### 2. Server-side source selection
The endpoint picks the source in this order:
1. If `state.stage === 'generate_code'` AND the ticket is in an active `runAgentsTeam` run (indicated by `state.data._active_team` being non-null, which is already set by the agents-team code path), return `source: 'live'` with a fresh snapshot computed via `localGetChanges(cfg.localRepo)` + a bounded set of originals via `localGetOriginal(...)`. This mirrors what the `codegen:live` poller sends over SSE — the two views stay consistent.
2. Else if `state.data.codeChanges?.changes?.length > 0`, return `source: 'state'` with `state.data.codeChanges.changes`, `state.data.codeChanges.summary || ''`, and `state.data.original_files || {}`.
3. Else if `cfg.localRepo` is set AND `localGetChanges(cfg.localRepo)` returns a non-empty array, return `source: 'git'` with that list plus lazily-computed originals (same mechanism used by `buildLiveSnapshot`).
4. Else return `source: 'none'` with `changes: []` and a `reason` such as `"no_state"`, `"no_local_repo"`, or `"no_changes_yet"` for the frontend to show contextual empty-state copy.

**Why:** The precedence reflects freshness and truth. A live run may be writing files *right now*, so always prefer the filesystem during a run. Post-run the persisted `codeChanges` is authoritative (it's what downstream stages also consume). Cached resumes without in-state `codeChanges` still benefit from the git fallback. And `'none'` is an explicit, renderable state rather than an error.

**Alternatives considered:** making the client pick — rejected, source selection depends on server-only facts (`cfg.localRepo`, `state.data._active_team`).

### 3. Frontend: thin `ChangesTab.tsx` wrapper, not a new viewer
The new tab component does three things: (a) read `useCodegenLiveStore` for the active ticket, (b) call `/api/changes` once on mount + whenever the ticket's stage transitions, (c) hand the resulting data to `<DiffViewer source={isLive ? 'live' : 'frozen'} liveData={...} />`. The frozen-mode render path is ambient: `DiffViewer` already fetches `/api/review` by default on the frozen path, but we need to override that for this tab. Two options:
- **3a (chosen):** extend `DiffViewer` with an optional `frozenData: ReviewData | null` prop that, when set, bypasses the internal `/api/review` fetch. This is a minimal, backward-compatible addition — old callers who don't pass the prop get today's behaviour.
- 3b (rejected): duplicate `DiffViewer`'s file-list + split-diff UI into `ChangesTab`. High maintenance cost.

**Why 3a:** The only change to `DiffViewer` is a single additional prop. It keeps the tab component under 80 lines.

### 4. Tab position and status dot
The tab sits between **Developer** and **Review** in the `TABS` array. Status dot logic in `deriveTabStatus()`:
- `done` — when `state.data.codeChanges?.changes?.length > 0` OR `state.stage` is past `generate_code`.
- `in_progress` — when `state.stage === 'generate_code' && isRunning`.
- `pending` — otherwise.
- `failed` — when `state.data._codegen_failed === true` (an existing flag — verify in `deriveTabStatus` source).

**Why:** Matches the visual grammar of the other tabs.

### 5. Ticket-change lifecycle
Because `/api/changes` is request/response (no SSE), the tab re-fetches on: (a) mount, (b) active-ticket change, (c) ticket-stage transition into or out of `generate_code` (avoids stale `state` data after advancement), (d) on the arrival of a `codegen:live-stop` event for this ticket (run just finished; state may now be authoritative). We do NOT poll — the existing `LiveCodegenDiff` above provides the continuous live ticker; the tab catches up on state transitions.

### 6. Empty-state copy (developer refusal)
When `source === 'none'` with `reason !== 'error'`, the tab renders:
> **No file changes**  
> The developer agent returned a summary without modifying any files. See the **Developer** tab for the reasoning.

When `stage` is earlier than `generate_code` (pre-run), render:
> **No changes yet**  
> The developer has not run yet.

Both are explanatory, not error-colored.

## Risks / Trade-offs

- **Two diff surfaces during a live run.** The ambient `LiveCodegenDiff` strip AND the Changes tab will both render the same data simultaneously while `generate_code` is running. This is intentional per the locked decision, but it may confuse users who expect one source of truth. Mitigation: the tab displays a small "live" pill next to the file count when `source === 'live'`, signaling it will evolve.
- **`/api/changes` adds a route to maintain.** Mitigation: the handler is ≤ 50 lines and reuses `getState`, `localGetChanges`, `localGetOriginal` — no new logic, just routing.
- **`DiffViewer`'s new `frozenData` prop is a minor public-surface change.** Mitigation: the prop is optional; absence preserves today's behaviour; documented in JSDoc.
- **Large diffs.** `DiffViewer` already handles tens of files and hundreds of hunks; the tab's container is height-capped with scroll. No additional work needed.
- **Auth.** The `/api/*` token check in `routes.ts` applies uniformly before the per-path branches. The new handler inherits it.

## Migration Plan

1. Ship backend `/api/changes` first (frontend can ignore unknown 200 responses). This is a pure add; nothing else is touched.
2. Ship the optional `frozenData` prop on `DiffViewer`. No caller changes.
3. Ship `ChangesTab.tsx` and the `TABS` entry + `deriveTabStatus` extension in one frontend PR.
4. Rollback: revert the `TABS` entry. The endpoint and the prop become dead code but harmless.

## Open Questions

- When `source === 'git'` and the local repo has unrelated uncommitted junk (e.g. IDE artifacts, `.state-secret`), the endpoint may return non-signal changes. The same `-e` exclusions used by `localResetRepo` in `local-repo.ts:188` should be applied here too — worth flagging in the task list to add a filter. (Current lean: filter `.env`, `.env.*`, `.api-token`, `.state-secret`, `.debug` at the endpoint level.)
- Should the empty-state for `source === 'none' && stage === 'generate_code' && isRunning` say "working…" instead of "no changes yet"? Lean: yes, that's a better live affordance. Decide during apply.
