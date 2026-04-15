"use strict";

const { cfg, TICKET, MAX_REJECTIONS, RUN_BUILD_CHECK, RUN_RUNTIME_TESTS, BROWSER_VERIFY } = require("../../lib/config");
const { logStep, logOk, logInfo, logErr, logWarn } = require("../../lib/logging");
const { sanitizeForPrompt, truncateWithIndicator } = require("../../lib/utils");
const { save } = require("../../lib/state");
const { slack } = require("../../lib/slack");
const { localGetChanges, localGetOriginal, localResetRepo } = require("../../lib/local-repo");
const { pushCodeToGitLab } = require("../push-code");

const { runDeveloperAgent } = require("./developer");
const { runReviewerAndSecurity } = require("./reviewer");
const { runBuildCheck } = require("./build-check");
const { runRuntimeTests } = require("./runtime-tests");
const { runACVerification } = require("./ac-verification");
const { legacyJsonCodegen } = require("./legacy-codegen");
const { ensureEnvironment } = require("./env-setup");
const { startDevServer, stopDevServer, cleanupOrphanDevServer, killProcess } = require("./dev-server");
const { runBrowserVerification, buildBrowserVerifyMRSection } = require("./browser-verify");
const { onShutdown } = require("../../lib/graceful-shutdown");

/**
 * Stage: Generate Code with Claude AI.
 * Orchestrates: Developer → Reviewer+Security → Fixer → Build Check → Runtime Tests → AC Verification → Push.
 */
async function stageGenerateCode(state) {
  logStep("2–3", "Generate code with Claude AI");

  // H1/H4: Track internal rejection counter for code gen loop
  state.data._codegen_rejections = state.data._codegen_rejections || 0;
  if (state.data._codegen_rejections >= MAX_REJECTIONS) {
    logErr(`Code generation rejected ${state.data._codegen_rejections} times (max: ${MAX_REJECTIONS}) — halting pipeline`);
    await slack(
      `🛑 *Code Gen Rejection Limit — ${TICKET}*\nCode was rejected ${state.data._codegen_rejections} times by internal reviewer/security. Pipeline halted.`,
      [cfg.slack.ownerId],
    );
    throw new Error(`Code generation exceeded MAX_REJECTIONS (${MAX_REJECTIONS})`);
  }

  // R6: Config mode switch guard — detect if mode changed between runs
  const currentMode = cfg.localRepo ? "local" : "legacy";
  if (state.data._codegen_mode && state.data._codegen_mode !== currentMode) {
    logWarn(`R6: Code generation mode changed (${state.data._codegen_mode} → ${currentMode}) — clearing previous code`);
    state.data.codeChanges = null;
    state.data.plan = null;
  }
  state.data._codegen_mode = currentMode;

  // Skip Claude generation if code already exists and no new feedback
  if (state.data.codeChanges && !state.data.feedback && state.data.plan) {
    logOk("Code already generated — skipping to branch/commit/MR");
    const changes = state.data.codeChanges;
    return await pushCodeToGitLab(state, changes);
  }

  // Extract ticket data
  const { summary, description, ac, supplementaryDocs, planFeedback,
    comments: ticketComments, linkedIssues, parent: parentEpic,
    attachmentContents, fetchedUrlContents, issueType: iType, priority: iPriority
  } = state.data.ticket;
  const feedback = state.data.feedback || "";

  // Use the pre-approved plan from explore_plan stage
  const approvedPlan = state.data.explore_plan || "";
  const extraDocs = supplementaryDocs ? `\nSupplementary docs:\n${supplementaryDocs}\n` : "";
  const extraFeedback = planFeedback ? `\nPlan feedback:\n${planFeedback}\n` : "";

  // D1: Build full context from all gathered sources for developer agent (sanitized)
  let devFullContext = "";
  if (ticketComments && ticketComments.length > 0) {
    devFullContext += "\n## Jira Comments (IMPORTANT — may contain API specs, field names, payloads)\n";
    for (const c of ticketComments) {
      devFullContext += `### [${c.author}] (${c.created ? c.created.split("T")[0] : ""}):\n${sanitizeForPrompt(c.body)}\n\n`;
    }
  }
  if (linkedIssues && linkedIssues.length > 0) {
    devFullContext += "\n## Linked Issues (business context)\n";
    for (const li of linkedIssues) {
      devFullContext += `- ${li.key} (${li.relationship}): ${sanitizeForPrompt(li.summary)}\n`;
    }
  }
  if (parentEpic) {
    devFullContext += `\n## Parent Epic: ${parentEpic.key} — ${sanitizeForPrompt(parentEpic.summary)}\n`;
  }
  if (attachmentContents && attachmentContents.length > 0) {
    devFullContext += "\n## Attachment Contents\n";
    for (const att of attachmentContents) {
      const content = truncateWithIndicator(att.content, 5000);
      devFullContext += `### ${att.filename}\n\`\`\`\n${sanitizeForPrompt(content)}\n\`\`\`\n\n`;
    }
  }
  if (fetchedUrlContents && fetchedUrlContents.length > 0) {
    devFullContext += "\n## Fetched External URLs\n";
    for (const fu of fetchedUrlContents) {
      const content = truncateWithIndicator(fu.content, 5000);
      devFullContext += `### ${fu.url}\n\`\`\`\n${sanitizeForPrompt(content)}\n\`\`\`\n\n`;
    }
  }
  const connectorContents = ticket.connectorContents;
  if (connectorContents && connectorContents.length > 0) {
    devFullContext += "\n## Connector Documents\n";
    for (const cd of connectorContents) {
      const content = truncateWithIndicator(cd.content, 15000);
      devFullContext += `### ${cd.title} (source: ${cd.source})\n${sanitizeForPrompt(content)}\n\n`;
    }
  }

  // Build context object shared by sub-modules
  const ctx = { state, approvedPlan, devFullContext, extraDocs, extraFeedback, feedback };

  // ── Local file-based approach (preferred) ──
  if (cfg.localRepo) {
    logInfo("Using local repo for code generation (file-based approach)");

    try {
    // Kill orphan dev server from previous crash (if any)
    cleanupOrphanDevServer(state);

    // Register shutdown hooks for processes spawned during code generation
    onShutdown("codegen-dev-server", () => {
      try { stopDevServer(state); } catch {}
    });
    onShutdown("codegen-vite-preview", () => {
      const pid = state.data._vite_preview_pid;
      if (pid) {
        try { killProcess(pid); } catch {}
        state.data._vite_preview_pid = null;
        state.data._vite_preview_port = null;
      }
    });

    // Phase 0: Environment setup for browser verification
    if (BROWSER_VERIFY && !state.data._env_setup_complete) {
      const envReady = await ensureEnvironment(state, cfg.localRepo);
      if (envReady && !state.data._dev_server_ready) {
        await startDevServer(cfg.localRepo, state);
      }
    }

    // D10: Skip completed sub-stages on re-entry — only fast-path to push if ALL stages done
    const allStagesDone = state.data._dev_complete && state.data._reviewed && state.data._fixed
      && (!RUN_RUNTIME_TESTS || state.data._unit_tests_complete)
      && (!BROWSER_VERIFY || state.data._browser_verified)
      && (state.data._ac_verified || !state.data.ticket?.ac?.trim());
    if (allStagesDone) {
      logOk("All sub-stages complete (dev/review/fix/tests/verify/AC) — extracting final changes");
      const fileChanges = localGetChanges(cfg.localRepo);
      if (fileChanges.length > 0) {
        const originalFiles = {};
        for (const c of fileChanges) {
          if (c.action === "update") {
            const orig = localGetOriginal(cfg.localRepo, c.file_path);
            if (orig) originalFiles[c.file_path] = orig;
          }
        }
        const changes = { changes: fileChanges, summary: state.data._dev_summary || "Resumed from checkpoint", test_notes: "See developer summary" };
        state.data.original_files = originalFiles;
        state.data.codeChanges = changes;
        state.data.plan = approvedPlan;
        delete state.data.feedback;
        save(state);
        await pushCodeToGitLab(state, changes);
        try { localResetRepo(cfg.localRepo); } catch (e) { logWarn(`Post-push reset failed: ${e.message}`); }
        return;
      }
    }

    // D10: Skip developer if already complete on re-entry
    if (!state.data._dev_complete) {
      await runDeveloperAgent(ctx);
    } else {
      logOk("Developer already complete (checkpoint) — skipping to review");
    }

    // Step 4 — Fetch originals for diff viewer
    let fileChanges = localGetChanges(cfg.localRepo);
    const originalFiles = {};
    for (const c of fileChanges) {
      if (c.action === "update") {
        const orig = localGetOriginal(cfg.localRepo, c.file_path);
        if (orig) originalFiles[c.file_path] = orig;
      }
    }

    // Step 5 — Reviewer + Security (parallel) + Fixer
    fileChanges = await runReviewerAndSecurity(ctx, fileChanges, originalFiles);

    logOk(`${fileChanges.length} file(s) ready`);

    // Q5: Build Check (may write via fixer)
    const needsBuildCheck = RUN_BUILD_CHECK && cfg.localRepo && !state.data._build_checked;
    if (needsBuildCheck) {
      fileChanges = await runBuildCheck(state, fileChanges, originalFiles);
    }

    // Runtime Testing Pipeline (depends on build check completion)
    fileChanges = await runRuntimeTests(state, fileChanges, originalFiles);

    // Part 2: Browser Verification (after all static checks, before AC)
    if (BROWSER_VERIFY && state.data._dev_server_ready) {
      await runBrowserVerification(state, ctx);
    }

    // Q6: AC Verification — runs AFTER runtime tests + browser verify so evidence is available
    const needsACVerification = !state.data._ac_verified && state.data.ticket.ac &&
      state.data.ticket.ac.trim() && !state.data.ticket.ac_missing;
    if (needsACVerification) {
      const tempChanges = {
        changes: fileChanges,
        summary: (state.data._dev_summary || "").substring(0, 2000),
        test_notes: "See developer summary above",
      };
      fileChanges = await runACVerification(state, fileChanges, originalFiles, tempChanges);
    }

    // Re-fetch final file changes after all stages (runtime tests, browser fix, AC fix may have modified code)
    fileChanges = localGetChanges(cfg.localRepo);
    for (const c of fileChanges) {
      if (c.action === "update" && !originalFiles[c.file_path]) {
        const orig = localGetOriginal(cfg.localRepo, c.file_path);
        if (orig) originalFiles[c.file_path] = orig;
      }
    }

    // Zero-files guard: verify at least one file was changed before push
    if (!fileChanges || fileChanges.length === 0) {
      logErr("No files were changed by code generation — cannot push empty changeset");
      throw new Error("No files were changed by code generation");
    }

    // GAP-2: Mark test phase complete AFTER all testing/verification, BEFORE push
    state.data._test_phase_complete = true;
    save(state);

    // Build changes object compatible with pushCodeToGitLab and Web UI
    const changes = {
      changes: fileChanges,
      summary: (state.data._dev_summary || "").substring(0, 2000),
      test_notes: "See developer summary above",
    };

    state.data.original_files = originalFiles;
    state.data.codeChanges = changes;
    state.data.plan = approvedPlan;
    if (state.data.feedback) {
      state.data.rejectionHistory = state.data.rejectionHistory || [];
      state.data.rejectionHistory.push({ feedback: state.data.feedback, ts: new Date().toISOString() });
    }
    delete state.data.feedback;
    save(state);

    // Step 8 — Push to GitLab
    await pushCodeToGitLab(state, changes);

    // Step 9 — Reset local repo after extracting all data
    try { localResetRepo(cfg.localRepo); } catch (e) { logWarn(`Post-push reset failed: ${e.message}`); }

    } finally {
      // Always stop dev server to prevent orphan processes
      try { stopDevServer(state); } catch (e) { logWarn(`Dev server cleanup: ${e.message}`); }
    }

  } else {
    // ── Legacy JSON-based approach (GitLab API only, no local repo) ──
    await legacyJsonCodegen(ctx);
  }
}

module.exports = { stageGenerateCode };
