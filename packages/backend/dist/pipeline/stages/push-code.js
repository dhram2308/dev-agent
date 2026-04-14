"use strict";
// =====================================================================
// MI Dev Agent -- Push Code Stage (TypeScript port)
// =====================================================================
// Creates branch, commits file changes, creates MR on GitLab.
//
// Features:
//   - Branch creation with parent branch awareness (Q4)
//   - File validation (L2/L3: dedup, size check, binary detection)
//   - Commit with inline recovery (create->update, corrupt branch)
//   - Merge conflict detection (GQ4)
//   - Divergence check (T2.19)
//   - Enhanced MR description with quality report (Q7)
//   - Slack notification
//
// Ported from: stages/push-code.js
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushCodeToGitLab = pushCodeToGitLab;
const constants_1 = require("@shared/constants");
const logger_1 = require("../../lib/logger");
const utils_1 = require("../../lib/utils");
// ── Main function ───────────────────────────────────────────────────
/**
 * Push code changes to GitLab: branch creation, commit, MR creation.
 */
async function pushCodeToGitLab(state, changes, deps) {
    const { cfg, gl, save, slack, req } = deps;
    const TICKET = cfg.ticket;
    const data = state.data;
    const ticket = data.ticket;
    if (!changes.changes || changes.changes.length === 0) {
        throw new Error('No files to push -- ticket needs more detail.');
    }
    // L3: Validate changes array entries
    changes.changes = changes.changes.filter((c) => {
        if (!c.file_path || typeof c.file_path !== 'string' || c.file_path.trim() === '') {
            (0, logger_1.logWarn)('Skipping change with empty file_path');
            return false;
        }
        if (c.action !== 'delete' && c.content === undefined) {
            (0, logger_1.logWarn)(`Skipping change with undefined content: ${c.file_path}`);
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
    if (changes.changes.length === 0) {
        throw new Error('No valid files to push after validation.');
    }
    const branch = `enterprise-ts-${TICKET}`;
    // Create branch if needed
    if (!data.code_branch) {
        const sourceBranch = data.parentBranch || cfg.branch.ts;
        (0, logger_1.logInfo)(`Creating branch ${branch} from ${sourceBranch}${data.parentBranch ? ' (parent feature branch)' : ''}...`);
        await gl.createBranch(branch, sourceBranch);
        data.code_branch = branch;
        data.code_source_branch = sourceBranch;
        save(state);
        (0, logger_1.logOk)(`Branch: ${branch} (from ${sourceBranch})`);
    }
    // Commit files
    if (!data.code_committed) {
        // Verify branch exists
        const branchInfo = await gl.getBranch(branch);
        if (!branchInfo) {
            (0, logger_1.logWarn)(`Branch ${branch} not found on remote -- recreating...`);
            data.code_branch = null;
            save(state);
            const sourceBranch = data.parentBranch || cfg.branch.ts;
            await gl.createBranch(branch, sourceBranch);
            data.code_branch = branch;
            data.code_source_branch = sourceBranch;
            save(state);
            (0, logger_1.logOk)(`Branch recreated: ${branch}`);
        }
        // Build commit message
        const commitSummary = (ticket?.summary || '').trim();
        const commitMsg = commitSummary
            ? `feat(${TICKET}): ${commitSummary}`
            : `feat(${TICKET}): Implementation`;
        (0, logger_1.logInfo)('Committing files...');
        // GQ2: Filter out oversized files + T2.18: binary detection
        const validChanges = [];
        for (const c of changes.changes) {
            if (c.action !== 'delete') {
                // T2.18: Skip binary files
                const ext = (c.file_path.match(/\.[^.]+$/) || [''])[0].toLowerCase();
                if (constants_1.BINARY_EXTENSIONS.has(ext)) {
                    (0, logger_1.logWarn)(`T2.18: Skipping binary file: ${c.file_path}`);
                    (0, utils_1.addWarning)(state, 'generate_code', `Binary file skipped: ${c.file_path}`);
                    continue;
                }
                if (c.content && c.content.includes('\0')) {
                    (0, logger_1.logWarn)(`T2.18: Skipping file with null bytes (binary): ${c.file_path}`);
                    (0, utils_1.addWarning)(state, 'generate_code', `Binary content skipped: ${c.file_path}`);
                    continue;
                }
                if (c.content && c.content.length > deps.maxCommitFileSize) {
                    (0, logger_1.logWarn)(`GQ2: Skipping ${c.file_path} -- content size ${(c.content.length / 1024).toFixed(1)}KB exceeds limit`);
                    (0, utils_1.addWarning)(state, 'generate_code', `File skipped (too large): ${c.file_path}`);
                    continue;
                }
            }
            validChanges.push(c);
        }
        if (validChanges.length === 0) {
            throw new Error('No files to commit after size filtering');
        }
        const actions = validChanges.map((c) => {
            const entry = {
                action: c.action || 'update',
                file_path: c.file_path,
            };
            if (c.action !== 'delete')
                entry.content = c.content;
            return entry;
        });
        // Attempt commit with inline recovery
        let commitResult;
        try {
            commitResult = await gl.commit(branch, commitMsg, actions, cfg.git.authorName, cfg.git.authorEmail);
        }
        catch (commitErr) {
            const errStr = commitErr instanceof Error ? commitErr.message : String(commitErr);
            if (/already exists/i.test(errStr) && actions.some((a) => a.action === 'create')) {
                (0, logger_1.logWarn)('Some files already exist on branch -- switching create -> update and retrying');
                for (const a of actions) {
                    if (a.action === 'create')
                        a.action = 'update';
                }
                commitResult = await gl.commit(branch, commitMsg, actions, cfg.git.authorName, cfg.git.authorEmail);
            }
            else if (/only create or edit files when you are on a branch/i.test(errStr)) {
                (0, logger_1.logWarn)('Branch appears corrupt -- deleting and recreating...');
                try {
                    await gl.deleteBranch(branch);
                }
                catch { /* best effort */ }
                const sourceBranch = data.parentBranch || cfg.branch.ts;
                await gl.createBranch(branch, sourceBranch);
                (0, logger_1.logOk)(`Branch recreated: ${branch}`);
                commitResult = await gl.commit(branch, commitMsg, actions, cfg.git.authorName, cfg.git.authorEmail);
            }
            else {
                throw commitErr;
            }
        }
        data.code_committed = true;
        data._last_commit_sha = commitResult.id || null;
        save(state);
        (0, logger_1.logOk)(`Committed ${commitResult.id ? commitResult.id.substring(0, 8) + ' ' : ''}as ${cfg.git.authorName}`);
    }
    // GQ4: Merge conflict detection
    if (!data._conflict_check_done) {
        try {
            const diffResp = await req(gl.u(`/repository/compare?from=${encodeURIComponent(cfg.branch.qa)}&to=${encodeURIComponent(branch)}`), { headers: gl.h() });
            if (diffResp.status === 200 && diffResp.data) {
                const diffs = diffResp.data.diffs || [];
                const conflicts = diffs.filter((d) => !d.new_file && !d.deleted_file && !d.renamed_file);
                if (conflicts.length > 0) {
                    (0, logger_1.logWarn)(`GQ4: ${conflicts.length} file(s) modified in both branches -- potential merge conflicts`);
                    (0, utils_1.addWarning)(state, 'generate_code', `${conflicts.length} potential merge conflicts detected`);
                }
                else {
                    (0, logger_1.logOk)('GQ4: No merge conflicts detected');
                }
            }
        }
        catch (conflictErr) {
            const msg = conflictErr instanceof Error ? conflictErr.message : String(conflictErr);
            (0, logger_1.logDebug)(`GQ4: Conflict detection failed: ${msg} -- proceeding anyway`);
        }
        data._conflict_check_done = true;
        save(state);
    }
    // T2.19: Divergence check
    if (data.code_committed && !data._divergence_checked) {
        try {
            const branchResp = await req(gl.u(`/repository/branches/${encodeURIComponent(branch)}`), { headers: gl.h() });
            if (branchResp.status === 200 && branchResp.data && branchResp.data.commit) {
                const commitObj = branchResp.data.commit;
                const remoteSha = commitObj.id;
                const localSha = data._last_commit_sha;
                if (localSha && localSha !== remoteSha) {
                    (0, logger_1.logErr)(`GQ8: Remote branch has diverged! Local SHA: ${localSha.substring(0, 8)}, Remote SHA: ${remoteSha.substring(0, 8)}`);
                    (0, utils_1.addWarning)(state, 'generate_code', `Branch diverged: local ${localSha.substring(0, 8)} vs remote ${remoteSha.substring(0, 8)}`);
                    throw new Error(`Branch ${branch} has diverged -- manual resolution required.`);
                }
                (0, logger_1.logOk)('GQ8: Remote branch verified -- no divergence');
            }
        }
        catch (divErr) {
            const msg = divErr instanceof Error ? divErr.message : String(divErr);
            if (msg.includes('diverged'))
                throw divErr;
            (0, logger_1.logDebug)(`GQ8: Divergence check failed: ${msg}`);
        }
        data._divergence_checked = true;
        save(state);
    }
    // Create MR
    if (!data.code_mr_iid) {
        (0, logger_1.logInfo)(`Creating MR: ${branch} -> ${cfg.branch.qa} (assigned to you)...`);
        const safeSummary = (0, utils_1.sanitizeMRText)(changes.summary || '');
        const safeTestNotes = (0, utils_1.sanitizeMRText)(changes.test_notes || '');
        // Q7: Enhanced MR description with quality report
        const tscStatus = data._build_tsc || 'N/A';
        const eslintStatus = data._build_eslint || 'N/A';
        const acVerification = data._ac_verification
            ? (data._ac_known_gaps ? 'Partial -- see known gaps below' : 'All criteria met')
            : (ticket?.ac_missing ? 'N/A (no AC)' : 'Not verified');
        let qualitySection = `### Quality Report\n`;
        qualitySection += `- TypeScript: ${tscStatus === 'PASS' ? 'No errors' : tscStatus}\n`;
        qualitySection += `- ESLint: ${eslintStatus === 'PASS' ? 'No errors' : eslintStatus}\n`;
        qualitySection += `- Code Review: ${data._reviewed ? 'Completed' : 'Pending'}\n`;
        qualitySection += `- Security: ${data._fixed ? 'Fixed' : (data._reviewed ? 'Passed' : 'Pending')}\n`;
        qualitySection += `- AC Verification: ${acVerification}\n`;
        // Browser verify section
        let browserVerifySection = '';
        if (cfg.flags?.browserVerify && data._browser_verified && deps.buildBrowserVerifyMRSection) {
            browserVerifySection = deps.buildBrowserVerifyMRSection(state);
        }
        // Per-file change rationale
        let fileSection = `### Changes\n`;
        const plan = data.explore_plan || '';
        for (const c of changes.changes) {
            const fileName = c.file_path.split('/').pop() || '';
            const planLines = plan.split('\n');
            const rationale = planLines.find((l) => l.includes(fileName) || l.includes(c.file_path));
            fileSection += `- ${c.action}: \`${c.file_path}\`${rationale ? ` -- ${rationale.replace(/^[-*\s]+/, '').substring(0, 100)}` : ''}\n`;
        }
        // Known gaps
        let gapSection = '';
        if (data._ac_known_gaps) {
            gapSection = `\n### Known Gaps\n${data._ac_known_gaps}\n`;
        }
        const mrDescription = deps.redactSecrets(`## ${TICKET} -- ${ticket?.summary || ''}\n\n` +
            `${safeSummary}\n\n` +
            `${qualitySection}\n` +
            `${browserVerifySection ? browserVerifySection + '\n' : ''}` +
            `${fileSection}\n` +
            `### Test Notes\n${safeTestNotes}\n` +
            `${gapSection}\n` +
            `---\nAI Dev Agent | Branch: \`${data.code_source_branch || cfg.branch.ts}\` -> \`${branch}\``);
        deps.validateMRTarget(cfg.branch.qa);
        const mr = await gl.createMR(branch, cfg.branch.qa, `feat(${TICKET}): ${(ticket?.summary || '').replace(/\n/g, ' ').replace(/[<>]/g, '').substring(0, 100)}`, mrDescription, true, cfg.git.assigneeId);
        data.code_mr_iid = mr.iid;
        data.code_mr_url = mr.web_url;
        save(state);
        (0, logger_1.logOk)(`MR !${mr.iid} created and assigned`);
    }
    // Slack notification only (no Jira comment)
    if (!data.code_slack_sent) {
        await slack(`*Code Review Required -- ${TICKET}*\n` +
            `Agent generated code for: *${ticket?.summary || ''}*\n` +
            `MR: ${data.code_mr_url}\n` +
            `Approve the MR on GitLab to proceed.`, [cfg.slack.ownerId]);
        data.code_slack_sent = true;
        save(state);
        (0, logger_1.logOk)('Slack notification sent (no Jira comment)');
    }
    state.stage = 'gate_code_review';
    save(state);
}
//# sourceMappingURL=push-code.js.map