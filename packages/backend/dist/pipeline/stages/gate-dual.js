"use strict";
// =====================================================================
// MI Dev Agent -- Gate: Dual Approval (TypeScript port of stages/gate-dual.js)
// =====================================================================
//
// Stage 9: Require both owner AND Anshit to approve before production.
//
// Features:
//   - T1.10: Validate both approvers are configured and distinct
//   - Dual approval enforcement (exactly 2 required)
//   - Jira comment + Slack notification
//   - Poll for both approvals via Web UI or Jira
//   - Reuses the shared waitForApproval poller
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGateDualHandler = createGateDualHandler;
const logger_1 = require("../../lib/logger");
const state_manager_1 = require("../../state/state-manager");
const loader_1 = require("../../config/loader");
const gate_preprod_1 = require("./gate-preprod");
// ── Stage Handler ────────────────────────────────────────────────
function createGateDualHandler(deps) {
    const { jira, slack } = deps;
    return async function stageGateDualApproval(state) {
        const cfg = (0, loader_1.loadConfig)();
        const ext = (0, loader_1.loadExtendedConfig)();
        const data = state.data;
        const ticket = state.ticket;
        (0, logger_1.logStep)(9, 'GATE 2b -- Dual Approval (Owner + Anshit)');
        if (!data.gate2b_posted) {
            await jira.addComment(ticket, `Dual Approval Required\n\n` +
                `Pre-Prod MR: ${data.preprod_mr_url}\n\n` +
                `BOTH must approve:\n` +
                `1. Owner\n` +
                `2. Anshit Malhotra\n\n` +
                `Both: comment "approved" on this ticket.`);
            await slack.send(`Dual Approval Required -- ${ticket}\n` +
                `Pre-Prod MR ready. BOTH of you must approve.\n` +
                `Jira: ${jira.issueUrl(ticket)}`, [cfg.slack.ownerSlackId || '', ext.anshitSlackId || '']);
            data.gate2b_posted = true;
            data.gate2b_at = new Date().toISOString();
            (0, state_manager_1.save)(state);
            (0, logger_1.logOk)('Dual approval request sent');
        }
        (0, logger_1.logWait)('Waiting for BOTH approvals (Web UI or Jira)...');
        // T1.10: Validate both approvers are configured and distinct
        const ownerId = cfg.owner.jiraId;
        const anshitId = ext.anshitJiraId;
        if (!ownerId || !anshitId) {
            throw new Error('Dual approval requires both owner and anshit Jira IDs configured (OWNER_JIRA_ID, ANSHIT_JIRA_ID)');
        }
        if (ownerId === anshitId) {
            throw new Error('Dual approval requires two different approvers -- OWNER_JIRA_ID and ANSHIT_JIRA_ID are the same');
        }
        const requiredIds = [ownerId, anshitId];
        const count = 2; // Always require exactly 2 approvals
        const result = await (0, gate_preprod_1.waitForApproval)(state, { jira, slack }, 'gate2b_at', count, requiredIds, 'gate2b');
        if (!result.approved)
            throw new Error('Dual approval rejected');
        (0, logger_1.logOk)('Both approvals received!');
        state.stage = 'deploy_prod';
        (0, state_manager_1.save)(state);
    };
}
//# sourceMappingURL=gate-dual.js.map