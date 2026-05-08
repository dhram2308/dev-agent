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

import { logStep, logOk, logWarn, logWait, logInfo, logErr } from '../../lib/logger';
import { sleep, matchApprovalWord } from '../../lib/utils';
import { save, checkUIApproval } from '../../state/state-manager';
import { loadConfig, loadExtendedConfig } from '../../config/loader';
import { JiraService } from '../../services/jira';
import { SlackService } from '../../services/slack';
import type { PipelineState, StageHandler } from '@shared/types';

// ── Types ────────────────────────────────────────────────────────────

interface GatePreprodDeps {
  jira: JiraService;
  slack: SlackService;
}

// ── Monotonic clock helper ──────────────────────────────────────

function monotonicMs(): number {
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
export async function waitForApproval(
  state: PipelineState,
  deps: { jira: JiraService; slack: SlackService },
  sinceKey: string,
  requiredCount: number = 1,
  requiredIds: string[] = [],
  uiPrefix: string | null = null,
): Promise<{ approved: boolean; by?: string[]; feedback?: string }> {
  const cfg = loadConfig();
  const ext = loadExtendedConfig();
  const data = state.data as Record<string, unknown>;
  const ticket = state.ticket;

  const since = data[sinceKey] as string;
  const approvedBy = new Set<string>((data[`${sinceKey}_approvals`] as string[]) || []);
  const notifiedUsers = new Set<string>((data[`${sinceKey}_notified_users`] as string[]) || []);

  const reminderKey1h = `${sinceKey}_reminder_1h`;
  const reminderKey4h = `${sinceKey}_reminder_4h`;

  const maxApprovalTimeout = ext.approvalReminder4h * 2; // 8h default
  const pollStart = monotonicMs();
  let approvalPollCount = 0;

  while (approvedBy.size < requiredCount) {
    if (monotonicMs() - pollStart > maxApprovalTimeout) {
      logErr(`Approval timeout after ${maxApprovalTimeout / 3_600_000}h`);
      await deps.slack.send(
        `Timeout -- Approval -- ${ticket}\nWaiting for approval exceeded ${maxApprovalTimeout / 3_600_000}h. Pipeline halted.`,
        [cfg.slack.ownerSlackId || ''],
      );
      save(state);
      throw new Error(`Approval timeout after ${maxApprovalTimeout / 3_600_000}h`);
    }

    // 1h reminder
    if (!data[reminderKey1h] && monotonicMs() - pollStart > ext.approvalReminder1h) {
      logInfo('Sending 1h approval reminder...');
      await deps.slack.send(
        `Reminder -- ${ticket}\nApproval pending for 1 hour. Please review.\nJira: ${deps.jira.issueUrl(ticket)}`,
        [cfg.slack.ownerSlackId || ''],
      );
      data[reminderKey1h] = new Date().toISOString();
      save(state);
    }

    // 4h escalation
    if (!data[reminderKey4h] && monotonicMs() - pollStart > ext.approvalReminder4h) {
      logWarn('Sending 4h escalation reminder...');
      await deps.slack.send(
        `Escalation -- ${ticket}\nApproval pending for 4 hours! Pipeline is blocked.\nJira: ${deps.jira.issueUrl(ticket)}`,
        [cfg.slack.ownerSlackId || '', ext.qaSlackId || ''],
      );
      data[reminderKey4h] = new Date().toISOString();
      save(state);
    }

    // Check Web UI
    if (uiPrefix) {
      const uiResult = checkUIApproval(ticket, uiPrefix);
      if (uiResult) {
        if (uiResult.approved) {
          const uiApprover = 'ui-unknown';
          if (!approvedBy.has(uiApprover)) {
            approvedBy.add(uiApprover);
            data[`${sinceKey}_approvals`] = [...approvedBy];
            save(state);
            logOk(`Approved via Web UI (${approvedBy.size}/${requiredCount})`);
          }
          if (approvedBy.size >= requiredCount) {
            return { approved: true, by: [...approvedBy] };
          }
        } else {
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
          if (
            matchApprovalWord(text, 'rejected', ['not rejected']) ||
            matchApprovalWord(text, 'revoked', ['not revoked'])
          ) {
            approvedBy.delete(authorId);
            data[`${sinceKey}_approvals`] = [...approvedBy];
            save(state);
            logWarn(`Approval revoked by ${c.author?.displayName || 'Unknown'} -- ${approvedBy.size}/${requiredCount}`);
          }
        }
      }

      // Check for new approvals
      for (const c of comments) {
        const text = (typeof c.body === 'string' ? c.body : '').toLowerCase().trim();
        const authorId = c.author?.accountId || 'unknown';

        if (matchApprovalWord(text, 'rejected', ['not rejected'])) {
          return { approved: false, by: [c.author?.displayName || 'Unknown'], feedback: typeof c.body === 'string' ? c.body : '' };
        }

        if (matchApprovalWord(text, 'approved', ['not approved', 'unapproved', 'disapproved', 'needs approval'])) {
          if (requiredIds.length && !requiredIds.includes(authorId)) {
            const authorName = c.author?.displayName || 'Unknown';
            if (!notifiedUsers.has(authorId)) {
              notifiedUsers.add(authorId);
              data[`${sinceKey}_notified_users`] = [...notifiedUsers];
              save(state);
              logInfo(`${authorName} approved but not in required approvers -- notifying`);
              try {
                await deps.jira.addComment(ticket, `Thanks ${authorName}, but only the designated approvers can approve this gate.`);
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                logWarn(`Could not notify unauthorized approver: ${msg}`);
              }
            }
            continue;
          }
          if (!approvedBy.has(authorId)) {
            approvedBy.add(authorId);
            data[`${sinceKey}_approvals`] = [...approvedBy];
            save(state);
            logOk(`Approved by ${c.author?.displayName || 'Unknown'} (${approvedBy.size}/${requiredCount})`);
          }
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn(`Approval polling error: ${msg} -- will retry`);
    }

    if (approvedBy.size >= requiredCount) break;
    approvalPollCount++;
    if (approvalPollCount % 6 === 0) {
      const waitMins = Math.floor((monotonicMs() - pollStart) / 60_000);
      logInfo(`Polling approvals... (${approvedBy.size}/${requiredCount}) ${waitMins}m elapsed`);
    }
    await sleep(ext.pollInterval);
  }

  return { approved: true, by: [...approvedBy] };
}

// ── Stage Handler ────────────────────────────────────────────────

export function createGatePreprodHandler(deps: GatePreprodDeps): StageHandler {
  const { jira, slack } = deps;

  return async function stageGatePreprodApproval(state: PipelineState): Promise<void> {
    const cfg = loadConfig();
    const data = state.data as Record<string, unknown>;
    const ticket = state.ticket;

    logStep(7, 'GATE 2a -- Pre-Prod Approval');

    if (!data.gate2a_posted) {
      const qaTest = (data.qa_test as Array<{ ok: boolean; name: string }>) || [];
      const summary = qaTest
        .map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`)
        .join('\n');

      await jira.addComment(
        ticket,
        `QA Verified\n\n` +
        `Module status:\n${summary}\n\n` +
        `Approve: Comment "approved" to promote to Pre-Prod.`,
      );

      await slack.send(
        `Pre-Prod Approval -- ${ticket}\n` +
        `QA verified for: ${(data.ticket as { summary?: string })?.summary || ''}\n` +
        `Approve: ${jira.issueUrl(ticket)}`,
        [cfg.slack.ownerSlackId || ''],
      );

      data.gate2a_posted = true;
      data.gate2a_at = new Date().toISOString();
      save(state);
      logOk('Approval request sent');
    }

    logWait('Waiting for pre-prod approval (Web UI or Jira)...');
    const result = await waitForApproval(state, { jira, slack }, 'gate2a_at', 1, [], 'gate2a');
    if (!result.approved) throw new Error('Pre-prod rejected');

    state.stage = 'create_preprod_mr';
    save(state);
  };
}
