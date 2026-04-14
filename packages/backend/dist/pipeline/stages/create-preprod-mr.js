"use strict";
// =====================================================================
// MI Dev Agent -- Create Pre-Prod MR (TypeScript port of stages/create-preprod-mr.js)
// =====================================================================
//
// Stage 8: Create a merge request from QA branch to pre-prod branch.
//
// Features:
//   - S5: MR target branch validation
//   - Idempotent: skips if MR already exists (checkpoint recovery)
//   - Uses QA branch as source (feature branch may be deleted after QA merge)
//   - Includes code change summary in MR description
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCreatePreprodMrHandler = createCreatePreprodMrHandler;
const logger_1 = require("../../lib/logger");
const state_manager_1 = require("../../state/state-manager");
const loader_1 = require("../../config/loader");
const constants_1 = require("@shared/constants");
// ── MR target validation (S5) ────────────────────────────────────
function validateMRTarget(target) {
    const allowed = constants_1.ALLOWED_MR_TARGETS;
    if (!allowed.includes(target)) {
        throw new Error(`S5: MR target branch "${target}" is not in the allowed list: ${allowed.join(', ')}`);
    }
}
// ── Stage Handler ────────────────────────────────────────────────
function createCreatePreprodMrHandler(deps) {
    const { gl } = deps;
    return async function stageCreatePreprodMR(state) {
        const cfg = (0, loader_1.loadConfig)();
        const data = state.data;
        const ticket = state.ticket;
        (0, logger_1.logStep)(8, 'Create Pre-Prod MR');
        if (!data.preprod_mr_iid) {
            // Use enterprise-qa as source (feature branch may be deleted after QA merge)
            const sourceBranch = cfg.branches.qa;
            (0, logger_1.logInfo)(`Creating MR: ${sourceBranch} -> ${cfg.branches.preprod}...`);
            // S5: Validate MR target branch before creation
            validateMRTarget(cfg.branches.preprod);
            const codeChanges = data.codeChanges;
            const changeSummary = codeChanges?.summary || '(No summary available)';
            const mr = await gl.createMR({
                sourceBranch,
                targetBranch: cfg.branches.preprod,
                title: `release(${ticket}): ${data.ticket?.summary || ''} -> Pre-Prod`,
                description: `## ${ticket} -- Promote to Pre-Prod\n\n` +
                    `${changeSummary}\n\n` +
                    `QA verified.\n\n` +
                    `---\nAI Dev Agent`,
            });
            data.preprod_mr_iid = mr.iid;
            data.preprod_mr_url = mr.web_url;
            (0, state_manager_1.save)(state);
            (0, logger_1.logOk)(`Pre-Prod MR !${mr.iid} created`);
        }
        state.stage = 'gate_dual_approval';
        (0, state_manager_1.save)(state);
    };
}
//# sourceMappingURL=create-preprod-mr.js.map