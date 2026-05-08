// =====================================================================
// MI Dev Agent -- Gate: Dual Approval (TypeScript port of stages/gate-dual.js)
// =====================================================================
//
// Stage 9: Require both owner AND QA to approve before production.
//
// Features:
//   - T1.10: Validate both approvers are configured and distinct
//   - Dual approval enforcement (exactly 2 required)
//   - Jira comment + Slack notification
//   - Poll for both approvals via Web UI or Jira
//   - Reuses the shared waitForApproval poller
// =====================================================================

import { logStep, logOk, logWait } from '../../lib/logger';
import { save } from '../../state/state-manager';
import { loadConfig, loadExtendedConfig } from '../../config/loader';
import { JiraService } from '../../services/jira';
import { SlackService } from '../../services/slack';
import { waitForApproval } from './gate-preprod';
import type { PipelineState, StageHandler } from '@shared/types';

// ── Types ────────────────────────────────────────────────────────────

interface GateDualDeps {
  jira: JiraService;
  slack: SlackService;
}

// ── Stage Handler ────────────────────────────────────────────────

export function createGateDualHandler(deps: GateDualDeps): StageHandler {
  const { jira, slack } = deps;

  return async function stageGateDualApproval(state: PipelineState): Promise<void> {
    const cfg = loadConfig();
    const ext = loadExtendedConfig();
    const data = state.data as Record<string, unknown>;
    const ticket = state.ticket;

    logStep(9, 'GATE 2b -- Dual Approval (Owner + QA)');

    if (!data.gate2b_posted) {
      await jira.addComment(
        ticket,
        `Dual Approval Required\n\n` +
        `Pre-Prod MR: ${data.preprod_mr_url}\n\n` +
        `BOTH must approve:\n` +
        `1. Owner\n` +
        `2. QA Malhotra\n\n` +
        `Both: comment "approved" on this ticket.`,
      );

      await slack.send(
        `Dual Approval Required -- ${ticket}\n` +
        `Pre-Prod MR ready. BOTH of you must approve.\n` +
        `Jira: ${jira.issueUrl(ticket)}`,
        [cfg.slack.ownerSlackId || '', ext.qaSlackId || ''],
      );

      data.gate2b_posted = true;
      data.gate2b_at = new Date().toISOString();
      save(state);
      logOk('Dual approval request sent');
    }

    logWait('Waiting for BOTH approvals (Web UI or Jira)...');

    // T1.10: Validate both approvers are configured and distinct
    const ownerId = cfg.owner.jiraId;
    const qaId = ext.qaJiraId;
    if (!ownerId || !qaId) {
      throw new Error(
        'Dual approval requires both owner and qa Jira IDs configured (OWNER_JIRA_ID, QA_JIRA_ID)',
      );
    }
    if (ownerId === qaId) {
      throw new Error(
        'Dual approval requires two different approvers -- OWNER_JIRA_ID and QA_JIRA_ID are the same',
      );
    }

    const requiredIds = [ownerId, qaId];
    const count = 2; // Always require exactly 2 approvals

    const result = await waitForApproval(
      state,
      { jira, slack },
      'gate2b_at',
      count,
      requiredIds,
      'gate2b',
    );
    if (!result.approved) throw new Error('Dual approval rejected');

    logOk('Both approvals received!');
    state.stage = 'deploy_prod';
    save(state);
  };
}
