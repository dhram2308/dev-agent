## ADDED Requirements

### Requirement: Circuit breaker prunes stale failures on state transitions
The `CircuitBreaker` class in `lib/http-client.js` SHALL prune failures older than `windowMs` when transitioning from OPEN→HALF_OPEN and from HALF_OPEN→CLOSED. The `recordSuccess()` method in CLOSED state SHALL NOT call `_prune()`.

#### Scenario: Recovery after transient GitLab outage
- **WHEN** the circuit breaker is in OPEN state and `resetTimeoutMs` has elapsed
- **THEN** the breaker transitions to HALF_OPEN and prunes all failures older than `windowMs` from the failures array

#### Scenario: Successful probe closes the breaker
- **WHEN** the circuit breaker is in HALF_OPEN state and `recordSuccess()` is called
- **THEN** the breaker transitions to CLOSED, prunes all stale failures, and resets the failure count

#### Scenario: High-throughput CLOSED state does not prune
- **WHEN** the circuit breaker is in CLOSED state and `recordSuccess()` is called at 100+ RPS
- **THEN** no `_prune()` call occurs, maintaining O(1) per-request overhead

#### Scenario: Failures accumulate and trip the breaker
- **WHEN** failures exceed `threshold` within `windowMs` in CLOSED state
- **THEN** the breaker transitions to OPEN and sets the reset timer (existing behavior preserved)

### Requirement: Deduplicator removes dead refCount code
The `Deduplicator` class SHALL remove the `refCount` field and all references to it, as it is incremented but never checked or decremented.

#### Scenario: Deduplicator cleanup removes inflight entry
- **WHEN** a deduplicated request completes and `cleanup()` is called
- **THEN** the inflight entry is deleted unconditionally (no refCount check)

### Requirement: Deduplicator has inflight TTL safety
The `Deduplicator` class SHALL enforce a maximum time-to-live (default 300,000ms) on inflight entries. Entries older than the TTL SHALL be evicted on the next `acquire()` call.

#### Scenario: Stale inflight entry is evicted
- **WHEN** a new request calls `acquire()` and an existing inflight entry for the same key is older than 300s
- **THEN** the stale entry is evicted and the new request proceeds as a fresh request

#### Scenario: Active inflight entry is coalesced
- **WHEN** a new request calls `acquire()` and an existing inflight entry for the same key is younger than 300s
- **THEN** the new request waits on the existing Promise (existing coalescing behavior)
