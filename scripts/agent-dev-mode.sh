#!/usr/bin/env bash
set -uo pipefail

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'  GREEN='\033[0;32m'  YELLOW='\033[0;33m'
BLUE='\033[0;34m'  CYAN='\033[0;36m'  NC='\033[0m'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BACKEND_PID=""  VITE_PID=""

# ── Shared API token for backend + frontend ─────────────
export API_TOKEN=$(openssl rand -hex 24)
export VITE_API_TOKEN="$API_TOKEN"

# ── Cleanup on exit ────────────────────────────────────
cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down dev environment...${NC}"
  [ -n "$VITE_PID" ]    && kill "$VITE_PID"    2>/dev/null
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
  wait 2>/dev/null
  echo -e "${GREEN}All processes stopped.${NC}"
}
trap cleanup EXIT INT TERM

# ── Kill existing processes on dev ports ─────────────────
kill_port() {
  local port=$1
  local pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo -e "${YELLOW}[setup]${NC} Killing process on :${port}"
    kill -9 $pids 2>/dev/null || true
  fi
}
kill_port 3000
kill_port 5173
sleep 1

# ── Dev is TS-native: no build step ───────────────────────
# tsx transpiles packages/{backend,agent,shared}/src on the fly.
# dev-boot.js installs a require hook that maps @mi/agent, @mi/shared,
# @shared, @native, and relative `/agent/dist/` requests → src paths.
# Prod (`npm run build && npm start`) is unaffected.

echo -e "${CYAN}[dev]${NC} TS-native (tsx) — no compile step"

# ── Backend via tsx watch ─────────────────────────────────
# tsx watches every TS file it transpiles, so edits to backend/src,
# agent/src, and shared/src all trigger restart automatically.
npx tsx watch \
  --clear-screen=false \
  packages/backend/dev-boot.js 2>&1 \
  | sed "s/^/${GREEN}[backend]${NC} /" &
BACKEND_PID=$!
sleep 2

# ── Frontend Vite dev server ──────────────────────────────
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
echo -e "  Edit any .ts  → tsx restarts backend (<1s)"
echo -e "  Edit any .tsx → Vite HMR → browser updates instantly"
echo ""
echo -e "  Press ${YELLOW}CTRL+C${NC} to stop all"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""

wait