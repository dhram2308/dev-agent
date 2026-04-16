# Design: Unified TypeScript Migration

## Context

The MI Dev Agent is a monorepo with two worlds:

- **Legacy JS (root)**: 68 files (~31,500 LOC) across `lib/`, `stages/`, `server/`, and root entry points (`run-agent.js`, `server.js`). Zero type safety. `state.data` carries 100+ untyped optional fields set implicitly across 20+ files.
- **Modern TS (packages/)**: `packages/shared` (types + utils), `packages/backend` (Express API), `packages/frontend` (React 18 + Zustand + Vite), `packages/native` (Rust NAPI-RS SSE engine). Already covers 55-60% of functionality.

The React frontend is missing Settings, Diff Viewer, Notifications, and Connectors (36-40 components). The Rust SSE engine only owns replay buffer (11% of EventHub). There is no shared type contract between the JS pipeline, React UI, and Rust addon.

## Goals

1. **Complete type safety across entire codebase** -- all 68 JS files converted to TypeScript with ~160 domain types defined in `packages/shared`.
2. **React feature parity with legacy `html.js`** -- Settings page, Diff Viewer, Toast/Modal system, and hash-based routing replace the server-rendered HTML.
3. **Rust SSE performance optimization** -- typed events, atomic IDs, pre-formatted frame cache, and client registry in Rust (napi8+).
4. **Zero functional regression during migration** -- pipeline behavior unchanged at every phase boundary; `allowJs` keeps unconverted files working.

## Design Decisions

### D1: CommonJS + TypeScript (NOT ESM)

**Decision**: The `packages/agent/` workspace will compile TypeScript to CommonJS (`"module": "commonjs"` in tsconfig).

**Rationale**:
- NAPI-RS `.node` files use `require()` -- ESM `import` of native addons is fragile and version-dependent.
- Dynamic `require()` patterns exist throughout `stages/` (e.g., loading stage modules by name, conditional requires for optional features).
- `__dirname` and `__filename` are used extensively for path resolution in config, logging, and state file management. ESM equivalents (`import.meta.url` + `fileURLToPath`) add ceremony with no benefit.
- ESM migration would be a second, orthogonal risk layered on top of the TS migration. Deferring it eliminates that risk entirely.

### D2: Incremental Bottom-Up Conversion with allowJs

**Decision**: Convert files in dependency order (leaves first, hubs in the middle, entry points last) with `allowJs: true` enabled throughout.

**Rationale**:
- Leaf files (16 files, 0 downstream dependents) can be converted and tested in isolation. Examples: `graceful-shutdown.js`, `state-lock.js`, `state-migration.js`.
- Hub files (`config.js` with 42+ importers, `logging.js` with 40+, `state-unified.js` with 30+) are converted in middle phases after their leaf dependencies are typed.
- Entry points (`run-agent.js`, `server.js`) are converted last since they import everything.
- `allowJs: true` means a half-converted codebase compiles and runs at every phase boundary. No big-bang switchover.
- Each phase produces a working, testable agent -- CI can validate before proceeding.

### D3: Domain-Split PipelineData Types

**Decision**: Split the monolithic `state.data` object into domain-specific type interfaces, composed via intersection.

**Structure**:
```
PipelineData = TicketData & CodeGenData & GateData & MetricsData & UIStateData
```

**Rationale**:
- `state.data` currently has 100+ optional fields spread across 20+ files with no documentation of which stage sets which field.
- A single flat interface with 100+ optional properties provides almost no type safety (everything is `T | undefined`).
- Domain-split types let each stage declare what it produces and what it consumes. Example: `stageFetchTicket()` returns `TicketData`; `stageGenerateCode()` consumes `TicketData` and returns `CodeGenData`.
- Initial typing uses `Partial<>` liberally. Type assertions at stage boundaries narrow the types. Follow-up passes tighten `Partial` to required fields as confidence grows.

### D4: Rust Brain + JS Hands for SSE

**Decision**: Rust owns computation (typed replay buffer, atomic IDs, frame formatting, client registry). JS owns all I/O (`res.write`, drain handling, keepalive timers, auth).

**Rationale**:
- NAPI-RS boundary constraint: Rust cannot call `res.write()` directly on a Node.js HTTP response object. The FFI boundary only supports data transfer, not callback invocation (until ThreadsafeFunction in napi8+).
- Rust excels at: memory-efficient circular buffers, lock-free atomic counters (`AtomicU64`), zero-copy frame formatting (`Vec<u8>` via `Arc`).
- JS excels at: HTTP stream lifecycle, backpressure (`drain` events), timer management, Express middleware integration.
- Upgrading to napi8+ unlocks `ThreadsafeFunction` for future Rust-initiated broadcasts, but the initial design keeps the boundary simple: JS calls into Rust for data, Rust never calls into JS.

### D5: Hash-Based Frontend Routing (No react-router)

**Decision**: Use `window.location.hash` for view switching with 3 routes: `#/dashboard`, `#/settings`, `#/review`.

**Rationale**:
- The frontend is a single-page dashboard served from one Express route. There is no server-side routing to coordinate with.
- Three views do not justify a router library (react-router adds ~15KB gzipped + complexity around loaders, outlets, error boundaries).
- A Zustand store slice (`currentView`) listening to `hashchange` events is ~30 lines of code.
- Hash routing works without any backend changes -- Express serves `index.html` for `/` and the hash fragment is purely client-side.

### D6: packages/agent/ Workspace Structure

**Decision**: Create `packages/agent/` as the new home for all pipeline code, with legacy root files becoming thin shims.

**Target layout**:
```
packages/agent/
  src/
    lib/        -- config, logging, state, http-client, utils
    stages/     -- all 12 pipeline stages
    server/     -- Express server, SSE, HTML fallback
    index.ts    -- main entry
  tsconfig.json -- extends root, commonjs, allowJs
```

**Build order**: `shared` -> `agent` -> `backend` -> `frontend`

**Rationale**:
- Keeps the monorepo pattern consistent (all packages under `packages/`).
- Legacy `run-agent.js` and `server.js` at root become one-line shims: `require('./packages/agent/dist/index.js')`. Existing deployment scripts and Docker commands continue to work.
- Workspace dependency wiring (`"@mi/shared": "workspace:*"`) gives agent access to shared types without path aliases.
- `allowJs` in the agent tsconfig means files can be moved from root to `packages/agent/src/` one at a time, converting to `.ts` in the process.

## Risks

### R1: Hub File Conversion (HIGH)

`config.js` is imported by 42+ files. A type error or changed export shape breaks the entire pipeline.

**Mitigation**: Convert hub files with liberal `any` escape hatches on the first pass. Export shapes remain identical (`module.exports = { ... }`). Tighten types in dedicated follow-up passes after all importers are converted. Run full pipeline integration test after each hub conversion.

### R2: State Shape Typing (MEDIUM)

100+ optional fields in `state.data` are set implicitly across 20+ files. No single file documents the complete shape. Fields may be set conditionally, making it unclear which are guaranteed at any given pipeline stage.

**Mitigation**: Start with `Partial<PipelineData>` everywhere. Use `as` type assertions at stage boundaries where the developer has verified field presence. Gradually replace `Partial` with required fields as test coverage confirms invariants. A generated "field origin map" (which stage sets which field) will guide the tightening.

### R3: NAPI-RS Upgrade (MEDIUM)

Moving from napi6 (v3 crate) to napi8+ could introduce build failures on different platforms, linking issues, or ABI incompatibilities.

**Mitigation**: `fallback.js` already exists and provides a pure-JS implementation of every Rust function. The Rust addon is always optional -- if the `.node` file fails to load, the JS fallback activates. The upgrade can be tested in isolation without blocking the TS migration or React work.

### R4: React Diff Viewer Complexity (MEDIUM)

Character-level diff highlighting and inline comment threading are the two most complex UI features in the entire frontend. Getting scroll sync, virtual rendering, and comment anchoring right is non-trivial.

**Mitigation**: Use `react-diff-view` library for the core diff rendering (split/unified modes, hunk parsing, token-level highlighting). Custom code is limited to: inline comment sidebar, file tree navigation, and context collapse toggle. This reduces the custom surface area to ~500 lines instead of ~2,000.
