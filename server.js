#!/usr/bin/env node
// Entry shim — delegates to packages/agent (compiled TypeScript).
// All server code lives in packages/agent/src/server/.
require('./packages/agent/dist/server/index.js');
