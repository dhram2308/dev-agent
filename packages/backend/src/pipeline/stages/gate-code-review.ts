// =====================================================================
// MI Dev Agent -- Gate: Code Review (TypeScript port of stages/gate-code-review.js)
// =====================================================================
//
// Stage 4: Poll GitLab MR for approval/rejection, with Web UI support.
//
// Features:
//   - Poll MR for approvals (GitLab API)
//   - GL API calls wrapped in try-catch in poll loop (transient errors -> continue)
//   - UI approval support via checkUIApproval
//   - MR state detection: merged (skip), closed (reject), approved (pass)
//   - Rejection note detection with word-boundary regex (avoids false positives)
//   - Rejection counter (H4) with MAX_REJECTIONS halt
//   - Shutdown-aware polling with graceful exit
//   - Timeout with Slack notification
//   - Branch mismatch detection (E14)
//   - Clears generate_code state on rejection (T1.3)
// =====================================================================

import { logStep, logOk, logErr, logInfo, logWarn, logWait } from '../../lib/logger';
import { sleep } from '../../lib/utils';
import { save, checkUIApproval } from '../../state/state-manager';
import { loadConfig, loadExtendedConfig } from '../../config/loader';
import { GitLabService } from '../../services/gitlab';
import { SlackService } from '../../services/slack';
import { STAGE_CLEARS } from '@shared/constants';
import type { PipelineState, StageHandler } from '@shared/types';

// ── Types ────────────────────────────────────────────────────────────

interface GateCodeReviewDeps {
  gl: GitLabService;
  slack: SlackService;
}

// ── Constants ────────────────────────────────────────────────────────

const REJECTION_WORD_RE = /\brejected\b/i;
const NOT_REJECTED_RE = /\bnot\s+rejected\b/i;

// ── Shared cleanup function for ALL rejection paths (T1.3) ──────

function clearGenerateCodeState(state: PipelineState): void {
  const data = state.data as Record<string, unknown>;
  for (const f of STAGE_CLEARS.generate_code) {
    data[f] = null;
  }
  // Also clear UI gate flags and other fields not in STAGE_CLEARS
  data.gate1_ui_approved = null;
  data.gate1_ui_rejected = null;
  data.gate1_ui_feedback = null;
  data.original_files = null;
  data.plan = null;
  data.previousAttemptSummary = null;
  data._conflict_check_done = null;
  data._divergence_checked = null;
}

// ── Rejection counter helper (H4) ───────────────────────────────

export function incrementRejectionCounter(
  state: PipelineState,
  gate: string,
  maxRejections: number,
): boolean {
  const data = state.data as Record<string, unknown>;
  if (!data._gate_rejections) data._gate_rejections = {};
  const rejections = data._gate_rejections as Record<string, number>;
  rejections[gate] = (rejections[gate] || 0) + 1;
  const count = rejections[gate];
  logInfo(`Rejection counter for ${gate}: ${count}/${maxRejections}`);
  if (count >= maxRejections) {
    logErr(`${gate} rejected ${count} times -- MAX_REJECTIONS (${maxRejections}) reached`);
    return true; // halt
  }
  return false; // continue
}

// ── Preserve diff summary helper (P9) ───────────────────────────

function preserveDiffSummary(data: Record<string, unknown>): void {
  const codeChanges = data.codeChanges as { changes?: Array<{ action: string; file_path: string }> } | undefined;
  if (codeChanges?.changes) {
    data.previousAttemptSummary = codeChanges.changes
      .map((c) => `${c.action}: ${c.file_path}`)
      .join('\n');
  }
}

// ── Monotonic clock helper ──────────────────────────────────────

function monotonicMs(): number {
  const [sec, nsec] = process.hrtime();
  return sec * 1000 + Math.floor(nsec / 1_000_000);
}

// ── Stage Handler ────────────────────────────────────────────────

export function createGateCodeReviewHandler(deps: GateCodeReviewDeps): StageHandler {
  const { gl, slack } = deps;

  return async function stageGateCodeReview(state: PipelineState): Promise<void> {
    const cfg = loadConfig();
    const ext = loadExtendedConfig();
    const data = state.data as Record<string, unknown>;
    const ticket = state.ticket;

    logStep(4, 'GATE 1 -- Code Review (GitLab MR Approval)');

    const mrIid = data.code_mr_iid as number | undefined;
    if (!mrIid) throw new Error('No MR IID found -- code generation may have failed');

    if (!data.gate1_at) {
      data.gate1_at = new Date().toISOString();
      save(state);
    }

    logInfo(`MR: ${data.code_mr_url}`);
    logWait('Waiting for MR approval (Web UI or GitLab)...');

    // Poll GitLab MR for approval / rejection
    const gate1PollStart = monotonicMs();
    let gate1PollCount = 0;
    const maxApprovalTimeout = ext.approvalReminder4h * 2; // 8h default

    while (true) {
      if (monotonicMs() - gate1PollStart > maxApprovalTimeout) {
        logErr(`Gate 1 code review timeout after ${maxApprovalTimeout / 3_600_000}h`);
        await slack.send(`Timeout -- Code Review -- ${ticket}\nPipeline halted.`, [cfg.slack.ownerSlackId || '']);
        save(state);
        throw new Error(`Gate 1 code review timeout after ${maxApprovalTimeout / 3_600_000}h`);
      }

      // Check Web UI approval first
      const uiResult = checkUIApproval(ticket, 'gate1');
      if (uiResult) {
        if (uiResult.approved) {
          logOk('MR approved via Web UI');
          state.stage = 'deploy_qa';
          save(state);
          return;
        } else {
          logErr('Code rejected via Web UI');
          if (incrementRejectionCounter(state, 'gate1', cfg.limits.maxRejections)) {
            save(state);
            throw new Error(`Gate 1 rejected ${cfg.limits.maxRejections} times -- pipeline halted`);
          }
          data.feedback = uiResult.feedback || 'Rejected via Web UI';
          if (!data.rejectionHistory) data.rejectionHistory = [];
          const history = data.rejectionHistory as Array<Record<string, unknown>>;
          history.push({
            round: history.length + 1,
            feedback: data.feedback,
            timestamp: new Date().toISOString(),
          });
          preserveDiffSummary(data);
          clearGenerateCodeState(state);
          state.stage = 'generate_code';
          save(state);
          return;
        }
      }

      // Check MR state -- wrapped in try-catch for transient GitLab errors
      let mr;
      try {
        mr = await gl.getMR(mrIid);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logWarn(`[gate1] getMR transient error: ${msg} -- will retry next poll`);
        await sleep(ext.pollInterval);
        continue;
      }

      // If MR was merged directly -> approved
      if (mr.state === 'merged') {
        const mergedBy = mr.merged_by?.name || mr.merged_by?.username || 'unknown';
        const mrSourceBranch = mr.source_branch || '';
        const expectedBranch = (data.code_branch as string) || `enterprise-ts-${ticket}`;
        // Branch mismatch is a hard stop (T2.25)
        if (mrSourceBranch && mrSourceBranch !== expectedBranch) {
          throw new Error(
            `Wrong branch merged: expected "${expectedBranch}", got "${mrSourceBranch}". Manual investigation required.`,
          );
        }
        logOk(`MR already merged by ${mergedBy} -- skipping merge step`);
        data.ts_merged = true;
        state.stage = 'deploy_qa';
        save(state);
        return;
      }

      // If MR was closed -> rejected
      if (mr.state === 'closed') {
        logErr('MR closed -- treated as rejection');
        if (incrementRejectionCounter(state, 'gate1', cfg.limits.maxRejections)) {
          save(state);
          throw new Error(`Gate 1 rejected ${cfg.limits.maxRejections} times -- pipeline halted`);
        }
        let closedNotes: Array<{ system: boolean; body: string }>;
        try {
          closedNotes = await gl.getMRNotes(mrIid, data.gate1_at as string);
        } catch {
          closedNotes = [];
        }
        const feedback = closedNotes
          .filter((n) => !n.system)
          .map((n) => n.body)
          .join('\n') || 'MR closed without feedback';

        data.feedback = feedback;
        if (!data.rejectionHistory) data.rejectionHistory = [];
        const history = data.rejectionHistory as Array<Record<string, unknown>>;
        history.push({
          round: history.length + 1,
          feedback: data.feedback,
          timestamp: new Date().toISOString(),
        });
        preserveDiffSummary(data);
        clearGenerateCodeState(state);
        state.stage = 'generate_code';
        save(state);
        return;
      }

      // Check MR approvals -- wrapped for transient errors
      let approvals;
      try {
        approvals = await gl.getMRApprovals(mrIid);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logWarn(`[gate1] getMRApprovals transient error: ${msg} -- will retry next poll`);
        await sleep(ext.pollInterval);
        continue;
      }

      if (approvals.approved) {
        const approvedByNames = (approvals.approved_by || [])
          .map((a) => a.user?.name || a.user?.username)
          .join(', ');
        logOk(`MR approved by: ${approvedByNames}`);
        state.stage = 'deploy_qa';
        save(state);
        return;
      }

      // Check MR notes for explicit "rejected" keyword -- wrapped for transient errors
      let notes;
      try {
        notes = await gl.getMRNotes(mrIid, data.gate1_at as string);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logWarn(`[gate1] getMRNotes transient error: ${msg} -- will retry next poll`);
        await sleep(ext.pollInterval);
        continue;
      }

      // Use word-boundary regex to avoid false positives (T2.11)
      const rejectionNote = notes.find(
        (n) => !n.system && REJECTION_WORD_RE.test(n.body) && !NOT_REJECTED_RE.test(n.body),
      );
      if (rejectionNote) {
        logErr(`Rejected by ${rejectionNote.author?.name || 'reviewer'}`);
        if (incrementRejectionCounter(state, 'gate1', cfg.limits.maxRejections)) {
          save(state);
          throw new Error(`Gate 1 rejected ${cfg.limits.maxRejections} times -- pipeline halted`);
        }
        data.feedback = rejectionNote.body;
        preserveDiffSummary(data);
        clearGenerateCodeState(state);
        state.stage = 'generate_code';
        save(state);
        return;
      }

      const approvedCount = (approvals.approved_by || []).length;
      gate1PollCount++;
      if (gate1PollCount % 6 === 0) {
        const waitMins = Math.floor((monotonicMs() - gate1PollStart) / 60_000);
        logInfo(`Polling MR !${mrIid}... (${approvedCount} approvals) ${waitMins}m elapsed`);
      }
      await sleep(ext.pollInterval);
    }
  };
}
