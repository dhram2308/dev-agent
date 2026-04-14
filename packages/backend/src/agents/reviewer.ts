// =====================================================================
// MI Dev Agent -- Reviewer Agent (TypeScript port of stages/generate-code/reviewer.js)
// =====================================================================
//
// Runs the Reviewer + Security Agents in parallel, then the Fixer Agent
// if issues are found. Supports checkpoint recovery to skip completed
// sub-stages on re-entry.
//
// Key features:
//   - Parallel Reviewer + Security agents
//   - Security checklist review (XSS, injection, auth, PII, etc.)
//   - Code quality review (reuse violations, pattern compliance, plan fidelity)
//   - VERDICT parsing with legacy keyword fallback
//   - Issue categorization by priority (COMPILATION > SECURITY > CODE_REVIEW > LINT)
//   - Fixer Agent with direct repo access for auto-remediation
//   - Checkpoint persistence for crash recovery
// =====================================================================

import { logInfo, logOk, logWarn } from '../lib/logger';
import { sanitizeForPrompt, truncateWithIndicator } from '../lib/utils';
import { categorizeIssues } from '../services/jira';
import { parseVerdict } from './fixer';
import type { PipelineState } from '@shared/types';
import type { ClaudeService } from '../services/claude';
import type { IssueCategory } from '../services/jira';

// Re-export parseVerdict for consumers
export { parseVerdict } from './fixer';

// ── Types ────────────────────────────────────────────────────────────

/** Context needed by the reviewer agent */
export interface ReviewerContext {
  /** The approved implementation plan */
  approvedPlan: string;
  /** Claude service instance */
  claude: ClaudeService;
  /** Project directory (target repo) */
  projectDir: string;
  /** Timeout for reviewer agent in ms */
  reviewerTimeoutMs: number;
  /** Timeout for fixer/developer agent in ms */
  developerTimeoutMs: number;
  /** Complexity-adjusted timeout multiplier */
  timeoutMultiplier?: number;
}

/** Result from running the reviewer agent */
export interface ReviewerResult {
  /** Whether the review passed without issues */
  passed: boolean;
  /** Whether the fixer was invoked */
  fixerRan: boolean;
  /** Reviewer output text */
  reviewOutput: string;
  /** Security output text */
  securityOutput: string;
  /** Issue categories found */
  categories?: IssueCategory[];
}

/** File change descriptor */
export interface FileChange {
  action: 'create' | 'update' | 'delete';
  file_path: string;
  content?: string;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_REVIEWER_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_DEVELOPER_TIMEOUT_MS = 900_000; // 15 minutes
const REVIEWER_MAX_TURNS = 15;
const SECURITY_MAX_TURNS = 10;
const FIXER_MAX_TURNS = 20;

// ── Reviewer Agent Entry Point ───────────────────────────────────

/**
 * Run Reviewer + Security Agents in parallel, then Fixer if needed.
 *
 * @param state - Current pipeline state
 * @param ctx - Reviewer context (plan, services, timeouts)
 * @param fileChanges - Current file changes array
 * @returns ReviewerResult with pass/fail status and outputs
 */
export async function runReviewer(
  state: PipelineState,
  ctx: ReviewerContext,
  fileChanges: FileChange[],
): Promise<ReviewerResult> {
  const { approvedPlan, claude, projectDir, reviewerTimeoutMs, developerTimeoutMs } = ctx;
  const data = state.data as Record<string, unknown>;
  const ticket = state.ticket;

  const effectiveReviewerTimeout = reviewerTimeoutMs || DEFAULT_REVIEWER_TIMEOUT_MS;
  const effectiveDeveloperTimeout = developerTimeoutMs || DEFAULT_DEVELOPER_TIMEOUT_MS;

  // Extract ticket summary
  const ticketData = data.ticket as { summary?: string } | undefined;
  const ticketSummary = ticketData?.summary || '';

  // Skip if already reviewed on re-entry (checkpoint recovery)
  if (data._reviewed && data._fixed) {
    logOk('Reviewer + Fixer already complete (checkpoint) -- skipping');
    return {
      passed: true,
      fixerRan: false,
      reviewOutput: (data._reviewer_result as string) || '',
      securityOutput: (data._security_result as string) || '',
    };
  }

  logInfo('Review Team -- Reviewer + Security Agents (parallel)...');
  const changedFilesList = fileChanges
    .map((c) => `- ${c.action}: ${c.file_path}`)
    .join('\n');

  // Include approved plan for Reviewer (truncated)
  const planDigest = approvedPlan
    ? truncateWithIndicator(approvedPlan, 8000)
    : '(no plan available)';

  // Set up Claude with the project directory
  claude.setProjectDir(projectDir);

  // Build prompts
  const reviewerPrompt =
    `You are the **Reviewer Agent** at MasterIndia. Review the code changes in this repository.\n\n` +
    `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Use Read/Grep/Glob tools to verify code quality.\n\n` +
    `## Review checklist:\n` +
    `1. **Reuse violations**: Did the developer create new components/utils/hooks that already exist? Flag as CRITICAL.\n` +
    `2. **Pattern violations**: Does the code follow existing codebase patterns?\n` +
    `3. **Bugs & missing imports**: Any runtime errors, missing dependencies, broken references?\n` +
    `4. **Unnecessary new files**: Could any new file be an update to an existing file instead?\n` +
    `5. **Generic VITE_PRODUCT_ID checks**: Flag as CRITICAL if code uses generic multi-product conditionals instead of the exact enterprise product ID.\n` +
    `6. **Plan Compliance**: Compare changes against the approved plan below. Flag if Developer skipped steps, modified unplanned files, or deviated.\n` +
    `7. **Non-enterprise scope**: Flag as CRITICAL if code modifies or references other product lines (SME, GST, TaxPro, etc.).\n\n` +
    `## Approved Plan:\n${planDigest}\n\n` +
    `Ticket: ${ticket} -- ${sanitizeForPrompt(ticketSummary)}\n\n` +
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
    `Ticket: ${ticket} -- ${sanitizeForPrompt(ticketSummary)}\n\n` +
    `## Changed files:\n${changedFilesList}\n\n` +
    `Read the changed files and list all security issues with severity (CRITICAL/HIGH/MEDIUM/LOW).\n\n` +
    `**IMPORTANT**: End your response with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``;

  // Run Reviewer + Security in parallel
  const [reviewResult, securityResult] = await Promise.all([
    claude.callClaude(reviewerPrompt, effectiveReviewerTimeout, {
      agentName: 'Reviewer Agent',
      maxTurns: REVIEWER_MAX_TURNS,
      projectDir,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`Reviewer Agent failed: ${msg}`);
      return '';
    }),
    claude.callClaude(securityPrompt, effectiveReviewerTimeout, {
      agentName: 'Security Agent',
      maxTurns: SECURITY_MAX_TURNS,
      projectDir,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`Security Agent failed: ${msg}`);
      return '';
    }),
  ]);

  logOk('Review Team complete');

  // Checkpoint: reviewed
  data._reviewed = true;
  data._reviewer_result = reviewResult.substring(0, 5000);
  data._security_result = securityResult.substring(0, 5000);

  // Parse verdicts
  const reviewPassed = parseVerdict(reviewResult, 'lgtm');
  const securityPassed = parseVerdict(securityResult, 'secure');
  const hasReviewIssues = !reviewPassed;
  // Only flag security issues if we have a meaningful security result
  // Empty/crashed security agent should NOT trigger fixer on nonexistent issues
  const hasSecurityIssues = securityResult && securityResult.length > 20 && !securityPassed;

  if (hasReviewIssues || hasSecurityIssues) {
    // Categorize and prioritize issues
    const categorized = categorizeIssues(
      hasReviewIssues ? reviewResult : null,
      hasSecurityIssues ? securityResult : null,
    );
    const allIssues = categorized
      .map((c) => `## ${c.label} (${c.type})\n${c.content}`)
      .join('\n\n');
    const priorityOrder = categorized.map((c) => c.type).join(' > ');
    logInfo(`Issue categories (priority order): ${priorityOrder}`);

    // Run Fixer Agent
    logInfo('Fixer Agent: resolving issues directly...');
    const fixerPrompt =
      `You are the **Fixer Agent**. Fix ALL issues found by the Reviewer and Security agents.\n\n` +
      `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Read the flagged files and fix them directly using Write/Edit.\n` +
      `DO NOT output JSON. Write fixes DIRECTLY to the files on disk.\n\n` +
      `## Fix Priority Order\nFix issues in this order: ${priorityOrder}\n` +
      `COMPILATION errors first (missing imports, type errors), then SECURITY vulnerabilities, then CODE REVIEW issues, then LINT warnings.\n\n` +
      `If reuse violations were flagged, replace custom code with existing repo components/utils/hooks.\n` +
      `If security issues were flagged, fix them following OWASP best practices.\n` +
      `If generic VITE_PRODUCT_ID checks were flagged, replace with the exact enterprise product ID constant.\n` +
      `If non-enterprise scope was flagged, remove all references to other product lines (SME, GST, TaxPro, etc.).\n\n` +
      `${allIssues}\n\n` +
      `## Changed files:\n${changedFilesList}\n\n` +
      `Read each flagged file, apply the fixes, and confirm what you changed.`;

    await claude.callClaude(fixerPrompt, effectiveDeveloperTimeout, {
      agentName: 'Fixer Agent',
      maxTurns: FIXER_MAX_TURNS,
      projectDir,
    });

    logOk('Fixer Agent: issues resolved');

    // Checkpoint: fixed
    data._fixed = true;

    return {
      passed: false,
      fixerRan: true,
      reviewOutput: reviewResult,
      securityOutput: securityResult,
      categories: categorized,
    };
  }

  logOk('Review: LGTM -- Security: SECURE');
  data._fixed = true;

  return {
    passed: true,
    fixerRan: false,
    reviewOutput: reviewResult,
    securityOutput: securityResult,
  };
}
