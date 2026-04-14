#!/bin/bash
set -e

# ---------------------------------------------------------------------------
# MI Dev Agent — Docker Entrypoint
# ---------------------------------------------------------------------------
# Forwards SIGTERM/SIGINT to the Node.js process so graceful-shutdown.ts
# can drain SSE connections, flush state, and release file locks cleanly.
# The stop_grace_period (35s) in docker-compose gives the app time to
# finish its 30s shutdown sequence before Docker sends SIGKILL.
# ---------------------------------------------------------------------------

trap 'kill -TERM "$PID"; wait "$PID"' SIGTERM SIGINT

# Execute the CMD passed by Docker (default: node packages/backend/dist/server/http-server.js)
exec "$@" &
PID=$!
wait "$PID"
EXIT_STATUS=$?
exit $EXIT_STATUS
