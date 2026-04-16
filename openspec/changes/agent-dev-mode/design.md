# Design: agent-dev-mode

## Context

The monorepo has 4 packages with this dependency graph:

```
shared (leaf — no deps)
  ├──► agent (refs shared)
  └──► backend (refs shared)

frontend (standalone Vite app, proxies /api/* → :3000)
```

All backend code runs from compiled `dist/` output. Frontend uses Vite HMR (no build needed in dev).

## Architecture

```
scripts/agent-dev-mode.sh
│
├─ Step 1: Initial build (sequential)
│  npm run build:shared
│  npm run build:agent
│  npm run build:backend
│
├─ Step 2: TypeScript watcher (background process)
│  tsc -b --watch packages/backend/tsconfig.json packages/agent/tsconfig.json
│  - Watches shared/src, agent/src, backend/src
│  - Recompiles on change (cascading via project references)
│
├─ Step 3: Backend server with auto-restart (background process)
│  node --watch-path=packages/backend/dist \
│       --watch-path=packages/agent/dist \
│       --watch-path=packages/shared/dist \
│       packages/backend/boot.js
│  - Restarts automatically when compiled JS changes
│
├─ Step 4: Frontend Vite dev server (background process)
│  cd packages/frontend && npx vite --port 5173
│  - HMR for instant browser updates
│  - Proxy: /api/* → http://localhost:3000
│
└─ Cleanup: trap EXIT INT TERM
   - Kills all background processes
   - Waits for clean shutdown
```

## Decisions

### D1: Bash script vs npm-only
**Decision**: Bash script + npm alias.
**Rationale**: `node --watch` with multiple `--watch-path` flags and background process management with trap cleanup is cleaner in bash. npm script just calls the bash script.

### D2: No new dependencies
**Decision**: Use only built-in tools (`tsc`, `node --watch`, `vite`).
**Rationale**: Node 22.19 has stable `--watch`. No need for concurrently/nodemon. Fewer deps = less maintenance.

### D3: tsc -b --watch covers both agent and backend
**Decision**: Pass both tsconfig paths to a single `tsc -b --watch` invocation.
**Rationale**: `tsc -b --watch packages/backend/tsconfig.json packages/agent/tsconfig.json` watches the full dependency tree (shared is a reference of both). One watcher process instead of two.

### D4: Delay between tsc output and node restart
**Decision**: Rely on `node --watch` debounce (built-in ~500ms).
**Rationale**: Node's native watch already debounces rapid file changes. No custom delay needed.

### D5: Frontend port
**Decision**: Fixed at 5173 (Vite default).
**Rationale**: Consistent with existing proxy config in `vite.config.ts`. Developer opens `http://localhost:5173`.

## Risks

| Risk | Mitigation |
|------|------------|
| Race: tsc still writing when node restarts | Node --watch has built-in debounce; tsc writes are fast |
| Port 3000 already in use | Script kills existing process on port 3000 before starting |
| tsc --watch misses a change | Manual CTRL+C and re-run; rare with tsc -b --watch |
