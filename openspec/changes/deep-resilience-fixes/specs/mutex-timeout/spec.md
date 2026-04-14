## ADDED Requirements

### Requirement: InProcessMutex supports configurable timeout
The `InProcessMutex.acquire()` method in `lib/state-lock.js` SHALL accept an optional `timeoutMs` parameter (default 30,000ms). If the lock is not acquired within the timeout, the returned Promise SHALL reject with a `MutexTimeoutError`.

#### Scenario: Lock acquired within timeout
- **WHEN** `acquire(30000)` is called and the lock becomes available within 30s
- **THEN** the Promise resolves normally and the caller holds the lock

#### Scenario: Lock not acquired within timeout
- **WHEN** `acquire(5000)` is called and the lock is held by another operation for more than 5s
- **THEN** the Promise rejects with a `MutexTimeoutError` containing the wait duration and queue position

#### Scenario: Default timeout applies when no parameter given
- **WHEN** `acquire()` is called without a timeout parameter
- **THEN** a default timeout of 30,000ms is applied

### Requirement: Mutex timeout does not corrupt the queue
When a queued waiter times out, the queue entry SHALL NOT be spliced. The entry remains in the queue and its `resolve` becomes a no-op when the turn arrives.

#### Scenario: Timed-out entry reaches front of queue
- **WHEN** a waiter times out and later its turn arrives in the queue
- **THEN** the queue calls `shift()` as normal, the abandoned resolve is a no-op, and the next waiter proceeds immediately

#### Scenario: Multiple concurrent timeouts
- **WHEN** 3 waiters are queued and 2 of them time out before their turn
- **THEN** the queue drains normally via `shift()`, abandoned entries are skipped, and the surviving waiter acquires the lock

### Requirement: acquireLockAsync handles mutex rejection
The `acquireLockAsync()` function in `lib/state-lock.js` SHALL catch `MutexTimeoutError` from `acquire()` and throw a descriptive error including the ticket ID and timeout duration.

#### Scenario: Mutex timeout during state save
- **WHEN** `acquireLockAsync(ticket)` is called and the mutex times out
- **THEN** the function throws an error with message containing "mutex timeout", ticket ID, and timeout value
