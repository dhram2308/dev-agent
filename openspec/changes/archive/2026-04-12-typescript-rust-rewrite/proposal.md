## Why

The MI Dev Agent is a ~18,000-line Node.js CommonJS pipeline running unattended for hours. Three rounds of audit found 52 robustness gaps — 42 fixed in JS, 10 remaining (7 frontend timer/DOM, 1 saveAndThrow, 1 dead code, 1 defensive throw). The current architecture has fundamental limitations:

1. **No type safety** — string-based stage names, untyped state, runtime crashes from typos
2. **CLI dependency** — `claude -p` subprocess blocks Docker/cloud deployment
3. **Monolithic frontend** — 6,000-line html.js with timer leaks, duplicate listeners, no componentization
4. **No compile-time correctness** — circuit breaker states, error classifications, config fields all runtime-checked

A full rewrite to TypeScript + Rust + React eliminates all 10 remaining gaps by architecture (not patches), enables Docker deployment, and provides compile-time guarantees for safety-critical code paths.

## What Changes

### Rust Native Addons (napi-rs) — Safety-Critical Modules
- **http-engine**: CircuitBreaker enum state machine (exhaustive matching), retry scheduler, deduplicator with TTL
- **state-engine**: HMAC via ring (timing-safe), RAII FileLock (Drop trait), atomic write (fsync+rename), CAS counter
- **sse-engine**: CircularBuffer<T> generic (O(1) push, iterator), broadcast with atomic counter

### TypeScript Backend — Application Layer
- **pipeline/**: 11 stage handlers, agent-runner state machine, error recovery, stage timeouts, checkpoints
- **services/**: claude.ts (Anthropic API direct), jira.ts, gitlab.ts, slack.ts
- **agents/**: developer, reviewer, fixer + tool executor (7 tools) + multi-turn agent loop
- **server/**: HTTP server, routes, SSE wrapper, security middleware, rate limiter
- **state/**: state-api, state-manager, state-io (wrapping Rust state-engine)
- **config/**: Zod schema validation, snapshot, drift detection

### React Frontend — Replacing 6,000-line html.js
- **components/**: AgentStatus, LogViewer, GateApproval, CodeDiff, TicketForm, Timer
- **hooks/**: useSSE, usePolling, useVisibility, useLeaderElection
- **store/**: Zustand (pipelineStore)

### Shared Package — Types + Schemas
- PipelineState interface, StageName literal union, Config interface
- Zod schemas for config, state, API requests
- Constants ported from lib/constants.js

### Anthropic API Migration — Replacing Claude CLI
- Tool definitions (read_file, write_file, edit_file, bash, glob, grep, list_dir)
- ToolExecutor with security sandbox (path validation, bash whitelist, output limits)
- AgentLoop (multi-turn conversation with tool execution)
- Drop-in callClaude() replacement (zero changes to agents-team.js)

## Capabilities

### New Capabilities
- `rust-safety-engine`: Compile-time correctness for circuit breaker, HMAC, locks, buffers
- `anthropic-api-integration`: Direct API calls replacing CLI subprocess
- `react-frontend`: Component-based UI with hook lifecycle management
- `typed-pipeline`: Zod-validated state, exhaustive stage matching, Result<T,E> errors
- `docker-deployment`: Multi-stage Dockerfile, health checks, graceful SIGTERM

### Modified Capabilities
- All 14 existing resilience patterns preserved with type-safe implementations

## Impact

- **Files created**: ~60 new files across 4 packages (native, backend, frontend, shared)
- **Files deprecated**: All 48 JS files (kept during transition, removed after validation)
- **Dependencies added**: napi-rs, ring, serde_json (Rust); zod, pino, vite (Node)
- **No API changes**: Same HTTP routes, same SSE protocol, same state file format
- **Backward compatible**: State files readable by both old JS and new TS+Rust
