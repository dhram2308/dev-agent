// =====================================================================
// MI Dev Agent -- Push Code Stage (TypeScript port)
// =====================================================================
// Creates branch, commits file changes, creates MR on GitLab.
//
// Features:
//   - Branch creation with parent branch awareness (Q4)
//   - File validation (L2/L3: dedup, size check, binary detection)
//   - Commit with inline recovery (create->update, corrupt branch)
//   - Merge conflict detection (GQ4)
//   - Divergence check (T2.19)
//   - Enhanced MR description with quality report (Q7)
//   - Slack notification
//
// Ported from: stages/push-code.js
// =====================================================================

import type { PipelineState } from '@shared/types';
import { BINARY_EXTENSIONS, ALLOWED_MR_TARGETS } from '@shared/constants';
import {
  logStep, logOk, logErr, logInfo, logWarn, logDebug,
} from '../../lib/logger';
import { sanitizeMRText, addWarning, isBinaryFile } from '../../lib/utils';
import { isChannelEnabled } from '../../lib/notification-gates';

// ── Types ────────────────────────────────────────────────────────────

/** A single file change in the changeset */
export interface FileChange {
  action: 'create' | 'update' | 'delete';
  file_path: string;
  content?: string;
}

/** Code changes object */
export interface CodeChanges {
  changes: FileChange[];
  summary?: string;
  test_notes?: string;
}

/** Dependencies injected into push-code */
export interface PushCodeDeps {
  cfg: {
    ticket: string;
    branch: { ts: string; qa: string };
    git: { authorName: string; authorEmail: string; assigneeId: number };
    slack: { ownerId: string };
    localRepo?: string;
    flags?: { runRuntimeTests?: boolean; browserVerify?: boolean };
  };
  /** Maximum commit file size in bytes */
  maxCommitFileSize: number;
  /** GitLab service */
  gl: {
    createBranch: (branch: string, ref: string) => Promise<void>;
    getBranch: (branch: string) => Promise<unknown>;
    deleteBranch: (branch: string) => Promise<void>;
    commit: (
      branch: string, message: string,
      actions: Array<{ action: string; file_path: string; content?: string }>,
      authorName: string, authorEmail: string,
    ) => Promise<{ id?: string }>;
    createMR: (
      source: string, target: string, title: string,
      description: string, removeSource: boolean, assigneeId: number,
    ) => Promise<{ iid: number; web_url: string }>;
    u: (path: string) => string;
    h: () => Record<string, string>;
  };
  /** HTTP request function */
  req: (url: string, opts: { headers: Record<string, string> }) => Promise<{
    status: number;
    data?: Record<string, unknown>;
  }>;
  /** Slack notification */
  slack: (message: string, mentions?: string[]) => Promise<void>;
  /** Save pipeline state */
  save: (state: PipelineState) => void;
  /** Validate MR target branch */
  validateMRTarget: (branch: string) => void;
  /** Redact secrets from text */
  redactSecrets: (text: string) => string;
  /** Browser verify MR section builder (optional) */
  buildBrowserVerifyMRSection?: (state: PipelineState) => string;
}

// ── Main function ───────────────────────────────────────────────────

/**
 * Push code changes to GitLab: branch creation, commit, MR creation.
 */
export async function pushCodeToGitLab(
  state: PipelineState,
  changes: CodeChanges,
  deps: PushCodeDeps,
): Promise<void> {
  const { cfg, gl, save, slack, req } = deps;
  const TICKET = cfg.ticket;
  const data = state.data as Record<string, unknown>;
  const ticket = data.ticket as Record<string, unknown>;

  if (!changes.changes || changes.changes.length === 0) {
    throw new Error('No files to push -- ticket needs more detail.');
  }

  // L3: Validate changes array entries
  changes.changes = changes.changes.filter((c) => {
    if (!c.file_path || typeof c.file_path !== 'string' || c.file_path.trim() === '') {
      logWarn('Skipping change with empty file_path');
      return false;
    }
    if (c.action !== 'delete' && c.content === undefined) {
      logWarn(`Skipping change with undefined content: ${c.file_path}`);
      return false;
    }
    return true;
  });

  // L2: Deduplicate by file_path (keep last occurrence)
  const seen = new Map<string, FileChange>();
  for (const c of changes.changes) {
    seen.set(c.file_path, c);
  }
  changes.changes = [...seen.values()];

  if (changes.changes.length === 0) {
    throw new Error('No valid files to push after validation.');
  }

  const branch = `enterprise-ts-${TICKET}`;

  // Create branch if needed
  if (!data.code_branch) {
    const sourceBranch = (data.parentBranch as string) || cfg.branch.ts;
    logInfo(`Creating branch ${branch} from ${sourceBranch}${data.parentBranch ? ' (parent feature branch)' : ''}...`);
    await gl.createBranch(branch, sourceBranch);
    data.code_branch = branch;
    data.code_source_branch = sourceBranch;
    save(state);
    logOk(`Branch: ${branch} (from ${sourceBranch})`);
  }

  // Commit files
  if (!data.code_committed) {
    // Verify branch exists
    const branchInfo = await gl.getBranch(branch);
    if (!branchInfo) {
      logWarn(`Branch ${branch} not found on remote -- recreating...`);
      data.code_branch = null;
      save(state);
      const sourceBranch = (data.parentBranch as string) || cfg.branch.ts;
      await gl.createBranch(branch, sourceBranch);
      data.code_branch = branch;
      data.code_source_branch = sourceBranch;
      save(state);
      logOk(`Branch recreated: ${branch}`);
    }

    // Build commit message
    const commitSummary = ((ticket?.summary as string) || '').trim();
    const commitMsg = commitSummary
      ? `feat(${TICKET}): ${commitSummary}`
      : `feat(${TICKET}): Implementation`;

    logInfo('Committing files...');

    // GQ2: Filter out oversized files + T2.18: binary detection
    const validChanges: FileChange[] = [];
    for (const c of changes.changes) {
      if (c.action !== 'delete') {
        // T2.18: Skip binary files
        const ext = (c.file_path.match(/\.[^.]+$/) || [''])[0].toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          logWarn(`T2.18: Skipping binary file: ${c.file_path}`);
          addWarning(state, 'generate_code', `Binary file skipped: ${c.file_path}`);
          continue;
        }
        if (c.content && c.content.includes('\0')) {
          logWarn(`T2.18: Skipping file with null bytes (binary): ${c.file_path}`);
          addWarning(state, 'generate_code', `Binary content skipped: ${c.file_path}`);
          continue;
        }
        if (c.content && c.content.length > deps.maxCommitFileSize) {
          logWarn(`GQ2: Skipping ${c.file_path} -- content size ${(c.content.length / 1024).toFixed(1)}KB exceeds limit`);
          addWarning(state, 'generate_code', `File skipped (too large): ${c.file_path}`);
          continue;
        }
      }
      validChanges.push(c);
    }

    if (validChanges.length === 0) {
      throw new Error('No files to commit after size filtering');
    }

    const actions = validChanges.map((c) => {
      const entry: { action: string; file_path: string; content?: string } = {
        action: c.action || 'update',
        file_path: c.file_path,
      };
      if (c.action !== 'delete') entry.content = c.content;
      return entry;
    });

    // Attempt commit with inline recovery
    let commitResult: { id?: string };
    try {
      commitResult = await gl.commit(branch, commitMsg, actions, cfg.git.authorName, cfg.git.authorEmail);
    } catch (commitErr: unknown) {
      const errStr = commitErr instanceof Error ? commitErr.message : String(commitErr);

      if (/already exists/i.test(errStr) && actions.some((a) => a.action === 'create')) {
        logWarn('Some files already exist on branch -- switching create -> update and retrying');
        for (const a of actions) {
          if (a.action === 'create') a.action = 'update';
        }
        commitResult = await gl.commit(branch, commitMsg, actions, cfg.git.authorName, cfg.git.authorEmail);
      } else if (/only create or edit files when you are on a branch/i.test(errStr)) {
        logWarn('Branch appears corrupt -- deleting and recreating...');
        try { await gl.deleteBranch(branch); } catch { /* best effort */ }
        const sourceBranch = (data.parentBranch as string) || cfg.branch.ts;
        await gl.createBranch(branch, sourceBranch);
        logOk(`Branch recreated: ${branch}`);
        commitResult = await gl.commit(branch, commitMsg, actions, cfg.git.authorName, cfg.git.authorEmail);
      } else {
        throw commitErr;
      }
    }

    data.code_committed = true;
    data._last_commit_sha = commitResult.id || null;
    save(state);
    logOk(`Committed ${commitResult.id ? commitResult.id.substring(0, 8) + ' ' : ''}as ${cfg.git.authorName}`);
  }

  // GQ4: Merge conflict detection
  if (!data._conflict_check_done) {
    try {
      const diffResp = await req(
        gl.u(`/repository/compare?from=${encodeURIComponent(cfg.branch.qa)}&to=${encodeURIComponent(branch)}`),
        { headers: gl.h() },
      );
      if (diffResp.status === 200 && diffResp.data) {
        const diffs = (diffResp.data.diffs as Array<Record<string, boolean>>) || [];
        const conflicts = diffs.filter((d) => !d.new_file && !d.deleted_file && !d.renamed_file);
        if (conflicts.length > 0) {
          logWarn(`GQ4: ${conflicts.length} file(s) modified in both branches -- potential merge conflicts`);
          addWarning(state, 'generate_code', `${conflicts.length} potential merge conflicts detected`);
        } else {
          logOk('GQ4: No merge conflicts detected');
        }
      }
    } catch (conflictErr: unknown) {
      const msg = conflictErr instanceof Error ? conflictErr.message : String(conflictErr);
      logDebug(`GQ4: Conflict detection failed: ${msg} -- proceeding anyway`);
    }
    data._conflict_check_done = true;
    save(state);
  }

  // T2.19: Divergence check
  if (data.code_committed && !data._divergence_checked) {
    try {
      const branchResp = await req(
        gl.u(`/repository/branches/${encodeURIComponent(branch)}`),
        { headers: gl.h() },
      );
      if (branchResp.status === 200 && branchResp.data && (branchResp.data as Record<string, unknown>).commit) {
        const commitObj = (branchResp.data as Record<string, unknown>).commit as Record<string, string>;
        const remoteSha = commitObj.id;
        const localSha = data._last_commit_sha as string;
        if (localSha && localSha !== remoteSha) {
          logErr(`GQ8: Remote branch has diverged! Local SHA: ${localSha.substring(0, 8)}, Remote SHA: ${remoteSha.substring(0, 8)}`);
          addWarning(state, 'generate_code', `Branch diverged: local ${localSha.substring(0, 8)} vs remote ${remoteSha.substring(0, 8)}`);
          throw new Error(`Branch ${branch} has diverged -- manual resolution required.`);
        }
        logOk('GQ8: Remote branch verified -- no divergence');
      }
    } catch (divErr: unknown) {
      const msg = divErr instanceof Error ? divErr.message : String(divErr);
      if (msg.includes('diverged')) throw divErr;
      logDebug(`GQ8: Divergence check failed: ${msg}`);
    }
    data._divergence_checked = true;
    save(state);
  }

  // Create MR
  if (!data.code_mr_iid) {
    logInfo(`Creating MR: ${branch} -> ${cfg.branch.qa} (assigned to you)...`);

    const safeSummary = sanitizeMRText(changes.summary || '');
    const safeTestNotes = sanitizeMRText(changes.test_notes || '');

    // Q7: Enhanced MR description with quality report
    const tscStatus = (data._build_tsc as string) || 'N/A';
    const eslintStatus = (data._build_eslint as string) || 'N/A';
    const acVerification = data._ac_verification
      ? (data._ac_known_gaps ? 'Partial -- see known gaps below' : 'All criteria met')
      : (ticket?.ac_missing ? 'N/A (no AC)' : 'Not verified');

    let qualitySection = `### Quality Report\n`;
    qualitySection += `- TypeScript: ${tscStatus === 'PASS' ? 'No errors' : tscStatus}\n`;
    qualitySection += `- ESLint: ${eslintStatus === 'PASS' ? 'No errors' : eslintStatus}\n`;
    qualitySection += `- Code Review: ${data._reviewed ? 'Completed' : 'Pending'}\n`;
    qualitySection += `- Security: ${data._fixed ? 'Fixed' : (data._reviewed ? 'Passed' : 'Pending')}\n`;
    qualitySection += `- AC Verification: ${acVerification}\n`;

    // Browser verify section
    let browserVerifySection = '';
    if (cfg.flags?.browserVerify && data._browser_verified && deps.buildBrowserVerifyMRSection) {
      browserVerifySection = deps.buildBrowserVerifyMRSection(state);
    }

    // Per-file change rationale
    let fileSection = `### Changes\n`;
    const plan = (data.explore_plan as string) || '';
    for (const c of changes.changes) {
      const fileName = c.file_path.split('/').pop() || '';
      const planLines = plan.split('\n');
      const rationale = planLines.find((l) => l.includes(fileName) || l.includes(c.file_path));
      fileSection += `- ${c.action}: \`${c.file_path}\`${rationale ? ` -- ${rationale.replace(/^[-*\s]+/, '').substring(0, 100)}` : ''}\n`;
    }

    // Known gaps
    let gapSection = '';
    if (data._ac_known_gaps) {
      gapSection = `\n### Known Gaps\n${data._ac_known_gaps}\n`;
    }

    const mrDescription = deps.redactSecrets(
      `## ${TICKET} -- ${ticket?.summary || ''}\n\n` +
      `${safeSummary}\n\n` +
      `${qualitySection}\n` +
      `${browserVerifySection ? browserVerifySection + '\n' : ''}` +
      `${fileSection}\n` +
      `### Test Notes\n${safeTestNotes}\n` +
      `${gapSection}\n` +
      `---\nAI Dev Agent | Branch: \`${data.code_source_branch || cfg.branch.ts}\` -> \`${branch}\``,
    );

    deps.validateMRTarget(cfg.branch.qa);
    const mr = await gl.createMR(
      branch, cfg.branch.qa,
      `feat(${TICKET}): ${((ticket?.summary as string) || '').replace(/\n/g, ' ').replace(/[<>]/g, '').substring(0, 100)}`,
      mrDescription,
      true, cfg.git.assigneeId,
    );
    data.code_mr_iid = mr.iid;
    data.code_mr_url = mr.web_url;
    save(state);
    logOk(`MR !${mr.iid} created and assigned`);
  }

  // Slack notification only (no Jira comment)
  if (!data.code_slack_sent) {
    if (isChannelEnabled('gate_code_review', 'slack')) {
      await slack(
        `*Code Review Required -- ${TICKET}*\n` +
        `Agent generated code for: *${ticket?.summary || ''}*\n` +
        `MR: ${data.code_mr_url}\n` +
        `Approve the MR on GitLab to proceed.`,
        [cfg.slack.ownerId],
      );
      logOk('Slack notification sent (no Jira comment)');
    }
    data.code_slack_sent = true;
    save(state);
  }

  state.stage = 'gate_code_review';
  save(state);
}
