## ADDED Requirements

### Requirement: SSE drain handler is exception-safe
The drain event handler in `server/sse.js` SHALL wrap its body in a try-catch. On exception, it SHALL log a WARNING and call `res.resume()` to prevent the client from being permanently paused.

#### Scenario: Drain handler processes pending messages
- **WHEN** the response stream emits "drain" and pending messages exist
- **THEN** pending messages are flushed and the client receives them (existing behavior)

#### Scenario: Drain handler encounters an exception
- **WHEN** the drain handler throws during message flush
- **THEN** a WARNING is logged with the error, `res.resume()` is called, and the client stream continues

### Requirement: Replay buffer uses circular buffer with O(1) insertion
The `replayBuffer` in `server/sse.js` SHALL be implemented as a fixed-size circular buffer (capacity = MAX_REPLAY). Insertion SHALL be O(1) via tail pointer increment. The O(n) `Array.shift()` pattern SHALL be removed.

#### Scenario: Buffer stores messages up to capacity
- **WHEN** messages are added to the replay buffer and count < MAX_REPLAY
- **THEN** all messages are stored and available for replay

#### Scenario: Buffer overwrites oldest message on overflow
- **WHEN** a new message is added and the buffer is full
- **THEN** the oldest message (at head pointer) is overwritten and head advances by 1

#### Scenario: Replay iterates in insertion order
- **WHEN** a reconnecting client requests replay from a given Last-Event-ID
- **THEN** messages are iterated from head to tail in correct chronological order

### Requirement: Replay assigns fresh sequential IDs
When replaying messages to a reconnecting client, the SSE system SHALL assign new sequential IDs to replayed messages instead of reusing old IDs. This prevents browser EventSource from deduplicating messages it already processed.

#### Scenario: Client reconnects and receives replay
- **WHEN** a client reconnects with Last-Event-ID and replay messages are sent
- **THEN** each replayed message receives a new ID from the global counter (not its original ID)

#### Scenario: Client receives new messages after replay
- **WHEN** replay completes and new messages arrive
- **THEN** new message IDs continue sequentially from the last replay ID (no gaps, no collisions)

### Requirement: Log buffers are cleaned on agent startup failure
The `logBuffers` map in `server/sse.js` SHALL remove entries for a ticket when the agent process fails to start (exits before producing output). The `clearTicketLogs(ticket)` function SHALL be called on agent startup failure.

#### Scenario: Agent starts and produces output
- **WHEN** an agent process starts successfully and writes to stdout/stderr
- **THEN** log buffers accumulate normally (existing behavior)

#### Scenario: Agent crashes immediately on startup
- **WHEN** an agent process exits with non-zero code before producing any output
- **THEN** `clearTicketLogs(ticket)` is called in the proc.on("close") handler and the logBuffer entry for that ticket is cleaned up

### Requirement: Replay buffer bounds message size
Each message stored in the replay buffer SHALL be limited to 64KB. Messages exceeding this limit SHALL be truncated with a "[truncated]" suffix before storage.

#### Scenario: Normal-sized message stored
- **WHEN** a message under 64KB is added to the replay buffer
- **THEN** it is stored in full

#### Scenario: Oversized message truncated
- **WHEN** a message over 64KB is added to the replay buffer
- **THEN** it is truncated to 64KB with "[truncated]" appended before storage
