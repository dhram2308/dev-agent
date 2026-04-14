"use strict";
// =====================================================================
// MI Dev Agent -- AC Verification Agent (TypeScript port)
// =====================================================================
// Q6: Compares code changes against acceptance criteria.
// Enhanced with test evidence (unit + e2e results).
//
// Features:
//   - Structured AC evaluation (PASS/PARTIAL/FAIL/NOT_ADDRESSED per criterion)
//   - Test evidence integration (unit test + e2e results)
//   - Counter-based retry (up to 2 retries)
//   - Developer Agent for fixing FAIL items
//   - Known gap tracking for MR description
//
// Ported from: stages/generate-code/ac-verification.js
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.runACVerification = runACVerification;
const logger_1 = require("../lib/logger");
const utils_1 = require("../lib/utils");
// ── Main function ───────────────────────────────────────────────────
/**
 * Q6: AC Verification Agent -- compares code changes against acceptance criteria.
 *
 * @param state - pipeline state
 * @param fileChanges - current file changes
 * @param originalFiles - map of file_path -> original content (mutated in place)
 * @param changes - the changes object (changes.changes will be updated)
 * @param deps - injected dependencies
 * @returns updated fileChanges after any AC fix retries
 */
async function runACVerification(state, fileChanges, originalFiles, changes, deps) {
    const data = state.data;
    const ticket = data.ticket;
    const ac = ticket?.ac || '';
    if (data._ac_verified || ticket?.ac_missing || !ac || !ac.trim()) {
        if (ticket?.ac_missing) {
            (0, logger_1.logInfo)('Q6: Skipping AC verification (no acceptance criteria)');
            data._ac_verified = true;
            data._ac_verification = 'Skipped -- no acceptance criteria';
        }
        return fileChanges;
    }
    (0, logger_1.logInfo)('Q6: Running AC Verification Agent...');
    // Build test evidence section from runtime test results
    let testEvidence = '';
    if (data._unit_tests_count || data._e2e_tests_count) {
        testEvidence = '\n## Test Evidence\n';
        if (data._unit_tests_count) {
            const ut = data._unit_tests_count;
            testEvidence += `Unit Tests: ${ut.passed}/${ut.total} passed` +
                (ut.flaky > 0 ? ` (${ut.flaky} flaky)` : '') +
                ` -- Status: ${data._unit_tests_complete || 'N/A'}\n`;
        }
        if (data._e2e_tests_count) {
            const et = data._e2e_tests_count;
            testEvidence += `Browser Smoke: ${et.passed}/${et.total} passed` +
                ` -- Status: ${data._e2e_tests_complete || 'N/A'}\n`;
        }
        const consoleErrors = data._e2e_console_errors || [];
        if (consoleErrors.length > 0) {
            testEvidence += `Console Errors: ${consoleErrors.length} captured\n`;
            testEvidence += consoleErrors.slice(0, 5).map((e) => `  - [${e.severity}] ${e.text || e.message || 'unknown'}`).join('\n') + '\n';
        }
        testEvidence += '\n**IMPORTANT**: Weight verdict toward PARTIAL or FAIL for failed tests.\n';
    }
    const acVerifyResult = await deps.runSingleAgent({
        name: 'AC Verification Agent',
        prompt: `You are the **AC Verification Agent**. Compare the code changes against the acceptance criteria.\n\n` +
            `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Read the changed files to verify.\n\n` +
            `## Acceptance Criteria\n${(0, utils_1.sanitizeForPrompt)(ac)}\n\n` +
            `## Changed files:\n${fileChanges.map((c) => `- ${c.action}: ${c.file_path}`).join('\n')}\n` +
            testEvidence + '\n' +
            `For EACH acceptance criterion, rate it:\n` +
            `- **PASS**: Fully implemented and working\n` +
            `- **PARTIAL**: Partially implemented\n` +
            `- **FAIL**: Not implemented or incorrect\n` +
            `- **NOT_ADDRESSED**: Not relevant to code changes\n\n` +
            `Format: "AC: [criterion text] -> [PASS/PARTIAL/FAIL/NOT_ADDRESSED]: [brief reason]"\n\n` +
            `End with: "OVERALL: [PASS/PARTIAL/FAIL]"`,
        timeout: deps.applyComplexityTimeout(deps.reviewerTimeoutMs, state),
        opts: { cwd: deps.cfg.localRepo, maxTurns: 10, allowedTools: ['Read', 'Grep', 'Glob'] },
        state,
        checkpointKey: '_ac_agent_result',
        required: false,
    });
    // If agent failed -- NOT verified, will retry on restart
    if (!acVerifyResult) {
        (0, logger_1.logWarn)('Q6: AC Verification Agent failed -- will retry on next run');
        return fileChanges;
    }
    data._ac_verification = acVerifyResult;
    // Check for FAIL/PARTIAL/PASS items
    const failMatches = acVerifyResult.match(/(?:->|→)\s*FAIL/gi) || [];
    const partialMatches = acVerifyResult.match(/(?:->|→)\s*PARTIAL/gi) || [];
    const passMatches = acVerifyResult.match(/(?:->|→)\s*PASS/gi) || [];
    // Counter-based retry (up to 2 retries)
    data._ac_retry_count = data._ac_retry_count || 0;
    if (failMatches.length > 0 && data._ac_retry_count < 2) {
        (0, logger_1.logWarn)(`Q6: ${failMatches.length} AC item(s) FAILED -- retry ${data._ac_retry_count + 1}/2`);
        data._ac_retry_count = data._ac_retry_count + 1;
        deps.save(state);
        const fixResult = await deps.runSingleAgent({
            name: 'Developer Agent (AC Fix)',
            prompt: `You are the **Developer Agent**. The AC Verification Agent found FAILED acceptance criteria.\n\n` +
                `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Fix the issues directly.\n\n` +
                `## AC Verification Results\n${acVerifyResult}\n\n` +
                `## Acceptance Criteria\n${(0, utils_1.sanitizeForPrompt)(ac)}\n\n` +
                `Focus ONLY on items marked FAIL. Read the relevant files and fix them.`,
            timeout: deps.applyComplexityTimeout(deps.developerTimeoutMs, state),
            opts: { cwd: deps.cfg.localRepo, maxTurns: 15, allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'] },
            state,
            checkpointKey: `_ac_fix_attempt_${data._ac_retry_count}`,
            required: false,
        });
        if (fixResult) {
            // Re-extract changes
            fileChanges = deps.localGetChanges(deps.cfg.localRepo);
            changes.changes = fileChanges;
            for (const c of fileChanges) {
                if (c.action === 'update' && !originalFiles[c.file_path]) {
                    const orig = deps.localGetOriginal(deps.cfg.localRepo, c.file_path);
                    if (orig)
                        originalFiles[c.file_path] = orig;
                }
            }
            data.codeChanges = changes;
            deps.save(state);
            (0, logger_1.logOk)('Developer Agent fixed AC failures -- re-extracted changes');
        }
        else {
            (0, logger_1.logWarn)('AC fix attempt failed -- proceeding with current code');
        }
    }
    // T1.5: Only mark verified AFTER retries
    if (failMatches.length > 0) {
        data._ac_known_gaps = acVerifyResult.split('\n').filter((l) => /(?:->|→)\s*FAIL/i.test(l)).join('\n');
        if (data._ac_retry_count >= 2) {
            // Max retries exhausted
            data._ac_verified = true;
            (0, logger_1.logWarn)(`Q6: AC Verification complete with ${failMatches.length} known gap(s) after max retries`);
        }
    }
    else {
        data._ac_verified = true;
    }
    (0, logger_1.logOk)(`Q6: AC Verification: ${passMatches.length} PASS, ${partialMatches.length} PARTIAL, ${failMatches.length} FAIL`);
    deps.save(state);
    return fileChanges;
}
//# sourceMappingURL=ac-verification.js.map