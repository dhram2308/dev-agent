# Spec: Environment Setup (Phase 0)

## .env File Management

### ADDED: writeEnvFile(clonePath)

**WHEN** Phase 0 begins AND `apps/enterprise/.env` does not exist in .repo-cache
**THEN** write the .env file with all 12 required VITE_* variables:
```
VITE_APP_API_URL=https://qa-enterprise.mastersindia-einv.com/api/v2.1/
VITE_PRODUCT_ID=enterprises
VITE_APP_QA=https://qa-enterprise.mastersindia-einv.com
VITE_APP_ENV=qa
VITE_APP_TYPE=enterprise
VITE_INITIAL_URL=/dashboard
VITE_CHAT_SOCKET_URL=wss://qa-taxgptbackend.mastersindia-einv.com/ws/v1/
VITE_APP_NICKNAME=Masters India
VITE_SHOW_CLARITY=false
VITE_SHOW_TOUR_GUIDE=no
VITE_DISABLE_CAPTCHA_ON_QA=true
NODE_OPTIONS=--max_old_space_size=4096
```

**WHEN** `apps/enterprise/.env` already exists in .repo-cache
**THEN** verify it contains `VITE_APP_API_URL` — if missing, overwrite with full template
**THEN** log: `"Phase 0: .env verified (already exists)"`

**WHEN** .env file is written
**THEN** it survives all subsequent `git clean -fd` calls because `.gitignore` line 59 protects `/apps/enterprise/.env`

**WHEN** VITE_APP_API_URL env var is set in process.env
**THEN** use that value instead of the default QA URL (allows override for different environments)

## Node Modules Health Check

### ADDED: verifyNodeModules(clonePath)

**WHEN** Phase 0 begins
**THEN** check if `.repo-cache/node_modules/.bin/nx` exists and is executable

**WHEN** `.bin/nx` does not exist OR is a broken symlink
**THEN** log: `"Phase 0: node_modules broken — running clean install…"`
**THEN** run `npm install --legacy-peer-deps` with timeout `BUILD_INSTALL_TIMEOUT` (default 180s)
**THEN** verify `.bin/nx` exists after install — if still missing, skip Phase 0 with error

**WHEN** `.bin/nx` exists and is valid
**THEN** log: `"Phase 0: node_modules healthy"`
**THEN** skip npm install (saves 60-120s)

**WHEN** npm install fails (timeout, network error, peer dep conflict)
**THEN** set `state.data._env_setup_complete = false`
**THEN** log error with first 300 chars of stderr
**THEN** skip Part 2 entirely with warning in MR description

### ADDED: Package lock hash for cache invalidation

**WHEN** npm install succeeds
**THEN** compute SHA-256 of `package-lock.json` and store as `state.data._npm_install_hash`

**WHEN** Phase 0 re-enters (agent restart) AND `_npm_install_hash` matches current `package-lock.json` hash
**THEN** skip npm install (cached)

**WHEN** `_npm_install_hash` does NOT match (package-lock changed due to git pull)
**THEN** run npm install again

## Playwright Installation

### ADDED: ensurePlaywright(clonePath)

**WHEN** Phase 0 begins AND Playwright is needed (BROWSER_VERIFY=true)
**THEN** check if chromium browser binary exists: `npx playwright install --dry-run chromium`

**WHEN** chromium is not installed
**THEN** run `npx playwright install chromium` (timeout 420s — first install downloads ~150MB)
**THEN** browser cached at `~/.cache/ms-playwright/` — persists across agent restarts

**WHEN** chromium is already installed
**THEN** skip installation, log: `"Phase 0: Playwright chromium cached"`

**WHEN** Playwright install fails (network timeout, disk full)
**THEN** set `_browser_verify_available = false`
**THEN** skip Part 2 with warning

## Dev Server Lifecycle

### ADDED: startDevServer(clonePath, state)

**WHEN** Phase 0 begins AND no dev server is running (state._nx_serve_pid not set or process dead)
**THEN**:
1. Find free port in range `NX_SERVE_PORT_RANGE_START` to `NX_SERVE_PORT_RANGE_END` (default 4200-4299)
2. Spawn: `npx nx serve enterprise --port {port}` with `NODE_OPTIONS=--max_old_space_size=4096`
3. Store PID in `state.data._nx_serve_pid`, port in `state.data._nx_serve_port`
4. Save state immediately (for orphan cleanup on crash)
5. Poll `https://localhost:{port}` every 2s (ignore SSL cert errors) until HTTP 200
6. Max wait: `NX_SERVE_TIMEOUT` (default 120s)
7. On success: set `state.data._dev_server_ready = true`, log elapsed time

**WHEN** state._nx_serve_pid exists AND process is alive (`kill(pid, 0)` succeeds)
**THEN** health check the existing server at state._nx_serve_port
**THEN** if healthy: reuse existing server, log: `"Phase 0: Reusing dev server on port {port}"`
**THEN** if unhealthy: kill old process, start new one

**WHEN** dev server doesn't respond within NX_SERVE_TIMEOUT
**THEN** kill the process
**THEN** retry once with a new port
**THEN** if second attempt fails: set `_dev_server_ready = false`, skip Part 2

**WHEN** no free port found in range
**THEN** skip Part 2 with log: `"No free port in 4200-4299 — skipping browser verification"`

### ADDED: Dev server cleanup on agent shutdown

**WHEN** agent receives SIGTERM, SIGINT, or uncaughtException
**THEN** if `state.data._nx_serve_pid` exists: kill process
**THEN** clear `_nx_serve_pid`, `_nx_serve_port`, `_dev_server_ready` from state

**WHEN** agent completes all tickets and exits normally
**THEN** kill dev server (clean shutdown)

### MODIFIED: localResetRepo() interaction

**WHEN** `localResetRepo(clonePath)` is called (git checkout -f + git clean -fd)
**THEN** dev server stays running (only source files change, HMR picks up changes)
**THEN** .env file survives (protected by .gitignore)
**THEN** node_modules survives (not in git)

## Phase 0 Checkpoint

### ADDED: Phase 0 completion checkpoint

**WHEN** all Phase 0 steps complete successfully (.env, node_modules, Playwright, dev server)
**THEN** set `state.data._env_setup_complete = true`
**THEN** save state

**WHEN** Phase 0 re-enters AND `_env_setup_complete = true` AND `_dev_server_ready = true`
**THEN** verify dev server is still alive (health check)
**THEN** if alive: skip Phase 0 entirely
**THEN** if dead: restart dev server only (skip .env and npm install)

**WHEN** Phase 0 re-enters AND `_env_setup_complete = false`
**THEN** re-run full Phase 0 from scratch
