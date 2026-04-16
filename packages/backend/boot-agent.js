#!/usr/bin/env node
"use strict";

// Boot: Pipeline agent runner (TypeScript compiled)
// Usage: node boot-agent.js <TICKET>
//
// Wires runtime dependencies (Jira, GitLab, Slack, Claude services)
// and passes them to the pipeline runner so all stage handlers are live.
require("./register-aliases");

const ticket = process.argv[2];
if (!ticket) {
  console.error("Usage: node boot-agent.js <TICKET>");
  process.exit(1);
}

const { runPipeline } = require("./dist/pipeline/agent-runner");
const { loadConfig, loadExtendedConfig } = require("./dist/config/loader");
const { req } = require("./dist/http/client");
const { JiraService } = require("./dist/services/jira");
const { GitLabService } = require("./dist/services/gitlab");
const { SlackService } = require("./dist/services/slack");
const { ClaudeService, ClaudeCLIService } = require("./dist/services/claude");

(async () => {
  try {
    // Load config from .env (don't pass ticket as envPath)
    const config = loadConfig();
    config.ticket = ticket;

    // Construct runtime services
    const jira = new JiraService(config);
    const gl = new GitLabService(config);
    const slack = new SlackService(
      config.slack.token || "",
      req,
      { currentTicket: ticket }
    );

    // Claude: prefer API key, fall back to CLI (browser auth)
    let claude;
    const ext = loadExtendedConfig();
    const apiKey = ext.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      claude = new ClaudeService(apiKey, req);
    } else {
      // Fallback: use `claude -p` CLI with browser authentication
      claude = new ClaudeCLIService({ model: ext.claudeModel });
    }

    const deps = { gl, jira, slack, claude };
    await runPipeline(ticket, config, deps);
  } catch (err) {
    console.error(`Pipeline failed for ${ticket}:`, err);
    process.exit(1);
  }
})();