"use strict";

const { cfg, TICKET } = require("../lib/config");
const { logStep, logOk, logWait } = require("../lib/logging");
const { save } = require("../lib/state");
const { jira, jiraUrl } = require("../lib/jira");
const { slack } = require("../lib/slack");
const { waitForApproval } = require("../lib/approval");
const { isChannelEnabled } = require("../lib/notification-config");

async function stageGatePreprodApproval(state) {
  logStep(7, "GATE 2a — Pre-Prod Approval");

  if (!state.data.gate2a_posted) {
    const summary = (state.data.qa_test || [])
      .map((r) => `${r.ok ? "✅" : "❌"} ${r.name}`)
      .join("\n");

    if (isChannelEnabled("gate_preprod_approval", "jira")) {
      await jira.addComment(TICKET,
        `QA Verified\n\n` +
        `Module status:\n${summary}\n\n` +
        `QA: ${cfg.urls.qa}\n\n` +
        `✅ Comment "approved" to promote to Pre-Prod.`,
      );
    }

    if (isChannelEnabled("gate_preprod_approval", "slack")) {
      await slack(
        `🔔 *Pre-Prod Approval — ${TICKET}*\n` +
        `QA verified for: *${state.data.ticket.summary}*\n` +
        `📋 Approve: ${jiraUrl(TICKET)}`,
        [cfg.slack.ownerId],
      );
    }

    state.data.gate2a_posted = true;
    state.data.gate2a_at = new Date().toISOString();
    save(state);
    logOk("Approval request sent");
  }

  logWait("Waiting for pre-prod approval (Web UI or Jira)…");
  const result = await waitForApproval(state, "gate2a_at", 1, [], "gate2a");
  if (!result.approved) throw new Error("Pre-prod rejected");

  state.stage = "create_preprod_mr";
  save(state);
}

module.exports = { stageGatePreprodApproval };
