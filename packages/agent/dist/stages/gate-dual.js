"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stageGateDualApproval = stageGateDualApproval;
const { cfg, TICKET } = require("../lib/config");
const { logStep, logOk, logWait } = require("../lib/logging");
const { save } = require("../lib/state");
const { jira, jiraUrl } = require("../lib/jira");
const { slack } = require("../lib/slack");
const { waitForApproval } = require("../lib/approval");
const { isChannelEnabled } = require("../lib/notification-config");
async function stageGateDualApproval(state) {
    logStep(9, "GATE 2b — Dual Approval (You + QA)");
    if (!state.data.gate2b_posted) {
        if (isChannelEnabled("gate_dual_approval", "jira")) {
            await jira.addComment(TICKET, `Dual Approval Required\n\n` +
                `Pre-Prod MR: ${state.data.preprod_mr_url}\n\n` +
                `\u26a0\ufe0f BOTH must approve:\n` +
                `1. You (owner)\n` +
                `2. QA Malhotra\n\n` +
                `Both: comment "approved" on this ticket.`);
        }
        if (isChannelEnabled("gate_dual_approval", "slack")) {
            await slack(`\ud83d\udd14 *Dual Approval Required — ${TICKET}*\n` +
                `Pre-Prod MR ready. *BOTH* of you must approve.\n` +
                `\ud83d\udccb ${jiraUrl(TICKET)}`, [cfg.slack.ownerId, cfg.slack.qaId]);
        }
        state.data.gate2b_posted = true;
        state.data.gate2b_at = new Date().toISOString();
        save(state);
        logOk("Dual approval request sent");
    }
    logWait("Waiting for BOTH approvals (Web UI or Jira)…");
    // T1.10: Validate both approvers are configured and distinct
    if (!cfg.ids.owner || !cfg.ids.qa) {
        throw new Error("Dual approval requires both owner and qa Jira IDs configured (OWNER_JIRA_ID, QA_JIRA_ID)");
    }
    if (cfg.ids.owner === cfg.ids.qa) {
        throw new Error("Dual approval requires two different approvers — OWNER_JIRA_ID and QA_JIRA_ID are the same");
    }
    const requiredIds = [cfg.ids.owner, cfg.ids.qa];
    const count = 2; // Always require exactly 2 approvals
    const result = await waitForApproval(state, "gate2b_at", count, requiredIds, "gate2b");
    if (!result.approved)
        throw new Error("Dual approval rejected");
    logOk("Both approvals received!");
    state.stage = "deploy_prod";
    save(state);
}
//# sourceMappingURL=gate-dual.js.map