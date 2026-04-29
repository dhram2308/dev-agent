## ADDED Requirements

### Requirement: Live diff poller in `runAgentsTeam`
`runAgentsTeam` SHALL start a file-change poller during Phase 2 when at least one pending agent has `opts.cwd` set, and SHALL stop it in a `finally` block when Phase 2 ends (by success, rejection, or thrown error).

The poller SHALL tick every `LIVE_TICK_MS = 1500` milliseconds, SHALL use the `cwd` of the first agent that declared one, and SHALL be `.unref()`'d so it does not block process exit.

#### Scenario: Team with file-writing agent starts the poller
- **WHEN** `runAgentsTeam` is called with any pending agent having `opts.cwd = '/path/to/repo'`
- **THEN** a `setInterval` loop is started before `Promise.allSettled`
- **AND** the interval is cleared in the `finally` after `Promise.allSettled`

#### Scenario: Team with no file-writing agent skips the poller
- **WHEN** `runAgentsTeam` is called and no pending agent has `opts.cwd`
- **THEN** no interval is started
- **AND** no `codegen:live` or `codegen:live-stop` event is broadcast

#### Scenario: Poller survives transient git errors
- **WHEN** a tick's `localGetChanges` or `localGetOriginal` throws
- **THEN** the error is logged at debug level with prefix `[<teamName>] live poll:`
- **AND** the interval continues running on subsequent ticks

#### Scenario: Poller cleans up on thrown error
- **WHEN** an agent rejects with a required failure and `runAgentsTeam` throws
- **THEN** the `finally` block still clears the interval
- **AND** a single `codegen:live-stop` event is broadcast with `outcome: 'failure'`

### Requirement: Live payload shape and de-duplication
Each non-redundant tick SHALL broadcast `codegen:live` with `{ ticket, team, activeAgents, changes, original_files, ts }`, where `changes` is capped at `MAX_FILES_LIVE = 40` entries and each `content` string is capped at `MAX_FILE_BYTES_LIVE = 200_000` bytes.

A tick SHALL NOT broadcast when its content hash matches the previous broadcast's hash, where the hash is `simpleHash(changes.map(c => [c.file_path, c.action, c.content?.length]).join('|'))`.

#### Scenario: First tick with changes broadcasts
- **WHEN** the poller's first tick sees 2 modified files
- **THEN** `broadcast('codegen:live', payload)` is called
- **AND** `payload.changes` has 2 entries
- **AND** `payload.original_files` has HEAD content for both paths
- **AND** `payload.ts` is `Date.now()` at tick time

#### Scenario: Unchanged tick does not broadcast
- **WHEN** the poller's second tick produces the same `simpleHash` as the first
- **THEN** no `codegen:live` event is broadcast

#### Scenario: Payload caps are applied
- **WHEN** a tick sees 50 changed files
- **THEN** `payload.changes.length === 40`
- **AND** `payload.truncated.files === 10`

#### Scenario: Large files are truncated
- **WHEN** a file's on-disk content exceeds 200 KB
- **THEN** the `content` field in `changes` is truncated to `MAX_FILE_BYTES_LIVE` bytes
- **AND** that file's path appears in `payload.truncated.bytes`

### Requirement: `codegen:live-stop` lifecycle event
Exactly one `codegen:live-stop` SHALL be broadcast per team invocation where the poller was started, in the `finally` block of Phase 2.

The payload SHALL include `outcome: 'success' | 'failure'` where `'success'` means `failures.length === 0` after Phase 3's required-agent check, else `'failure'`.

#### Scenario: Successful team emits success stop
- **WHEN** all required agents in a file-writing team fulfill
- **THEN** `broadcast('codegen:live-stop', { ticket, team, outcome: 'success', ts })` is called exactly once

#### Scenario: Team with required agent failure emits failure stop
- **WHEN** a required agent in a file-writing team rejects
- **THEN** `broadcast('codegen:live-stop', { ticket, team, outcome: 'failure', ts })` is called exactly once before `runAgentsTeam` throws

### Requirement: Exported `buildLiveSnapshot` helper
`lib/agents-team.ts` SHALL export a synchronous `buildLiveSnapshot(cwd, ticket, team, activeAgents)` helper that returns the same payload shape as a single poller tick, applying the same caps.

#### Scenario: Snapshot on clean repo
- **WHEN** `buildLiveSnapshot(cwd, 'AUT-1', 'Developer Team', ['Dev Agent 1'])` is called on a repo with no changes
- **THEN** the return value is `{ ticket: 'AUT-1', team: 'Developer Team', activeAgents: ['Dev Agent 1'], changes: [], original_files: {}, ts: <number> }`

#### Scenario: Snapshot mid-codegen
- **WHEN** `buildLiveSnapshot` is called while 3 files are modified in the working tree
- **THEN** the return value's `changes` has 3 entries matching `localGetChanges(cwd)`
- **AND** `original_files` contains HEAD content for each `update`-action entry

## MODIFIED Requirements

### Requirement: `runAgentsTeam` backward compatibility
`runAgentsTeam` SHALL preserve all existing behavior — checkpoint replay, `_active_agents` tracking, required/optional agent semantics, output validation, result merge — for every caller. The live-poller behavior SHALL be strictly additive and gated on `opts.cwd`.

#### Scenario: Caller without `opts.cwd` is unaffected
- **WHEN** Reviewer Team calls `runAgentsTeam` with agents that have no `opts.cwd`
- **THEN** no `codegen:live*` events are broadcast
- **AND** checkpoint replay, validation, merge all behave exactly as before this change

#### Scenario: Existing Developer Team now emits live events
- **WHEN** Developer Team calls `runAgentsTeam` with all agents sharing `opts.cwd = cfg.localRepo`
- **THEN** every previously-specified behavior is unchanged
- **AND** the additive live poller runs until Phase 2 ends
