## ADDED Requirements

### Requirement: `GET /api/codegen/live` snapshot endpoint
The HTTP server SHALL expose `GET /api/codegen/live?ticket=<TICKET>` that returns a one-shot live-codegen snapshot so UI clients can hydrate when they mount mid-codegen and have no prior SSE ticks.

The handler SHALL validate the ticket via `safeTicket`, read the current state, gate on `state.stage === 'generate_code'` and `cfg.localRepo` being a truthy path, and return `{ live: true, ...payload }` where `payload` is the output of `buildLiveSnapshot`.

#### Scenario: Snapshot during active codegen
- **WHEN** the UI fetches `/api/codegen/live?ticket=AUT-8457`
- **AND** AUT-8457 is at stage `generate_code`
- **AND** `cfg.localRepo` is set
- **THEN** the response is HTTP 200 with JSON `{ live: true, ticket: 'AUT-8457', team, activeAgents, changes, original_files, ts }`

#### Scenario: Snapshot for invalid ticket
- **WHEN** `ticket=INVALID_FORMAT` is passed
- **THEN** the response is HTTP 400 with `{ error: 'Invalid ticket format' }`

#### Scenario: Snapshot when no state exists
- **WHEN** the ticket has no state loaded
- **THEN** the response is HTTP 200 with `{ live: false, reason: 'no_state' }`

#### Scenario: Snapshot when ticket is past generate_code
- **WHEN** the ticket's stage is `gate_code_review`
- **THEN** the response is HTTP 200 with `{ live: false, reason: 'not_generating' }`

#### Scenario: Snapshot in legacy codegen mode
- **WHEN** `cfg.localRepo` is null or undefined
- **THEN** the response is HTTP 200 with `{ live: false, reason: 'no_local_repo' }`

#### Scenario: Snapshot handler error
- **WHEN** `buildLiveSnapshot` throws
- **THEN** the response is HTTP 500 with `{ live: false, error: <truncated message up to 500 chars> }`
- **AND** the server continues to accept further requests

### Requirement: SSE replay buffer accepts live-codegen events
The existing SSE replay buffer SHALL store `codegen:live` and `codegen:live-stop` broadcasts with monotonic IDs so reconnecting clients using `Last-Event-ID` replay them in order.

Oversized live payloads SHALL be truncated in the replay buffer to `MAX_REPLAY_MSG_SIZE = 65536` bytes. Live subscribers SHALL still receive the full payload on the initial broadcast.

#### Scenario: Reconnecting client replays live events
- **WHEN** a client disconnects after `codegen:live` event id 42
- **AND** reconnects with header `Last-Event-ID: 42`
- **THEN** the client receives all events with id > 42, including subsequent `codegen:live` broadcasts

#### Scenario: Large live payload is truncated in replay buffer only
- **WHEN** a `codegen:live` payload exceeds 64 KB
- **THEN** its stored form in the replay buffer is truncated with `[truncated]` marker
- **AND** clients connected at broadcast time received the full payload directly

### Requirement: `codegen:live*` events bypass per-ticket log buffer
`codegen:live` and `codegen:live-stop` events SHALL NOT be stored in the per-ticket log buffer used for ticket-scoped client replay. They SHALL rely exclusively on the global replay buffer.

#### Scenario: Per-ticket replay excludes live events
- **WHEN** a client connects with `?ticket=AUT-8457` and no `Last-Event-ID`
- **THEN** the replayed entries contain log entries for the ticket
- **AND** the replayed entries do NOT contain any `codegen:live*` events (those are bandwidth-heavy and time-sensitive)
