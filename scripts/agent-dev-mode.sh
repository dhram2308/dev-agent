#!/usr/bin/env bash
set -uo pipefail

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'  GREEN='\033[0;32m'  YELLOW='\033[0;33m'
BLUE='\033[0;34m'  CYAN='\033[0;36m'  NC='\033[0m'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TSC_PID=""  BACKEND_PID=""  VITE_PID=""

# ── Shared API token for backend + frontend ─────────────
# Both processes use the same token so Vite dev server can auth with the backend.
export API_TOKEN=$(openssl rand -hex 24)
export VITE_API_TOKEN="$API_TOKEN"

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

# ── Kill existing processes on dev ports ─────────────────
EXISTING=$(lsof -ti:3000 -ti:5173 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  echo -e "${YELLOW}[setup]${NC} Killing existing processes on :3000/:5173"
  kill -9 $EXISTING 2>/dev/null || true
  sleep 1
fi

# ── Step 1: Initial build ──────────────────────────────
# tsc may exit non-zero due to type errors in test files but still emits JS.
echo -e "${CYAN}[build]${NC} Building shared → agent → backend..."

npx tsc -p packages/shared/tsconfig.json 2>&1 | sed "s/^/  ${CYAN}[tsc]${NC} /" || true
[ ! -f packages/shared/dist/index.js ] && echo -e "${RED}FATAL: shared build failed${NC}" && exit 1

npx tsc -p packages/agent/tsconfig.json 2>&1 | sed "s/^/  ${CYAN}[tsc]${NC} /" || true
[ ! -f packages/agent/dist/index.js ] && echo -e "${RED}FATAL: agent build failed${NC}" && exit 1

npx tsc -p packages/backend/tsconfig.json 2>&1 | sed "s/^/  ${CYAN}[tsc]${NC} /" || true
[ ! -f packages/backend/dist/server/http-server.js ] && echo -e "${RED}FATAL: backend build failed${NC}" && exit 1

echo -e "${GREEN}[build]${NC} Build complete."

# ── Step 2: TypeScript watcher ─────────────────────────
npx tsc -b --watch packages/backend/tsconfig.json packages/agent/tsconfig.json 2>&1 \
  | sed "s/^/${BLUE}[tsc]${NC} /" &
TSC_PID=$!
sleep 2

# ── Step 3: Backend with auto-restart ──────────────────
node --watch-path=packages/backend/dist \
     --watch-path=packages/agent/dist \
     --watch-path=packages/shared/dist \
     packages/backend/boot.js 2>&1 \
  | sed "s/^/${GREEN}[backend]${NC} /" &
BACKEND_PID=$!
sleep 2

# ── Step 4: Frontend Vite dev server ───────────────────
cd packages/frontend
npx vite --port 5173 2>&1 \
  | sed "s/^/${CYAN}[frontend]${NC} /" &
VITE_PID=$!
cd "$ROOT"

# ── Ready ──────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Dev environment ready!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Frontend:${NC}  http://localhost:5173  ${CYAN}← use this${NC}"
echo -e "  ${GREEN}Backend:${NC}   http://localhost:3000  (API only)"
echo ""
echo -e "  Edit .ts  → tsc rebuilds → backend auto-restarts"
echo -e "  Edit .tsx → Vite HMR → browser updates instantly"
echo ""
echo -e "  Press ${YELLOW}CTRL+C${NC} to stop all"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""

wait
