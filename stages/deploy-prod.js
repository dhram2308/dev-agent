"use strict";

const { cfg, TICKET, SKIP_SMOKE_CHECK } = require("../lib/config");
const { logStep, logOk, logErr, logInfo, logWarn } = require("../lib/logging");
const { req, sleep } = require("../lib/http-client");
const { addWarning } = require("../lib/utils");
const { save } = require("../lib/state");
const { gl } = require("../lib/gitlab");
const { slack } = require("../lib/slack");
const { validateMRTarget } = require("../lib/config");
const { isChannelEnabled } = require("../lib/notification-config");

async function stageDeployProd(state) {
  logStep(10, "Deploy Pre-Prod + Production");

  // E3: Merge Pre-Prod MR with error handling
  if (!state.data.preprod_merged) {
    logInfo("Merging Pre-Prod MR…");
    try {
      await gl.mergeMR(state.data.preprod_mr_iid);
      state.data.preprod_merged = true;
      save(state);
      logOk("Pre-Prod MR merged");
    } catch (err) {
      // E3: Check if already merged externally
      try {
        const mr = await gl.getMR(state.data.preprod_mr_iid);
        if (mr.state === "merged") {
          logOk("Pre-Prod MR already merged externally");
          state.data.preprod_merged = true;
          save(state);
        } else {
          // E3: Map error codes
          const errMsg = err.message || "";
          let detail = `Pre-Prod MR merge failed: ${errMsg}`;
          if (errMsg.includes("405")) detail += " (likely merge conflicts)";
          else if (errMsg.includes("406")) detail += " (pipeline failures or unresolved discussions)";
          logErr(detail);
          if (isChannelEnabled("deploy_prod", "slack")) {
            await slack(
              `🚨 *Pre-Prod Merge Failed — ${TICKET}*\n${detail}\nMR: ${state.data.preprod_mr_url}`,
              [cfg.slack.ownerId],
            );
          }
          throw new Error(detail);
        }
      } catch (checkErr) {
        if (checkErr.message.includes("Pre-Prod MR merge failed")) throw checkErr;
        logErr(`Pre-Prod merge error + could not check MR state: ${err.message}`);
        if (isChannelEnabled("deploy_prod", "slack")) {
          await slack(
            `🚨 *Pre-Prod Merge Failed — ${TICKET}*\n${err.message}\nMR: ${state.data.preprod_mr_url}`,
            [cfg.slack.ownerId],
          );
        }
        throw err;
      }
    }
  }

  // Wait for Pre-Prod CI
  if (!state.data.preprod_ci) {
    await gl.waitPipeline(cfg.branch.preProd);
    state.data.preprod_ci = true;
    save(state);
  }

  // E4: Pre-Prod Smoke Test Hard-Stop
  if (!state.data.preprod_smoke_passed) {
    if (SKIP_SMOKE_CHECK) {
      logWarn("Pre-Prod smoke check SKIPPED (SKIP_SMOKE_CHECK=true)");
      state.data.preprod_smoke_passed = true;
      save(state);
    } else {
      logInfo("Smoke-testing Pre-Prod…");
      let smokeOk = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await req(cfg.urls.preProd, { method: "GET" });
          if (r.status >= 200 && r.status < 400) {
            logOk(`Pre-Prod smoke: HTTP ${r.status} (attempt ${attempt})`);
            smokeOk = true;
            break;
          } else {
            logWarn(`Pre-Prod smoke: HTTP ${r.status} (attempt ${attempt}/2)`);
          }
        } catch (e) {
          logWarn(`Pre-Prod smoke error (attempt ${attempt}/2): ${e.message}`);
        }
        if (attempt === 1) {
          logInfo("Retrying smoke test in 30s…");
          await sleep(30_000);
        }
      }
      if (!smokeOk) {
        logErr("Pre-Prod smoke test FAILED — HALTING pipeline");
        if (isChannelEnabled("deploy_prod", "slack")) {
          await slack(
            `🚨 *Pre-Prod Smoke FAILED — ${TICKET}*\n` +
            `Pre-Prod (${cfg.urls.preProd}) is not responding. Pipeline HALTED before production deploy.\n` +
            `Fix the issue and re-run the agent.`,
            [cfg.slack.ownerId],
          );
        }
        addWarning(state, "deploy_prod", "Pre-Prod smoke test failed — pipeline halted");
        save(state);
        throw new Error("Pre-Prod smoke test failed — cannot proceed to production");
      }
      state.data.preprod_smoke_passed = true;
      save(state);
    }
  }

  // X8: Record pre-merge HEAD SHA for rollback (mandatory for safe rollback)
  if (!state.data._prod_pre_merge_sha) {
    try {
      const branchInfo = await req(gl.u(`/repository/branches/${encodeURIComponent(cfg.branch.prod)}`), { headers: gl.h() });
      if (branchInfo.status === 200 && branchInfo.data && branchInfo.data.commit) {
        state.data._prod_pre_merge_sha = branchInfo.data.commit.id;
        logInfo(`X8: Recorded pre-merge SHA: ${state.data._prod_pre_merge_sha.substring(0, 8)}`);
        save(state);
      } else {
        throw new Error(`Failed to get production branch HEAD — HTTP ${branchInfo.status}`);
      }
    } catch (e) {
      logErr(`X8: Could not record pre-merge SHA: ${e.message} — halting to ensure rollback capability`);
      throw new Error(`Cannot proceed to production without rollback SHA: ${e.message}`);
    }
  }

  // Create Production MR
  if (!state.data.prod_mr_iid) {
    logInfo(`Creating Production MR: ${cfg.branch.preProd} → ${cfg.branch.prod}…`);
    // S5: Validate MR target branch before creation
    validateMRTarget(cfg.branch.prod);
    // P12: Include warnings in MR description
    const warningsSummary = (state.data._warnings && state.data._warnings.length > 0)
      ? `\n\n### Known Limitations\n${state.data._warnings.map((w) => `- [${w.stage}] ${w.message}`).join("\n")}`
      : "";
    const mr = await gl.createMR(
      cfg.branch.preProd, cfg.branch.prod,
      `release(${TICKET}): ${state.data.ticket.summary} → Production`,
      `## ${TICKET} — Production Release\n\n${state.data.codeChanges?.summary || "(No summary available)"}\n\nQA ✅ · Pre-Prod ✅ · Dual Approval ✅${warningsSummary}\n\n---\n🤖 AI Dev Agent`,
    );
    state.data.prod_mr_iid = mr.iid;
    state.data.prod_mr_url = mr.web_url;
    save(state);
    logOk(`Production MR !${mr.iid} created`);
  }

  // E3: Merge Production MR with error handling
  if (!state.data.prod_merged) {
    logInfo("Merging Production MR…");
    await sleep(5000);
    try {
      await gl.mergeMR(state.data.prod_mr_iid);
      state.data.prod_merged = true;
      save(state);
      logOk("Production MR merged");
    } catch (err) {
      // E3: Check if already merged externally
      try {
        const mr = await gl.getMR(state.data.prod_mr_iid);
        if (mr.state === "merged") {
          logOk("Production MR already merged externally");
          state.data.prod_merged = true;
          save(state);
        } else {
          const errMsg = err.message || "";
          let detail = `Production MR merge failed: ${errMsg}`;
          if (errMsg.includes("405")) detail += " (likely merge conflicts)";
          else if (errMsg.includes("406")) detail += " (pipeline failures or unresolved discussions)";
          logErr(detail);
          if (isChannelEnabled("deploy_prod", "slack")) {
            await slack(
              `🚨 *Production Merge Failed — ${TICKET}*\n${detail}\nMR: ${state.data.prod_mr_url}`,
              [cfg.slack.ownerId],
            );
          }
          throw new Error(detail);
        }
      } catch (checkErr) {
        if (checkErr.message.includes("Production MR merge failed")) throw checkErr;
        logErr(`Production merge error + could not check MR state: ${err.message}`);
        if (isChannelEnabled("deploy_prod", "slack")) {
          await slack(
            `🚨 *Production Merge Failed — ${TICKET}*\n${err.message}\nMR: ${state.data.prod_mr_url}`,
            [cfg.slack.ownerId],
          );
        }
        throw err;
      }
    }
  }

  // Wait for Production CI
  if (!state.data.prod_ci) {
    await gl.waitPipeline(cfg.branch.prod);
    state.data.prod_ci = true;
    save(state);
  }

  // X8: Post-deploy smoke check + rollback info
  if (!state.data._prod_smoke_checked && !SKIP_SMOKE_CHECK) {
    logInfo("X8: Smoke-testing Production…");
    let prodSmokeOk = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await req(cfg.urls.prod, { method: "GET" });
        if (r.status >= 200 && r.status < 400) {
          logOk(`Production smoke: HTTP ${r.status} (attempt ${attempt})`);
          prodSmokeOk = true;
          break;
        }
        logWarn(`Production smoke: HTTP ${r.status} (attempt ${attempt}/2)`);
      } catch (e) {
        logWarn(`Production smoke error (attempt ${attempt}/2): ${e.message}`);
      }
      if (attempt === 1) await sleep(30_000);
    }
    if (!prodSmokeOk) {
      if (state.data._prod_pre_merge_sha) {
        const rollbackSha = state.data._prod_pre_merge_sha.substring(0, 12);
        logErr("X8: Production smoke FAILED — sending rollback instructions");
        if (isChannelEnabled("deploy_prod", "slack")) {
          await slack(
            `🚨 *PRODUCTION SMOKE FAILED — ${TICKET}*\n` +
            `Production (${cfg.urls.prod}) is not responding after deploy.\n\n` +
            `*Rollback command:*\n\`\`\`\ngit checkout ${cfg.branch.prod}\ngit reset --hard ${rollbackSha}\ngit push --force origin ${cfg.branch.prod}\n\`\`\`\n` +
            `Pre-merge SHA: \`${state.data._prod_pre_merge_sha}\``,
            [cfg.slack.ownerId, cfg.slack.anshitId],
          );
        }
      } else {
        if (isChannelEnabled("deploy_prod", "slack")) {
          await slack(
            `🚨 *PRODUCTION SMOKE FAILED — ${TICKET}*\n` +
            `Production (${cfg.urls.prod}) is not responding after deploy.\n` +
            `No rollback SHA available — manual investigation required.`,
            [cfg.slack.ownerId, cfg.slack.anshitId],
          );
        }
      }
      addWarning(state, "deploy_prod", `Production smoke failed — rollback SHA: ${state.data._prod_pre_merge_sha || "unavailable"}`);
      state.data._prod_smoke_checked = true;
      save(state);
      throw new Error("Production smoke test FAILED — pipeline halted. Manual rollback required.");
    }
    state.data._prod_smoke_checked = true;
    save(state);
  }

  state.stage = "done";
  save(state);
}

module.exports = { stageDeployProd };
