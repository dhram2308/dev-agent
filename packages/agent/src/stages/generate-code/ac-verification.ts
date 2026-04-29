"use strict";

import type { PipelineState, QuestionAnswer } from '@mi/shared';

const { cfg, TICKET, REVIEWER_TIMEOUT_MS, DEVELOPER_TIMEOUT_MS, applyComplexityTimeout } = require("../../lib/config");
const { logInfo, logOk, logWarn } = require("../../lib/logging");
const { sanitizeForPrompt } = require("../../lib/utils");
const { save } = require("../../lib/state");
const { runSingleAgent } = require("../../lib/agents-team");
const { buildDecisionsBlock } = require("./decisions-block") as {
  buildDecisionsBlock: (qa: QuestionAnswer[] | undefined | null) => string;
};
const { localGetChanges, localGetOriginal } = require("../../lib/local-repo");

/**
 * Q6: AC Verification Agent — compares code changes against acceptance criteria.
 */
async function runACVerification(state: PipelineState, fileChanges: any[], originalFiles: Record<string, string>, changes: any): Promise<any[]> {
  const ac = (state.data as any).ticket.ac || "";

  if ((state.data as any)._ac_verified || (state.data as any).ticket.ac_missing || !ac || !ac.trim()) {
    if ((state.data as any).ticket.ac_missing) {
      logInfo("Q6: Skipping AC verification (no acceptance criteria)");
      (state.data as any)._ac_verified = true;
      (state.data as any)._ac_verification = "Skipped — no acceptance criteria";
    }
    return fileChanges;
  }

  logInfo("Q6: Running AC Verification Agent…");

  // 7.1-7.3: Build test evidence section from runtime test results
  let testEvidence = "";
  if ((state.data as any)._unit_tests_count || (state.data as any)._e2e_tests_count) {
    testEvidence = `\n## Test Evidence\n`;
    if ((state.data as any)._unit_tests_count) {
      const ut = (state.data as any)._unit_tests_count;
      testEvidence += `Unit Tests: ${ut.passed}/${ut.total} passed` +
        (ut.flaky > 0 ? ` (${ut.flaky} flaky)` : "") +
        ` — Status: ${(state.data as any)._unit_tests_complete || "N/A"}\n`;
    }
    if ((state.data as any)._e2e_tests_count) {
      const et = (state.data as any)._e2e_tests_count;
      testEvidence += `Browser Smoke: ${et.passed}/${et.total} passed` +
        ` — Status: ${(state.data as any)._e2e_tests_complete || "N/A"}\n`;
    }
    if ((state.data as any)._e2e_console_errors && (state.data as any)._e2e_console_errors.length > 0) {
      testEvidence += `Console Errors: ${(state.data as any)._e2e_console_errors.length} captured\n`;
      testEvidence += (state.data as any)._e2e_console_errors.slice(0, 5).map((e: any) =>
        `  - [${e.severity}] ${e.text || e.message || "unknown"}`).join("\n") + "\n";
    }
    testEvidence += `\n**IMPORTANT**: If a test FAILED for a specific AC, weight your verdict toward PARTIAL or FAIL.\n` +
      `If a test PASSED for a specific AC, note higher confidence in PASS verdict.\n`;
  }

  const decisionsBlock = buildDecisionsBlock(
    (state as PipelineState).data._qa_answers as QuestionAnswer[] | undefined,
  );

  const acVerifyResult = await runSingleAgent({
    name: "AC Verification Agent",
    prompt: `You are the **AC Verification Agent**. Compare the code changes against the acceptance criteria.\n\n` +
      `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Read the changed files to verify.\n\n` +
      `## Acceptance Criteria\n${sanitizeForPrompt(ac)}\n\n` +
      `## Changed files:\n${fileChanges.map((c: any) => `- ${c.action}: ${c.file_path}`).join("\n")}\n` +
      testEvidence + `\n` +
      `${decisionsBlock}` +
      `For EACH acceptance criterion, rate it:\n` +
      `- **PASS**: Fully implemented and working\n` +
      `- **PARTIAL**: Partially implemented, some aspects missing\n` +
      `- **FAIL**: Not implemented or incorrectly implemented\n` +
      `- **NOT_ADDRESSED**: Not relevant to the code changes\n\n` +
      `Format each as: "AC: [criterion text] → [PASS/PARTIAL/FAIL/NOT_ADDRESSED]: [brief reason]"\n\n` +
      `End with a summary line: "OVERALL: [PASS/PARTIAL/FAIL]"`,
    timeout: applyComplexityTimeout(REVIEWER_TIMEOUT_MS, state),
    opts: { cwd: cfg.localRepo, maxTurns: 10, allowedTools: ["Read", "Grep", "Glob"] },
    state,
    checkpointKey: "_ac_agent_result",
    required: false,
  });

  if (!acVerifyResult) {
    logWarn("Q6: AC Verification Agent failed — will retry on next run");
    return fileChanges;
  }

  (state.data as any)._ac_verification = acVerifyResult;

  const failMatches = acVerifyResult.match(/→\s*FAIL/gi) || [];
  const partialMatches = acVerifyResult.match(/→\s*PARTIAL/gi) || [];
  const passMatches = acVerifyResult.match(/→\s*PASS/gi) || [];

  // Fix 6b: Counter-based retry (up to 2 retries instead of boolean)
  (state.data as any)._ac_retry_count = (state.data as any)._ac_retry_count || 0;
  if (failMatches.length > 0 && (state.data as any)._ac_retry_count < 2) {
    logWarn(`Q6: ${failMatches.length} AC item(s) FAILED — retry ${(state.data as any)._ac_retry_count + 1}/2`);
    (state.data as any)._ac_retry_count += 1;
    save(state);

    const fixResult = await runSingleAgent({
      name: "Developer Agent (AC Fix)",
      prompt: `You are the **Developer Agent**. The AC Verification Agent found FAILED acceptance criteria.\n\n` +
        `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Fix the issues directly.\n\n` +
        `## AC Verification Results\n${acVerifyResult}\n\n` +
        `## Acceptance Criteria\n${sanitizeForPrompt(ac)}\n\n` +
        `${decisionsBlock}` +
        `Focus ONLY on items marked FAIL. Read the relevant files and fix them.`,
      timeout: applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
      opts: { cwd: cfg.localRepo, maxTurns: 15, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
      state,
      checkpointKey: `_ac_fix_attempt_${(state.data as any)._ac_retry_count}`,
      required: false,
    });

    if (fixResult) {
      fileChanges = localGetChanges(cfg.localRepo);
      changes.changes = fileChanges;
      for (const c of fileChanges) {
        if (c.action === "update" && !originalFiles[c.file_path]) {
          const orig = localGetOriginal(cfg.localRepo, c.file_path);
          if (orig) originalFiles[c.file_path] = orig;
        }
      }
      (state.data as any).codeChanges = changes;
      save(state);
      logOk("Developer Agent fixed AC failures — re-extracted changes");
    } else {
      logWarn("AC fix attempt failed — proceeding with current code");
    }
  }

  // T1.5: Only mark verified AFTER retries, and only if no remaining FAILs
  if (failMatches.length > 0) {
    (state.data as any)._ac_known_gaps = acVerifyResult.split("\n").filter((l: string) => /→\s*FAIL/i.test(l)).join("\n");
    if ((state.data as any)._ac_retry_count >= 2) {
      (state.data as any)._ac_verified = true;
      logWarn(`Q6: AC Verification complete with ${failMatches.length} known gap(s) after max retries`);
    }
  } else {
    (state.data as any)._ac_verified = true;
  }
  logOk(`Q6: AC Verification: ${passMatches.length} PASS, ${partialMatches.length} PARTIAL, ${failMatches.length} FAIL`);
  save(state);

  return fileChanges;
}

export { runACVerification };
