"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseVerdict = void 0;
exports.runReviewer = runReviewer;
const logger_1 = require("../lib/logger");
const utils_1 = require("../lib/utils");
const jira_1 = require("../services/jira");
const fixer_1 = require("./fixer");
// Re-export parseVerdict for consumers
var fixer_2 = require("./fixer");
Object.defineProperty(exports, "parseVerdict", { enumerable: true, get: function () { return fixer_2.parseVerdict; } });
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
async function runReviewer(state, ctx, fileChanges) {
    const { approvedPlan, claude, projectDir, reviewerTimeoutMs, developerTimeoutMs } = ctx;
    const data = state.data;
    const ticket = state.ticket;
    const effectiveReviewerTimeout = reviewerTimeoutMs || DEFAULT_REVIEWER_TIMEOUT_MS;
    const effectiveDeveloperTimeout = developerTimeoutMs || DEFAULT_DEVELOPER_TIMEOUT_MS;
    // Extract ticket summary
    const ticketData = data.ticket;
    const ticketSummary = ticketData?.summary || '';
    // Skip if already reviewed on re-entry (checkpoint recovery)
    if (data._reviewed && data._fixed) {
        (0, logger_1.logOk)('Reviewer + Fixer already complete (checkpoint) -- skipping');
        return {
            passed: true,
            fixerRan: false,
            reviewOutput: data._reviewer_result || '',
            securityOutput: data._security_result || '',
        };
    }
    (0, logger_1.logInfo)('Review Team -- Reviewer + Security Agents (parallel)...');
    const changedFilesList = fileChanges
        .map((c) => `- ${c.action}: ${c.file_path}`)
        .join('\n');
    // Include approved plan for Reviewer (truncated)
    const planDigest = approvedPlan
        ? (0, utils_1.truncateWithIndicator)(approvedPlan, 8000)
        : '(no plan available)';
    // Set up Claude with the project directory
    claude.setProjectDir(projectDir);
    // Build prompts
    const reviewerPrompt = `You are the **Reviewer Agent** at MasterIndia. Review the code changes in this repository.\n\n` +
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
        `Ticket: ${ticket} -- ${(0, utils_1.sanitizeForPrompt)(ticketSummary)}\n\n` +
        `## Changed files:\n${changedFilesList}\n\n` +
        `Read the changed files, compare against existing patterns, and list all issues found.\n\n` +
        `**IMPORTANT**: End your response with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``;
    const securityPrompt = `You are the **Security Agent**. Audit the code changes in this repository for security issues.\n\n` +
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
        `Ticket: ${ticket} -- ${(0, utils_1.sanitizeForPrompt)(ticketSummary)}\n\n` +
        `## Changed files:\n${changedFilesList}\n\n` +
        `Read the changed files and list all security issues with severity (CRITICAL/HIGH/MEDIUM/LOW).\n\n` +
        `**IMPORTANT**: End your response with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``;
    // Run Reviewer + Security in parallel
    const [reviewResult, securityResult] = await Promise.all([
        claude.callClaude(reviewerPrompt, effectiveReviewerTimeout, {
            agentName: 'Reviewer Agent',
            maxTurns: REVIEWER_MAX_TURNS,
            projectDir,
        }).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            (0, logger_1.logWarn)(`Reviewer Agent failed: ${msg}`);
            return '';
        }),
        claude.callClaude(securityPrompt, effectiveReviewerTimeout, {
            agentName: 'Security Agent',
            maxTurns: SECURITY_MAX_TURNS,
            projectDir,
        }).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            (0, logger_1.logWarn)(`Security Agent failed: ${msg}`);
            return '';
        }),
    ]);
    (0, logger_1.logOk)('Review Team complete');
    // Checkpoint: reviewed
    data._reviewed = true;
    data._reviewer_result = reviewResult.substring(0, 5000);
    data._security_result = securityResult.substring(0, 5000);
    // Parse verdicts
    const reviewPassed = (0, fixer_1.parseVerdict)(reviewResult, 'lgtm');
    const securityPassed = (0, fixer_1.parseVerdict)(securityResult, 'secure');
    const hasReviewIssues = !reviewPassed;
    // Only flag security issues if we have a meaningful security result
    // Empty/crashed security agent should NOT trigger fixer on nonexistent issues
    const hasSecurityIssues = securityResult && securityResult.length > 20 && !securityPassed;
    if (hasReviewIssues || hasSecurityIssues) {
        // Categorize and prioritize issues
        const categorized = (0, jira_1.categorizeIssues)(hasReviewIssues ? reviewResult : null, hasSecurityIssues ? securityResult : null);
        const allIssues = categorized
            .map((c) => `## ${c.label} (${c.type})\n${c.content}`)
            .join('\n\n');
        const priorityOrder = categorized.map((c) => c.type).join(' > ');
        (0, logger_1.logInfo)(`Issue categories (priority order): ${priorityOrder}`);
        // Run Fixer Agent
        (0, logger_1.logInfo)('Fixer Agent: resolving issues directly...');
        const fixerPrompt = `You are the **Fixer Agent**. Fix ALL issues found by the Reviewer and Security agents.\n\n` +
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
        (0, logger_1.logOk)('Fixer Agent: issues resolved');
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
    (0, logger_1.logOk)('Review: LGTM -- Security: SECURE');
    data._fixed = true;
    return {
        passed: true,
        fixerRan: false,
        reviewOutput: reviewResult,
        securityOutput: securityResult,
    };
}
//# sourceMappingURL=reviewer.js.map