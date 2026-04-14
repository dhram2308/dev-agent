// =====================================================================
// MI Dev Agent -- Done Stage (TypeScript port of stages/done.js)
// =====================================================================
//
// Stage 11: Final stage -- transition Jira to "Done", post summary
// comment and Slack notification, archive state file.
//
// Features:
//   - P12: Log warning summary
//   - Transition Jira issue to "Done" status
//   - Post deployment summary comment to Jira (MR URLs, environments, time)
//   - Final Slack notification with all relevant links
//   - E9: Archive state file on completion
//   - Remove lock file
//   - Non-fatal error handling (done stage errors don't halt pipeline)
// =====================================================================

import * as fs from 'fs';
import * as path from 'path';
import { logStep, logOk, logErr, logInfo, logWarn, C } from '../../lib/logger';
import { save, getStateFilePath } from '../../state/state-manager';
import { loadConfig } from '../../config/loader';
import { JiraService } from '../../services/jira';
import { SlackService } from '../../services/slack';
import type { PipelineState, StageHandler } from '@shared/types';

// ── Types ────────────────────────────────────────────────────────────

interface DoneDeps {
  jira: JiraService;
  slack: SlackService;
}

// ── Stage Handler ────────────────────────────────────────────────

export function createDoneHandler(deps: DoneDeps): StageHandler {
  const { jira, slack } = deps;

  return async function stageDone(state: PipelineState): Promise<void> {
    const cfg = loadConfig();
    const data = state.data as Record<string, unknown>;
    const ticket = state.ticket;

    logStep(11, 'Done');

    // P12: Log warning summary
    const warnings = data._warnings as Array<{ stage: string; message: string }> | undefined;
    if (warnings && warnings.length > 0) {
      logInfo(`Pipeline completed with ${warnings.length} warning(s):`);
      for (const w of warnings) {
        logWarn(`  [${w.stage}] ${w.message}`);
      }
    }

    try {
      // Transition Jira to "Done"
      if (!data.jira_closed) {
        try {
          await jira.transitionIssue(ticket, 'done');
          logOk('Jira -> Done');
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logErr(`Jira transition: ${msg}`);
        }
        data.jira_closed = true;
        save(state);
      }

      // Post final Jira comment
      if (!data.final_comment) {
        const startedAt = (state as unknown as { startedAt?: string }).startedAt;
        const elapsed = startedAt
          ? ((Date.now() - new Date(startedAt).getTime()) / 60_000).toFixed(1)
          : 'unknown';

        const ticketData = data.ticket as { summary?: string } | undefined;
        const warningText =
          warnings && warnings.length > 0
            ? `\n\nKnown Limitations:\n${warnings.map((w) => `- [${w.stage}] ${w.message}`).join('\n')}`
            : '';

        await jira.addComment(
          ticket,
          `Deployment Complete\n` +
          `\n` +
          `${ticket}: ${ticketData?.summary || ''}\n` +
          `\n` +
          `Summary:\n` +
          `- QA MR: ${data.qa_mr_url || '--'}\n` +
          `- Pre-Prod MR: ${data.preprod_mr_url || '--'}\n` +
          `- Production MR: ${data.prod_mr_url || '--'}\n` +
          `\n` +
          `Total time: ${elapsed} minutes\n` +
          `All gates passed. Production is live.` +
          warningText,
        );
        data.final_comment = true;
        save(state);
      }

      // Final Slack notification
      if (!data.final_slack) {
        const startedAt = (state as unknown as { startedAt?: string }).startedAt;
        const elapsed = startedAt
          ? ((Date.now() - new Date(startedAt).getTime()) / 60_000).toFixed(1)
          : 'unknown';

        const ticketData = data.ticket as { summary?: string } | undefined;
        await slack.send(
          `${ticket} deployed to Production\n` +
          `${ticketData?.summary || ''}\n\n` +
          `Jira: ${jira.issueUrl(ticket)}\n` +
          `MR: ${data.prod_mr_url || '--'}\n` +
          `Time: ${elapsed} min`,
          [cfg.slack.ownerSlackId || ''],
        );
        data.final_slack = true;
        save(state);
      }

      // Banner
      console.log();
      console.log(`${C.bold}${C.green}  ${ticket} -- DEPLOYED TO PRODUCTION${C.reset}`);
      console.log();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logErr(`Done stage error (non-fatal): ${msg}`);
    }

    // E9: Archive state file on completion
    try {
      const stateFilePath = getStateFilePath(ticket);
      const archiveName = path.join(
        path.dirname(stateFilePath),
        `state-${ticket}.done.${Date.now()}.json`,
      );
      if (fs.existsSync(stateFilePath)) {
        fs.copyFileSync(stateFilePath, archiveName);
        fs.unlinkSync(stateFilePath);
      }
      // Remove lock file
      const lockFile = path.join(path.dirname(stateFilePath), `state-${ticket}.lock`);
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      logOk('State archived');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`State archive failed: ${msg}`);
    }
  };
}
