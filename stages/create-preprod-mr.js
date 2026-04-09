"use strict";

const { cfg, TICKET } = require("../lib/config");
const { logStep, logOk, logInfo } = require("../lib/logging");
const { save } = require("../lib/state");
const { gl } = require("../lib/gitlab");
const { validateMRTarget } = require("../lib/config");

async function stageCreatePreprodMR(state) {
  logStep(8, "Create Pre-Prod MR");

  if (!state.data.preprod_mr_iid) {
    // Use enterprise-qa as source (feature branch may be deleted after QA merge)
    const sourceBranch = cfg.branch.qa;
    logInfo(`Creating MR: ${sourceBranch} → ${cfg.branch.preProd}…`);
    // S5: Validate MR target branch before creation
    validateMRTarget(cfg.branch.preProd);
    const mr = await gl.createMR(
      sourceBranch, cfg.branch.preProd,
      `release(${TICKET}): ${state.data.ticket.summary} → Pre-Prod`,
      `## ${TICKET} — Promote to Pre-Prod\n\n${state.data.codeChanges?.summary || "(No summary available)"}\n\nQA verified ✅\n\n---\n🤖 AI Dev Agent`,
    );
    state.data.preprod_mr_iid = mr.iid;
    state.data.preprod_mr_url = mr.web_url;
    save(state);
    logOk(`Pre-Prod MR !${mr.iid} created`);
  }

  state.stage = "gate_dual_approval";
  save(state);
}

module.exports = { stageCreatePreprodMR };
