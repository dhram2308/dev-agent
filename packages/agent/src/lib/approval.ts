/**
 * approval.ts -- Approval gate polling logic
 *
 * Converted from lib/approval.js (zero functional changes).
 * Uses shared types from @mi/shared for ApprovalGate.
 */

import type {
  ApprovalGate,
  ApprovalCheckResult,
  PipelineState,
} from '@mi/shared';

const { cfg, TICKET, POLL_INTERVAL, MAX_APPROVAL_TIMEOUT, APPROVAL_REMINDER_1H, APPROVAL_REMINDER_4H, monotonicMs } = require('./config') as {
  cfg: {
    slack: { ownerId: string; anshitId: string };
    ids: { owner: string; anshit: string };
    [key: string]: any;
  };
  TICKET: string;
  POLL_INTERVAL: number;
  MAX_APPROVAL_TIMEOUT: number;
  APPROVAL_REMINDER_1H: number;
  APPROVAL_REMINDER_4H: number;
  monotonicMs: () => number;
};
const { logOk, logErr, logInfo, logWarn } = require('./logging') as {
  logOk: (msg: string) => void;
  logErr: (msg: string) => void;
  logInfo: (msg: string) => void;
  logWarn: (msg: string) => void;
};
const { sleep } = require('./http-client') as {
  sleep: (ms: number) => Promise<void>;
};
const { matchApprovalWord } = require('./utils') as {
  matchApprovalWord: (text: string, word: string, exclusions: string[]) => boolean;
};
const { adfText } = require('./adf') as {
  adfText: (body: any) => string;
};
const { save, checkUIApproval } = require('./state') as {
  save: (state: any) => void;
  checkUIApproval: (state: any, prefix: string) => any;
};
const { jira, jiraUrl } = require('./jira') as {
  jira: {
    getComments: (key: string, since?: string) => Promise<any[]>;
    addComment: (key: string, text: string) => Promise<any>;
  };
  jiraUrl: (key: string) => string;
};
const { slack } = require('./slack') as {
  slack: (text: string, mentionIds?: string[], options?: any) => Promise<any>;
};
const { isShuttingDown } = require('./graceful-shutdown') as {
  isShuttingDown: () => boolean;
};

interface ApprovalResult {
  approved: boolean;
  by?: string | string[];
  feedback?: string;
}

async function waitForApproval(
  state: any,
  sinceKey: string,
  requiredCount: number = 1,
  requiredIds: string[] = [],
  uiPrefix: string | null = null,
): Promise<ApprovalResult> {
  const since: string = state.data[sinceKey];
  const approvedBy = new Set<string>(state.data[`${sinceKey}_approvals`] || []);
  const notifiedUsers = new Set<string>(state.data[`${sinceKey}_notified_users`] || []);

  const reminderKey1h = `${sinceKey}_reminder_1h`;
  const reminderKey4h = `${sinceKey}_reminder_4h`;

  const pollStart = monotonicMs();
  let approvalPollCount = 0;
  while (approvedBy.size < requiredCount) {
    if (isShuttingDown()) {
      save(state);
      throw new Error("Shutdown in progress — exiting approval polling");
    }
    if (monotonicMs() - pollStart > MAX_APPROVAL_TIMEOUT) {
      logErr(`Approval timeout after ${MAX_APPROVAL_TIMEOUT / 3600000}h`);
      await slack(`\u23F0 *Approval Timeout — ${TICKET}*\nWaiting for approval exceeded ${MAX_APPROVAL_TIMEOUT / 3600000}h. Pipeline halted.`, [cfg.slack.ownerId]);
      save(state);
      throw new Error(`Approval timeout after ${MAX_APPROVAL_TIMEOUT / 3600000}h`);
    }

    if (!state.data[reminderKey1h] && (monotonicMs() - pollStart) > APPROVAL_REMINDER_1H) {
      logInfo("X4: Sending 1h approval reminder…");
      await slack(
        `\u23F0 *Reminder — ${TICKET}*\nApproval pending for 1 hour. Please review.\n\u{1F4CB} ${jiraUrl(TICKET)}`,
        [cfg.slack.ownerId],
      );
      state.data[reminderKey1h] = new Date().toISOString();
      save(state);
    }

    if (!state.data[reminderKey4h] && (monotonicMs() - pollStart) > APPROVAL_REMINDER_4H) {
      logWarn("X4: Sending 4h escalation reminder…");
      await slack(
        `\u{1F6A8} *Escalation — ${TICKET}*\nApproval pending for 4 hours! Pipeline is blocked.\n\u{1F4CB} ${jiraUrl(TICKET)}`,
        [cfg.slack.ownerId, cfg.slack.anshitId],
      );
      state.data[reminderKey4h] = new Date().toISOString();
      save(state);
    }

    if (uiPrefix) {
      const uiResult = checkUIApproval(state, uiPrefix);
      if (uiResult) {
        if (uiResult.approved) {
          const uiApprover = "ui-" + (uiResult.by || "unknown");
          if (!approvedBy.has(uiApprover)) {
            approvedBy.add(uiApprover);
            state.data[`${sinceKey}_approvals`] = [...approvedBy];
            save(state);
            logOk(`Approved via Web UI (${approvedBy.size}/${requiredCount})`);
          }
          if (approvedBy.size >= requiredCount) {
            return { approved: true, by: [...approvedBy] };
          }
          // Need more approvals — continue polling Jira
        } else {
          return { approved: false, by: "Web UI", feedback: uiResult.feedback || "" };
        }
      }
    }

    const comments = await jira.getComments(TICKET, since);

    // E5: Check if any previously-approved comment was edited to revoke
    for (const c of comments) {
      const authorId: string = c.author?.accountId || "unknown";
      const text = adfText(c.body).toLowerCase().trim();
      if (approvedBy.has(authorId)) {
        if (matchApprovalWord(text, "rejected", ["not rejected"]) ||
            matchApprovalWord(text, "revoked", ["not revoked"])) {
          approvedBy.delete(authorId);
          state.data[`${sinceKey}_approvals`] = [...approvedBy];
          save(state);
          logWarn(`Approval revoked by ${c.author?.displayName || "Unknown"} (edited comment) — ${approvedBy.size}/${requiredCount}`);
        }
      }
    }

    for (const c of comments) {
      const text = adfText(c.body).toLowerCase().trim();
      const authorId: string = c.author?.accountId || "unknown";

      if (matchApprovalWord(text, "rejected", ["not rejected"])) {
        return { approved: false, by: c.author?.displayName || "Unknown", feedback: adfText(c.body) };
      }

      if (matchApprovalWord(text, "approved", ["not approved", "unapproved", "disapproved", "needs approval"])) {
        if (requiredIds.length && !requiredIds.includes(authorId)) {
          const authorName: string = c.author?.displayName || "Unknown";
          if (!notifiedUsers.has(authorId)) {
            notifiedUsers.add(authorId);
            state.data[`${sinceKey}_notified_users`] = [...notifiedUsers];
            save(state);
            logInfo(`${authorName} approved but not in required approvers — notifying`);
            const requiredNames = requiredIds.map((id: string) => {
              if (id === cfg.ids.owner) return "Owner";
              if (id === cfg.ids.anshit) return "Anshit";
              return id;
            }).join(", ");
            try {
              await jira.addComment(TICKET,
                `Thanks ${authorName}, but only ${requiredNames} can approve this gate.`);
            } catch (e: any) {
              logWarn(`Could not notify unauthorized approver: ${e.message}`);
            }
          }
          continue;
        }
        if (!approvedBy.has(authorId)) {
          approvedBy.add(authorId);
          state.data[`${sinceKey}_approvals`] = [...approvedBy];
          save(state);
          logOk(`Approved by ${c.author.displayName} (${approvedBy.size}/${requiredCount})`);
        }
      }
    }

    if (approvedBy.size >= requiredCount) break;
    approvalPollCount++;
    if (approvalPollCount % 6 === 0) {
      const waitMins = Math.floor((monotonicMs() - pollStart) / 60000);
      logInfo(`Polling approvals… (${approvedBy.size}/${requiredCount}) ${waitMins}m elapsed`);
    }
    await sleep(POLL_INTERVAL);
  }

  return { approved: true };
}

module.exports = { waitForApproval };
