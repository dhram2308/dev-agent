"use strict";
// =====================================================================
// MI Dev Agent -- Gate: Pre-Prod Approval (TypeScript port of stages/gate-preprod.js)
// =====================================================================
//
// Stage 7: Request pre-prod approval via Jira comment + Slack, then
// poll for approval via Web UI or Jira comments.
//
// Features:
//   - Post QA test summary to Jira
//   - Slack notification to owner
//   - Poll for approval (Jira comments + Web UI)
//   - Approval reminders at 1h and 4h
//   - Shutdown-aware polling
//   - Approval revocation detection
//   - Unauthorized approver notification
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitForApproval = waitForApproval;
exports.createGatePreprodHandler = createGatePreprodHandler;
const logger_1 = require("../../lib/logger");
const utils_1 = require("../../lib/utils");
const state_manager_1 = require("../../state/state-manager");
const loader_1 = require("../../config/loader");
const notification_gates_1 = require("../../lib/notification-gates");
// ── Monotonic clock helper ──────────────────────────────────────
function monotonicMs() {
    const [sec, nsec] = process.hrtime();
    return sec * 1000 + Math.floor(nsec / 1_000_000);
}
// ── Generic approval poller ─────────────────────────────────────
/**
 * Wait for approval via Jira comments and/or Web UI.
 *
 * @param state - Pipeline state
 * @param deps - Jira + Slack service instances
 * @param sinceKey - Data key holding the ISO timestamp of when the request was posted
 * @param requiredCount - Number of approvals required
 * @param requiredIds - Jira account IDs that must approve (empty = anyone)
 * @param uiPrefix - UI gate prefix for checkUIApproval
 * @returns Approval result
 */
async function waitForApproval(state, deps, sinceKey, requiredCount = 1, requiredIds = [], uiPrefix = null, gate = 'gate_preprod_approval') {
    const cfg = (0, loader_1.loadConfig)();
    const ext = (0, loader_1.loadExtendedConfig)();
    const data = state.data;
    const ticket = state.ticket;
    const since = data[sinceKey];
    const approvedBy = new Set(data[`${sinceKey}_approvals`] || []);
    const notifiedUsers = new Set(data[`${sinceKey}_notified_users`] || []);
    const reminderKey1h = `${sinceKey}_reminder_1h`;
    const reminderKey4h = `${sinceKey}_reminder_4h`;
    const maxApprovalTimeout = ext.approvalReminder4h * 2; // 8h default
    const pollStart = monotonicMs();
    let approvalPollCount = 0;
    while (approvedBy.size < requiredCount) {
        if (monotonicMs() - pollStart > maxApprovalTimeout) {
            (0, logger_1.logErr)(`Approval timeout after ${maxApprovalTimeout / 3_600_000}h`);
            if ((0, notification_gates_1.isChannelEnabled)(gate, 'slack')) {
                await deps.slack.send(`Timeout -- Approval -- ${ticket}\nWaiting for approval exceeded ${maxApprovalTimeout / 3_600_000}h. Pipeline halted.`, [cfg.slack.ownerSlackId || '']);
            }
            (0, state_manager_1.save)(state);
            throw new Error(`Approval timeout after ${maxApprovalTimeout / 3_600_000}h`);
        }
        // 1h reminder
        if (!data[reminderKey1h] && monotonicMs() - pollStart > ext.approvalReminder1h) {
            (0, logger_1.logInfo)('Sending 1h approval reminder...');
            if ((0, notification_gates_1.isChannelEnabled)(gate, 'reminder1h')) {
                await deps.slack.send(`Reminder -- ${ticket}\nApproval pending for 1 hour. Please review.\nJira: ${deps.jira.issueUrl(ticket)}`, [cfg.slack.ownerSlackId || '']);
            }
            data[reminderKey1h] = new Date().toISOString();
            (0, state_manager_1.save)(state);
        }
        // 4h escalation
        if (!data[reminderKey4h] && monotonicMs() - pollStart > ext.approvalReminder4h) {
            (0, logger_1.logWarn)('Sending 4h escalation reminder...');
            if ((0, notification_gates_1.isChannelEnabled)(gate, 'reminder4h')) {
                await deps.slack.send(`Escalation -- ${ticket}\nApproval pending for 4 hours! Pipeline is blocked.\nJira: ${deps.jira.issueUrl(ticket)}`, [cfg.slack.ownerSlackId || '', ext.qaSlackId || '']);
            }
            data[reminderKey4h] = new Date().toISOString();
            (0, state_manager_1.save)(state);
        }
        // Check Web UI
        if (uiPrefix) {
            const uiResult = (0, state_manager_1.checkUIApproval)(ticket, uiPrefix);
            if (uiResult) {
                if (uiResult.approved) {
                    const uiApprover = 'ui-unknown';
                    if (!approvedBy.has(uiApprover)) {
                        approvedBy.add(uiApprover);
                        data[`${sinceKey}_approvals`] = [...approvedBy];
                        (0, state_manager_1.save)(state);
                        (0, logger_1.logOk)(`Approved via Web UI (${approvedBy.size}/${requiredCount})`);
                    }
                    if (approvedBy.size >= requiredCount) {
                        return { approved: true, by: [...approvedBy] };
                    }
                }
                else {
                    return { approved: false, by: ['Web UI'], feedback: uiResult.feedback || '' };
                }
            }
        }
        // Check Jira comments
        try {
            const comments = await deps.jira.getComments(ticket, since);
            // Check for revocation of previous approvals (E5)
            for (const c of comments) {
                const authorId = c.author?.accountId || 'unknown';
                const text = (typeof c.body === 'string' ? c.body : '').toLowerCase().trim();
                if (approvedBy.has(authorId)) {
                    if ((0, utils_1.matchApprovalWord)(text, 'rejected', ['not rejected']) ||
                        (0, utils_1.matchApprovalWord)(text, 'revoked', ['not revoked'])) {
                        approvedBy.delete(authorId);
                        data[`${sinceKey}_approvals`] = [...approvedBy];
                        (0, state_manager_1.save)(state);
                        (0, logger_1.logWarn)(`Approval revoked by ${c.author?.displayName || 'Unknown'} -- ${approvedBy.size}/${requiredCount}`);
                    }
                }
            }
            // Check for new approvals
            for (const c of comments) {
                const text = (typeof c.body === 'string' ? c.body : '').toLowerCase().trim();
                const authorId = c.author?.accountId || 'unknown';
                if ((0, utils_1.matchApprovalWord)(text, 'rejected', ['not rejected'])) {
                    return { approved: false, by: [c.author?.displayName || 'Unknown'], feedback: typeof c.body === 'string' ? c.body : '' };
                }
                if ((0, utils_1.matchApprovalWord)(text, 'approved', ['not approved', 'unapproved', 'disapproved', 'needs approval'])) {
                    if (requiredIds.length && !requiredIds.includes(authorId)) {
                        const authorName = c.author?.displayName || 'Unknown';
                        if (!notifiedUsers.has(authorId)) {
                            notifiedUsers.add(authorId);
                            data[`${sinceKey}_notified_users`] = [...notifiedUsers];
                            (0, state_manager_1.save)(state);
                            (0, logger_1.logInfo)(`${authorName} approved but not in required approvers -- notifying`);
                            try {
                                if ((0, notification_gates_1.isChannelEnabled)(gate, 'jira')) {
                                    await deps.jira.addComment(ticket, `Thanks ${authorName}, but only the designated approvers can approve this gate.`);
                                }
                            }
                            catch (e) {
                                const msg = e instanceof Error ? e.message : String(e);
                                (0, logger_1.logWarn)(`Could not notify unauthorized approver: ${msg}`);
                            }
                        }
                        continue;
                    }
                    if (!approvedBy.has(authorId)) {
                        approvedBy.add(authorId);
                        data[`${sinceKey}_approvals`] = [...approvedBy];
                        (0, state_manager_1.save)(state);
                        (0, logger_1.logOk)(`Approved by ${c.author?.displayName || 'Unknown'} (${approvedBy.size}/${requiredCount})`);
                    }
                }
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logWarn)(`Approval polling error: ${msg} -- will retry`);
        }
        if (approvedBy.size >= requiredCount)
            break;
        approvalPollCount++;
        if (approvalPollCount % 6 === 0) {
            const waitMins = Math.floor((monotonicMs() - pollStart) / 60_000);
            (0, logger_1.logInfo)(`Polling approvals... (${approvedBy.size}/${requiredCount}) ${waitMins}m elapsed`);
        }
        await (0, utils_1.sleep)(ext.pollInterval);
    }
    return { approved: true, by: [...approvedBy] };
}
// ── Stage Handler ────────────────────────────────────────────────
function createGatePreprodHandler(deps) {
    const { jira, slack } = deps;
    return async function stageGatePreprodApproval(state) {
        const cfg = (0, loader_1.loadConfig)();
        const data = state.data;
        const ticket = state.ticket;
        (0, logger_1.logStep)(7, 'GATE 2a -- Pre-Prod Approval');
        if (!data.gate2a_posted) {
            const qaTest = data.qa_test || [];
            const summary = qaTest
                .map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`)
                .join('\n');
            if ((0, notification_gates_1.isChannelEnabled)('gate_preprod_approval', 'jira')) {
                await jira.addComment(ticket, `QA Verified\n\n` +
                    `Module status:\n${summary}\n\n` +
                    `Approve: Comment "approved" to promote to Pre-Prod.`);
            }
            if ((0, notification_gates_1.isChannelEnabled)('gate_preprod_approval', 'slack')) {
                await slack.send(`Pre-Prod Approval -- ${ticket}\n` +
                    `QA verified for: ${data.ticket?.summary || ''}\n` +
                    `Approve: ${jira.issueUrl(ticket)}`, [cfg.slack.ownerSlackId || '']);
            }
            data.gate2a_posted = true;
            data.gate2a_at = new Date().toISOString();
            (0, state_manager_1.save)(state);
            (0, logger_1.logOk)('Approval request sent');
        }
        (0, logger_1.logWait)('Waiting for pre-prod approval (Web UI or Jira)...');
        const result = await waitForApproval(state, { jira, slack }, 'gate2a_at', 1, [], 'gate2a');
        if (!result.approved)
            throw new Error('Pre-prod rejected');
        state.stage = 'create_preprod_mr';
        (0, state_manager_1.save)(state);
    };
}
//# sourceMappingURL=gate-preprod.js.map