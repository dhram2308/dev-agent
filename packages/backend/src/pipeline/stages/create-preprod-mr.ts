// =====================================================================
// MI Dev Agent -- Create Pre-Prod MR (TypeScript port of stages/create-preprod-mr.js)
// =====================================================================
//
// Stage 8: Create a merge request from QA branch to pre-prod branch.
//
// Features:
//   - S5: MR target branch validation
//   - Idempotent: skips if MR already exists (checkpoint recovery)
//   - Uses QA branch as source (feature branch may be deleted after QA merge)
//   - Includes code change summary in MR description
// =====================================================================

import { logStep, logOk, logInfo } from '../../lib/logger';
import { save } from '../../state/state-manager';
import { loadConfig } from '../../config/loader';
import { GitLabService } from '../../services/gitlab';
import { ALLOWED_MR_TARGETS } from '@shared/constants';
import type { PipelineState, StageHandler } from '@shared/types';

// ── Types ────────────────────────────────────────────────────────────

interface CreatePreprodMrDeps {
  gl: GitLabService;
}

// ── MR target validation (S5) ────────────────────────────────────

function validateMRTarget(target: string): void {
  const allowed = ALLOWED_MR_TARGETS as readonly string[];
  if (!allowed.includes(target)) {
    throw new Error(
      `S5: MR target branch "${target}" is not in the allowed list: ${allowed.join(', ')}`,
    );
  }
}

// ── Stage Handler ────────────────────────────────────────────────

export function createCreatePreprodMrHandler(deps: CreatePreprodMrDeps): StageHandler {
  const { gl } = deps;

  return async function stageCreatePreprodMR(state: PipelineState): Promise<void> {
    const cfg = loadConfig();
    const data = state.data as Record<string, unknown>;
    const ticket = state.ticket;

    logStep(8, 'Create Pre-Prod MR');

    if (!data.preprod_mr_iid) {
      // Use enterprise-qa as source (feature branch may be deleted after QA merge)
      const sourceBranch = cfg.branches.qa;
      logInfo(`Creating MR: ${sourceBranch} -> ${cfg.branches.preprod}...`);

      // S5: Validate MR target branch before creation
      validateMRTarget(cfg.branches.preprod);

      const codeChanges = data.codeChanges as { summary?: string } | undefined;
      const changeSummary = codeChanges?.summary || '(No summary available)';

      const mr = await gl.createMR({
        sourceBranch,
        targetBranch: cfg.branches.preprod,
        title: `release(${ticket}): ${(data.ticket as { summary?: string })?.summary || ''} -> Pre-Prod`,
        description:
          `## ${ticket} -- Promote to Pre-Prod\n\n` +
          `${changeSummary}\n\n` +
          `QA verified.\n\n` +
          `---\nAI Dev Agent`,
      });

      data.preprod_mr_iid = mr.iid;
      data.preprod_mr_url = mr.web_url;
      save(state);
      logOk(`Pre-Prod MR !${mr.iid} created`);
    }

    state.stage = 'gate_dual_approval';
    save(state);
  };
}
