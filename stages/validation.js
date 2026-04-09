"use strict";

const { STAGE_REQUIREMENTS, REQUIRED_GATES, STAGE_CLEARS } = require("../lib/constants");
const { logOk, logErr, logInfo, logWarn } = require("../lib/logging");
const { addWarning } = require("../lib/utils");

// ── W1: Stage Entry Validation ────────────────────────────────────
function validateStageEntry(state) {
  const stage = state.stage;
  const reqs = STAGE_REQUIREMENTS[stage];
  if (!reqs || reqs.length === 0) return; // No requirements for this stage
  const missing = [];
  for (const field of reqs) {
    if (state.data[field] === undefined || state.data[field] === null) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    logWarn(`W1: Stage "${stage}" missing required data: ${missing.join(", ")}`);
    addWarning(state, stage, `Stage entry validation: missing ${missing.join(", ")}`);
    // Don't throw — warn only. Some fields may be set during the stage itself.
  }
}

// ── W2: Stage Skip Protection ────────────────────────────────────
function validateCompletedGates(state) {
  if (state.stage !== "deploy_prod") return; // Only enforce at production deploy
  if (!state.data._completedGates) state.data._completedGates = [];
  const missing = REQUIRED_GATES.filter((g) => !state.data._completedGates.includes(g));
  if (missing.length > 0) {
    logErr(`W2: Cannot deploy to production — ${missing.length} required gate(s) not completed: ${missing.join(", ")}`);
    throw new Error(`Stage skip detected: gates not completed: ${missing.join(", ")}. Cannot deploy to production.`);
  }
  logOk("W2: All required gates verified for production deploy");
}

// ── O11: Failed Stage Auto-Resets ────────────────────────────────
function clearDownstreamData(state, targetStage) {
  const fields = STAGE_CLEARS[targetStage];
  if (!fields || fields.length === 0) return;
  let cleared = 0;
  for (const field of fields) {
    if (state.data[field] !== undefined && state.data[field] !== null) {
      state.data[field] = null;
      cleared++;
    }
  }
  if (cleared > 0) {
    logInfo(`O11: Cleared ${cleared} downstream data field(s) for stage reset to "${targetStage}"`);
  }
}

module.exports = { validateStageEntry, validateCompletedGates, clearDownstreamData };
