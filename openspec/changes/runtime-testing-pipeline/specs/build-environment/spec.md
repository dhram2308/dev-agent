# Spec: Build Environment (Phase 0 + Phase 1)

## Phase 0: Environment Bootstrap

### ADDED: bootstrapTestEnvironment()

New function in `run-agent.js` that prepares the local repo for runtime testing. Runs once per ticket, cached via `state.data._env_bootstrapped`.

**WHEN** `stageGenerateCode()` reaches the runtime testing phase AND `state.data._env_bootstrapped` is falsy
**THEN** the agent:
1. Runs `npm install --legacy-peer-deps --ignore-scripts` if `node_modules/` missing
2. Installs `jest-environment-jsdom`, `jest-canvas-mock` if not present
3. Installs `@playwright/test` and runs `npx playwright install chromium` if not present
4. Generates `jest.config.override.ts` in `.repo-cache/{project}/`
5. Generates `setupTests.runtime.ts` in `.repo-cache/{project}/`
6. Generates `test-providers.tsx` in `.repo-cache/{project}/src/`
7. Generates `@mi/core` shim at the path alias location
8. Writes `.env.local` with `VITE_APP_API_URL=http://localhost:9876`, `VITE_APP_QA=true`, `VITE_CHAT_SOCKET_URL=`
9. Sets `state.data._env_bootstrapped = true` and saves

**WHEN** `npm install` fails
**THEN** log warning, set `state.data._env_bootstrap_failed = true`, skip Phases 2-3 (graceful degradation)

**WHEN** Playwright browser install fails
**THEN** log warning, skip Phase 3 only (Phase 2 still runs)

**WHEN** validation test (running 1 existing test) fails
**THEN** log warning with failure reason, proceed anyway (existing tests may have pre-existing issues)

### ADDED: jest.config.override.ts (generated)

**WHEN** bootstrap generates Jest config
**THEN** it includes:
- `testEnvironment: "jsdom"`
- `moduleNameMapper` for all 150+ tsconfig path aliases (read from `tsconfig.base.json`)
- `moduleNameMapper` for `@mi/core` pointing to generated shim
- `moduleNameMapper` for SVG, CSS, images (return empty module)
- `setupFilesAfterSetup: ["./setupTests.runtime.ts"]`
- `testTimeout: 10000`
- `forceExit: true`

### ADDED: setupTests.runtime.ts (generated)

**WHEN** bootstrap generates setup file
**THEN** it includes mocks for:
- `window.matchMedia` (returns `{ matches: false, addListener: jest.fn(), ... }`)
- `IntersectionObserver` (observe/unobserve/disconnect stubs)
- `ResizeObserver` (observe/unobserve/disconnect stubs)
- `window.crypto.getRandomValues` (returns random bytes)
- `HTMLCanvasElement.prototype.getContext` (returns mock 2D context)
- Module mocks: `mapbox-gl`, `pdfjs-dist`, `html2canvas`, `react-google-charts` (return empty components)
- `import.meta.env` stub with `VITE_APP_TYPE: "enterprise"`, `VITE_PRODUCT_ID`, `VITE_APP_QA: "true"`

### ADDED: test-providers.tsx (generated)

**WHEN** bootstrap generates test providers
**THEN** it exports `TestProviders` component that wraps children with:
- `MemoryRouter` (not BrowserRouter)
- Mock `AuthContext` with test user (name, email, roles, permissions)
- Mock `AppContext` with default locale, theme, permissions
- Mock `ThemeProvider` (styled-components) with test theme
- Mock `InfoViewActionsContext` with jest.fn() callbacks
- Mock `BusinessContext` with test org data
- Mock `IntlProvider` with English locale

### ADDED: @mi/core shim (generated)

**WHEN** bootstrap generates @mi/core shim
**THEN** it exports:
- `renderWithWrapper(ui, options)` — calls `render(ui, { wrapper: TestProviders, ...options })`
- `defineMatchMedia()` — sets up window.matchMedia mock
- Re-exports from `@testing-library/react`: `screen`, `fireEvent`, `waitFor`, `act`

## Phase 1: Enhanced Build Verification

### MODIFIED: Q5 Build Check

**WHEN** build check runs AND `RUN_RUNTIME_TESTS` is true
**THEN** after tsc + eslint (existing), also runs:
- `NODE_OPTIONS=--max_old_space_size=8192 npx nx build enterprise --base=origin/enterprise-ts` (affected build)
- With timeout: `VITE_BUILD_TIMEOUT` (default 10 min)

**WHEN** Nx affected build is first run (no dist/ exists)
**THEN** run full build instead of affected (no base comparison available)

**WHEN** Vite build fails
**THEN** pass errors to existing Build Fixer Agent pattern (one retry)

**WHEN** Vite build succeeds
**THEN** `dist/apps/enterprise/` is ready for Phase 3 (`vite preview`)

### ADDED: Change Classifier

**WHEN** runtime testing begins
**THEN** classify changes into one of:
- `STYLE`: only .css/.scss/.styled.ts files changed → Phase 1 only
- `UTILITY`: only utils/helpers/services (no components) → Phase 1 + 2
- `COMPONENT`: React component files changed → Phase 1 + 2 + 3
- `API_INTEGRATION`: API hooks/services + components → Phase 1 + 2 + 3

**WHEN** change type is STYLE
**THEN** skip Phase 2 and Phase 3 (log: "Style-only change — skipping runtime tests")

**WHEN** classification is uncertain (mixed file types)
**THEN** default to highest applicable depth (COMPONENT or API_INTEGRATION)
