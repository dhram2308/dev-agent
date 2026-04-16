#!/usr/bin/env node
// Entry shim — delegates to packages/agent (compiled TypeScript).
// All orchestrator code lives in packages/agent/src/.
require('./packages/agent/dist/index.js');
