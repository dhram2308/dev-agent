"use strict";

import type { PipelineState } from '@mi/shared';

const { cfg, TICKET, MAX_APPROVAL_TIMEOUT, MAX_REJECTIONS, POLL_INTERVAL, monotonicMs } = require("../lib/config");
const { logStep, logOk, logErr, logInfo, logWarn, logWait, C } = require("../lib/logging");
const { sleep } = require("../lib/http-client");
const { save, checkUIApproval } = require("../lib/state");
const { gl } = require("../lib/gitlab");
const { slack } = require("../lib/slack");
const { isShuttingDown } = require("../lib/graceful-shutdown");
const { STAGE_CLEARS } = require("../lib/constants");
const { isChannelEnabled } = require("../lib/notification-config");

// T1.3: Shared cleanup function for ALL rejection paths
function clearGenerateCodeState(state: PipelineState): void {
  for (const f of STAGE_CLEARS.generate_code) { (state.data as any)[f] = null; }
  // Also clear UI gate flags and other fields not in STAGE_CLEARS
  (state.data as any).gate1_ui_approved = null;
  (state.data as any).gate1_ui_rejected = null;
  (state.data as any).gate1_ui_feedback = null;
  (state.data as any).original_files = null;
  (state.data as any).plan = null;
  (state.data as any).previousAttemptSummary = null;
  (state.data as any)._conflict_check_done = null;
  (state.data as any)._divergence_checked = null;
}

// H4: Rejection counter helper
function incrementRejectionCounter(state: PipelineState, gate: string): boolean {
  (state.data as any)._gate_rejections = (state.data as any)._gate_rejections || {};
  (state.data as any)._gate_rejections[gate] = ((state.data as any)._gate_rejections[gate] || 0) + 1;
  const count = (state.data as any)._gate_rejections[gate];
  logInfo(`Rejection counter for ${gate}: ${count}/${MAX_REJECTIONS}`);
  if (count >= MAX_REJECTIONS) {
    logErr(`${gate} rejected ${count} times — MAX_REJECTIONS (${MAX_REJECTIONS}) reached`);
    return true; // halt
  }
  return false; // continue
}

async function stageGateCodeReview(state: PipelineState): Promise<void> {
  logStep(4, "GATE 1 — Code Review (GitLab MR Approval)");

  const mrIid = (state.data as any).code_mr_iid;
  if (!mrIid) throw new Error("No MR IID found — code generation may have failed");

  if (!(state.data as any).gate1_at) {
    (state.data as any).gate1_at = new Date().toISOString();
    save(state);
  }

  logInfo(`MR: ${(state.data as any).code_mr_url}`);
  logWait("Waiting for MR approval (Web UI or GitLab)…");

  // Poll GitLab MR for approval / rejection
  const gate1PollStart = monotonicMs(); // V9: monotonic clock
  let gate1PollCount = 0;
  while (true) {
    if (isShuttingDown()) {
      save(state);
      throw new Error("Shutdown in progress — exiting gate_code_review");
    }
    if (monotonicMs() - gate1PollStart > MAX_APPROVAL_TIMEOUT) {
      logErr(`Gate 1 code review timeout after ${MAX_APPROVAL_TIMEOUT / 3600000}h`);
      if (isChannelEnabled("gate_code_review", "slack")) {
        await slack(`\u23f0 *Code Review Timeout — ${TICKET}*\nPipeline halted.`, [cfg.slack.ownerId]);
      }
      save(state);
      throw new Error(`Gate 1 code review timeout after ${MAX_APPROVAL_TIMEOUT / 3600000}h`);
    }
    // Check Web UI approval first
    const uiResult = checkUIApproval(state, "gate1");
    if (uiResult) {
      if (uiResult.approved) {
        logOk("MR approved via Web UI");
        state.stage = "deploy_qa";
        save(state);
        return;
      } else {
        logErr("Code rejected via Web UI");
        // H4: Check rejection counter
        if (incrementRejectionCounter(state, "gate1")) {
          save(state);
          throw new Error(`Gate 1 rejected ${MAX_REJECTIONS} times — pipeline halted`);
        }
        (state.data as any).feedback = uiResult.feedback || "Rejected via Web UI";
        (state.data as any).rejectionHistory = (state.data as any).rejectionHistory || [];
        (state.data as any).rejectionHistory.push({ round: ((state.data as any).rejectionHistory || []).length + 1, feedback: (state.data as any).feedback, timestamp: new Date().toISOString() });
        // P9: Preserve diff summary for developer on rejection
        if ((state.data as any).codeChanges && (state.data as any).codeChanges.changes) {
          (state.data as any).previousAttemptSummary = (state.data as any).codeChanges.changes.map((c: any) =>
            `${c.action}: ${c.file_path}`).join("\n");
        }
        // T1.3: Clear ALL code artifacts and dev sub-stage checkpoints for re-generation
        clearGenerateCodeState(state);
        state.stage = "generate_code";
        save(state);
        return;
      }
    }

    // Check MR state — wrapped in try-catch for transient GitLab errors
    let mr: any, approvals: any, notes: any;
    try {
      mr = await gl.getMR(mrIid);
    } catch (e: any) {
      logWarn(`[gate1] getMR transient error: ${e.message} — will retry next poll`);
      await sleep(POLL_INTERVAL);
      continue;
    }

    // If MR was merged directly → approved
    if (mr.state === "merged") {
      // E14: Verify external merge matches our feature branch/SHA
      const mergedBy = mr.merged_by?.name || mr.merged_by?.username || "unknown";
      const mrSourceBranch = mr.source_branch || "";
      const expectedBranch = state.data.code_branch || `enterprise-ts-${TICKET}`;
      // T2.25: Branch mismatch is a hard stop — wrong branch merged
      if (mrSourceBranch && mrSourceBranch !== expectedBranch) {
        throw new Error(`Wrong branch merged: expected "${expectedBranch}", got "${mrSourceBranch}". Manual investigation required.`);
      }
      logOk(`MR already merged by ${mergedBy} — skipping merge step`);
      (state.data as any).ts_merged = true;
      state.stage = "deploy_qa";
      save(state);
      return;
    }

    // If MR was closed → rejected
    if (mr.state === "closed") {
      logErr("MR closed — treated as rejection");
      // H4: Check rejection counter
      if (incrementRejectionCounter(state, "gate1")) {
        save(state);
        throw new Error(`Gate 1 rejected ${MAX_REJECTIONS} times — pipeline halted`);
      }
      // Check MR notes for feedback
      let closedNotes: any[];
      try { closedNotes = await gl.getMRNotes(mrIid, (state.data as any).gate1_at); } catch { closedNotes = []; }
      const feedback = closedNotes
        .filter((n: any) => !n.system)
        .map((n: any) => n.body)
        .join("\n") || "MR closed without feedback";

      (state.data as any).feedback = feedback;
      (state.data as any).rejectionHistory = (state.data as any).rejectionHistory || [];
      (state.data as any).rejectionHistory.push({ round: ((state.data as any).rejectionHistory || []).length + 1, feedback: (state.data as any).feedback, timestamp: new Date().toISOString() });
      // P9: Preserve diff summary for developer on rejection
      if ((state.data as any).codeChanges && (state.data as any).codeChanges.changes) {
        (state.data as any).previousAttemptSummary = (state.data as any).codeChanges.changes.map((c: any) =>
          `${c.action}: ${c.file_path}`).join("\n");
      }
      // T1.3: Clear ALL code artifacts and dev sub-stage checkpoints for re-generation
      clearGenerateCodeState(state);
      state.stage = "generate_code";
      save(state);
      return;
    }

    // Check MR approvals — wrapped for transient errors
    try {
      approvals = await gl.getMRApprovals(mrIid);
    } catch (e: any) {
      logWarn(`[gate1] getMRApprovals transient error: ${e.message} — will retry next poll`);
      await sleep(POLL_INTERVAL);
      continue;
    }
    if (approvals.approved) {
      logOk(`MR approved by: ${(approvals.approved_by || []).map((a: any) => a.user?.name || a.user?.username).join(", ")}`);
      state.stage = "deploy_qa";
      save(state);
      return;
    }

    // Check MR notes for explicit "rejected" keyword — wrapped for transient errors
    try {
      notes = await gl.getMRNotes(mrIid, (state.data as any).gate1_at);
    } catch (e: any) {
      logWarn(`[gate1] getMRNotes transient error: ${e.message} — will retry next poll`);
      await sleep(POLL_INTERVAL);
      continue;
    }
    // T2.11: Use word-boundary regex to avoid false positives on notes that just contain the word
    const rejectionNote = notes.find((n: any) =>
      !n.system && /\brejected\b/i.test(n.body) && !/\bnot\s+rejected\b/i.test(n.body),
    );
    if (rejectionNote) {
      logErr(`Rejected by ${rejectionNote.author?.name || "reviewer"}`);
      // H4: Check rejection counter
      if (incrementRejectionCounter(state, "gate1")) {
        save(state);
        throw new Error(`Gate 1 rejected ${MAX_REJECTIONS} times — pipeline halted`);
      }
      (state.data as any).feedback = rejectionNote.body;
      // P9: Preserve diff summary for developer on rejection
      if ((state.data as any).codeChanges && (state.data as any).codeChanges.changes) {
        (state.data as any).previousAttemptSummary = (state.data as any).codeChanges.changes.map((c: any) =>
          `${c.action}: ${c.file_path}`).join("\n");
      }
      // T1.3: Clear ALL code artifacts and dev sub-stage checkpoints for re-generation
      clearGenerateCodeState(state);
      state.stage = "generate_code";
      save(state);
      return;
    }

    const approvedCount = (approvals.approved_by || []).length;
    gate1PollCount++;
    if (gate1PollCount % 6 === 0) {
      const waitMins = Math.floor((monotonicMs() - gate1PollStart) / 60000);
      logInfo(`Polling MR !${mrIid}… (${approvedCount} approvals) ${waitMins}m elapsed`);
    }
    await sleep(POLL_INTERVAL);
  }
}

export { stageGateCodeReview, incrementRejectionCounter };
