"use strict";

import type { PipelineState } from '@mi/shared';

const { cfg, TICKET, DEVELOPER_TIMEOUT_MS, REVIEWER_TIMEOUT_MS, applyComplexityTimeout } = require("../../lib/config");
const { logInfo, logOk, logErr, logWarn } = require("../../lib/logging");
const { sanitizeForPrompt, truncateWithIndicator, validateClaudeNotEmpty, detectClaudeRefusal, extractJson } = require("../../lib/utils");
const { save } = require("../../lib/state");
const { callClaude, fetchRepoContext } = require("../../lib/claude");
const { gl } = require("../../lib/gitlab");
const { parseVerdict } = require("./fixer");
const { pushCodeToGitLab } = require("../push-code");

/**
 * Legacy JSON-based code generation (GitLab API only, no local repo).
 */
async function legacyJsonCodegen(ctx: any): Promise<void> {
  const { state, approvedPlan, devFullContext, extraDocs, extraFeedback, feedback } = ctx;
  const { summary, description, ac, issueType: iType, priority: iPriority } = (state as PipelineState).data.ticket as any;

  // Z12: Use named timeouts from config
  const CODEGEN_TIMEOUT = REVIEWER_TIMEOUT_MS;

  logInfo("No local repo -- using legacy JSON-based code generation");

  const { treeStr, fileContext } = await fetchRepoContext(TICKET, summary, description, ac, feedback, state);

  const code = await callClaude(
    `You are the **Developer Agent** in an agents-team at MasterIndia. Write production-ready code.\n\n` +
    `## MANDATORY RULES\n` +
    `1. **REUSE existing code**: Use the EXACT same components, hooks, utils, services, API calls, styles, constants.\n` +
    `2. **Match existing patterns EXACTLY**: Same import style, state management, error handling, naming, folder structure.\n` +
    `3. **Prefer "update" over "create"**: Modify existing files. Only create a new file when genuinely needed.\n` +
    `4. **Import from existing paths**: Same import aliases, relative paths, barrel exports.\n` +
    `5. **Copy from similar features**: If there's an existing edit form, table, modal -- copy its structure.\n` +
    `6. **No unnecessary abstractions**: Don't create helpers/utils the repo doesn't have.\n` +
    `7. **VITE_PRODUCT_ID checks**: Must use the exact enterprise product ID -- no generic multi-product conditionals like \`=== '1' || === '2'\`.\n` +
    `8. **Enterprise app ONLY**: Do NOT modify or reference other product lines (SME, GST, TaxPro, etc.) -- stay within enterprise scope.\n` +
    `9. **NEVER delete existing functions, components, or endpoints** -- only add or modify.\n\n` +
    `## FORBIDDEN (F3 -- File Path Restrictions)\n` +
    `You may ONLY modify files within the project directory.\n` +
    `FORBIDDEN: You must NEVER modify files in .git/, node_modules/, or package.json scripts.\n` +
    `FORBIDDEN: You must NEVER create shell scripts (.sh, .bash) or modify CI/CD files (.gitlab-ci.yml).\n\n` +
    `## Pre-approved implementation plan\n${approvedPlan}\n\n` +
    `Jira ticket: ${TICKET} [${iType || "Task"} / ${iPriority || "Medium"}]: ${summary}\nDescription: ${sanitizeForPrompt(description)}\nAC: ${sanitizeForPrompt(ac)}\n` +
    `${extraDocs}${extraFeedback}${devFullContext}` +
    `${feedback ? `Feedback: ${feedback}\n` : ""}` +
    `${(state as PipelineState).data.previousAttemptSummary ? `\n## Previous attempt file changes (for reference):\n${(state as PipelineState).data.previousAttemptSummary}\n` : ""}` +
    `\nRepository structure (branch: ${cfg.branch.ts}):\n${treeStr}\n\n` +
    `Existing code:\n${fileContext}\n\n` +
    `Return ALL changes as JSON:\n` +
    `\`\`\`json\n{\n  "changes": [\n    { "action": "update", "file_path": "src/existing-file.js", "content": "...full file..." },\n    { "action": "create", "file_path": "src/new-file.js", "content": "...only if truly needed..." }\n  ],\n  "summary": "one-paragraph summary",\n  "test_notes": "what to test manually"\n}\n\`\`\`\nReturn COMPLETE file contents (not diffs).`,
    applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
  );
  // W7: Validate non-empty output
  validateClaudeNotEmpty(code, "Developer Agent (legacy)");
  // W8: Detect safety refusals
  detectClaudeRefusal(code, "Developer Agent (legacy)");

  let changes: any;
  try {
    changes = extractJson(code);
  } catch (extractErr: any) {
    logErr(`Could not parse JSON (${extractErr.message}) -- asking JSON Fixer Agent...`);
    const truncated = code.length > 80_000 ? code.substring(0, 80_000) + "\n...(truncated)" : code;
    const fix = await callClaude(
      `You are the **JSON Fixer Agent**. The following text should contain a JSON object with a "changes" array. ` +
      `Extract, repair, and return ONLY the valid JSON. Fix any truncation, missing brackets, or trailing commas. ` +
      `No markdown fences, no explanation -- pure JSON only.\n\n${truncated}`,
      applyComplexityTimeout(CODEGEN_TIMEOUT, state),
    );
    try {
      changes = extractJson(fix);
    } catch {
      throw new Error("Code generation failed: could not parse JSON after retry");
    }
  }

  if (!changes || !changes.changes || changes.changes.length === 0) {
    logErr("No files were generated -- ticket may lack description or acceptance criteria.");
    throw new Error("Code generation produced 0 files. Cannot proceed.");
  }

  // Reviewer + Security (parallel) -- legacy JSON preview mode
  logInfo("Agents Team -- Reviewer + Security Agents (parallel)...");
  const changesPreview = changes.changes.map((c: any) => `--- ${c.action}: ${c.file_path} ---\n${c.content.substring(0, 4000)}`).join("\n\n");

  // F9/Z2: Include approved plan for Reviewer
  const legacyPlanDigest = approvedPlan ? truncateWithIndicator(approvedPlan, 8000) : "(no plan available)";

  const [reviewResult, securityResult] = await Promise.all([
    callClaude(
      `You are the **Reviewer Agent**. Check proposed changes.\n\n` +
      `## Review checklist:\n` +
      `1. **Reuse violations**: New components/utils/hooks that already exist? CRITICAL.\n` +
      `2. **Pattern violations**: Does code follow existing patterns?\n` +
      `3. **Bugs & missing imports**: Runtime errors, broken references?\n` +
      `4. **Unnecessary new files**: Could any "create" be an "update"?\n` +
      `5. **Generic VITE_PRODUCT_ID checks**: Flag as CRITICAL if code uses generic multi-product conditionals.\n` +
      `6. **Plan Compliance**: Compare changes against the approved plan below. Flag if Developer skipped steps, modified unplanned files, or deviated.\n` +
      `7. **Non-enterprise scope**: Flag as CRITICAL if code modifies other product lines.\n\n` +
      `## Approved Plan:\n${legacyPlanDigest}\n\n` +
      `Ticket: ${TICKET} -- ${summary}\n\n` +
      `Existing codebase:\n${fileContext}\n\nProposed:\n${changesPreview}\n\n` +
      `List issues found.\n\n` +
      `**IMPORTANT**: End your response with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``,
      applyComplexityTimeout(REVIEWER_TIMEOUT_MS, state),
    ),
    callClaude(
      `You are the **Security Agent**. Audit for security issues.\n\n` +
      `## Checklist: XSS, Injection, Auth, Secrets, Input validation\n` +
      `## Enterprise-specific (Z4):\n` +
      `- **Data Isolation**: Verify tenant/product data isolation is maintained.\n` +
      `- **PII Handling**: Check for proper PII handling (no logging, encryption at rest/transit).\n` +
      `- **Product Scope**: Ensure no cross-product data leakage.\n\n` +
      `Ticket: ${TICKET} -- ${summary}\n\nProposed:\n${changesPreview}\n\n` +
      `List security issues (CRITICAL/HIGH/MEDIUM/LOW).\n\n` +
      `**IMPORTANT**: End your response with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``,
      applyComplexityTimeout(REVIEWER_TIMEOUT_MS, state),
    ),
  ]);
  logOk("Reviewer + Security Agents complete");

  const hasReviewIssues = !parseVerdict(reviewResult, "lgtm");
  const hasSecurityIssues = !parseVerdict(securityResult, "secure");

  if (hasReviewIssues || hasSecurityIssues) {
    // Z3: Tag issues before sending to Fixer
    const issues: string[] = [];
    if (hasReviewIssues) issues.push(`## [REVIEWER-CRITICAL] Code Review Issues\n${reviewResult}`);
    if (hasSecurityIssues) issues.push(`## [SECURITY-HIGH] Security Issues\n${securityResult}`);

    logInfo("Agents Team -- Fixer Agent: resolving issues...");
    try {
      const fixed = await callClaude(
        `You are the **Fixer Agent**. Fix ALL issues.\n\n` +
        `IMPORTANT: Issues tagged [REVIEWER-CRITICAL] must be fixed first. Issues tagged [SECURITY-HIGH] are security vulnerabilities.\n\n` +
        `${issues.join("\n\n")}\n\n` +
        `Existing codebase:\n${fileContext}\n\nOriginal:\n\`\`\`json\n${JSON.stringify(changes, null, 2)}\n\`\`\`\n\n` +
        `Return corrected JSON only. Prefer "update" over "create". Reuse existing code.`,
        applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
      );
      try {
        changes = extractJson(fixed);
        logOk("Fixer Agent: issues resolved");
      } catch (parseErr: any) {
        // F7: Explicit halt on Fixer failure -- never silently use original code
        logErr(`Fixer output not parseable -- HALTING. Code has known issues.`);
        (state.data as any)._fixer_failed = true;
        save(state);
        throw new Error("Fixer failed to produce valid output -- manual review required");
      }
    } catch (fixerErr: any) {
      if (fixerErr.message.includes("Fixer Agent failed")) throw fixerErr;
      // F7: Explicit halt on Fixer error
      logErr(`Fixer Agent error: ${fixerErr.message}`);
      (state.data as any)._fixer_failed = true;
      save(state);
      throw new Error(`Fixer Agent failed: ${fixerErr.message}`);
    }
  } else {
    logOk("Review: LGTM -- Security: SECURE");
  }

  logOk(`${changes.changes.length} file(s) ready`);

  // Fetch original files for diff viewer
  const originalFiles: Record<string, string> = {};
  for (const c of changes.changes) {
    if (c.action === "update") {
      try {
        const orig = await gl.getFile(c.file_path, cfg.branch.ts);
        if (orig) originalFiles[c.file_path] = orig;
      } catch {}
    }
  }
  (state.data as any).original_files = originalFiles;
  (state.data as any).codeChanges = changes;
  (state.data as any).plan = ctx.approvedPlan;
  if ((state.data as any).feedback) {
    (state.data as any).rejectionHistory = (state.data as any).rejectionHistory || [];
    (state.data as any).rejectionHistory.push({ feedback: (state.data as any).feedback, ts: new Date().toISOString() });
  }
  delete (state.data as any).feedback;
  save(state);

  await pushCodeToGitLab(state, changes);
}

export { legacyJsonCodegen };
