#!/usr/bin/env bash
set -uo pipefail

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TSC_PID=""
BACKEND_PID=""
VITE_PID=""

# ── Cleanup on exit ────────────────────────────────────
cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down dev environment...${NC}"
  [ -n "$VITE_PID" ]    && kill "$VITE_PID"    2>/dev/null
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
  [ -n "$TSC_PID" ]     && kill "$TSC_PID"     2>/dev/null
  wait 2>/dev/null
  echo -e "${GREEN}All processes stopped.${NC}"
}
trap cleanup EXIT INT TERM

# ── Kill existing process on port 3000 ─────────────────
echo -e "${YELLOW}[setup]${NC} Checking port 3000..."
EXISTING=$(lsof -ti:3000 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  echo -e "${YELLOW}[setup]${NC} Killing existing process on port 3000 (PID: $EXISTING)"
  kill -9 $EXISTING 2>/dev/null || true
  sleep 1
fi

# ── Step 1: Initial build ──────────────────────────────
# tsc may exit non-zero due to type errors in test files but still emits JS output.
# We check that dist/ exists after each build to confirm it worked.
echo -e "${CYAN}[build]${NC} Building shared → agent → backend..."

npx tsc -p packages/shared/tsconfig.json 2>&1 | sed "s/^/  ${CYAN}[tsc]${NC} /" || true
if [ ! -f packages/shared/dist/index.js ]; then
  echo -e "${RED}[build]${NC} FATAL: shared build produced no output. Fix errors and retry."
  exit 1
fi

npx tsc -p packages/agent/tsconfig.json 2>&1 | sed "s/^/  ${CYAN}[tsc]${NC} /" || true
if [ ! -f packages/agent/dist/index.js ]; then
  echo -e "${RED}[build]${NC} FATAL: agent build produced no output. Fix errors and retry."
  exit 1
fi

npx tsc -p packages/backend/tsconfig.json 2>&1 | sed "s/^/  ${CYAN}[tsc]${NC} /" || true
if [ ! -f packages/backend/dist/server/http-server.js ]; then
  echo -e "${RED}[build]${NC} FATAL: backend build produced no output. Fix errors and retry."
  exit 1
fi

echo -e "${GREEN}[build]${NC} Initial build complete."

# ── Step 2: TypeScript watcher ─────────────────────────
echo -e "${BLUE}[tsc]${NC} Starting TypeScript watcher..."
npx tsc -b --watch packages/backend/tsconfig.json packages/agent/tsconfig.json 2>&1 \
  | sed "s/^/${BLUE}[tsc]${NC} /" &
TSC_PID=$!

# Give tsc a moment to initialize before starting the server
sleep 2

# ── Step 3: Backend with auto-restart ──────────────────
echo -e "${GREEN}[backend]${NC} Starting backend on :3000 (auto-restart on changes)..."
node --watch-path=packages/backend/dist \
     --watch-path=packages/agent/dist \
     --watch-path=packages/shared/dist \
     packages/backend/boot.js 2>&1 \
  | sed "s/^/${GREEN}[backend]${NC} /" &
BACKEND_PID=$!

# Give backend a moment to start before vite
sleep 2

# ── Step 4: Frontend Vite dev server ───────────────────
echo -e "${RED}[frontend]${NC} Starting Vite dev server on :5173..."
cd packages/frontend
npx vite --port 5173 2>&1 \
  | sed "s/^/${RED}[frontend]${NC} /" &
VITE_PID=$!
cd "$ROOT"

# ── Ready ──────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Dev environment ready!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo -e "  ${GREEN}Backend:${NC}   http://localhost:3000"
echo -e "  ${RED}Frontend:${NC}  http://localhost:5173"
echo ""
echo -e "  Edit .ts  → tsc rebuilds → backend restarts"
echo -e "  Edit .tsx → Vite HMR → browser updates"
echo ""
echo -e "  Press ${YELLOW}CTRL+C${NC} to stop all processes"
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo ""

# Wait for any process to exit
wait
