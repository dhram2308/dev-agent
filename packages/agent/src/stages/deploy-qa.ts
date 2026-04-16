"use strict";

import type { PipelineState } from '@mi/shared';

const { cfg, TICKET, MAX_APPROVAL_TIMEOUT, MERGE_POLL_TIMEOUT, POLL_INTERVAL, monotonicMs } = require("../lib/config");
const { logStep, logOk, logErr, logInfo, logWarn, logWait, C } = require("../lib/logging");
const { sleep } = require("../lib/http-client");
const { save, checkUIApproval } = require("../lib/state");
const { gl } = require("../lib/gitlab");
const { slack } = require("../lib/slack");
const { isShuttingDown } = require("../lib/graceful-shutdown");
const { incrementRejectionCounter } = require("./gate-code-review");
const { isChannelEnabled } = require("../lib/notification-config");

async function stageDeployQA(state: PipelineState): Promise<void> {
  logStep(5, "Deploy to QA");

  // Post review for user approval (triggers Web UI diff viewer)
  if (!(state.data as any).deploy_qa_posted) {
    (state.data as any).deploy_qa_posted = true;
    (state.data as any).deploy_qa_at = new Date().toISOString();
    save(state);

    const mrIid = (state.data as any).code_mr_iid;
    if (isChannelEnabled("deploy_qa", "slack")) {
      await slack(
        `\ud83d\udd0d *Review & Approve Merge to QA — ${TICKET}*\n` +
        `MR !${mrIid} is ready for merge into \`${cfg.branch.qa}\`.\n` +
        `\ud83d\udd00 MR: ${(state.data as any).code_mr_url}\n` +
        `Please review the diff in the Web UI and click *Approve & Merge* or *Reject*.`,
        [cfg.slack.ownerId],
      );
    }
    logWait("Waiting for user approval to merge into QA (Web UI)…");
  }

  // Poll for user approval before merging
  if (!(state.data as any).qa_merged) {
    const mrIid = (state.data as any).code_mr_iid;
    logInfo(`Waiting for approval to merge MR !${mrIid}… (polling every 30s)`);

    const deployQaPollStart = monotonicMs(); // V9: monotonic clock
    let deployQaPollCount = 0;
    while (true) {
      if (isShuttingDown()) {
        save(state);
        throw new Error("Shutdown in progress — exiting deploy_qa");
      }
      if (monotonicMs() - deployQaPollStart > MAX_APPROVAL_TIMEOUT) {
        logErr(`Deploy QA approval timeout after ${MAX_APPROVAL_TIMEOUT / 3600000}h`);
        if (isChannelEnabled("deploy_qa", "slack")) {
          await slack(`\u23f0 *Deploy QA Timeout — ${TICKET}*\nPipeline halted.`, [cfg.slack.ownerId]);
        }
        save(state);
        throw new Error(`Deploy QA approval timeout after ${MAX_APPROVAL_TIMEOUT / 3600000}h`);
      }
      // Check Web UI approval/rejection
      const uiResult = checkUIApproval(state, "deploy_qa");
      if (uiResult) {
        if (uiResult.approved) {
          logOk("Merge approved via Web UI — merging MR…");
          try {
            await gl.mergeMR(mrIid);
            (state.data as any).qa_merged = true;
            (state.data as any).qa_mr_url = (state.data as any).code_mr_url;
            save(state);
            logOk(`Merged into ${cfg.branch.qa}`);
          } catch (err: any) {
            logErr(`Merge failed after approval (${err.message}) — polling GitLab for manual merge`);
            if (isChannelEnabled("deploy_qa", "slack")) {
              await slack(
                `\u26a0\ufe0f *Merge Failed — ${TICKET}*\n` +
                `API merge of MR !${mrIid} failed: ${err.message}\n` +
                `Please merge manually on GitLab: ${(state.data as any).code_mr_url}`,
                [cfg.slack.ownerId],
              );
            }
            // E2: Start merge poll timeout tracking
            (state.data as any)._merge_poll_start = Date.now();
            save(state);
            // Fall through to auto-detect loop below
          }
        } else {
          // Rejected — reset code state and go back to generate_code
          logErr("Merge rejected via Web UI — sending back for regeneration");
          // H4: Check rejection counter
          if (incrementRejectionCounter(state, "deploy_qa")) {
            save(state);
            throw new Error(`Deploy QA rejected ${require("../lib/config").MAX_REJECTIONS} times — pipeline halted`);
          }
          (state.data as any).feedback = uiResult.feedback || "Rejected at deploy_qa via Web UI";
          // P9: Preserve diff summary for developer on rejection
          if ((state.data as any).codeChanges && (state.data as any).codeChanges.changes) {
            (state.data as any).previousAttemptSummary = (state.data as any).codeChanges.changes.map((c: any) =>
              `${c.action}: ${c.file_path}`).join("\n");
          }
          // H5: Keep code_branch, codeChanges, original_files, explore_plan on deploy_qa rejection
          // Only clear commit/MR flags so developer can recommit
          (state.data as any).code_committed = null;
          (state.data as any).code_mr_iid = null;
          (state.data as any).code_mr_url = null;
          (state.data as any).code_slack_sent = null;
          (state.data as any).gate1_at = null;
          (state.data as any).gate1_ui_approved = null;
          (state.data as any).gate1_ui_rejected = null;
          (state.data as any).gate1_ui_feedback = null;
          (state.data as any).deploy_qa_posted = null;
          (state.data as any).deploy_qa_at = null;
          (state.data as any).deploy_qa_ui_approved = null;
          (state.data as any).deploy_qa_ui_rejected = null;
          (state.data as any).deploy_qa_ui_feedback = null;
          // R5: Clear stale plan on rejection to force re-generation
          (state.data as any).plan = null;
          // Clear dev sub-stage checkpoints for re-generation
          (state.data as any)._dev_complete = null;
          (state.data as any)._dev_summary = null;
          (state.data as any)._reviewed = null;
          (state.data as any)._fixed = null;
          state.stage = "generate_code";
          save(state);
          return;
        }
      }

      // Auto-detect merge on GitLab (in case user merged manually or API merge succeeded above)
      if (!(state.data as any).qa_merged) {
        // E2: Merge poll timeout after merge failure
        if ((state.data as any)._merge_poll_start && (Date.now() - (state.data as any)._merge_poll_start > MERGE_POLL_TIMEOUT)) {
          logErr(`Merge poll timeout after ${MERGE_POLL_TIMEOUT / 60000}min — MR !${mrIid} was not merged`);
          if (isChannelEnabled("deploy_qa", "slack")) {
            await slack(
              `\u23f0 *Merge Poll Timeout — ${TICKET}*\n` +
              `MR !${mrIid} was not merged within ${MERGE_POLL_TIMEOUT / 60000}min after merge failure.\n` +
              `MR: ${(state.data as any).code_mr_url}\n` +
              `Please merge manually and re-run the agent.`,
              [cfg.slack.ownerId],
            );
          }
          save(state);
          throw new Error(`Merge poll timeout after ${MERGE_POLL_TIMEOUT / 60000}min — MR !${mrIid} was not merged`);
        }
        try {
          const mr = await gl.getMR(mrIid);
          if (mr.state === "merged") {
            logOk(`MR !${mrIid} merged on GitLab — auto-detected`);
            (state.data as any).qa_merged = true;
            (state.data as any).qa_mr_url = (state.data as any).code_mr_url;
            delete (state.data as any)._merge_poll_start;
            save(state);
          }
        } catch (e: any) { logWarn(`[deploy-qa] getMR poll error: ${e.message}`); }
      }

      if ((state.data as any).qa_merged) break;
      deployQaPollCount++;
      if (deployQaPollCount % 6 === 0) {
        const waitMins = Math.floor((monotonicMs() - deployQaPollStart) / 60000);
        logInfo(`Waiting for QA merge approval… ${waitMins}m elapsed`);
      }
      await sleep(POLL_INTERVAL);
    }
  }

  // Wait for CI pipeline
  if (!(state.data as any).qa_ci) {
    await gl.waitPipeline(cfg.branch.qa);
    (state.data as any).qa_ci = true;
    save(state);
  }

  state.stage = "test_qa";
  save(state);
}

export { stageDeployQA };
