// =====================================================================
// MI Dev Agent -- Deploy QA (TypeScript port of stages/deploy-qa.js)
// =====================================================================
//
// Stage 5: Merge code MR to QA branch and wait for CI pipeline.
//
// Features:
//   - Post review notification for user approval
//   - Poll for Web UI approval/rejection
//   - Merge MR via GitLab API with fallback to manual merge detection
//   - Merge poll timeout (E2) with Slack notification
//   - Auto-detect external merge on GitLab
//   - Wait for CI pipeline
//   - On rejection: clear commit/MR flags, loop back to generate_code
//   - Rejection counter (H4) with halt on max
//   - Replace empty catch {} with catch (e) { logWarn(...) }
// =====================================================================

import { logStep, logOk, logErr, logInfo, logWarn, logWait } from '../../lib/logger';
import { sleep } from '../../lib/utils';
import { save, checkUIApproval } from '../../state/state-manager';
import { loadConfig, loadExtendedConfig } from '../../config/loader';
import { GitLabService } from '../../services/gitlab';
import { SlackService } from '../../services/slack';
import { incrementRejectionCounter } from './gate-code-review';
import type { PipelineState, StageHandler } from '@shared/types';
import { isChannelEnabled } from '../../lib/notification-gates';

// ── Types ────────────────────────────────────────────────────────────

interface DeployQaDeps {
  gl: GitLabService;
  slack: SlackService;
}

// ── Monotonic clock helper ──────────────────────────────────────

function monotonicMs(): number {
  const [sec, nsec] = process.hrtime();
  return sec * 1000 + Math.floor(nsec / 1_000_000);
}

// ── Stage Handler ────────────────────────────────────────────────

export function createDeployQaHandler(deps: DeployQaDeps): StageHandler {
  const { gl, slack } = deps;

  return async function stageDeployQA(state: PipelineState): Promise<void> {
    const cfg = loadConfig();
    const ext = loadExtendedConfig();
    const data = state.data as Record<string, unknown>;
    const ticket = state.ticket;

    logStep(5, 'Deploy to QA');

    // Post review for user approval (triggers Web UI diff viewer)
    if (!data.deploy_qa_posted) {
      data.deploy_qa_posted = true;
      data.deploy_qa_at = new Date().toISOString();
      save(state);

      const mrIid = data.code_mr_iid as number;
      if (isChannelEnabled('deploy_qa', 'slack')) {
        await slack.send(
          `Review & Approve Merge to QA -- ${ticket}\n` +
          `MR !${mrIid} is ready for merge into \`${cfg.branches.qa}\`.\n` +
          `MR: ${data.code_mr_url}\n` +
          `Please review the diff in the Web UI and click Approve & Merge or Reject.`,
          [cfg.slack.ownerSlackId || ''],
        );
      }
      logWait('Waiting for user approval to merge into QA (Web UI)...');
    }

    // Poll for user approval before merging
    if (!data.qa_merged) {
      const mrIid = data.code_mr_iid as number;
      logInfo(`Waiting for approval to merge MR !${mrIid}... (polling every ${ext.pollInterval / 1000}s)`);

      const deployQaPollStart = monotonicMs();
      let deployQaPollCount = 0;
      const maxApprovalTimeout = ext.approvalReminder4h * 2; // 8h default
      const mergePollTimeout = cfg.timeouts.stageTimeouts.mergePoll || 1_800_000;

      while (true) {
        if (monotonicMs() - deployQaPollStart > maxApprovalTimeout) {
          logErr(`Deploy QA approval timeout after ${maxApprovalTimeout / 3_600_000}h`);
          if (isChannelEnabled('deploy_qa', 'slack')) {
            await slack.send(`Timeout -- Deploy QA -- ${ticket}\nPipeline halted.`, [cfg.slack.ownerSlackId || '']);
          }
          save(state);
          throw new Error(`Deploy QA approval timeout after ${maxApprovalTimeout / 3_600_000}h`);
        }

        // Check Web UI approval/rejection
        const uiResult = checkUIApproval(ticket, 'deploy_qa');
        if (uiResult) {
          if (uiResult.approved) {
            logOk('Merge approved via Web UI -- merging MR...');
            try {
              await gl.mergeMR(mrIid);
              data.qa_merged = true;
              data.qa_mr_url = data.code_mr_url;
              save(state);
              logOk(`Merged into ${cfg.branches.qa}`);
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              logErr(`Merge failed after approval (${errMsg}) -- polling GitLab for manual merge`);
              if (isChannelEnabled('deploy_qa', 'slack')) {
                await slack.send(
                  `Merge Failed -- ${ticket}\n` +
                  `API merge of MR !${mrIid} failed: ${errMsg}\n` +
                  `Please merge manually on GitLab: ${data.code_mr_url}`,
                  [cfg.slack.ownerSlackId || ''],
                );
              }
              // E2: Start merge poll timeout tracking
              data._merge_poll_start = Date.now();
              save(state);
              // Fall through to auto-detect loop below
            }
          } else {
            // Rejected -- reset code state and go back to generate_code
            logErr('Merge rejected via Web UI -- sending back for regeneration');
            if (incrementRejectionCounter(state, 'deploy_qa', cfg.limits.maxRejections)) {
              save(state);
              throw new Error(`Deploy QA rejected ${cfg.limits.maxRejections} times -- pipeline halted`);
            }
            data.feedback = uiResult.feedback || 'Rejected at deploy_qa via Web UI';
            // P9: Preserve diff summary for developer on rejection
            const codeChanges = data.codeChanges as { changes?: Array<{ action: string; file_path: string }> } | undefined;
            if (codeChanges?.changes) {
              data.previousAttemptSummary = codeChanges.changes
                .map((c) => `${c.action}: ${c.file_path}`)
                .join('\n');
            }
            // H5: Keep code_branch, codeChanges, original_files, explore_plan on deploy_qa rejection
            // Only clear commit/MR flags so developer can recommit
            data.code_committed = null;
            data.code_mr_iid = null;
            data.code_mr_url = null;
            data.code_slack_sent = null;
            data.gate1_at = null;
            data.gate1_ui_approved = null;
            data.gate1_ui_rejected = null;
            data.gate1_ui_feedback = null;
            data.deploy_qa_posted = null;
            data.deploy_qa_at = null;
            data.deploy_qa_ui_approved = null;
            data.deploy_qa_ui_rejected = null;
            data.deploy_qa_ui_feedback = null;
            // R5: Clear stale plan on rejection to force re-generation
            data.plan = null;
            // Clear dev sub-stage checkpoints for re-generation
            data._dev_complete = null;
            data._dev_summary = null;
            data._reviewed = null;
            data._fixed = null;
            state.stage = 'generate_code';
            save(state);
            return;
          }
        }

        // Auto-detect merge on GitLab (in case user merged manually or API merge succeeded above)
        if (!data.qa_merged) {
          // E2: Merge poll timeout after merge failure
          const mergePollStart = data._merge_poll_start as number | undefined;
          if (mergePollStart && Date.now() - mergePollStart > mergePollTimeout) {
            logErr(`Merge poll timeout after ${mergePollTimeout / 60_000}min -- MR !${mrIid} was not merged`);
            if (isChannelEnabled('deploy_qa', 'slack')) {
              await slack.send(
                `Merge Poll Timeout -- ${ticket}\n` +
                `MR !${mrIid} was not merged within ${mergePollTimeout / 60_000}min after merge failure.\n` +
                `MR: ${data.code_mr_url}\n` +
                `Please merge manually and re-run the agent.`,
                [cfg.slack.ownerSlackId || ''],
              );
            }
            save(state);
            throw new Error(`Merge poll timeout after ${mergePollTimeout / 60_000}min -- MR !${mrIid} was not merged`);
          }
          try {
            const mr = await gl.getMR(mrIid);
            if (mr.state === 'merged') {
              logOk(`MR !${mrIid} merged on GitLab -- auto-detected`);
              data.qa_merged = true;
              data.qa_mr_url = data.code_mr_url;
              delete data._merge_poll_start;
              save(state);
            }
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            logWarn(`[deploy-qa] getMR poll error: ${msg}`);
          }
        }

        if (data.qa_merged) break;
        deployQaPollCount++;
        if (deployQaPollCount % 6 === 0) {
          const waitMins = Math.floor((monotonicMs() - deployQaPollStart) / 60_000);
          logInfo(`Waiting for QA merge approval... ${waitMins}m elapsed`);
        }
        await sleep(ext.pollInterval);
      }
    }

    // Wait for CI pipeline
    if (!data.qa_ci) {
      await gl.waitPipeline(cfg.branches.qa);
      data.qa_ci = true;
      save(state);
    }

    state.stage = 'test_qa';
    save(state);
  };
}
