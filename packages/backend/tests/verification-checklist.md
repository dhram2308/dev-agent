# Verification Checklist (Task 6.7)

## Build Verification

- [ ] `npm ci` at root installs all workspace dependencies (shared, backend, frontend)
- [ ] `npm run build:shared` compiles shared types to `packages/shared/dist/`
- [ ] `npm run build:backend` compiles backend to `packages/backend/dist/`
- [ ] `npm run build:frontend` builds React app to `packages/frontend/dist/`
- [ ] `npm run build:native` compiles Rust crates via `cargo build --release`
- [ ] `npm run build` runs the full sequential build (shared -> backend -> frontend)

## Server Startup

- [ ] Run `node packages/backend/dist/server/http-server.js`
- [ ] Server starts without errors on port 3000
- [ ] Console shows "AI Dev Agent UI -> http://127.0.0.1:3000"

## Web UI

- [ ] Open http://localhost:3000 in browser
- [ ] Page loads without console errors
- [ ] Ticket form renders with input and Start button
- [ ] Ticket validation works (rejects "invalid", accepts "AUT-1234")

## SSE Connection

- [ ] SSE connects (green dot in UI footer)
- [ ] Log messages appear in real-time
- [ ] Disconnect and reconnect: replayed messages have fresh IDs

## Circuit Breaker

- [ ] Trigger 5+ failures to service endpoint
- [ ] Circuit opens (requests fail fast)
- [ ] After timeout, circuit transitions to half-open
- [ ] Success in half-open closes the circuit

## Mutex Timeout

- [ ] acquireLockAsync() returns lock within timeout
- [ ] Second acquire on same resource waits
- [ ] After timeout, MutexTimeoutError is thrown

## Graceful Shutdown

- [ ] Send SIGTERM to server process
- [ ] Log shows "Shutting down..." phases
- [ ] Server closes connections gracefully
- [ ] Process exits with code 0

## Rust Native Addons (if built)

- [ ] HMAC compute/verify roundtrip
- [ ] FileLock acquire/release
- [ ] AtomicWrite write/read consistency
- [ ] CircuitBreaker state transitions
- [ ] CircularBuffer push/iterate/wraparound

## JS Fallback (if native not available)

- [ ] Server starts with WARNING about fallback
- [ ] All operations work via pure-JS fallback
- [ ] No functional difference in behavior

## Docker Verification

- [ ] `docker build -t mi-dev-agent .` completes all 3 stages without errors
- [ ] `docker-compose up -d` starts the container and passes healthcheck
- [ ] Container responds to `curl http://localhost:3000/api/health`
- [ ] `docker-compose down` triggers graceful shutdown (SIGTERM forwarded via entrypoint)
- [ ] State volume (`state-data`) persists across container restarts

## CI/CD Verification

- [ ] `rust-test` job: `cargo test --all` and `cargo clippy` pass
- [ ] `ts-test` job: backend lint + test with coverage
- [ ] `react-test` job: frontend build + test with coverage
- [ ] `docker-build` job: runs only on master push, after all test jobs pass
- [ ] Concurrency group cancels superseded runs on the same branch
