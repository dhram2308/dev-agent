"use strict";

const fs = require("fs");
const path = require("path");
const { cfg, TICKET, STATE_FILE } = require("../lib/config");
const { logStep, logOk, logErr, logInfo, logWarn, C } = require("../lib/logging");
const { save } = require("../lib/state");
const { jira, jiraUrl } = require("../lib/jira");
const { slack } = require("../lib/slack");
const { isChannelEnabled } = require("../lib/notification-config");

async function stageDone(state) {
  logStep(11, "Done");

  // P12: Log warning summary
  if (state.data._warnings && state.data._warnings.length > 0) {
    logInfo(`Pipeline completed with ${state.data._warnings.length} warning(s):`);
    for (const w of state.data._warnings) {
      logWarn(`  [${w.stage}] ${w.message}`);
    }
  }

  try {

  if (!state.data.jira_closed) {
    try {
      await jira.transition(TICKET, "done");
      logOk("Jira → Done");
    } catch (e) {
      logErr(`Jira transition: ${e.message}`);
    }
    state.data.jira_closed = true;
    save(state);
  }

  if (!state.data.final_comment) {
    const elapsed = ((Date.now() - new Date(state.startedAt).getTime()) / 60000).toFixed(1);
    if (isChannelEnabled("done", "jira")) {
      await jira.addComment(TICKET,
        `Deployment Complete ✅\n` +
        `\n` +
        `${TICKET}: ${state.data.ticket.summary}\n` +
        `\n` +
        `📊 Summary:\n` +
        `• QA MR: ${state.data.qa_mr_url || "—"}\n` +
        `• Pre-Prod MR: ${state.data.preprod_mr_url || "—"}\n` +
        `• Production MR: ${state.data.prod_mr_url || "—"}\n` +
        `\n` +
        `🌐 Environments:\n` +
        `• QA: ${cfg.urls.qa}\n` +
        `• Pre-Prod: ${cfg.urls.preProd}\n` +
        `• Production: ${cfg.urls.prod}\n` +
        `\n` +
        `⏱ Total time: ${elapsed} minutes\n` +
        `All gates passed. Production is live.` +
        ((state.data._warnings && state.data._warnings.length > 0)
          ? `\n\nKnown Limitations:\n${state.data._warnings.map((w) => `• [${w.stage}] ${w.message}`).join("\n")}`
          : ""),
      );
    }
    state.data.final_comment = true;
    save(state);
  }

  if (!state.data.final_slack) {
    const elapsed = ((Date.now() - new Date(state.startedAt).getTime()) / 60000).toFixed(1);
    if (isChannelEnabled("done", "slack")) {
      await slack(
        `✅ *${TICKET} deployed to Production*\n` +
        `*${state.data.ticket.summary}*\n\n` +
        `🌐 ${cfg.urls.prod}\n` +
        `📋 ${jiraUrl(TICKET)}\n` +
        `🔀 ${state.data.prod_mr_url || "—"}\n` +
        `⏱ ${elapsed} min`,
        [cfg.slack.ownerId, cfg.slack.anshitId],
      );
    }
    state.data.final_slack = true;
    save(state);
  }

  console.log();
  console.log(`${C.bold}${C.green}  ╔═══════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.green}  ║   ${TICKET} — DEPLOYED TO PRODUCTION ✅        ║${C.reset}`);
  console.log(`${C.bold}${C.green}  ╚═══════════════════════════════════════════════╝${C.reset}`);
  console.log();

  } catch (err) {
    logErr(`Done stage error (non-fatal): ${err.message}`);
  }

  // E9: Archive state file on completion
  try {
    const archiveName = path.join(path.dirname(STATE_FILE), `state-${TICKET}.done.${Date.now()}.json`);
    if (fs.existsSync(STATE_FILE)) {
      fs.copyFileSync(STATE_FILE, archiveName);
      fs.unlinkSync(STATE_FILE);
    }
    // Remove lock file
    const lockFile = path.join(path.dirname(STATE_FILE), `state-${TICKET}.lock`);
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    logOk("State archived");
  } catch (err) {
    logWarn(`State archive failed: ${err.message}`);
  }
}

module.exports = { stageDone };
