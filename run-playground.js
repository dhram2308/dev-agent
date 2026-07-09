#!/usr/bin/env node
// Entry shim — delegates to packages/agent (compiled TypeScript).
// Playground single-stage runner; see packages/agent/src/playground-runner.ts.
require('./packages/agent/dist/playground-runner.js');
