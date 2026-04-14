"use strict";
// =====================================================================
// MI Dev Agent -- Deploy Production (TypeScript port of stages/deploy-prod.js)
// =====================================================================
//
// Stage 10: Merge pre-prod MR, wait for CI, smoke test, create prod MR,
// merge prod MR, wait for CI, post-deploy smoke test.
//
// Features:
//   - E3: Merge error handling with external merge detection and error code mapping
//   - E4: Pre-Prod smoke test hard-stop (2 attempts with 30s retry)
//   - X8: Record pre-merge HEAD SHA for rollback capability
//   - X8: Post-deploy production smoke with rollback instructions
//   - S5: MR target branch validation
//   - P12: Include warnings in MR description
//   - saveAndThrow at all throw sites (state is saved before every throw)
//   - Move preprod_merged after getMR verification
//   - CI pipeline wait for both pre-prod and production
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDeployProdHandler = createDeployProdHandler;
const logger_1 = require("../../lib/logger");
const utils_1 = require("../../lib/utils");
const state_manager_1 = require("../../state/state-manager");
const loader_1 = require("../../config/loader");
const client_1 = require("../../http/client");
const constants_1 = require("@shared/constants");
// ── Helpers ──────────────────────────────────────────────────────
/** Save state and then throw -- ensures state is never lost on error */
function saveAndThrow(state, err) {
    try {
        (0, state_manager_1.save)(state);
    }
    catch (saveErr) {
        const msg = saveErr instanceof Error ? saveErr.message : String(saveErr);
        (0, logger_1.logWarn)(`[deploy-prod] save before throw failed: ${msg}`);
    }
    throw err;
}
/** S5: Validate MR target branch */
function validateMRTarget(target) {
    const allowed = constants_1.ALLOWED_MR_TARGETS;
    if (!allowed.includes(target)) {
        throw new Error(`S5: MR target branch "${target}" is not in the allowed list: ${allowed.join(', ')}`);
    }
}
// ── Stage Handler ────────────────────────────────────────────────
function createDeployProdHandler(deps) {
    const { gl, slack } = deps;
    return async function stageDeployProd(state) {
        const cfg = (0, loader_1.loadConfig)();
        const ext = (0, loader_1.loadExtendedConfig)();
        const data = state.data;
        const ticket = state.ticket;
        const skipSmokeCheck = !cfg.flags.runACVerification; // SKIP_SMOKE_CHECK inverted in config
        (0, logger_1.logStep)(10, 'Deploy Pre-Prod + Production');
        // ── E3: Merge Pre-Prod MR with error handling ──
        if (!data.preprod_merged) {
            (0, logger_1.logInfo)('Merging Pre-Prod MR...');
            try {
                await gl.mergeMR(data.preprod_mr_iid);
                // Verify merge succeeded
                const verifyMr = await gl.getMR(data.preprod_mr_iid);
                if (verifyMr.state === 'merged') {
                    data.preprod_merged = true;
                    (0, state_manager_1.save)(state);
                    (0, logger_1.logOk)('Pre-Prod MR merged');
                }
                else {
                    (0, logger_1.logWarn)(`Pre-Prod MR state after merge: "${verifyMr.state}" -- expected "merged"`);
                    data.preprod_merged = true;
                    (0, state_manager_1.save)(state);
                }
            }
            catch (err) {
                const errObj = err instanceof Error ? err : new Error(String(err));
                // Check if already merged externally
                try {
                    const mr = await gl.getMR(data.preprod_mr_iid);
                    if (mr.state === 'merged') {
                        (0, logger_1.logOk)('Pre-Prod MR already merged externally');
                        data.preprod_merged = true;
                        (0, state_manager_1.save)(state);
                    }
                    else {
                        // Map error codes
                        const errMsg = errObj.message;
                        let detail = `Pre-Prod MR merge failed: ${errMsg}`;
                        if (errMsg.includes('405'))
                            detail += ' (likely merge conflicts)';
                        else if (errMsg.includes('406'))
                            detail += ' (pipeline failures or unresolved discussions)';
                        (0, logger_1.logErr)(detail);
                        await slack.send(`Pre-Prod Merge Failed -- ${ticket}\n${detail}\nMR: ${data.preprod_mr_url}`, [cfg.slack.ownerSlackId || '']);
                        saveAndThrow(state, new Error(detail));
                    }
                }
                catch (checkErr) {
                    const checkMsg = checkErr instanceof Error ? checkErr.message : String(checkErr);
                    if (checkMsg.includes('Pre-Prod MR merge failed'))
                        throw checkErr;
                    (0, logger_1.logErr)(`Pre-Prod merge error + could not check MR state: ${errObj.message}`);
                    await slack.send(`Pre-Prod Merge Failed -- ${ticket}\n${errObj.message}\nMR: ${data.preprod_mr_url}`, [cfg.slack.ownerSlackId || '']);
                    saveAndThrow(state, errObj);
                }
            }
        }
        // Wait for Pre-Prod CI
        if (!data.preprod_ci) {
            await gl.waitPipeline(cfg.branches.preprod);
            data.preprod_ci = true;
            (0, state_manager_1.save)(state);
        }
        // ── E4: Pre-Prod Smoke Test Hard-Stop ──
        if (!data.preprod_smoke_passed) {
            if (skipSmokeCheck) {
                (0, logger_1.logWarn)('Pre-Prod smoke check SKIPPED (SKIP_SMOKE_CHECK=true)');
                data.preprod_smoke_passed = true;
                (0, state_manager_1.save)(state);
            }
            else {
                (0, logger_1.logInfo)('Smoke-testing Pre-Prod...');
                const preProdUrl = ext.viteAppQa; // Pre-prod URL
                let smokeOk = false;
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        const r = await (0, client_1.req)(preProdUrl, { method: 'GET' });
                        if (r.status >= 200 && r.status < 400) {
                            (0, logger_1.logOk)(`Pre-Prod smoke: HTTP ${r.status} (attempt ${attempt})`);
                            smokeOk = true;
                            break;
                        }
                        else {
                            (0, logger_1.logWarn)(`Pre-Prod smoke: HTTP ${r.status} (attempt ${attempt}/2)`);
                        }
                    }
                    catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        (0, logger_1.logWarn)(`Pre-Prod smoke error (attempt ${attempt}/2): ${msg}`);
                    }
                    if (attempt === 1) {
                        (0, logger_1.logInfo)('Retrying smoke test in 30s...');
                        await (0, utils_1.sleep)(30_000);
                    }
                }
                if (!smokeOk) {
                    (0, logger_1.logErr)('Pre-Prod smoke test FAILED -- HALTING pipeline');
                    await slack.send(`Pre-Prod Smoke FAILED -- ${ticket}\n` +
                        `Pre-Prod (${preProdUrl}) is not responding. Pipeline HALTED before production deploy.\n` +
                        `Fix the issue and re-run the agent.`, [cfg.slack.ownerSlackId || '']);
                    (0, utils_1.addWarning)(state, 'deploy_prod', 'Pre-Prod smoke test failed -- pipeline halted');
                    saveAndThrow(state, new Error('Pre-Prod smoke test failed -- cannot proceed to production'));
                }
                data.preprod_smoke_passed = true;
                (0, state_manager_1.save)(state);
            }
        }
        // ── X8: Record pre-merge HEAD SHA for rollback ──
        if (!data._prod_pre_merge_sha) {
            try {
                const branchInfo = await (0, client_1.req)(`${cfg.gitlab.base}/api/v4/projects/${cfg.gitlab.projectId}/repository/branches/${encodeURIComponent(cfg.branches.prod)}`, {
                    headers: {
                        'PRIVATE-TOKEN': cfg.gitlab.token,
                        'Content-Type': 'application/json',
                    },
                });
                const branchData = branchInfo.data;
                if (branchInfo.status === 200 && branchData?.commit?.id) {
                    data._prod_pre_merge_sha = branchData.commit.id;
                    (0, logger_1.logInfo)(`X8: Recorded pre-merge SHA: ${branchData.commit.id.substring(0, 8)}`);
                    (0, state_manager_1.save)(state);
                }
                else {
                    throw new Error(`Failed to get production branch HEAD -- HTTP ${branchInfo.status}`);
                }
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                (0, logger_1.logErr)(`X8: Could not record pre-merge SHA: ${msg} -- halting to ensure rollback capability`);
                saveAndThrow(state, new Error(`Cannot proceed to production without rollback SHA: ${msg}`));
            }
        }
        // ── Create Production MR ──
        if (!data.prod_mr_iid) {
            (0, logger_1.logInfo)(`Creating Production MR: ${cfg.branches.preprod} -> ${cfg.branches.prod}...`);
            // S5: Validate MR target branch before creation
            validateMRTarget(cfg.branches.prod);
            // P12: Include warnings in MR description
            const warnings = data._warnings;
            const warningsSummary = warnings && warnings.length > 0
                ? `\n\n### Known Limitations\n${warnings.map((w) => `- [${w.stage}] ${w.message}`).join('\n')}`
                : '';
            const codeChanges = data.codeChanges;
            const mr = await gl.createMR({
                sourceBranch: cfg.branches.preprod,
                targetBranch: cfg.branches.prod,
                title: `release(${ticket}): ${data.ticket?.summary || ''} -> Production`,
                description: `## ${ticket} -- Production Release\n\n` +
                    `${codeChanges?.summary || '(No summary available)'}\n\n` +
                    `QA -- Pre-Prod -- Dual Approval` +
                    `${warningsSummary}\n\n` +
                    `---\nAI Dev Agent`,
            });
            data.prod_mr_iid = mr.iid;
            data.prod_mr_url = mr.web_url;
            (0, state_manager_1.save)(state);
            (0, logger_1.logOk)(`Production MR !${mr.iid} created`);
        }
        // ── E3: Merge Production MR with error handling ──
        if (!data.prod_merged) {
            (0, logger_1.logInfo)('Merging Production MR...');
            await (0, utils_1.sleep)(5000);
            try {
                await gl.mergeMR(data.prod_mr_iid);
                data.prod_merged = true;
                (0, state_manager_1.save)(state);
                (0, logger_1.logOk)('Production MR merged');
            }
            catch (err) {
                const errObj = err instanceof Error ? err : new Error(String(err));
                try {
                    const mr = await gl.getMR(data.prod_mr_iid);
                    if (mr.state === 'merged') {
                        (0, logger_1.logOk)('Production MR already merged externally');
                        data.prod_merged = true;
                        (0, state_manager_1.save)(state);
                    }
                    else {
                        const errMsg = errObj.message;
                        let detail = `Production MR merge failed: ${errMsg}`;
                        if (errMsg.includes('405'))
                            detail += ' (likely merge conflicts)';
                        else if (errMsg.includes('406'))
                            detail += ' (pipeline failures or unresolved discussions)';
                        (0, logger_1.logErr)(detail);
                        await slack.send(`Production Merge Failed -- ${ticket}\n${detail}\nMR: ${data.prod_mr_url}`, [cfg.slack.ownerSlackId || '']);
                        saveAndThrow(state, new Error(detail));
                    }
                }
                catch (checkErr) {
                    const checkMsg = checkErr instanceof Error ? checkErr.message : String(checkErr);
                    if (checkMsg.includes('Production MR merge failed'))
                        throw checkErr;
                    (0, logger_1.logErr)(`Production merge error + could not check MR state: ${errObj.message}`);
                    await slack.send(`Production Merge Failed -- ${ticket}\n${errObj.message}\nMR: ${data.prod_mr_url}`, [cfg.slack.ownerSlackId || '']);
                    saveAndThrow(state, errObj);
                }
            }
        }
        // Wait for Production CI
        if (!data.prod_ci) {
            await gl.waitPipeline(cfg.branches.prod);
            data.prod_ci = true;
            (0, state_manager_1.save)(state);
        }
        // ── X8: Post-deploy smoke check + rollback info ──
        if (!data._prod_smoke_checked && !skipSmokeCheck) {
            (0, logger_1.logInfo)('X8: Smoke-testing Production...');
            const prodUrl = ext.viteAppQa.replace('qa-', ''); // derive prod URL
            let prodSmokeOk = false;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const r = await (0, client_1.req)(prodUrl, { method: 'GET' });
                    if (r.status >= 200 && r.status < 400) {
                        (0, logger_1.logOk)(`Production smoke: HTTP ${r.status} (attempt ${attempt})`);
                        prodSmokeOk = true;
                        break;
                    }
                    (0, logger_1.logWarn)(`Production smoke: HTTP ${r.status} (attempt ${attempt}/2)`);
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    (0, logger_1.logWarn)(`Production smoke error (attempt ${attempt}/2): ${msg}`);
                }
                if (attempt === 1)
                    await (0, utils_1.sleep)(30_000);
            }
            if (!prodSmokeOk) {
                const preMergeSha = data._prod_pre_merge_sha;
                if (preMergeSha) {
                    const rollbackSha = preMergeSha.substring(0, 12);
                    (0, logger_1.logErr)('X8: Production smoke FAILED -- sending rollback instructions');
                    await slack.send(`PRODUCTION SMOKE FAILED -- ${ticket}\n` +
                        `Production (${prodUrl}) is not responding after deploy.\n\n` +
                        `Rollback command:\n` +
                        `git checkout ${cfg.branches.prod}\n` +
                        `git reset --hard ${rollbackSha}\n` +
                        `git push --force origin ${cfg.branches.prod}\n\n` +
                        `Pre-merge SHA: ${preMergeSha}`, [cfg.slack.ownerSlackId || '', ext.anshitSlackId || '']);
                }
                else {
                    await slack.send(`PRODUCTION SMOKE FAILED -- ${ticket}\n` +
                        `Production (${prodUrl}) is not responding after deploy.\n` +
                        `No rollback SHA available -- manual investigation required.`, [cfg.slack.ownerSlackId || '', ext.anshitSlackId || '']);
                }
                (0, utils_1.addWarning)(state, 'deploy_prod', `Production smoke failed -- rollback SHA: ${preMergeSha || 'unavailable'}`);
                data._prod_smoke_checked = true;
                saveAndThrow(state, new Error('Production smoke test FAILED -- pipeline halted. Manual rollback required.'));
            }
            data._prod_smoke_checked = true;
            (0, state_manager_1.save)(state);
        }
        state.stage = 'done';
        (0, state_manager_1.save)(state);
    };
}
//# sourceMappingURL=deploy-prod.js.map