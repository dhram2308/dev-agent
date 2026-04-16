"use strict";

import type { PipelineState } from '@mi/shared';

const { cfg, TICKET, REVIEWER_TIMEOUT_MS, DEVELOPER_TIMEOUT_MS, applyComplexityTimeout } = require("../../lib/config");
const { logInfo, logOk, logErr, logWarn } = require("../../lib/logging");
const { truncateWithIndicator, sanitizeForPrompt } = require("../../lib/utils");
const { save } = require("../../lib/state");
const { runAgentsTeam, runSingleAgent } = require("../../lib/agents-team");
const { localGetChanges, localGetOriginal } = require("../../lib/local-repo");
const { categorizeIssues } = require("../../lib/jira");
const { parseVerdict } = require("./fixer");

/**
 * Run Reviewer + Security Agents in parallel, then Fixer if needed.
 */
async function runReviewerAndSecurity(ctx: any, fileChanges: any[], originalFiles: Record<string, string>): Promise<any[]> {
  const { state, approvedPlan } = ctx;
  const { summary } = (state as PipelineState).data.ticket as any;

  // D10: Skip if already reviewed on re-entry
  if ((state.data as any)._reviewed && (state.data as any)._fixed) {
    logOk("Reviewer + Fixer already complete (checkpoint) — skipping");
    return fileChanges;
  }

  logInfo("Agents Team — Reviewer + Security Agents (parallel)…");
  const changedFilesList = fileChanges.map((c: any) => `- ${c.action}: ${c.file_path}`).join("\n");

  // F9/Z2: Include approved plan for Reviewer
  const planDigest = approvedPlan ? truncateWithIndicator(approvedPlan, 8000) : "(no plan available)";

  const reviewerPrompt =
    `You are the **Reviewer Agent** at MasterIndia. Review the code changes in this repository.\n\n` +
    `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Use Read/Grep/Glob tools to verify code quality.\n\n` +
    `## Review checklist:\n` +
    `1. **Reuse violations**: Did the developer create new components/utils/hooks that already exist? Flag as CRITICAL.\n` +
    `2. **Pattern violations**: Does the code follow existing codebase patterns?\n` +
    `3. **Bugs & missing imports**: Any runtime errors, missing dependencies, broken references?\n` +
    `4. **Unnecessary new files**: Could any new file be an update to an existing file instead?\n` +
    `5. **Generic VITE_PRODUCT_ID checks**: Flag as CRITICAL if code uses generic multi-product conditionals (e.g. \`=== '1' || === '2'\`) instead of the exact enterprise product ID.\n` +
    `6. **Plan Compliance**: Compare changes against the approved plan below. Flag if Developer skipped steps, modified unplanned files, or deviated.\n` +
    `7. **Non-enterprise scope**: Flag as CRITICAL if code modifies or references other product lines (SME, GST, TaxPro, etc.).\n\n` +
    `## Approved Plan:\n${planDigest}\n\n` +
    `Ticket: ${TICKET} — ${sanitizeForPrompt(summary)}\n\n` +
    `## Changed files:\n${changedFilesList}\n\n` +
    `Read the changed files, compare against existing patterns, and list all issues found.\n\n` +
    `**IMPORTANT**: End your response with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``;

  const securityPrompt =
    `You are the **Security Agent**. Audit the code changes in this repository for security issues.\n\n` +
    `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Use Read/Grep tools to check code.\n\n` +
    `## Security checklist:\n` +
    `1. **XSS**: Unescaped user input? Unsafe innerHTML/dangerouslySetInnerHTML?\n` +
    `2. **Injection**: String concatenation in API calls, SQL, or shell commands?\n` +
    `3. **Auth/Permissions**: Missing auth checks or exposed sensitive data?\n` +
    `4. **Exposed secrets**: Hardcoded API keys, tokens, passwords?\n` +
    `5. **Input validation**: Missing validation on user inputs?\n` +
    `6. **Data Isolation**: Verify tenant/product data isolation is maintained.\n` +
    `7. **PII Handling**: Check for proper PII handling (no logging, encryption at rest/transit).\n` +
    `8. **Product Scope**: Ensure no cross-product data leakage (enterprise data stays enterprise).\n\n` +
    `Ticket: ${TICKET} — ${sanitizeForPrompt(summary)}\n\n` +
    `## Changed files:\n${changedFilesList}\n\n` +
    `Read the changed files and list all security issues with severity (CRITICAL/HIGH/MEDIUM/LOW).\n\n` +
    `**IMPORTANT**: End your response with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``;

  const { reviewResult, securityResult } = await runAgentsTeam({
    teamName: "Review Team",
    agents: [
      {
        name: "Reviewer Agent",
        prompt: reviewerPrompt,
        timeout: applyComplexityTimeout(REVIEWER_TIMEOUT_MS, state),
        opts: { cwd: cfg.localRepo, maxTurns: 15, allowedTools: ["Read", "Grep", "Glob"] },
        required: true,
        checkpointKey: "_reviewer_result",
      },
      {
        name: "Security Agent",
        prompt: securityPrompt,
        timeout: applyComplexityTimeout(REVIEWER_TIMEOUT_MS, state),
        opts: { cwd: cfg.localRepo, maxTurns: 10, allowedTools: ["Read", "Grep", "Glob"] },
        required: false,
        checkpointKey: "_security_result",
      },
    ],
    state,
    merge: (results: any[]) => {
      const rev = results.find((r: any) => r.name === "Reviewer Agent");
      const sec = results.find((r: any) => r.name === "Security Agent");
      return { reviewResult: rev?.output || "", securityResult: sec?.output || "" };
    },
  });
  logOk("Review Team complete");

  // D10: Reviewed checkpoint
  (state.data as any)._reviewed = true;
  save(state);

  // Step 6 — Fixer (conditional) — writes fixes directly
  const reviewPassed = parseVerdict(reviewResult, "lgtm");
  const securityPassed = parseVerdict(securityResult, "secure");
  const hasReviewIssues = !reviewPassed;
  const hasSecurityIssues = securityResult && securityResult.length > 20 && !securityPassed;

  if (hasReviewIssues || hasSecurityIssues) {
    const categorized = categorizeIssues(
      hasReviewIssues ? reviewResult : null,
      hasSecurityIssues ? securityResult : null,
    );
    const allIssues = categorized.map((c: any) => `## ${c.label} (${c.type})\n${c.content}`).join("\n\n");
    const priorityOrder = categorized.map((c: any) => c.type).join(" > ");
    logInfo(`X5: Issue categories (priority order): ${priorityOrder}`);

    logInfo("Agents Team — Fixer Agent: resolving issues directly…");
    const fixerResult = await runSingleAgent({
      name: "Fixer Agent",
      prompt: `You are the **Fixer Agent**. Fix ALL issues found by the Reviewer and Security agents.\n\n` +
        `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Read the flagged files and fix them directly using Write/Edit.\n` +
        `DO NOT output JSON. Write fixes DIRECTLY to the files on disk.\n\n` +
        `## X5: Fix Priority Order\nFix issues in this order: ${priorityOrder}\n` +
        `COMPILATION errors first (missing imports, type errors), then SECURITY vulnerabilities, then CODE REVIEW issues, then LINT warnings.\n\n` +
        `If reuse violations were flagged, replace custom code with existing repo components/utils/hooks.\n` +
        `If security issues were flagged, fix them following OWASP best practices.\n` +
        `If generic VITE_PRODUCT_ID checks were flagged, replace with the exact enterprise product ID constant.\n` +
        `If non-enterprise scope was flagged, remove all references to other product lines (SME, GST, TaxPro, etc.).\n\n` +
        `${allIssues}\n\n` +
        `## Changed files:\n${changedFilesList}\n\n` +
        `Read each flagged file, apply the fixes, and confirm what you changed.`,
      timeout: applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
      opts: { cwd: cfg.localRepo, maxTurns: 20, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
      state,
      checkpointKey: "_fixer_result",
      required: true,
    });
    logOk("Fixer Agent: issues resolved");

    // D10: Fixed checkpoint
    (state.data as any)._fixed = true;
    save(state);

    // Step 7 — Re-extract changes after fixer ran
    logInfo("Re-extracting file changes after fixes…");
    fileChanges = localGetChanges(cfg.localRepo);
    for (const c of fileChanges) {
      if (c.action === "update" && !originalFiles[c.file_path]) {
        const orig = localGetOriginal(cfg.localRepo, c.file_path);
        if (orig) originalFiles[c.file_path] = orig;
      }
    }
  } else {
    logOk("Review: LGTM · Security: SECURE");
    (state.data as any)._fixed = true;
    save(state);
  }

  return fileChanges;
}

export { runReviewerAndSecurity };
