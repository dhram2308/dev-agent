## ADDED Requirements

### Requirement: Live-codegen store
The frontend SHALL provide a zustand store at `packages/frontend/src/store/codegenLive.ts` holding a `liveByTicket: Map<string, LiveEntry>` where `LiveEntry = { team: string; activeAgents: string[]; changes: ChangeEntry[]; original_files: Record<string,string>; lastTs: number; stale: boolean }`.

The store SHALL export actions `setLive(ticket, patch)`, `markStale(ticket)`, `clearLive(ticket)`, and selector hooks `useLiveForTicket(ticket)` and `useIsLive(ticket)`.

#### Scenario: Setting live data for a ticket
- **WHEN** `setLive('AUT-1', { team, activeAgents, changes, original_files, lastTs: 123, stale: false })` is called
- **THEN** `liveByTicket.get('AUT-1')` returns an entry matching the input

#### Scenario: Marking a ticket stale
- **WHEN** `markStale('AUT-1')` is called while an entry exists for `AUT-1`
- **THEN** that entry's `stale` field becomes `true`
- **AND** the entry is NOT removed

#### Scenario: Clearing a ticket
- **WHEN** `clearLive('AUT-1')` is called
- **THEN** `liveByTicket.get('AUT-1')` returns `undefined`

### Requirement: SSE event routing for live-codegen
The SSE connection layer SHALL register listeners for `codegen:live` and `codegen:live-stop` event types and route them into the live-codegen store.

#### Scenario: Receiving a `codegen:live` event
- **WHEN** an SSE event `codegen:live` with payload `{ ticket: 'AUT-1', team, activeAgents, changes, original_files, ts: 123 }` arrives
- **THEN** `setLive('AUT-1', { team, activeAgents, changes, original_files, lastTs: 123, stale: false })` is called

#### Scenario: Receiving a `codegen:live-stop` event
- **WHEN** an SSE event `codegen:live-stop` with payload `{ ticket: 'AUT-1', team, outcome, ts }` arrives
- **AND** an entry exists in `liveByTicket` for `AUT-1`
- **THEN** `markStale('AUT-1')` is called

#### Scenario: Stage transition clears live entry
- **WHEN** the pipeline store observes `AUT-1` transition from `generate_code` to `gate_code_review`
- **THEN** `clearLive('AUT-1')` is called

### Requirement: Active-ticket hydration via snapshot
When the active ticket changes to a ticket whose `stage === 'generate_code'` and `liveByTicket` has no entry for it, the frontend SHALL issue one `GET /api/codegen/live?ticket=<TICKET>` request and, if the response's `live === true`, call `setLive(ticket, response)`.

#### Scenario: Hydration on first view of running codegen
- **WHEN** the user switches the active ticket to `AUT-8457` which is at `generate_code` with no local live entry
- **THEN** the UI fetches `/api/codegen/live?ticket=AUT-8457` exactly once
- **AND** on `{ live: true, ... }` response, `setLive('AUT-8457', response)` is called

#### Scenario: No hydration needed
- **WHEN** the active ticket becomes `AUT-8457` and `liveByTicket` already has an entry for it
- **THEN** no snapshot fetch is issued

## MODIFIED Requirements

### Requirement: `DiffViewer` accepts a source mode
The existing `DiffViewer` component SHALL accept optional props `source?: 'live' | 'frozen'` (default `'frozen'`) and `liveData?: LiveEntry`. When `source === 'live'`, it SHALL read `{ changes, original_files }` from `liveData` instead of `/api/review`.

In live mode, `DiffViewer` SHALL render a pulsing `● LIVE` badge in the toolbar and a chip list of `liveData.activeAgents`, and SHALL hide the inline-comment form and any approve/reject controls.

When `liveData.stale === true`, the `● LIVE` badge SHALL be replaced by a neutral `Codegen complete` label; inline comments and approve/reject remain hidden.

Downstream components (`FileTree`, `DiffPane`, `DiffStatsBar`, `PlanTabs`) SHALL receive identical props in both modes.

#### Scenario: Live viewer during active codegen
- **WHEN** `<DiffViewer source="live" liveData={entry} />` is rendered
- **AND** `entry.stale === false`
- **THEN** the toolbar shows a pulsing `● LIVE` badge
- **AND** the toolbar shows chips for each name in `entry.activeAgents`
- **AND** no inline-comment form is rendered
- **AND** no approve/reject buttons are rendered
- **AND** `FileTree` receives the same `files` prop it would in frozen mode

#### Scenario: Live viewer after codegen completes
- **WHEN** `<DiffViewer source="live" liveData={entry} />` is rendered with `entry.stale === true`
- **THEN** the `● LIVE` badge is replaced by a `Codegen complete` label
- **AND** inline comments and approve/reject remain hidden

#### Scenario: Frozen viewer is unchanged
- **WHEN** `<DiffViewer />` is rendered without a `source` prop (or `source="frozen"`)
- **THEN** it loads data via `/api/review` exactly as before
- **AND** `liveData` is ignored

### Requirement: Main-panel routing for live diff
When the active ticket's `stage === 'generate_code'` and `useLiveForTicket(ticket)` returns a non-null entry, the main panel SHALL render `<DiffViewer source="live" liveData={entry} />` in the same slot the review `DiffViewer` occupies at `gate_code_review`.

`<WriteCodeDetail />` SHALL continue to render alongside the live `DiffViewer` so checkpoint tiles remain visible during codegen.

#### Scenario: Active ticket in generate_code with live entry
- **WHEN** the active ticket's stage is `generate_code`
- **AND** `useLiveForTicket(ticket)` returns a non-null entry
- **THEN** `<DiffViewer source="live" liveData={entry} />` is rendered
- **AND** `<WriteCodeDetail />` is also rendered in its existing slot

#### Scenario: Active ticket in generate_code without live entry yet
- **WHEN** the active ticket's stage is `generate_code`
- **AND** `useLiveForTicket(ticket)` returns null
- **THEN** the panel falls back to the existing generate-code layout with no `DiffViewer`
- **AND** exactly one hydration fetch to `/api/codegen/live?ticket=<TICKET>` has been issued

#### Scenario: Transition to gate_code_review is flicker-free
- **WHEN** the active ticket transitions from `generate_code` to `gate_code_review`
- **THEN** the live `DiffViewer` unmounts or re-renders with `source="frozen"` loading from `/api/review`
- **AND** because both sources derive from `localGetChanges` / `localGetOriginal`, the visible file list and diffs match between the final live tick and the first frozen render
