// =====================================================================
// MI Dev Agent -- Legacy JSON-based Code Generation (TypeScript port)
// =====================================================================
// Fallback code generation path when no local repo is available.
// Uses GitLab API only (no local file system access).
//
// Flow:
//   1. Fetch repo context (tree + file content)
//   2. Developer Agent generates JSON changes
//   3. Reviewer + Security Agents (parallel)
//   4. Fixer Agent resolves issues
//   5. Push to GitLab
//
// Ported from: stages/generate-code/legacy-codegen.js
// =====================================================================

import type { PipelineState } from '@shared/types';
import { logInfo, logOk, logErr, logWarn } from '../lib/logger';
import {
  sanitizeForPrompt, truncateWithIndicator,
  validateClaudeNotEmpty, detectClaudeRefusal, extractJson,
} from '../lib/utils';
import { parseVerdict } from './fixer';

// ── Types ────────────────────────────────────────────────────────────

/** File change in JSON format */
export interface LegacyFileChange {
  action: 'create' | 'update' | 'delete';
  file_path: string;
  content: string;
}

/** Legacy changes object */
export interface LegacyChanges {
  changes: LegacyFileChange[];
  summary?: string;
  test_notes?: string;
}

/** Context for legacy codegen */
export interface LegacyCodegenContext {
  state: PipelineState;
  approvedPlan: string;
  devFullContext: string;
  extraDocs: string;
  extraFeedback: string;
  feedback: string;
}

/** Dependencies for legacy codegen */
export interface LegacyCodegenDeps {
  cfg: {
    ticket: string;
    branch: { ts: string; qa: string };
    git: { authorName: string; authorEmail: string; assigneeId: number };
    slack: { ownerId: string };
  };
  /** Timeout values */
  developerTimeoutMs: number;
  reviewerTimeoutMs: number;
  /** Apply complexity timeout */
  applyComplexityTimeout: (baseMs: number, state: PipelineState) => number;
  /** Call Claude (direct API) */
  callClaude: (prompt: string, timeoutMs: number) => Promise<string>;
  /** Fetch repo context (tree + files) */
  fetchRepoContext: (
    ticket: string, summary: string, description: string,
    ac: string, feedback: string, state: PipelineState,
  ) => Promise<{ treeStr: string; fileContext: string }>;
  /** GitLab service (for fetching originals) */
  gl: {
    getFile: (filePath: string, branch: string) => Promise<string | null>;
  };
  /** Save state */
  save: (state: PipelineState) => void;
  /** Push code to GitLab */
  pushCodeToGitLab: (state: PipelineState, changes: LegacyChanges) => Promise<void>;
}

// ── Main function ───────────────────────────────────────────────────

/**
 * Legacy JSON-based code generation (GitLab API only, no local repo).
 */
export async function legacyJsonCodegen(
  ctx: LegacyCodegenContext,
  deps: LegacyCodegenDeps,
): Promise<void> {
  const { state, approvedPlan, devFullContext, extraDocs, extraFeedback, feedback } = ctx;
  const data = state.data as Record<string, unknown>;
  const ticket = data.ticket as Record<string, unknown>;
  const { summary, description, ac } = ticket as {
    summary: string; description: string; ac: string;
  };
  const iType = (ticket.issueType as string) || 'Task';
  const iPriority = (ticket.priority as string) || 'Medium';
  const TICKET = deps.cfg.ticket;

  const CODEGEN_TIMEOUT = deps.reviewerTimeoutMs;

  logInfo('No local repo -- using legacy JSON-based code generation');

  const { treeStr, fileContext } = await deps.fetchRepoContext(
    TICKET, summary, description, ac, feedback, state,
  );

  const code = await deps.callClaude(
    `You are the **Developer Agent** at MasterIndia. Write production-ready code.\n\n` +
    `## MANDATORY RULES\n` +
    `1. **REUSE existing code**: Use EXACT same components, hooks, utils, services.\n` +
    `2. **Match existing patterns EXACTLY**: Same import style, state management, naming.\n` +
    `3. **Prefer "update" over "create"**: Modify existing files.\n` +
    `4. **Import from existing paths**: Same import aliases, relative paths.\n` +
    `5. **Copy from similar features**: If there's an existing edit form, table, modal -- copy it.\n` +
    `6. **No unnecessary abstractions**.\n` +
    `7. **VITE_PRODUCT_ID checks**: Must use exact enterprise product ID.\n` +
    `8. **Enterprise app ONLY**: Do NOT reference other product lines.\n` +
    `9. **NEVER delete existing functions, components, or endpoints**.\n\n` +
    `## FORBIDDEN (F3)\n` +
    `FORBIDDEN: .git/, node_modules/, package.json scripts, shell scripts, CI/CD files.\n\n` +
    `## Pre-approved implementation plan\n${approvedPlan}\n\n` +
    `Jira ticket: ${TICKET} [${iType} / ${iPriority}]: ${summary}\n` +
    `Description: ${sanitizeForPrompt(description)}\nAC: ${sanitizeForPrompt(ac)}\n` +
    `${extraDocs}${extraFeedback}${devFullContext}` +
    `${feedback ? `Feedback: ${feedback}\n` : ''}` +
    `${data.previousAttemptSummary ? `\n## Previous attempt file changes:\n${data.previousAttemptSummary}\n` : ''}` +
    `\nRepository structure (branch: ${deps.cfg.branch.ts}):\n${treeStr}\n\n` +
    `Existing code:\n${fileContext}\n\n` +
    `Return ALL changes as JSON:\n` +
    '```json\n{\n  "changes": [\n    { "action": "update", "file_path": "...", "content": "...full file..." }\n  ],\n  "summary": "...",\n  "test_notes": "..."\n}\n```\nReturn COMPLETE file contents (not diffs).',
    deps.applyComplexityTimeout(deps.developerTimeoutMs, state),
  );

  validateClaudeNotEmpty(code, 'Developer Agent (legacy)');
  detectClaudeRefusal(code, 'Developer Agent (legacy)');

  let changes: LegacyChanges;
  try {
    changes = extractJson(code) as unknown as LegacyChanges;
  } catch (extractErr: unknown) {
    const errMsg = extractErr instanceof Error ? extractErr.message : String(extractErr);
    logErr(`Could not parse JSON (${errMsg}) -- asking JSON Fixer Agent...`);
    const truncated = code.length > 80_000 ? code.substring(0, 80_000) + '\n...(truncated)' : code;
    const fix = await deps.callClaude(
      `You are the **JSON Fixer Agent**. The following text should contain a JSON object with a "changes" array. ` +
      `Extract, repair, and return ONLY the valid JSON. No markdown fences, no explanation.\n\n${truncated}`,
      deps.applyComplexityTimeout(CODEGEN_TIMEOUT, state),
    );
    try {
      changes = extractJson(fix) as unknown as LegacyChanges;
    } catch {
      throw new Error('Code generation failed: could not parse JSON after retry');
    }
  }

  if (!changes || !changes.changes || changes.changes.length === 0) {
    logErr('No files were generated -- ticket may lack description or acceptance criteria.');
    throw new Error('Code generation produced 0 files. Cannot proceed.');
  }

  // Reviewer + Security (parallel)
  logInfo('Agents Team -- Reviewer + Security Agents (parallel)...');
  const changesPreview = changes.changes
    .map((c) => `--- ${c.action}: ${c.file_path} ---\n${c.content.substring(0, 4000)}`)
    .join('\n\n');

  const legacyPlanDigest = approvedPlan
    ? truncateWithIndicator(approvedPlan, 8000)
    : '(no plan available)';

  const [reviewResult, securityResult] = await Promise.all([
    deps.callClaude(
      `You are the **Reviewer Agent**. Check proposed changes.\n\n` +
      `## Checklist:\n1. Reuse violations 2. Pattern violations 3. Bugs 4. Unnecessary new files\n` +
      `5. Generic VITE_PRODUCT_ID 6. Plan compliance 7. Non-enterprise scope\n\n` +
      `## Approved Plan:\n${legacyPlanDigest}\n\n` +
      `Ticket: ${TICKET} -- ${summary}\n\nExisting:\n${fileContext}\n\nProposed:\n${changesPreview}\n\n` +
      `List issues found.\n\n` +
      `**IMPORTANT**: End with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``,
      deps.applyComplexityTimeout(deps.reviewerTimeoutMs, state),
    ),
    deps.callClaude(
      `You are the **Security Agent**. Audit for security issues.\n\n` +
      `## Checklist: XSS, Injection, Auth, Secrets, Input validation\n` +
      `- Data Isolation, PII Handling, Product Scope\n\n` +
      `Ticket: ${TICKET} -- ${summary}\n\nProposed:\n${changesPreview}\n\n` +
      `List security issues (CRITICAL/HIGH/MEDIUM/LOW).\n\n` +
      `**IMPORTANT**: End with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``,
      deps.applyComplexityTimeout(deps.reviewerTimeoutMs, state),
    ),
  ]);
  logOk('Reviewer + Security Agents complete');

  const hasReviewIssues = !parseVerdict(reviewResult, 'lgtm');
  const hasSecurityIssues = !parseVerdict(securityResult, 'secure');

  if (hasReviewIssues || hasSecurityIssues) {
    const issues: string[] = [];
    if (hasReviewIssues) issues.push(`## [REVIEWER-CRITICAL] Code Review Issues\n${reviewResult}`);
    if (hasSecurityIssues) issues.push(`## [SECURITY-HIGH] Security Issues\n${securityResult}`);

    logInfo('Agents Team -- Fixer Agent: resolving issues...');
    try {
      const fixed = await deps.callClaude(
        `You are the **Fixer Agent**. Fix ALL issues.\n\n` +
        `IMPORTANT: [REVIEWER-CRITICAL] first. [SECURITY-HIGH] are security vulnerabilities.\n\n` +
        `${issues.join('\n\n')}\n\n` +
        `Existing:\n${fileContext}\n\nOriginal:\n\`\`\`json\n${JSON.stringify(changes, null, 2)}\n\`\`\`\n\n` +
        `Return corrected JSON only. Prefer "update" over "create". Reuse existing code.`,
        deps.applyComplexityTimeout(deps.developerTimeoutMs, state),
      );
      try {
        changes = extractJson(fixed) as unknown as LegacyChanges;
        logOk('Fixer Agent: issues resolved');
      } catch {
        logErr('Fixer output not parseable -- HALTING. Code has known issues.');
        data._fixer_failed = true;
        deps.save(state);
        throw new Error('Fixer failed to produce valid output -- manual review required');
      }
    } catch (fixerErr: unknown) {
      const msg = fixerErr instanceof Error ? fixerErr.message : String(fixerErr);
      if (msg.includes('Fixer Agent failed') || msg.includes('Fixer failed')) throw fixerErr;
      logErr(`Fixer Agent error: ${msg}`);
      data._fixer_failed = true;
      deps.save(state);
      throw new Error(`Fixer Agent failed: ${msg}`);
    }
  } else {
    logOk('Review: LGTM. Security: SECURE');
  }

  logOk(`${changes.changes.length} file(s) ready`);

  // Fetch original files for diff viewer
  const originalFiles: Record<string, string> = {};
  for (const c of changes.changes) {
    if (c.action === 'update') {
      try {
        const orig = await deps.gl.getFile(c.file_path, deps.cfg.branch.ts);
        if (orig) originalFiles[c.file_path] = orig;
      } catch { /* ignore */ }
    }
  }
  data.original_files = originalFiles;
  data.codeChanges = changes;
  data.plan = ctx.approvedPlan;

  if (data.feedback) {
    data.rejectionHistory = data.rejectionHistory || [];
    (data.rejectionHistory as Array<{ feedback: unknown; ts: string }>).push({
      feedback: data.feedback,
      ts: new Date().toISOString(),
    });
  }
  delete data.feedback;
  deps.save(state);

  await deps.pushCodeToGitLab(state, changes);
}
