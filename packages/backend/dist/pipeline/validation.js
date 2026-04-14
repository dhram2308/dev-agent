"use strict";
// ===================================================================
// MI Dev Agent -- Stage Validation
// (TypeScript port of stages/validation.js)
//
// Three validation functions that enforce pipeline integrity:
//
//   W1: validateStageEntry()
//       Checks that required data fields exist before entering a stage.
//       Warns but does NOT throw -- some fields are set during the stage.
//
//   W2: validateCompletedGates()
//       Verifies ALL required gates passed before production deploy.
//       Throws if any gates are missing (hard blocker).
//
//   O11: clearDownstreamData()
//       Wipes stale data fields when re-entering a stage (e.g., after
//       code review rejection). Prevents downstream stages from using
//       outdated artifacts.
//
// All requirements maps are sourced from @shared/constants.
// ===================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateStageEntry = validateStageEntry;
exports.validateCompletedGates = validateCompletedGates;
exports.clearDownstreamData = clearDownstreamData;
const constants_1 = require("@shared/constants");
const logger_1 = require("../lib/logger");
const utils_1 = require("../lib/utils");
// ── W1: Stage Entry Validation ──────────────────────────────────────
/**
 * Check that all required data fields exist for the current stage.
 *
 * This is a soft validation -- it logs warnings but does NOT throw.
 * Some fields may legitimately be set during the stage itself (e.g.,
 * `code_mr_iid` is created during `generate_code`).
 *
 * Missing fields are recorded in `state.data._warnings` for diagnostics.
 *
 * @param state - Current pipeline state
 */
function validateStageEntry(state) {
    const stage = state.stage;
    const reqs = constants_1.STAGE_REQUIREMENTS[stage];
    if (!reqs || reqs.length === 0)
        return; // No requirements for this stage
    const missing = [];
    for (const field of reqs) {
        const value = state.data[field];
        if (value === undefined || value === null) {
            missing.push(field);
        }
    }
    if (missing.length > 0) {
        (0, logger_1.logWarn)(`W1: Stage "${stage}" missing required data: ${missing.join(', ')}`);
        (0, utils_1.addWarning)(state, stage, `Stage entry validation: missing ${missing.join(', ')}`);
        // Don't throw -- warn only. Some fields may be set during the stage itself.
    }
}
// ── W2: Stage Skip Protection ───────────────────────────────────────
/**
 * Verify that all required gates have been completed before production deploy.
 *
 * This is a hard validation -- it THROWS if any required gate is missing.
 * Only enforced at the `deploy_prod` stage.
 *
 * Required gates: every stage from fetch_ticket through gate_dual_approval
 * must appear in `state.data._completedGates`.
 *
 * @param state - Current pipeline state
 * @throws Error if any required gates are missing
 */
function validateCompletedGates(state) {
    if (state.stage !== 'deploy_prod')
        return; // Only enforce at production deploy
    if (!state.data._completedGates) {
        state.data._completedGates = [];
    }
    const missing = constants_1.REQUIRED_GATES.filter((g) => !state.data._completedGates.includes(g));
    if (missing.length > 0) {
        (0, logger_1.logErr)(`W2: Cannot deploy to production -- ${missing.length} required gate(s) not completed: ${missing.join(', ')}`);
        throw new Error(`Stage skip detected: gates not completed: ${missing.join(', ')}. Cannot deploy to production.`);
    }
    (0, logger_1.logOk)('W2: All required gates verified for production deploy');
}
// ── O11: Failed Stage Auto-Resets ───────────────────────────────────
/**
 * Wipe stale downstream data when re-entering a stage.
 *
 * When a stage is re-entered (e.g., code generation after review rejection),
 * all data fields listed in STAGE_CLEARS for that stage are set to null.
 * This prevents downstream stages from using outdated artifacts.
 *
 * @param state - Current pipeline state
 * @param targetStage - The stage being re-entered
 */
function clearDownstreamData(state, targetStage) {
    const fields = constants_1.STAGE_CLEARS[targetStage];
    if (!fields || fields.length === 0)
        return;
    let cleared = 0;
    const data = state.data;
    for (const field of fields) {
        if (data[field] !== undefined && data[field] !== null) {
            data[field] = null;
            cleared++;
        }
    }
    if (cleared > 0) {
        (0, logger_1.logInfo)(`O11: Cleared ${cleared} downstream data field(s) for stage reset to "${targetStage}"`);
    }
}
//# sourceMappingURL=validation.js.map