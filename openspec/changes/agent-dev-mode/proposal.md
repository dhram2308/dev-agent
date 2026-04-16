# Proposal: agent-dev-mode

## Problem

Starting the dev environment requires 3 separate terminals and commands:
1. `npm run build` (initial compile of shared → agent → backend)
2. `npm run dev` (backend on :3000)
3. `cd packages/frontend && npx vite` (frontend on :5173)

Changes to TypeScript source files (backend, shared, agent) don't reflect at runtime — you must manually rebuild and restart. This kills the dev feedback loop.

## Solution

A single `scripts/agent-dev-mode.sh` bash script that:
1. Builds all packages once (shared → agent → backend)
2. Watches all TypeScript sources via `tsc -b --watch` (cascading rebuilds via project references)
3. Auto-restarts the backend server via `node --watch` when compiled output changes
4. Starts the Vite frontend dev server with HMR and API proxy to :3000
5. Cleans up all processes on CTRL+C

**Zero new dependencies** — uses `tsc -b --watch` (TS 5.4), `node --watch` (Node 22.19), and Vite dev server already in the project.

## Scope

- One new bash script: `scripts/agent-dev-mode.sh`
- One new npm script: `"dev:full"` in root package.json
- Optional: add agent tsconfig as reference in backend tsconfig (for full cascade)

## Out of Scope

- Production changes
- Docker changes
- Changing the build system (no Turbo, no tsx)
