"use strict";

import type { PipelineState, QuestionAnswer } from '@mi/shared';

const { cfg, TICKET, REVIEWER_TIMEOUT_MS, SECURITY_TIMEOUT_MS, DEVELOPER_TIMEOUT_MS, REVIEWER_MAX_TURNS, FIXER_MAX_TURNS, applyComplexityTimeout } = require("../../lib/config");
const { logInfo, logOk, logErr, logWarn } = require("../../lib/logging");
const { truncateWithIndicator, sanitizeForPrompt } = require("../../lib/utils");
const { save } = require("../../lib/state");
const { runAgentsTeam, runSingleAgent } = require("../../lib/agents-team");
const { localGetChanges, localGetOriginal } = require("../../lib/local-repo");
const { categorizeIssues } = require("../../lib/jira");
const { parseVerdict } = require("./fixer");
const { _validateDevChanges } = require("./developer");
const { buildDecisionsBlock } = require("./decisions-block") as {
  buildDecisionsBlock: (qa: QuestionAnswer[] | undefined | null) => string;
};

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

  // Decisions from clarifying-questions — all three agents here need them
  // so they don't flag correctly-answered items as wrong.
  const decisionsBlock = buildDecisionsBlock(
    (state as PipelineState).data._qa_answers as QuestionAnswer[] | undefined,
  );

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
    `7. **Non-enterprise scope**: Flag as CRITICAL if code modifies or references other product lines (SME, GST, TaxPro, etc.).\n` +
    // M19/M20: Defense in depth — even if the Security Agent runs, the
    // Reviewer should independently flag the most common ship-stoppers so
    // the Fixer can pick up either signal.
    `8. **Hardcoded secrets**: API keys, tokens, passwords, private keys in source? Flag as CRITICAL.\n` +
    `9. **Injection risk**: String concatenation building SQL, shell commands, or API URLs from user input? Flag as CRITICAL.\n\n` +
    `## Approved Plan:\n${planDigest}\n\n` +
    `Ticket: ${TICKET} — ${sanitizeForPrompt(summary)}\n\n` +
    `## Changed files:\n${changedFilesList}\n\n` +
    `${decisionsBlock}` +
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
    `${decisionsBlock}` +
    `Read the changed files and list all security issues with severity (CRITICAL/HIGH/MEDIUM/LOW).\n\n` +
    `**IMPORTANT**: End your response with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``;

  const { reviewResult, securityResult } = await runAgentsTeam({
    teamName: "Review Team",
    agents: [
      {
        name: "Reviewer Agent",
        prompt: reviewerPrompt,
        timeout: applyComplexityTimeout(REVIEWER_TIMEOUT_MS, state),
        opts: { cwd: cfg.localRepo, maxTurns: REVIEWER_MAX_TURNS, allowedTools: ["Read", "Grep", "Glob"] },
        required: true,
        checkpointKey: "_reviewer_result",
      },
      {
        name: "Security Agent",
        prompt: securityPrompt,
        // M23: SECURITY_TIMEOUT_MS lets ops give the security audit a longer
        // budget than the reviewer pass — deep grep + file reads can be
        // slow. Falls back to REVIEWER_TIMEOUT_MS when unset.
        timeout: applyComplexityTimeout(SECURITY_TIMEOUT_MS || REVIEWER_TIMEOUT_MS, state),
        opts: { cwd: cfg.localRepo, maxTurns: REVIEWER_MAX_TURNS, allowedTools: ["Read", "Grep", "Glob"] },
        // H4: Security audit is a hard gate. Marking `required: true` makes
        // the team throw if the security agent errors/times out, so the
        // stage retries via executeWithRecovery instead of silently shipping
        // code with no security review (the prior `required: false` + empty
        // output parsed as "no issues found").
        required: true,
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
  // H4: With security now required:true, an empty/short securityResult would
  // have surfaced as a team failure. If we reach here with a result, treat
  // anything that's not a clear PASS as an issue worth fixing — including
  // short or malformed outputs (previously silently ignored).
  const hasSecurityIssues = !securityPassed;

  if (hasReviewIssues || hasSecurityIssues) {
    // H1: Wire up the rejection counter. Previously read but never written —
    // the MAX_REJECTIONS guard at generate-code/index.ts was dead code.
    // Bump once per fixer invocation (a fix loop = one rejection cycle).
    (state.data as any)._codegen_rejections = ((state.data as any)._codegen_rejections || 0) + 1;
    logInfo(`H1: codegen rejection #${(state.data as any)._codegen_rejections} (review issues: ${hasReviewIssues}, security issues: ${hasSecurityIssues})`);
    save(state);

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
        `${decisionsBlock}` +
        `Read each flagged file, apply the fixes, and confirm what you changed.`,
      timeout: applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
      opts: { cwd: cfg.localRepo, maxTurns: FIXER_MAX_TURNS, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
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

    // H2: Re-run GQ7 (unresolved imports) + F3 (forbidden paths) after the
    // fixer modified the code. A fixer can easily reference a path that
    // doesn't exist or write to .env / package.json — same risk surface as
    // the Developer Agent. Throws (with state.data.feedback set) so the
    // stage retries with feedback in the next developer prompt.
    _validateDevChanges(state);
  } else {
    logOk("Review: LGTM · Security: SECURE");
    // M21: Use a distinct flag for "nothing to fix" so a future re-entry
    // can tell the difference between "fixer ran successfully" and
    // "fixer was never needed". _fixed is still set to keep the existing
    // D10 resume fast-path working.
    (state.data as any)._review_clean = true;
    (state.data as any)._fixed = true;
    save(state);
  }

  return fileChanges;
}

export { runReviewerAndSecurity };
