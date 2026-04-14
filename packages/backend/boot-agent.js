#!/usr/bin/env node
"use strict";

// Boot: Pipeline agent runner (TypeScript compiled)
// Usage: node boot-agent.js <TICKET>
require("./register-aliases");

const ticket = process.argv[2];
if (!ticket) {
  console.error("Usage: node boot-agent.js <TICKET>");
  process.exit(1);
}

const { runPipeline } = require("./dist/pipeline/agent-runner");
const { loadConfig } = require("./dist/config/loader");

(async () => {
  try {
    const config = loadConfig(ticket);
    await runPipeline(ticket, config);
  } catch (err) {
    console.error(`Pipeline failed for ${ticket}:`, err);
    process.exit(1);
  }
})();
