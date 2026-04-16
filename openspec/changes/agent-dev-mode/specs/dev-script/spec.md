# Spec: agent-dev-mode script

## ADDED

### REQ-1: Single command startup
- WHEN the developer runs `npm run dev:full` or `./scripts/agent-dev-mode.sh`
- THEN all packages are built, watchers start, backend runs on :3000, frontend runs on :5173

### REQ-2: TypeScript watch with cascade rebuild
- WHEN a `.ts` file in `packages/shared/src/`, `packages/agent/src/`, or `packages/backend/src/` is modified
- THEN `tsc -b --watch` recompiles the changed package and all dependents

### REQ-3: Backend auto-restart
- WHEN compiled `.js` files in `packages/backend/dist/`, `packages/agent/dist/`, or `packages/shared/dist/` change
- THEN the backend Node.js process restarts automatically via `node --watch`

### REQ-4: Frontend HMR
- WHEN a `.tsx`/`.ts`/`.css` file in `packages/frontend/src/` is modified
- THEN the browser updates instantly via Vite HMR (no page reload for most changes)

### REQ-5: API proxy in dev
- WHEN the frontend makes a request to `/api/*`
- THEN Vite proxies it to `http://localhost:3000` (existing config, no change needed)

### REQ-6: Clean shutdown
- WHEN the developer presses CTRL+C
- THEN all background processes (tsc, node, vite) are killed cleanly

### REQ-7: Port conflict handling
- WHEN port 3000 is already in use
- THEN the script kills the existing process before starting

### REQ-8: Colored output
- WHEN the script is running
- THEN each process (tsc, backend, frontend) is prefixed with a colored label for readability
