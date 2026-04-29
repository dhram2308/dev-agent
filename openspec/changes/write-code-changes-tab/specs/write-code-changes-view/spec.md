## ADDED Requirements

### Requirement: Expose a unified diff-data endpoint
The system SHALL expose `GET /api/changes?ticket=<id>` returning a JSON body `{ source, changes, summary, original_files, ts, reason? }` where:
- `source` is one of `"live" | "state" | "git" | "none"`,
- `changes` is an array of objects `{ file: string; action: 'added' | 'modified' | 'deleted' | 'renamed'; content?: string }`,
- `summary` is a (possibly empty) string,
- `original_files` is a `Record<string, string>` mapping file paths to their pre-change content,
- `ts` is a unix-millis timestamp,
- `reason` is an optional short string present only when `source === 'none'`.

The endpoint SHALL be served by the same HTTP server that serves `/api/review` (`packages/agent/src/server/routes.ts`) and SHALL inherit the existing `/api/*` authentication check.

#### Scenario: Missing ticket parameter
- **WHEN** a client calls `/api/changes` without a `ticket` query parameter
- **THEN** the server responds with HTTP 400 and JSON body `{ error: "Invalid ticket format" }`

#### Scenario: Unknown ticket
- **WHEN** a client calls `/api/changes?ticket=UNKNOWN-999` for a ticket with no state file
- **THEN** the server responds with HTTP 200 and body `{ source: "none", changes: [], summary: "", original_files: {}, ts: <now>, reason: "no_state" }`

#### Scenario: Invalid ticket format
- **WHEN** a client calls `/api/changes?ticket=not%2Fvalid`
- **THEN** the server responds with HTTP 400 and JSON body `{ error: "Invalid ticket format" }`, matching the behavior of `/api/review`

### Requirement: Select the best data source automatically
The `/api/changes` handler SHALL select `source` using this precedence, evaluated in order:

1. `"live"` — when `state.stage === 'generate_code'` AND `state.data._active_team` is set to a non-empty value. Payload is computed fresh by calling `localGetChanges(cfg.localRepo)` and populating `original_files` lazily via `localGetOriginal(cfg.localRepo, path)` for each changed file.
2. `"state"` — when rule 1 does not apply AND `state.data.codeChanges?.changes` exists with length > 0. Payload uses `state.data.codeChanges.changes`, `state.data.codeChanges.summary || ''`, and `state.data.original_files || {}`.
3. `"git"` — when rules 1 and 2 do not apply AND `cfg.localRepo` is non-null AND `localGetChanges(cfg.localRepo)` returns a non-empty array. Payload matches the shape of rule 1.
4. `"none"` — otherwise. Payload has `changes: []`, `summary: ''`, `original_files: {}`, and a `reason` string from the set `{ "no_state", "no_local_repo", "no_changes_yet" }`.

#### Scenario: Live run with active agents
- **WHEN** `state.stage === 'generate_code'` and `state.data._active_team === 'Developer Team'`
- **THEN** the response has `source: 'live'` and `changes` reflects the current filesystem state of `cfg.localRepo`

#### Scenario: Post-run, pre-gate
- **WHEN** `state.stage === 'generate_code'`, the stage is not running, and `state.data.codeChanges.changes.length === 5`
- **THEN** the response has `source: 'state'` and `changes.length === 5`, taken from `state.data.codeChanges.changes`

#### Scenario: Cached resume with git fallback
- **WHEN** `state.data.codeChanges` is absent or has an empty `changes` array, `cfg.localRepo` is set, and `git status --porcelain` in that directory returns two modified files
- **THEN** the response has `source: 'git'` and `changes.length === 2`

#### Scenario: Developer refusal — zero-change run
- **WHEN** `state.stage === 'generate_code'`, not running, `state.data.codeChanges` is absent, and `cfg.localRepo` is null
- **THEN** the response has `source: 'none'`, `changes: []`, and `reason: 'no_local_repo'`

### Requirement: Exclude sensitive and tooling files from `git` source
When `source === 'git'`, the endpoint SHALL filter out any `changes` entry whose `file` path matches the patterns `.env`, `.env.*`, `.api-token`, `.state-secret`, or `.debug`. The same filter SHALL NOT be applied to the `state` or `live` sources because those lists are produced by the agent and already exclude sensitive files.

#### Scenario: Sensitive files excluded from git source
- **WHEN** `source === 'git'` and `localGetChanges` returns entries for `.env.local` and `src/App.tsx`
- **THEN** the response `changes` contains only `src/App.tsx`

### Requirement: Render a Changes tab in the Write Code panel
The Web UI SHALL render a tab labeled `"Changes"` in `WriteCodeDetail.tsx`, positioned in the `TABS` array between the `"Developer"` and `"Review"` tabs. The tab content SHALL be rendered by a new component `ChangesTab` located at `packages/frontend/src/components/write-code/ChangesTab.tsx`.

`ChangesTab` SHALL render `<DiffViewer />` with data sourced as follows:
- When `ticketState.stage === 'generate_code' && ticketState.isRunning` AND the codegen-live store has an entry for the active ticket: pass `source='live'` and `liveData={…the store entry}`.
- Otherwise: call `GET /api/changes?ticket=<activeTicket>` on mount, on active-ticket change, on stage transition into/out of `generate_code`, and on arrival of a `codegen:live-stop` SSE event for the ticket. Pass `source='frozen'` and a new `frozenData` prop (see the next requirement) carrying the converted shape.

#### Scenario: Tab position
- **WHEN** `WriteCodeDetail` is rendered
- **THEN** its tab bar displays tabs in the exact order: `Developer`, `Changes`, `Review`, `Build`, `Tests`, `Browser`, `AC`, `Create MR`

#### Scenario: Live run renders from live store
- **WHEN** the ticket is on `generate_code`, `isRunning === true`, and the codegen-live store has 3 file changes for the ticket
- **THEN** the `<DiffViewer>` inside `ChangesTab` receives `source='live'` and `liveData` containing the 3 changes

#### Scenario: Post-run renders from endpoint
- **WHEN** the ticket is on `generate_code` and `isRunning === false` and `/api/changes` returns `source: 'state'` with 5 changes
- **THEN** the `<DiffViewer>` receives `source='frozen'` and `frozenData` containing the 5 changes

#### Scenario: Stage transition refetch
- **WHEN** the ticket transitions from `generate_code` to `gate_code_review`
- **THEN** `ChangesTab` calls `/api/changes` again to refresh data

### Requirement: Support injected frozen data in DiffViewer
`DiffViewer` SHALL accept an optional `frozenData?: ReviewData | null` prop. When `source === 'frozen'` and `frozenData` is non-null, `DiffViewer` SHALL render from that data and SHALL NOT perform its internal `/api/review` fetch. Callers that omit the prop retain today's behaviour (fetching `/api/review`).

#### Scenario: Injected frozen data bypasses /api/review
- **WHEN** `<DiffViewer source='frozen' frozenData={…}/>` is rendered
- **THEN** no network request to `/api/review` is initiated; the diff renders directly from the injected data

#### Scenario: Backward compatibility of existing /review page
- **WHEN** `<DiffViewer />` is rendered without any props by the existing `/review` page
- **THEN** the component's behaviour is unchanged from before this change; it fetches `/api/review` as before

### Requirement: Render explanatory empty states
The `ChangesTab` component SHALL render context-aware empty states instead of errors when no changes are available:

| Condition | Empty state copy |
|---|---|
| `source === 'none' && stage === 'generate_code' && isRunning === true` | `"Working… the developer agent has not produced any file changes yet."` |
| `source === 'none' && stage === 'generate_code' && isRunning === false` | `"No file changes — the developer agent returned a summary without modifying any files. See the Developer tab for the reasoning."` |
| `source === 'none' && stage !== 'generate_code'` (earlier stage) | `"No changes yet — the developer has not run yet."` |
| `source === 'none'` AND endpoint returned 500 or network error | `"Could not load changes."` with a small retry button |

#### Scenario: Developer refusal
- **WHEN** the ticket is on `generate_code`, not running, and `/api/changes` returns `source: 'none'` with `reason: 'no_local_repo'` or any other reason
- **THEN** `ChangesTab` renders the copy `"No file changes — the developer agent returned a summary without modifying any files. See the Developer tab for the reasoning."`

#### Scenario: Pre-run stage
- **WHEN** the ticket is on `explore_plan`
- **THEN** the Changes tab renders the copy `"No changes yet — the developer has not run yet."`

#### Scenario: Running with no files yet
- **WHEN** the ticket is on `generate_code`, running, and `/api/changes` returns `source: 'none'` (nothing written to disk yet)
- **THEN** `ChangesTab` renders the copy `"Working… the developer agent has not produced any file changes yet."`

### Requirement: Reflect tab state in the status dot
`deriveTabStatus()` in `WriteCodeDetail.tsx` SHALL compute the Changes tab's status using the following rules:

- `'in_progress'` — when `state.stage === 'generate_code'` AND `isRunning === true`.
- `'failed'` — when `state.data._codegen_failed === true`.
- `'done'` — when `state.stage` is past `generate_code` OR `state.data.codeChanges?.changes?.length > 0`.
- `'pending'` — otherwise.

#### Scenario: In-progress during live run
- **WHEN** `state.stage === 'generate_code'` and the stage is running
- **THEN** the Changes tab's status dot is `in_progress`

#### Scenario: Done after code review gate reached
- **WHEN** `state.stage === 'gate_code_review'`
- **THEN** the Changes tab's status dot is `done`

### Requirement: Preserve the existing LiveCodegenDiff surface
The existing `LiveCodegenDiff` component mounted by `App.tsx` above `WriteCodeDetail` SHALL remain rendered and functional. The Changes tab SHALL be purely additive: both surfaces MAY render simultaneously during an active `generate_code` run.

#### Scenario: Both surfaces render during a live run
- **WHEN** `state.stage === 'generate_code'` is running and the user is viewing the Changes tab
- **THEN** both the ambient `LiveCodegenDiff` strip above `WriteCodeDetail` and the `DiffViewer` inside the Changes tab are mounted and rendering the same underlying diff

### Requirement: Must not alter /api/review or DiffViewer's existing behavior
This change SHALL NOT modify the `/api/review` handler's branches, response shape, or authentication. This change SHALL NOT modify `DiffViewer`'s existing `'live'` or `'frozen'` rendering paths; its only permitted change is the addition of the optional `frozenData` prop defined in a separate requirement above.

#### Scenario: /api/review unchanged
- **WHEN** a client calls `/api/review?ticket=<id>` for a ticket whose stage is `gate_code_review`
- **THEN** the response shape and contents are identical to before this change
