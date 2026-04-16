# Agent Workspace Spec

## Domain: packages/agent/

## Status: ADDED

## Overview
New monorepo workspace that houses the converted TypeScript agent code. Uses CommonJS module
target (not ESM) to preserve NAPI-RS compatibility. Supports incremental migration via allowJs.

## Requirements

### ADDED: Workspace Registration
- WHEN `packages/agent/` exists THEN it is registered in root `package.json` workspaces array as `"packages/agent"`.
- WHEN `npm install` runs at the root THEN `packages/agent/node_modules` is symlinked correctly.
- WHEN the workspace is listed via `npm ls --workspaces` THEN `@mi/agent` appears alongside `@mi/shared`, `@mi/backend`, `@mi/frontend`, and `@mi/native`.

### ADDED: Build Order
- WHEN building the full monorepo THEN build order is: shared -> agent -> backend -> frontend.
- WHEN `packages/agent/` build runs THEN `packages/shared/` has already been compiled and its `dist/` exists.
- WHEN `npm run build` runs at root THEN all four packages compile without errors.

### ADDED: TypeScript Configuration
- WHEN `packages/agent/tsconfig.json` is used THEN it has `composite: true` for project references.
- WHEN `packages/agent/tsconfig.json` is used THEN it has `allowJs: true` so unconverted .js files compile alongside .ts files.
- WHEN `packages/agent/tsconfig.json` is used THEN `module` is `"CommonJS"` and `target` is `"ES2020"` or later.
- WHEN `packages/agent/tsconfig.json` is used THEN `outDir` is `"./dist"` and `rootDir` is `"./src"`.

### ADDED: Path Alias Resolution
- WHEN importing from `@shared/types` inside packages/agent THEN TypeScript resolves to `packages/shared/src/types/`.
- WHEN importing from `@shared/utils` inside packages/agent THEN TypeScript resolves to `packages/shared/src/utils/`.
- WHEN the agent is compiled THEN `@shared/*` paths are rewritten to relative paths in the output JS.

### ADDED: Docker Integration
- WHEN Docker builds THEN `packages/agent/` source is copied in Stage 2 (build stage).
- WHEN Docker builds THEN `packages/agent/dist/` output is copied in Stage 3 (runtime stage).
- WHEN the Docker image runs THEN `packages/agent/dist/` is present and executable.

### ADDED: Legacy Entry Point Delegation
- WHEN running `node run-agent.js` at root THEN it delegates to `packages/agent/dist/run-agent.js`.
- WHEN running `node server.js` at root THEN it delegates to `packages/agent/dist/server.js`.
- WHEN legacy shims execute THEN they print a deprecation notice to stderr before delegating.

### ADDED: Incremental Migration Support
- WHEN a `.js` file in packages/agent/src/ is unconverted THEN it still compiles and runs alongside `.ts` files.
- WHEN a `.js` file is converted to `.ts` THEN no other file's import statement needs to change (extension-free imports).
- WHEN all files are converted THEN `allowJs` can be set to `false` and the build still passes.
