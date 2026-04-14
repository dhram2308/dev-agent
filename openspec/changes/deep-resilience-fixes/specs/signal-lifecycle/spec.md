## ADDED Requirements

### Requirement: Signal handlers are consolidated in graceful-shutdown.js
All process signal handling (SIGTERM, SIGINT, uncaughtException, unhandledRejection) SHALL be managed exclusively by `lib/graceful-shutdown.js`. The legacy `lib/cleanup.js` signal handlers SHALL be removed.

#### Scenario: Server receives SIGTERM
- **WHEN** the server process receives SIGTERM
- **THEN** `graceful-shutdown.js` runs the shutdown sequence (close HTTP server, kill child processes, flush state) and exits cleanly

#### Scenario: No competing signal handlers
- **WHEN** the server starts up
- **THEN** only `graceful-shutdown.js` registers SIGTERM/SIGINT handlers; `cleanup.js` does not register any signal handlers

### Requirement: Server.js registers HTTP server close on shutdown
The HTTP server created in `server.js` SHALL register with `onShutdown('http-server', callback)` to close the server during graceful shutdown. The callback SHALL call `server.close()` to stop accepting new connections.

#### Scenario: Graceful server shutdown
- **WHEN** SIGTERM is received while the HTTP server is accepting connections
- **THEN** `server.close()` is called, existing connections complete, and no new connections are accepted

#### Scenario: Server already closed
- **WHEN** SIGTERM is received but the HTTP server was already closed (e.g., port conflict error)
- **THEN** the shutdown handler completes without error

### Requirement: cleanup.js is removed or neutered
The `lib/cleanup.js` module SHALL either be deleted entirely or have its signal handler registration removed. Only the file-cleanup utility functions (if any) SHALL remain.

#### Scenario: run-agent.js no longer imports cleanup signal handlers
- **WHEN** `run-agent.js` starts execution
- **THEN** it does NOT call `installCleanupHandlers()` from `cleanup.js`; graceful-shutdown.js handles all signal cleanup

### Requirement: Escalation errors are logged at WARN level
Escalation evaluation errors in `run-agent.js` (currently logged as DEBUG) SHALL be logged at WARN level to ensure visibility.

#### Scenario: Escalation rule evaluation fails
- **WHEN** `evaluateRules()` throws an error in the run-agent.js catch block
- **THEN** the error is logged with `console.warn()` including the error message (not `console.debug()`)

### Requirement: _ticketFailureCounts is pruned on agent exit
The `_ticketFailureCounts` map in `server/agent-process.js` SHALL delete entries for tickets that exit with code 0 (clean exit), preventing unbounded map growth.

#### Scenario: Agent exits cleanly
- **WHEN** an agent process exits with code 0
- **THEN** the ticket's entry in `_ticketFailureCounts` is deleted (not just set to 0)

#### Scenario: Agent exits with error
- **WHEN** an agent process exits with non-zero code
- **THEN** the failure count is incremented (existing behavior preserved)

### Requirement: Redactor cleanup is exception-safe
The redactor cleanup in `proc.on("close")` handler in `server/agent-process.js` SHALL be wrapped in a try-catch to prevent cleanup errors from interrupting the close handler.

#### Scenario: Redactor cleanup succeeds
- **WHEN** an agent process closes and `agentRedactors[ticket].cleanup()` is called
- **THEN** the redactor is cleaned up and deleted from the map (existing behavior)

#### Scenario: Redactor cleanup throws
- **WHEN** `agentRedactors[ticket].cleanup()` throws an error
- **THEN** a WARNING is logged with the error message, the redactor entry is still deleted, and the close handler continues
