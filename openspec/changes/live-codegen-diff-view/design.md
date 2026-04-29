# Design: Live Codegen Diff View

## Context

`stageGenerateCode` calls `runAgentsTeam` (inside `generate-code/developer.ts`) with either:
- **Parallel mode** — 2–5 Developer agents, each with disjoint `files` ownership, all sharing `opts.cwd = cfg.localRepo`
- **Single mode** — one Developer agent via `runSingleAgent` → `runAgentsTeam` with `opts.cwd = cfg.localRepo`

Either way, the agent(s) use Claude's Write/Edit tools to mutate files on disk in `cfg.localRepo` as they work. The existing `localGetChanges(cwd)` and `localGetOriginal(cwd, path)` are the exact helpers the diff viewer's data pipeline already uses *after* codegen (see `generate-code/index.ts:178–185`).

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  runAgentsTeam({ teamName, agents, state, merge })                    │
│                                                                        │
│  Phase 1: checkpoint replay (unchanged)                                │
│  Phase 2: pending agents run in parallel                               │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  NEW — start live poller                                      │    │
│  │    hasCwd = pending.some(a => a.opts?.cwd)                    │    │
│  │    if (hasCwd) {                                              │    │
│  │      const cwd = first agent with opts.cwd                    │    │
│  │      let lastHash = ''                                        │    │
│  │      poller = setInterval(() => {                             │    │
│  │        try {                                                  │    │
│  │          const changes = localGetChanges(cwd).slice(0, 40)   │    │
│  │          const originals = {}                                 │    │
│  │          for (c of changes if c.action==='update')            │    │
│  │            originals[c.file_path] = localGetOriginal(cwd, …) │    │
│  │          const payload = {                                    │    │
│  │            ticket: TICKET,                                    │    │
│  │            team: teamName,                                    │    │
│  │            activeAgents: state.data._active_agents || [],     │    │
│  │            changes, original_files: originals,                │    │
│  │            ts: Date.now(),                                    │    │
│  │          }                                                    │    │
│  │          const hash = cheapHash(changes)                      │    │
│  │          if (hash !== lastHash) {                             │    │
│  │            lastHash = hash                                    │    │
│  │            broadcast('codegen:live', payload)                 │    │
│  │          }                                                    │    │
│  │        } catch (e) { logDebug(`[${teamName}] live poll: ${e.message}`) }│
│  │      }, 1500)                                                 │    │
│  │      poller.unref()                                           │    │
│  │    }                                                          │    │
│  │                                                               │    │
│  │    await Promise.allSettled(promises)                         │    │
│  │                                                               │    │
│  │  } finally {                                                  │    │
│  │    if (poller) clearInterval(poller)                          │    │
│  │    if (hasCwd) broadcast('codegen:live-stop', { ticket, team })│   │
│  │  }                                                            │    │
│  └──────────────────────────────────────────────────────────────┘    │
│  Phase 3–5: validate / summary / merge (unchanged)                    │
└───────────────────────────────────────────────────────────────────────┘

                              SSE
                               │
                               ▼
┌───────────────────────────────────────────────────────────────────────┐
│  UI — packages/frontend                                                │
│                                                                        │
│  New zustand slice `useCodegenLiveStore`:                              │
│    liveByTicket: Map<ticket, {                                         │
│      team, activeAgents,                                               │
│      changes, original_files,                                          │
│      lastTs, stale: boolean                                            │
│    }>                                                                  │
│    onSse('codegen:live', patch)    → set/update slice                  │
│    onSse('codegen:live-stop', …)   → set stale=true                    │
│                                                                        │
│  DiffViewer gains a `source: 'live' | 'frozen'` prop:                  │
│    • 'live'   → reads from useCodegenLiveStore                         │
│    • 'frozen' → reads from /api/review (existing)                      │
│    • common data shape → same DiffPane + FileTree                      │
│                                                                        │
│  Routing in App.tsx:                                                   │
│    if (stage === 'generate_code' && liveReview)    → <DiffViewer src="live"/> │
│    else if (stage ∈ REVIEW_STAGES && reviewData)   → <DiffViewer src="frozen"/>│
│    else → current WriteCodeDetail / other panels                       │
└───────────────────────────────────────────────────────────────────────┘
```

## Key Decisions

### D1 — Poller lives in `runAgentsTeam`, not in `developer.ts`

**Why:** The user asked to "use agents-team". This also:
- Keeps the live-diff feature automatic for any future team that writes files (e.g. AC fixer, browser fixer — these today use `runSingleAgent` which flows through `runAgentsTeam`)
- Avoids duplicating poller start/stop in each code-writing caller
- Co-locates the lifecycle with the `_active_agents` tracking already in `runAgentsTeam`

**Trade-off accepted:** Teams that happen to pass `opts.cwd` without expecting live broadcasts get them anyway. Harmless — the only consumer is the UI, which ignores them outside `generate_code` (or renders them in a future live-review capability).

### D2 — Opt-in by `opts.cwd` presence (not a new flag)

**Why:** Every agent that writes files already has `opts.cwd` set (it's how Claude's Write/Edit tools target a directory). Teams that don't write files (Reviewer, Security) don't set `cwd`. The signal is free.

**Alternative considered:** `liveFileWatch: true` team flag. Rejected as redundant — a team without `cwd` has nothing to poll.

### D3 — Git polling, not `fs.watch` or stream-json

**Why git poll:**
- Reuses `localGetChanges` / `localGetOriginal` — the exact same pipeline the frozen review uses. Guarantees shape parity, zero drift.
- Ignores transient vim swap, editor temp, tsc cache files naturally (git doesn't track them).
- Single source of truth for "what changed" across live and frozen.

**Why not `fs.watch`:**
- Platform quirks (macOS FSEvents coalescing, Linux inotify limits)
- Noisy events from non-source files
- Would need a separate ignore-list that duplicates `.gitignore`

**Why not stream-json:**
- Bigger rewrite of `_callClaudeOnce`
- Shows tool calls, not code — different product. Stream-json is the right answer for a future "live tool-call ticker" feature (see proposal's "Out of scope")

### D4 — 1500 ms tick interval

Balance of responsiveness vs git command overhead. `git status --porcelain` on a ~2000-file repo takes 50–150 ms; `git show HEAD:path` for 40 files ≈ 1–2 s worst case. A 1.5 s tick gives the previous tick time to complete before the next fires. De-dupe by content hash prevents redundant broadcasts when Claude is "thinking" between tool calls.

### D5 — Content-hash de-dupe

`cheapHash = JSON.stringify(changes.map(c => [c.file_path, c.action, c.content?.length]))` then hash (md5 or simple rolling). Avoid hashing file contents — length + path + action is a good proxy; rare false-dedupes are acceptable because the next tick will correct them.

### D6 — Payload caps

- `MAX_FILES_LIVE = 40` — if codegen produces >40 changed files, live view shows the first 40 and a "+N more" indicator (reuses existing `DiffStatsBar` pattern). Frozen review removes the cap.
- `MAX_FILE_BYTES_LIVE = 200_000` (per file) — truncate content > 200 KB with a marker; the viewer already handles truncated files at review time.

### D7 — UI data-source routing

The `DiffViewer` shell receives `{ changes, original_files, summary?, mode: 'live' | 'frozen', activeAgents? }`. Downstream (`FileTree`, `DiffPane`) is unchanged. The only visual difference in live mode:
- Toolbar: `● LIVE` red/green pulse badge + chip list of `activeAgents`
- Inline comments panel: hidden (can't comment on code that's still being written)
- Approve/Reject buttons: hidden (no gate active yet)

Transition `generate_code → gate_code_review`: UI keeps rendering the same component; the source flips from `live` to `frozen` when `/api/review` returns `changes`. Because both sources produce the same shape from the same git helpers, the visible diff is identical — no flicker.

### D8 — `/api/codegen/live` snapshot endpoint

When the UI mounts mid-codegen, it has missed prior `codegen:live` ticks (SSE replay buffer is global and capped). A stateless snapshot endpoint computes the current `{ changes, original_files }` on demand (just calls `localGetChanges` + `localGetOriginal` with the same caps). UI uses this to hydrate, then relies on SSE for updates.

**Alternative considered:** Store the latest live payload in `state.data._live_diff`. Rejected because the payload can be hundreds of KB and state is persisted per-tick — we'd be serializing it to disk unnecessarily.

### D9 — Lifecycle events

- `codegen:live` — diff payload (throttled, de-duped)
- `codegen:live-stop` — sent in the `finally` block when the team ends; carries `{ ticket, team, outcome: 'success' | 'failure' }`. UI marks `stale: true` and may remove the "● LIVE" badge pending the stage transition.

No explicit `codegen:live-start`: the first `codegen:live` event *is* the start signal.

### D10 — Parallel Developer Teams

When the Developer Team runs in parallel mode (5 agents), they share one `cfg.localRepo`. The poller sees the union of all five agents' changes as one diff. This is desirable — the user sees the whole codegen progress as a single live diff, not five separate ones. Per-agent attribution is out of scope (see proposal; would require stream-json).

## Data Shape

```ts
// broadcast('codegen:live', payload)
interface CodegenLivePayload {
  ticket: string;                                 // e.g. "AUT-8457"
  team: string;                                   // e.g. "Developer Team"
  activeAgents: string[];                         // from state.data._active_agents
  changes: Array<{
    action: 'create' | 'update' | 'delete';
    file_path: string;
    content?: string;                             // capped at MAX_FILE_BYTES_LIVE
  }>;                                             // capped at MAX_FILES_LIVE
  original_files: Record<string, string>;         // HEAD contents, same cap
  ts: number;                                     // Date.now()
  truncated?: { files?: number; bytes?: string[] };
}

// broadcast('codegen:live-stop', payload)
interface CodegenLiveStopPayload {
  ticket: string;
  team: string;
  outcome: 'success' | 'failure';
  ts: number;
}
```

## Risks & Edge Cases

- **Git lock contention.** `git status` is read-only and doesn't acquire `.git/index.lock`. Safe to run concurrently with the agents' Edit/Write (which never invoke git themselves). `localResetRepo` at the start of `developer.ts` runs *before* the team, so no overlap.
- **Poller starts before agents' first write.** First 1–2 ticks will see empty `changes`. Broadcast once (empty changes is a valid state — "no changes yet"), then de-dupe subsequent empty ticks.
- **Repo in detached-HEAD / dirty state from a previous run.** `developer.ts` calls `localResetRepo(cfg.localRepo)` first, so we start from a clean known state. Poller reflects only in-progress codegen work.
- **Subagent runs after team completes** (e.g. fixer in `reviewer.ts`). That's a separate `runSingleAgent` call with its own `opts.cwd`. It triggers its own poller lifecycle. UI sees two successive live sessions for the same stage — acceptable; each one refreshes the diff view.
- **Frontend store growth.** `liveByTicket` keeps one entry per ticket. When a ticket transitions to `gate_code_review`, the entry can be pruned (or left stale — it's bounded by ticket count which is bounded by concurrent pipeline slots).

## Testing Strategy

- **Unit**: a mock team with an agent that writes a test file to a tmp git repo; assert `broadcast` is called with correct payload shape and is de-duped when file is unchanged.
- **Integration**: run `stageGenerateCode` end-to-end with a no-op Claude stub that writes 3 files; assert SSE client receives ≥ 2 distinct `codegen:live` events and one `codegen:live-stop`.
- **Visual**: manual check on a real ticket — open UI, observe growing file list and diffs during codegen; verify no flicker on transition to `gate_code_review`.
- **Regression**: Reviewer Team (no `cwd`) does NOT emit `codegen:live` events; legacy mode (`cfg.localRepo` null) does NOT emit events.
