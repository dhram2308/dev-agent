# Tasks: agent-dev-mode

- [x] 1. Create `scripts/agent-dev-mode.sh` with initial build, tsc watch, node --watch backend, vite frontend, and trap cleanup
- [x] 2. Add `"dev:full": "./scripts/agent-dev-mode.sh"` to root package.json scripts
- [x] 3. Add port 3000 kill guard at script startup
- [x] 4. Test: edit shared type → verify backend restarts with new compiled output
- [x] 5. Test: edit backend route → verify backend restarts
- [x] 6. Test: edit frontend component → verify HMR updates browser
- [x] 7. Test: CTRL+C cleanly kills all processes
