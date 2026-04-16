## Why

The MI Dev Agent codebase is split across two runtime worlds: 68 legacy JavaScript files (~31,500 LOC in lib/, stages/, server/, root) with zero type safety, and a modern TypeScript monorepo (packages/shared, backend, frontend, native) that already ports 55-60% of the functionality. The legacy JS side has 100+ untyped fields in `state.data`, no compile-time error detection, and no shared type contracts with the React frontend or Rust native addon. Meanwhile, the React frontend is missing 4 critical feature areas (Settings, Diff Viewer, Notifications, Connectors — 36-40 components), and the Rust SSE engine only owns 11% of EventHub responsibility (replay buffer only). This migration unifies all three tracks — JS→TS conversion, React frontend completion, and Rust SSE optimization — into a single coordinated effort that eliminates the legacy/modern split.

## What Changes

### Track 1: JS → TypeScript Conversion
- Convert 68 JS files to TypeScript across 11 dependency phases (leaves first, entry points last)
- Create `packages/agent/` workspace with CommonJS + TypeScript (NOT ESM, to preserve NAPI-RS compat)
- Define ~160 missing types across 28 domains (~2,500 LOC in packages/shared/src/types/)
- Convert 5 critical hub files: config.js (42+ importers), logging.js (40+), state-unified.js (30+), http-client.js (25+), utils.js (20+)
- Use `allowJs: true` for incremental migration — agent stays functional throughout
- Wire into monorepo build pipeline: workspace registration, tsconfig references, Docker stages

### Track 2: React Frontend Completion
- Build Settings page (3 tabs: Config Fields, Notifications Grid 9x5, Connector Cards)
- Build Diff Viewer (split/unified modes, char-level highlighting, inline comments, file tree)
- Add Toast/Modal system (toast stack, error overlay, confirm dialog)
- Add hash-based URL routing (#/dashboard, #/settings, #/review)
- Add approval form components (reject modal, refine form, plan tabs viewer)
- Add Zustand settings store slice + 4 new API endpoints in api.ts

### Track 3: Rust SSE Optimizer
- Upgrade napi from v3/napi6 to v8+ to unlock ThreadsafeFunction
- Create typed `SseEvent` struct replacing opaque `StringCircularBuffer`
- Add atomic message ID counter in Rust (AtomicU64)
- Add pre-formatted SSE frame cache (format once as Vec<u8>, share via Arc)
- Create Rust-side `ClientRegistry` for query-only state (JS still owns I/O)
- Keep all I/O in JS (res.write, drain handlers, keepalive) — "Rust brain + JS hands"

### Track 4: Build System & Infrastructure
- Add `packages/agent/` to npm workspaces, root tsconfig references, Docker multi-stage
- Update build order: shared → agent → backend → frontend
- Add vitest config for agent package
- **BREAKING**: Legacy entry points (`node server.js`, `node run-agent.js`) become shims that delegate to `packages/agent/dist/`

## Capabilities

### New Capabilities
- `shared-type-definitions`: Complete TypeScript type definitions for all 28 domains (Jira API, GitLab API, ADF, Ticket Context, Code Generation, HTTP, State, Connectors, SSE, Slack, Process, Approval, Metrics, etc.)
- `agent-workspace`: New `packages/agent/` monorepo workspace with CommonJS TypeScript compilation, allowJs incremental migration, and workspace dependency wiring
- `react-settings-page`: Settings page with 3 tabs (API Config with 20+ grouped fields + test connection, Notification grid 9x5, Connector cards with status inference)
- `react-diff-viewer`: Code review diff viewer with split/unified modes, char-level highlighting, inline comments, file tree navigation, context collapse
- `react-ui-shell`: Toast system, error/confirm modals, hash-based URL routing, keyboard shortcuts
- `rust-sse-optimizer`: Typed SSE events, atomic message IDs, pre-formatted frame cache, client registry in Rust with napi8+

### Modified Capabilities
- (none — existing specs are not affected at the requirement level)

## Impact

**Code**: All 68 JS files in lib/, stages/, server/, root converted to .ts. 36-40 new React components. ~600 lines of new Rust code in sse-engine.

**APIs**: 4 new frontend API calls in api.ts (config, notification-config, config/save, config/test). No backend API changes — all routes already exist in packages/backend.

**Dependencies**: TypeScript added to packages/agent. napi upgraded from v3 to v8+ in packages/native. No new npm runtime dependencies for frontend (uses existing React 18 + Zustand 4.5 + Vite).

**Build**: Root package.json gains 4th workspace. Build order changes. Docker Stage 2 adds agent package compilation. CI needs agent lint/test jobs.

**Pipeline Stages**: All 12 stages + 6 generate-code sub-stages get type annotations but behavior is unchanged. Zero functional changes to pipeline execution.

**Breaking**: `node server.js` and `node run-agent.js` become thin shims. `npm run dev:legacy` deprecated in favor of `npm run dev` (packages/backend entry).
