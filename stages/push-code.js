"use strict";

const { cfg, TICKET, MAX_COMMIT_FILE_SIZE, RUN_RUNTIME_TESTS, BROWSER_VERIFY } = require("../lib/config");
const { logStep, logOk, logErr, logInfo, logWarn, logDebug } = require("../lib/logging");
const { req } = require("../lib/http-client");
const { redactSecrets, sanitizeMRText, addWarning, isBinaryFile } = require("../lib/utils");
const { save } = require("../lib/state");
const { gl } = require("../lib/gitlab");
const { slack } = require("../lib/slack");
const { validateMRTarget } = require("../lib/config");
const { BINARY_EXTENSIONS } = require("../lib/constants");

async function pushCodeToGitLab(state, changes) {
  if (!changes.changes || changes.changes.length === 0) {
    throw new Error("No files to push — ticket needs more detail.");
  }

  // L3: Validate changes array entries
  changes.changes = changes.changes.filter((c) => {
    if (!c.file_path || typeof c.file_path !== "string" || c.file_path.trim() === "") {
      logWarn(`Skipping change with empty file_path`);
      return false;
    }
    if (c.action !== "delete" && c.content === undefined) {
      logWarn(`Skipping change with undefined content: ${c.file_path}`);
      return false;
    }
    return true;
  });

  // L2: Deduplicate by file_path (keep last occurrence)
  const seen = new Map();
  for (const c of changes.changes) {
    seen.set(c.file_path, c);
  }
  changes.changes = [...seen.values()];
  if (changes.changes.length !== seen.size) {
    logInfo(`Deduplicated to ${changes.changes.length} unique file(s)`);
  }

  if (changes.changes.length === 0) {
    throw new Error("No valid files to push after validation.");
  }

  const branch = `enterprise-ts-${TICKET}`;

  if (!state.data.code_branch) {
    // Q4: Parent Branch Awareness — branch from parent feature branch if available
    const sourceBranch = state.data.parentBranch || cfg.branch.ts;
    logInfo(`Creating branch ${branch} from ${sourceBranch}${state.data.parentBranch ? " (parent feature branch)" : ""}…`);
    await gl.createBranch(branch, sourceBranch);
    state.data.code_branch = branch;
    state.data.code_source_branch = sourceBranch;
    save(state);
    logOk(`Branch: ${branch} (from ${sourceBranch})`);
  }

  if (!state.data.code_committed) {
    // Verify branch exists before committing (may be corrupt from prior failed attempt)
    const branchInfo = await gl.getBranch(branch);
    if (!branchInfo) {
      logWarn(`Branch ${branch} not found on remote — recreating...`);
      state.data.code_branch = null;
      save(state);
      const sourceBranch = state.data.parentBranch || cfg.branch.ts;
      await gl.createBranch(branch, sourceBranch);
      state.data.code_branch = branch;
      state.data.code_source_branch = sourceBranch;
      save(state);
      logOk(`Branch recreated: ${branch}`);
    }

    // M5: Validate summary non-empty before building commit message
    const commitSummary = (state.data.ticket.summary || "").trim();
    if (!commitSummary) {
      logWarn("Ticket summary is empty — using ticket key as commit message");
    }
    const commitMsg = commitSummary
      ? `feat(${TICKET}): ${commitSummary}`
      : `feat(${TICKET}): Implementation`;

    logInfo("Committing files…");
    // GQ2: Filter out files exceeding MAX_COMMIT_FILE_SIZE + T2.18: binary file detection
    const validChanges = [];
    for (const c of changes.changes) {
      if (c.action !== "delete") {
        // T2.18: Skip binary files
        const ext = (c.file_path.match(/\.[^.]+$/) || [""])[0].toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          logWarn(`T2.18: Skipping binary file: ${c.file_path}`);
          addWarning(state, "generate_code", `Binary file skipped: ${c.file_path}`);
          continue;
        }
        if (c.content && c.content.includes("\0")) {
          logWarn(`T2.18: Skipping file with null bytes (binary): ${c.file_path}`);
          addWarning(state, "generate_code", `Binary content skipped: ${c.file_path}`);
          continue;
        }
        if (c.content && c.content.length > MAX_COMMIT_FILE_SIZE) {
          logWarn(`GQ2: Skipping ${c.file_path} — content size ${(c.content.length / 1024).toFixed(1)}KB exceeds limit ${(MAX_COMMIT_FILE_SIZE / 1024).toFixed(0)}KB`);
          addWarning(state, "generate_code", `File skipped (too large): ${c.file_path} (${(c.content.length / 1024).toFixed(1)}KB)`);
          continue;
        }
      }
      validChanges.push(c);
    }
    if (validChanges.length === 0) {
      throw new Error("No files to commit after size filtering — all files exceeded MAX_COMMIT_FILE_SIZE");
    }
    const actions = validChanges.map((c) => {
      const entry = { action: c.action || "update", file_path: c.file_path };
      // GitLab commit API: delete actions don't need content
      if (c.action !== "delete") entry.content = c.content;
      return entry;
    });

    // Attempt commit with inline recovery for known GL errors
    let commitResult;
    try {
      commitResult = await gl.commit(branch, commitMsg, actions,
        cfg.git.authorName, cfg.git.authorEmail);
    } catch (commitErr) {
      const errStr = commitErr.message || "";
      // Handle "file already exists" — switch create→update and retry
      if (/already exists/i.test(errStr) && actions.some(a => a.action === "create")) {
        logWarn("Some files already exist on branch — switching create → update and retrying commit");
        for (const a of actions) {
          if (a.action === "create") a.action = "update";
        }
        commitResult = await gl.commit(branch, commitMsg, actions,
          cfg.git.authorName, cfg.git.authorEmail);
      }
      // Handle "not on a branch" — branch is corrupt, delete and recreate
      else if (/only create or edit files when you are on a branch/i.test(errStr)) {
        logWarn("Branch appears corrupt — deleting and recreating...");
        try { await gl.deleteBranch(branch); } catch (e) {
          logWarn(`deleteBranch failed: ${e.message}`);
        }
        const sourceBranch = state.data.parentBranch || cfg.branch.ts;
        await gl.createBranch(branch, sourceBranch);
        logOk(`Branch recreated: ${branch}`);
        commitResult = await gl.commit(branch, commitMsg, actions,
          cfg.git.authorName, cfg.git.authorEmail);
      }
      else {
        throw commitErr;
      }
    }
    state.data.code_committed = true;
    state.data._last_commit_sha = commitResult.id || null;
    save(state);
    logOk(`Committed ${commitResult.id ? commitResult.id.substring(0, 8) + " " : ""}as ${cfg.git.authorName} <${cfg.git.authorEmail}>`);
  }

  // GQ4: Merge conflict detection before MR creation
  if (!state.data._conflict_check_done) {
    try {
      // Fetch the target branch diff to detect potential conflicts
      const diffResp = await req(
        gl.u(`/repository/compare?from=${encodeURIComponent(cfg.branch.qa)}&to=${encodeURIComponent(branch)}`),
        { headers: gl.h() },
      );
      if (diffResp.status === 200 && diffResp.data) {
        // T2.20: Check for files modified in BOTH branches (actual conflict risk),
        // not just renames/deletes which are expected changes
        const diffs = diffResp.data.diffs || [];
        const conflicts = diffs.filter((d) => !d.new_file && !d.deleted_file && !d.renamed_file);
        if (conflicts.length > 0) {
          logWarn(`GQ4: ${conflicts.length} file(s) modified in both branches — potential merge conflicts`);
          addWarning(state, "generate_code", `${conflicts.length} potential merge conflicts detected`);
        } else {
          logOk("GQ4: No merge conflicts detected");
        }
      }
    } catch (conflictErr) {
      logDebug(`GQ4: Conflict detection failed: ${conflictErr.message} — proceeding anyway`);
    }
    state.data._conflict_check_done = true;
    save(state);
  }

  // T2.19: Divergence check — compare local commit SHA vs remote HEAD
  if (state.data.code_committed && !state.data._divergence_checked) {
    try {
      const branchResp = await req(gl.u(`/repository/branches/${encodeURIComponent(branch)}`), { headers: gl.h() });
      if (branchResp.status === 200 && branchResp.data && branchResp.data.commit) {
        const remoteSha = branchResp.data.commit.id;
        if (state.data._last_commit_sha && state.data._last_commit_sha !== remoteSha) {
          logErr(`GQ8: Remote branch has diverged! Local SHA: ${state.data._last_commit_sha.substring(0, 8)}, Remote SHA: ${remoteSha.substring(0, 8)}`);
          addWarning(state, "generate_code", `Branch diverged: local ${state.data._last_commit_sha.substring(0, 8)} vs remote ${remoteSha.substring(0, 8)}`);
          throw new Error(`Branch ${branch} has diverged — remote HEAD differs from local commit. Manual resolution required.`);
        }
        logOk("GQ8: Remote branch verified — no divergence");
      }
    } catch (divErr) {
      if (divErr.message.includes("diverged")) throw divErr;
      logDebug(`GQ8: Divergence check failed: ${divErr.message}`);
    }
    state.data._divergence_checked = true;
    save(state);
  }

  if (!state.data.code_mr_iid) {
    logInfo(`Creating MR: ${branch} → ${cfg.branch.qa} (assigned to you)…`);
    // M4: Sanitize summary and test notes for MR description
    const safeSummary = sanitizeMRText(changes.summary || "");
    const safeTestNotes = sanitizeMRText(changes.test_notes || "");

    // Q7: Enhanced MR description with quality report
    const tscStatus = state.data._build_tsc || "N/A";
    const eslintStatus = state.data._build_eslint || "N/A";
    const acVerification = state.data._ac_verification
      ? (state.data._ac_known_gaps ? "Partial — see known gaps below" : "All criteria met")
      : (state.data.ticket?.ac_missing ? "N/A (no AC)" : "Not verified");
    const reviewStatus = state.data._reviewed ? "Completed" : "Pending";
    const securityStatus = state.data._fixed ? "Fixed" : (state.data._reviewed ? "Passed" : "Pending");

    let qualitySection = `### Quality Report\n`;
    qualitySection += `- TypeScript: ${tscStatus === "PASS" ? "No errors" : tscStatus}\n`;
    qualitySection += `- ESLint: ${eslintStatus === "PASS" ? "No errors" : eslintStatus}\n`;
    qualitySection += `- Code Review: ${reviewStatus}\n`;
    qualitySection += `- Security: ${securityStatus}\n`;
    qualitySection += `- AC Verification: ${acVerification}\n`;

    // 8.1-8.5: Runtime Test Results section in MR description
    let runtimeTestSection = "";
    if (RUN_RUNTIME_TESTS && (state.data._unit_tests_complete || state.data._e2e_tests_complete)) {
      runtimeTestSection = `\n### Runtime Test Results\n`;
      // 8.2: Unit test counts
      if (state.data._unit_tests_complete) {
        const ut = state.data._unit_tests_count || {};
        if (state.data._unit_tests_complete === "INCONCLUSIVE") {
          runtimeTestSection += `- Unit Tests: INCONCLUSIVE — ${ut.failed || 0} tests could not be verified. Manual testing recommended.\n`;
        } else {
          runtimeTestSection += `- Unit Tests: ${ut.passed || 0}/${ut.total || 0} passed`;
          if (ut.flaky > 0) runtimeTestSection += ` (${ut.flaky} flaky)`;
          runtimeTestSection += ` — ${state.data._unit_tests_complete}\n`;
        }
      }
      // 8.3: Browser smoke status
      if (state.data._e2e_tests_complete) {
        const et = state.data._e2e_tests_count || {};
        if (state.data._e2e_tests_complete === "INCONCLUSIVE") {
          runtimeTestSection += `- Browser Smoke: INCONCLUSIVE — Manual testing recommended.\n`;
        } else {
          runtimeTestSection += `- Browser Smoke: ${et.passed || 0}/${et.total || 0} passed — ${state.data._e2e_tests_complete}\n`;
        }
        // 8.3: Console warning count
        const e2eConsoleErrs = state.data._e2e_console_errors || [];
        if (e2eConsoleErrs.length > 0) {
          runtimeTestSection += `- Console Warnings: ${e2eConsoleErrs.length} captured\n`;
        }
      }
      // 8.5: First 5 console errors in MR description
      const consoleErrors = state.data._e2e_console_errors || [];
      if (consoleErrors.length > 0) {
        runtimeTestSection += `\n#### Console Warnings\n`;
        consoleErrors.slice(0, 5).forEach(e => {
          runtimeTestSection += `- [${e.severity || "UNKNOWN"}] ${sanitizeMRText((e.text || e.message || "").substring(0, 200))}\n`;
        });
        if (consoleErrors.length > 5) runtimeTestSection += `- ... and ${consoleErrors.length - 5} more\n`;
      }
    } else if (RUN_RUNTIME_TESTS === false || state.data._env_bootstrap_failed) {
      // 8.4: Note when tests were skipped
      runtimeTestSection = `\n### Runtime Test Results\n- Runtime Tests: Skipped${state.data._env_bootstrap_failed ? " (environment bootstrap failed)" : ""}\n`;
    }

    // Browser Verification section
    let browserVerifySection = "";
    if (BROWSER_VERIFY && state.data._browser_verified) {
      const { buildBrowserVerifyMRSection } = require("./generate-code/browser-verify");
      browserVerifySection = buildBrowserVerifyMRSection(state);
    }

    // X9: Per-file change rationale from the plan
    let fileSection = `### Changes\n`;
    const plan = state.data.explore_plan || "";
    for (const c of changes.changes) {
      // Try to find a rationale for this file from the plan
      const fileName = c.file_path.split("/").pop();
      const planLines = plan.split("\n");
      const rationale = planLines.find((l) => l.includes(fileName) || l.includes(c.file_path));
      fileSection += `- ${c.action}: \`${c.file_path}\`${rationale ? ` — ${rationale.replace(/^[-*•\s]+/, "").substring(0, 100)}` : ""}\n`;
    }

    // Known gaps from AC verification
    let gapSection = "";
    if (state.data._ac_known_gaps) {
      gapSection = `\n### Known Gaps\n${state.data._ac_known_gaps}\n`;
    }

    // S11: Apply redactSecrets to MR description to strip any leaked credentials
    const mrDescription = redactSecrets(
      `## ${TICKET} — ${state.data.ticket.summary}\n\n` +
      `${safeSummary}\n\n` +
      `${qualitySection}\n` +
      `${runtimeTestSection ? runtimeTestSection + "\n" : ""}` +
      `${browserVerifySection ? browserVerifySection + "\n" : ""}` +
      `${fileSection}\n` +
      `### Test Notes\n${safeTestNotes}\n` +
      `${gapSection}\n` +
      `---\nAI Dev Agent | Branch: \`${state.data.code_source_branch || cfg.branch.ts}\` -> \`${branch}\``
    );

    // S5: Validate MR target branch before creation
    validateMRTarget(cfg.branch.qa);
    const mr = await gl.createMR(
      branch, cfg.branch.qa,
      // T2.24: Sanitize MR title — strip newlines/special chars, cap length
      `feat(${TICKET}): ${(state.data.ticket.summary || "").replace(/\n/g, " ").replace(/[<>]/g, "").substring(0, 100)}`,
      mrDescription,
      true, cfg.git.assigneeId,
    );
    state.data.code_mr_iid = mr.iid;
    state.data.code_mr_url = mr.web_url;
    save(state);
    logOk(`MR !${mr.iid} created and assigned`);
  }

  // Slack notification only — NO Jira comment
  if (!state.data.code_slack_sent) {
    await slack(
      `🔔 *Code Review Required — ${TICKET}*\n` +
      `Agent generated code for: *${state.data.ticket.summary}*\n` +
      `🔀 MR: ${state.data.code_mr_url}\n` +
      `Approve the MR on GitLab to proceed.`,
      [cfg.slack.ownerId],
    );
    state.data.code_slack_sent = true;
    save(state);
    logOk("Slack notification sent (no Jira comment)");
  }

  state.stage = "gate_code_review";
  save(state);
}

module.exports = { pushCodeToGitLab };
