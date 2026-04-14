## ADDED Requirements

### Requirement: saveAndThrow preserves state before throwing
A `saveAndThrow(state, error)` helper SHALL call `save(state)` in a try-catch, then throw the original `error`. If `save()` fails, the save error SHALL be logged as a WARNING and the original error SHALL still be thrown.

#### Scenario: Save succeeds before throw
- **WHEN** `saveAndThrow(state, new Error("pipeline failed"))` is called and `save(state)` succeeds
- **THEN** state is persisted to disk and the original "pipeline failed" error is thrown

#### Scenario: Save fails due to lock timeout
- **WHEN** `saveAndThrow(state, new Error("pipeline failed"))` is called and `save(state)` throws a lock timeout error
- **THEN** a WARNING is logged with the save error message, and the original "pipeline failed" error is thrown (not the lock timeout)

#### Scenario: Save fails due to disk full
- **WHEN** `saveAndThrow(state, new Error("pipeline failed"))` is called and `save(state)` triggers process.exit(1) due to disk full
- **THEN** the process exits (existing DISK FULL behavior preserved — saveAndThrow does not catch process.exit)

### Requirement: saveAndThrow applied to unguarded throw sites
The `saveAndThrow()` helper SHALL be used at all throw sites in pipeline stages where state mutations have occurred but `save()` was not called before the throw. Identified sites: `deploy-prod.js` (4 throws), gate stages (2 throws), `generate-code/index.js` (1 throw), `run-agent.js` (1 throw).

#### Scenario: deploy-prod throw preserves error state
- **WHEN** `deploy-prod.js` encounters a "Wrong branch merged" error after setting state fields
- **THEN** `saveAndThrow(state, error)` persists the error state and throws the original error

#### Scenario: Existing save-before-throw sites are not double-saved
- **WHEN** a throw site already has an explicit `save(state)` call before the throw
- **THEN** that site is NOT converted to `saveAndThrow()` to avoid double-saving

### Requirement: CAS sequence initialization is consistent
The `_seq` field SHALL use a consistent default value. The envelope wrap (state-unified.js `wrapEnvelope`) and unwrap (`unwrapEnvelope`) SHALL both use `0` as the fallback when `_seq` is missing.

#### Scenario: Fresh state file with no _seq
- **WHEN** a new state file is created with no existing `_seq` field
- **THEN** `unwrapEnvelope` returns `_seq: 0` and `wrapEnvelope` writes `_seq: 1` on first save

#### Scenario: Existing state file with _seq
- **WHEN** a state file has `_seq: 5`
- **THEN** `unwrapEnvelope` returns `_seq: 5` and `wrapEnvelope` writes `_seq: 6` on save

### Requirement: State atomic write does not double-close file descriptor
The `atomicWriteSync()` function SHALL close the file descriptor exactly once, even on write error. The error path SHALL not attempt `fs.closeSync(fd)` if the fd was already closed.

#### Scenario: Write succeeds
- **WHEN** `atomicWriteSync()` writes data and calls `fs.fsyncSync(fd)` + `fs.closeSync(fd)`
- **THEN** the fd is closed exactly once and the file is renamed atomically

#### Scenario: Write fails mid-stream
- **WHEN** `fs.writeSync(fd, data)` throws an error
- **THEN** `fs.closeSync(fd)` is called in the catch block, and the finally block does NOT attempt a second close

### Requirement: HMAC secret regeneration logs warning
When `lib/state-unified.js` fails to read the HMAC secret file and generates a new secret, it SHALL log a WARNING message indicating that existing state files may become unverifiable.

#### Scenario: Secret file missing on startup
- **WHEN** the HMAC secret file does not exist at startup
- **THEN** a new secret is generated, written to disk, and a WARNING is logged: "HMAC secret regenerated — existing state files may fail verification"

#### Scenario: Secret file exists and is readable
- **WHEN** the HMAC secret file exists and is readable
- **THEN** the secret is loaded silently with no warning
