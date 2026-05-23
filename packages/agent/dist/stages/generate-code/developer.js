"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASK_GROUP_FILES_HARD = exports.TASK_GROUP_FILES_WARN = void 0;
exports.runDeveloperAgent = runDeveloperAgent;
exports.parseTaskGroups = parseTaskGroups;
exports._validateDevChanges = _validateDevChanges;
exports._auditTaskGroupSizes = _auditTaskGroupSizes;
exports._canRetryParallelTeam = _canRetryParallelTeam;
const fs = require("fs");
const path = require("path");
const { cfg, TICKET, DEVELOPER_TIMEOUT_MS, DEVELOPER_MAX_TURNS, applyComplexityTimeout } = require("../../lib/config");
const { logInfo, logOk, logErr, logWarn, logDebug } = require("../../lib/logging");
const { sanitizeForPrompt, addWarning, validateClaudeNotEmpty } = require("../../lib/utils");
const { save } = require("../../lib/state");
const { runAgentsTeam, runSingleAgent } = require("../../lib/agents-team");
const { localResetRepo, localGetChanges, createSubWorktree, removeSubWorktree, removeAllSubWorktrees, mergeSubWorktrees } = require("../../lib/local-repo");
const { jira, jiraUrl } = require("../../lib/jira");
const { slack } = require("../../lib/slack");
const { buildDecisionsBlock } = require("./decisions-block");
// Parse tasks.md into independent task groups
function parseTaskGroups(tasksMarkdown) {
    if (!tasksMarkdown || typeof tasksMarkdown !== "string")
        return [];
    const lines = tasksMarkdown.split("\n");
    const groups = [];
    let currentGroup = null;
    for (const line of lines) {
        const headingMatch = line.match(/^##\s+(.+)/);
        if (headingMatch) {
            if (currentGroup)
                groups.push(currentGroup);
            currentGroup = { title: headingMatch[1].trim(), content: "", files: [] };
        }
        if (currentGroup) {
            currentGroup.content += line + "\n";
        }
    }
    if (currentGroup)
        groups.push(currentGroup);
    if (groups.length === 0)
        return [];
    // Extract file paths from each group.
    // M2: Broadened to cover common monorepo roots (packages, features,
    // domain, routes, server, frontend, backend, shared, tests, tools).
    // Previously paths like `packages/agent/src/...` weren't detected, so the
    // union-find collision merge below silently failed to spot two groups
    // touching the same file — producing parallel agents that raced on
    // overlapping files.
    const FILE_PATH_RE = /(?:src|lib|app|apps|pages|components|hooks|utils|services|constants|types|styles|modules|packages|features|domain|routes|server|frontend|backend|shared|tests|tools)\/[\w\-./@]+\.\w+/g;
    for (const g of groups) {
        const matches = g.content.match(FILE_PATH_RE) || [];
        g.files = [...new Set(matches)];
    }
    // Union-Find to merge groups that share files
    const parent = groups.map((_, i) => i);
    function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
    function union(a, b) { parent[find(a)] = find(b); }
    // Build file → group index map
    const fileToGroups = {};
    for (let i = 0; i < groups.length; i++) {
        for (const f of groups[i].files) {
            if (fileToGroups[f] !== undefined) {
                union(fileToGroups[f], i);
            }
            else {
                fileToGroups[f] = i;
            }
        }
    }
    // Merge into disjoint sets
    const merged = {};
    for (let i = 0; i < groups.length; i++) {
        const root = find(i);
        if (!merged[root]) {
            merged[root] = { title: groups[root].title, content: "", files: new Set() };
        }
        if (root !== i) {
            merged[root].title += " + " + groups[i].title;
        }
        merged[root].content += groups[i].content;
        for (const f of groups[i].files)
            merged[root].files.add(f);
    }
    return Object.values(merged).map((g) => ({
        title: g.title,
        content: g.content.trim(),
        files: [...g.files],
    }));
}
// Fix C: Runtime check for oversized task groups. The architect prompt
// (explore-plan.ts) asks for ≤ 5 files per group, but the model can
// still produce kitchen-sink groups that hit the Dev Agent's max-turns
// cap (the AUT-8648 75-turn failures). This helper enforces it at the
// orchestrator level: groups touching too many files are reported as
// state warnings so the human reviewer / next architect pass can split
// them. We don't auto-split here (that would scramble the architect's
// intent) — we surface and proceed.
const TASK_GROUP_FILES_WARN = 6;
exports.TASK_GROUP_FILES_WARN = TASK_GROUP_FILES_WARN;
const TASK_GROUP_FILES_HARD = 10;
exports.TASK_GROUP_FILES_HARD = TASK_GROUP_FILES_HARD;
function _auditTaskGroupSizes(groups, state) {
    const violations = [];
    for (const g of groups) {
        const n = g.files.length;
        if (n >= TASK_GROUP_FILES_HARD) {
            violations.push({ title: g.title, fileCount: n, severity: 'hard' });
        }
        else if (n >= TASK_GROUP_FILES_WARN) {
            violations.push({ title: g.title, fileCount: n, severity: 'warn' });
        }
    }
    if (violations.length === 0)
        return;
    for (const v of violations) {
        const tag = v.severity === 'hard' ? 'OVERSIZED (hard)' : 'oversized (warn)';
        const msg = `Task group ${tag}: "${v.title.substring(0, 80)}" — references ${v.fileCount} files (target ≤ ${TASK_GROUP_FILES_WARN}). Likely to hit Dev Agent max-turns.`;
        logWarn(`Fix C: ${msg}`);
        addWarning(state, "generate_code", msg);
    }
    // A single hard-oversized group means the plan is structurally wrong —
    // surface prominently but don't halt (the Dev Agent might still
    // succeed; Fix B will scale max-turns on retry). The warning lets the
    // operator know to re-architect after the run if it fails.
}
// Fix E: Decision logic for "should we retry the parallel team before
// falling to single agent?" Pure function — exported for unit tests.
//
// Triggers retry when:
//   - At least 1 agent succeeded (we have partial work worth keeping)
//   - At least 1 agent failed (otherwise we wouldn't be in the catch block)
//   - We haven't already attempted the retry this stage entry
//
// Skips retry when:
//   - all-failed: structural plan failure; single agent fallback is more
//     likely to help (different agent shape / longer turn budget on union)
//   - all-succeeded: should never happen in a catch block, defensive
//   - already-attempted: bounded to one extra parallel attempt per stage
//     entry to avoid amplification when stacked with executeWithRecovery
function _canRetryParallelTeam(taskGroups, state) {
    const succeededCount = taskGroups.filter((_, i) => Boolean(state.data[`_dev_group_${i}`])).length;
    const failedCount = taskGroups.length - succeededCount;
    if (succeededCount === 0)
        return { canRetry: false, succeededCount, failedCount, reason: 'all-failed' };
    if (failedCount === 0)
        return { canRetry: false, succeededCount, failedCount, reason: 'all-succeeded' };
    if (state.data._team_retry_attempted)
        return { canRetry: false, succeededCount, failedCount, reason: 'already-attempted' };
    return { canRetry: true, succeededCount, failedCount };
}
// Architect-generated task groups that are ops/CI work, not developer work.
// The Developer Agent only has Read/Write/Edit/Grep/Glob tools — it can't
// run `npm test`, `tsc`, or eslint. When the architect produces a group like
// "Lint / Type / Test" or "Polish & Release", spawning a Dev Agent on it
// guarantees a self-aware refusal, which cascades into a parallel-team
// failure and wipes the work other agents did. Downstream stages handle
// these concerns properly:
//   - build-check.ts runs tsc + eslint + Build Fixer
//   - runtime-tests.ts runs Vite build + unit tests
//   - push-code + GitLab CI handle release prep
//
// AUT-8648 (2026-05-22) exposed this: Agent 4's "Lint / Type / Test" refusal
// cascaded into a repo reset, throwing away Agents 1/2/3's successful work.
const OPS_KEYWORDS = new Set([
    // Static-analysis ops
    'lint', 'eslint',
    'type', 'typecheck', 'type-check', 'tsc', 'typescript',
    // Test ops (the Developer Agent has no test runner)
    'test', 'tests', 'testing', 'coverage', 'unit', 'e2e', 'integration',
    // Manual / browser QA — handled by stages downstream (test_qa)
    'qa', 'manual', 'browser', 'verify', 'verification', 'acceptance', 'criteria',
    // Release ops
    'polish', 'release', 'deploy', 'deployment',
    'ci', 'cd', 'build', 'pipeline',
]);
function isOpsTaskGroup(title, content) {
    // Strip a leading numeric prefix like "8. " or "12) "
    const body = title.replace(/^\s*\d+[.)]\s*/, "").trim();
    if (!body)
        return false;
    // Split on whitespace and common separators (/, &, +, ,, -)
    const keywords = body.toLowerCase()
        .split(/[\s/&,+\-]+/)
        .map((w) => w.trim())
        .filter((w) => w && w !== 'and' && w !== 'or' && w !== 'the');
    if (keywords.length === 0)
        return false;
    // Filter only when EVERY keyword is ops/CI. "Add tests for X" survives
    // because "add" and "for" and "x" aren't in OPS_KEYWORDS. "Lint / Type /
    // Test" is filtered because all three keywords match.
    if (!keywords.every((k) => OPS_KEYWORDS.has(k)))
        return false;
    // L8: If the group content references concrete files, the architect
    // probably has real dev work attached to it (e.g. "Test setup: write
    // src/foo.test.ts"). Treat as non-ops to preserve the work.
    if (content && /(src|lib|app|apps|pages|components|hooks|utils|services|packages|features)\/[\w\-./]+\.\w+/.test(content)) {
        return false;
    }
    return true;
}
// Bundle consecutive task groups together when the architect produces more
// groups than the parallel cap. Keeps task ordering intact (foundational
// groups stay with the dependents that follow them) so each super-group
// remains coherent. Returns the input unchanged if it's already at or under
// `maxGroups`.
function bundleTaskGroups(groups, maxGroups) {
    if (groups.length <= maxGroups)
        return groups;
    const binSize = Math.ceil(groups.length / maxGroups);
    const bundled = [];
    for (let i = 0; i < groups.length; i += binSize) {
        const chunk = groups.slice(i, i + binSize);
        bundled.push({
            title: chunk.map((g) => g.title).join(" + "),
            content: chunk.map((g) => g.content).join("\n\n"),
            files: [...new Set(chunk.flatMap((g) => g.files))],
        });
    }
    return bundled;
}
/**
 * Run Developer Agent — writes code directly to local repo.
 */
async function runDeveloperAgent(ctx) {
    const { state, approvedPlan, devFullContext, extraDocs, extraFeedback, feedback } = ctx;
    const { summary, description, ac, issueType: iType, priority: iPriority } = state.data.ticket;
    // L1: Clear the stale _dev_failed marker from any prior run. Without
    // this, a flag set when developer.ts:396 hit the hard-fail path stays
    // true forever — confusing UI status displays and any "is the dev
    // healthy?" probes after a successful re-run.
    if (state.data._dev_failed) {
        delete state.data._dev_failed;
    }
    // User-confirmed decisions from clarifying-questions loop — bindings for
    // every downstream prompt (parallel groups, single, retry).
    const decisionsBlock = buildDecisionsBlock(state.data._qa_answers);
    // Step 1 — Reset local repo to clean enterprise-ts state
    localResetRepo(cfg.localRepo);
    // Step 2 — Try parallel developer agents via task group splitting
    const PARALLEL_MAX_GROUPS = 5;
    const rawTaskGroups = parseTaskGroups(approvedPlan);
    // Fix C: Audit task-group sizes before dispatch. Architect prompt asks
    // for ≤ 5 files per group; this catches violations and surfaces them
    // as state warnings so the next architect pass or the human reviewer
    // can re-split. Doesn't halt — the Dev Agent (with Fix B's adaptive
    // max-turns) might still succeed; we just signal the structural risk.
    _auditTaskGroupSizes(rawTaskGroups, state);
    // Filter out ops/CI task groups before bundling — see isOpsTaskGroup.
    const devTaskGroups = rawTaskGroups.filter((g) => !isOpsTaskGroup(g.title, g.content));
    const filteredCount = rawTaskGroups.length - devTaskGroups.length;
    if (filteredCount > 0) {
        const filteredTitles = rawTaskGroups
            .filter((g) => isOpsTaskGroup(g.title, g.content))
            .map((g) => g.title);
        logInfo(`Filtered ${filteredCount} ops/CI task group(s) — handled by downstream stages: ${filteredTitles.join("; ")}`);
    }
    const taskGroups = bundleTaskGroups(devTaskGroups, PARALLEL_MAX_GROUPS);
    if (taskGroups.length !== devTaskGroups.length) {
        logInfo(`Bundled ${devTaskGroups.length} dev task groups into ${taskGroups.length} super-groups (cap ${PARALLEL_MAX_GROUPS})`);
    }
    const canParallelize = taskGroups.length >= 2 && taskGroups.length <= PARALLEL_MAX_GROUPS;
    if (canParallelize) {
        logInfo(`Agents Team — ${taskGroups.length} parallel Developer Agents (task-group split)`);
        for (let i = 0; i < taskGroups.length; i++) {
            logInfo(`  Group ${i}: "${taskGroups[i].title}" — ${taskGroups[i].files.length} file(s)`);
        }
        // M1: Per-agent sub-worktree isolation. Each Dev Agent gets its own
        // git worktree at .worktrees/<TICKET>.dev-<idx>/, so two agents can
        // never overwrite each other on the filesystem. After the team
        // completes, mergeSubWorktrees() applies each agent's changes back
        // into the canonical ticket worktree (this is cfg.localRepo).
        //
        // Falls back gracefully: if sub-worktree creation fails for any
        // reason (disk, git error, missing parent worktree), we skip M1
        // and use the existing shared-worktree mode. The prompt-level
        // FORBIDDEN list + parseTaskGroups union-find merge remain as
        // the fallback safety nets.
        const subWorktreePaths = new Array(taskGroups.length).fill(null);
        let useSubWorktrees = true;
        for (let i = 0; i < taskGroups.length; i++) {
            try {
                subWorktreePaths[i] = createSubWorktree(TICKET, i);
            }
            catch (e) {
                logWarn(`M1: createSubWorktree for agent ${i} failed: ${e.message.substring(0, 200)} — falling back to shared-worktree mode for entire team`);
                useSubWorktrees = false;
                break;
            }
        }
        if (!useSubWorktrees) {
            // Roll back any sub-worktrees we managed to create.
            for (let i = 0; i < subWorktreePaths.length; i++) {
                if (subWorktreePaths[i]) {
                    try {
                        removeSubWorktree(TICKET, i);
                    }
                    catch { }
                    subWorktreePaths[i] = null;
                }
            }
        }
        // Build FORBIDDEN file lists — each group can only touch its own files
        const groupAgents = taskGroups.map((group, idx) => {
            const otherFiles = taskGroups
                .filter((_, i) => i !== idx)
                .flatMap((g) => g.files);
            const forbiddenList = otherFiles.length > 0
                ? `\n## FORBIDDEN FILES (owned by other agents — do NOT modify)\n${otherFiles.map((f) => `- ${f}`).join("\n")}\n`
                : "";
            const groupPrompt = `You are **Developer Agent ${idx + 1}** at MasterIndia. Write production-ready code for your assigned task group ONLY.\n\n` +
                `## REPOSITORY ACCESS\n` +
                `You have DIRECT ACCESS to this repository. Use Read, Grep, Glob to explore, and Write/Edit to modify files.\n` +
                `DO NOT output JSON. Write changes DIRECTLY to the files on disk.\n\n` +
                `## MANDATORY RULES\n` +
                `1. **REUSE existing code**: Use the EXACT same components, hooks, utils, services, API calls, styles, constants.\n` +
                `2. **Match existing patterns EXACTLY**: Same import style, state management, error handling, naming, folder structure.\n` +
                `3. **Prefer modifying existing files** over creating new ones.\n` +
                `4. **Import from existing paths**: Same import aliases, relative paths, barrel exports.\n` +
                `5. **Copy structure from similar features**: If there's an existing edit form, table, modal — copy it.\n` +
                `6. **No unnecessary abstractions**: Don't create helpers/utils the repo doesn't already have.\n` +
                `7. **VITE_PRODUCT_ID checks**: Must use the exact enterprise product ID — no generic multi-product conditionals.\n` +
                `8. **Enterprise app ONLY**: Do NOT modify or reference other product lines (SME, GST, TaxPro, etc.).\n` +
                `9. **NEVER delete existing functions, components, or endpoints** — only add or modify.\n\n` +
                `## FORBIDDEN (F3 — File Path Restrictions)\n` +
                `FORBIDDEN: You must NEVER modify files in .git/, node_modules/, or package.json scripts.\n` +
                `FORBIDDEN: You must NEVER create shell scripts (.sh, .bash) or modify CI/CD files (.gitlab-ci.yml).\n` +
                `${forbiddenList}\n` +
                `## YOUR ASSIGNED TASK GROUP\n${group.content}\n\n` +
                `## Full Plan Context (read-only — for understanding dependencies)\n${approvedPlan}\n\n` +
                `## Jira ticket: ${TICKET} [${iType || "Task"} / ${iPriority || "Medium"}]\nTitle: ${summary}\nDescription:\n${sanitizeForPrompt(description)}\nAC: ${sanitizeForPrompt(ac)}\n` +
                `${extraDocs}${extraFeedback}${devFullContext}` +
                `${feedback ? `\n## Previous code review feedback (address this):\n${feedback}\n` : ""}` +
                `${decisionsBlock}` +
                `\n## Instructions\n` +
                `1. Read the files mentioned in YOUR task group to understand existing code\n` +
                `2. Implement ONLY the changes in your assigned task group\n` +
                `3. After all changes, provide a brief summary of what you modified/created`;
            // M1: route each agent at its dedicated sub-worktree when available;
            // otherwise the shared ticket worktree (existing behavior).
            const agentCwd = subWorktreePaths[idx] || cfg.localRepo;
            return {
                name: `Dev Agent ${idx + 1}: ${group.title.substring(0, 50)}`,
                prompt: groupPrompt,
                timeout: applyComplexityTimeout(600_000, state), // 10 min per group
                opts: { cwd: agentCwd, maxTurns: DEVELOPER_MAX_TURNS, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
                required: true,
                checkpointKey: `_dev_group_${idx}`,
            };
        });
        try {
            const mergedSummary = await runAgentsTeam({
                teamName: "Developer Team",
                agents: groupAgents,
                state,
                merge: (results) => {
                    return results
                        .filter((r) => r.output)
                        .map((r) => `## ${r.name}\n${r.output}`)
                        .join("\n\n");
                },
            });
            // M1: Merge per-agent sub-worktrees back into the canonical ticket
            // worktree before downstream validation reads cfg.localRepo's state.
            if (useSubWorktrees) {
                const indices = taskGroups.map((_, i) => i);
                const result = mergeSubWorktrees(TICKET, indices, cfg.localRepo);
                logOk(`M1: merged ${result.applied} file(s) from ${indices.length} sub-worktrees into canonical`);
                if (result.conflicts.length > 0) {
                    for (const c of result.conflicts) {
                        const msg = `M1: ${c.file} modified by multiple agents (${c.agents.join(", ")}) — first-wins applied`;
                        logWarn(msg);
                        addWarning(state, "generate_code", msg);
                    }
                }
                if (result.skippedForbidden.length > 0) {
                    logWarn(`M1: skipped ${result.skippedForbidden.length} forbidden file(s) during merge: ${result.skippedForbidden.slice(0, 5).join(", ")}`);
                }
                try {
                    removeAllSubWorktrees(TICKET);
                }
                catch (e) {
                    logWarn(`M1: sub-worktree cleanup failed: ${e.message.substring(0, 120)}`);
                }
            }
            // Post-merge: check for conflicts via git diff
            const { execSync } = require("child_process");
            try {
                const diffStat = execSync("git diff --stat", { cwd: cfg.localRepo, timeout: 10_000, stdio: "pipe" }).toString();
                logInfo(`Post-merge diff stat:\n${diffStat.substring(0, 500)}`);
            }
            catch { }
            // Validate and checkpoint
            validateClaudeNotEmpty(mergedSummary, "Developer Team");
            logOk("Developer Team (parallel) complete");
            // GQ7 + F3: Validate changes
            _validateDevChanges(state);
            // T2.10: Verify file changes actually exist before marking complete
            const parallelChanges = localGetChanges(cfg.localRepo);
            if (!parallelChanges || parallelChanges.length === 0) {
                throw new Error("Developer Team produced no file changes — retry required");
            }
            state.data._dev_complete = true;
            state.data._dev_summary = mergedSummary.substring(0, 2000);
            save(state);
            return;
        }
        catch (teamErr) {
            logWarn(`Parallel developer agents failed: ${teamErr.message.substring(0, 300)}`);
            // Fix E: Selective parallel-team retry. Before falling to the
            // single-agent path (which consolidates ALL work into one Claude
            // session and is what caused the 75-turn failures in AUT-8648),
            // retry the parallel team ONCE. Succeeded agents skip via
            // runAgentsTeam Phase 1 (their checkpoints survive); failed agents
            // are re-attempted, and Fix B's adaptive max-turns scales their
            // budget. Bounded to ONE retry per stage entry to avoid
            // amplification when stacked with executeWithRecovery.
            const retryDecision = _canRetryParallelTeam(taskGroups, state);
            const succeededGroupCount = retryDecision.succeededCount;
            const failedGroupCount = retryDecision.failedCount;
            if (retryDecision.canRetry) {
                logInfo(`Fix E: Retrying parallel team — ${succeededGroupCount}/${taskGroups.length} succeeded, ` +
                    `${failedGroupCount} failed group(s) to re-run with Fix B's adaptive max-turns. ` +
                    `Skipping single-agent fallback unless this retry also fails.`);
                state.data._team_retry_attempted = true;
                save(state);
                try {
                    const retryMerged = await runAgentsTeam({
                        teamName: "Developer Team (retry — failed groups only)",
                        // Same agents array. Phase 1 of runAgentsTeam skips agents
                        // whose checkpoint key is already populated; only failed
                        // ones actually re-launch. Fix B applies adaptive max-turns
                        // based on prior _max_turns_failures counts.
                        agents: groupAgents,
                        state,
                        merge: (results) => {
                            return results
                                .filter((r) => r.output)
                                .map((r) => `## ${r.name}\n${r.output}`)
                                .join("\n\n");
                        },
                    });
                    // M1: Same merge step as the first-success path. The retry
                    // may have re-used some sub-worktrees from the first attempt
                    // (succeeded agents skip via Phase 1 checkpoint reuse, so
                    // their sub-worktrees still hold their changes from the
                    // first attempt) and produced new content in others.
                    if (useSubWorktrees) {
                        const indices = taskGroups.map((_, i) => i);
                        const result = mergeSubWorktrees(TICKET, indices, cfg.localRepo);
                        logOk(`M1: merged ${result.applied} file(s) from ${indices.length} sub-worktrees into canonical (after Fix E retry)`);
                        if (result.conflicts.length > 0) {
                            for (const c of result.conflicts) {
                                const msg = `M1: ${c.file} modified by multiple agents (${c.agents.join(", ")}) — first-wins applied`;
                                logWarn(msg);
                                addWarning(state, "generate_code", msg);
                            }
                        }
                        try {
                            removeAllSubWorktrees(TICKET);
                        }
                        catch (e) {
                            logWarn(`M1: sub-worktree cleanup failed: ${e.message.substring(0, 120)}`);
                        }
                    }
                    validateClaudeNotEmpty(retryMerged, "Developer Team (retry)");
                    logOk("Developer Team (retry) complete — all groups succeeded");
                    _validateDevChanges(state);
                    const retryChanges = localGetChanges(cfg.localRepo);
                    if (!retryChanges || retryChanges.length === 0) {
                        throw new Error("Developer Team (retry) produced no file changes");
                    }
                    state.data._dev_complete = true;
                    state.data._dev_summary = retryMerged.substring(0, 2000);
                    delete state.data._team_retry_attempted;
                    save(state);
                    return;
                }
                catch (retryErr) {
                    logWarn(`Fix E retry failed: ${retryErr.message.substring(0, 200)} — ` +
                        `falling through to single Developer Agent`);
                    // Fall through (intentionally don't return) into the existing
                    // single-agent fallback path below.
                }
            }
            else if (retryDecision.reason === 'all-failed') {
                logInfo("Fix E: All parallel groups failed — skipping selective retry " +
                    "(structural failure, retry would hit the same wall). Going to single Developer Agent.");
            }
            else if (retryDecision.reason === 'already-attempted') {
                logInfo("Fix E: Parallel-team retry already attempted this stage entry — " +
                    "going straight to single Developer Agent.");
            }
            logInfo("Falling back to single Developer Agent…");
            // M1: Before falling to single agent, merge any sub-worktrees from
            // agents that succeeded into the canonical worktree. This is the
            // same "preserve partial work" intent as the existing
            // `localGetChanges` check below — without it, the single agent
            // would start from a clean worktree and have to redo everything
            // the parallel team's succeeded agents already did.
            if (useSubWorktrees) {
                const succeededIndices = taskGroups
                    .map((_, i) => i)
                    .filter((i) => Boolean(state.data[`_dev_group_${i}`]));
                if (succeededIndices.length > 0) {
                    const result = mergeSubWorktrees(TICKET, succeededIndices, cfg.localRepo);
                    logInfo(`M1: merged ${result.applied} file(s) from ${succeededIndices.length} succeeded sub-worktrees before single-agent fallback`);
                    if (result.conflicts.length > 0) {
                        for (const c of result.conflicts) {
                            addWarning(state, "generate_code", `M1: ${c.file} modified by multiple agents (${c.agents.join(", ")}) — first-wins applied`);
                        }
                    }
                }
                try {
                    removeAllSubWorktrees(TICKET);
                }
                catch (e) {
                    logWarn(`M1: sub-worktree cleanup failed: ${e.message.substring(0, 120)}`);
                }
            }
            // Preserve partial work from agents that succeeded — only reset when
            // there's nothing useful to keep. This avoids wiping 3 agents' work
            // because of 1 refusal/failure (AUT-8648 retry 2 lesson). The single
            // agent then continues on top of the partial state instead of redoing
            // everything from scratch within its turn budget.
            const existingChanges = localGetChanges(cfg.localRepo);
            if (existingChanges.length > 0) {
                logInfo(`Preserving ${existingChanges.length} file change(s) from ${succeededGroupCount}/${taskGroups.length} ` +
                    `agent(s) that completed — single-agent fallback will continue from this partial state`);
            }
            else {
                logInfo("Parallel team produced no file changes — resetting repo for single Developer Agent fallback");
                localResetRepo(cfg.localRepo);
            }
            // Clear group checkpoints either way — the fallback path doesn't honor
            // them, and they shouldn't make a future re-entry skip groups.
            for (let i = 0; i < taskGroups.length; i++) {
                state.data[`_dev_group_${i}`] = null;
            }
            // Fall through to single-agent mode below
        }
    }
    // Single Developer Agent (original path, or fallback)
    logInfo("Agents Team — Developer Agent: writing code directly…");
    logInfo(`  cwd: ${cfg.localRepo} | maxTurns: ${DEVELOPER_MAX_TURNS} | timeout: ${DEVELOPER_TIMEOUT_MS / 1000}s`);
    const devResult = await runSingleAgent({
        name: "Developer Agent",
        prompt: `You are the **Developer Agent** at MasterIndia. Write production-ready code.\n\n` +
            `## REPOSITORY ACCESS\n` +
            `You have DIRECT ACCESS to this repository. Use Read, Grep, Glob to explore, and Write/Edit to modify files.\n` +
            `DO NOT output JSON. Write changes DIRECTLY to the files on disk.\n\n` +
            `## MANDATORY RULES\n` +
            `1. **REUSE existing code**: Use the EXACT same components, hooks, utils, services, API calls, styles, constants.\n` +
            `2. **Match existing patterns EXACTLY**: Same import style, state management, error handling, naming, folder structure.\n` +
            `3. **Prefer modifying existing files** over creating new ones.\n` +
            `4. **Import from existing paths**: Same import aliases, relative paths, barrel exports.\n` +
            `5. **Copy structure from similar features**: If there's an existing edit form, table, modal — copy it.\n` +
            `6. **No unnecessary abstractions**: Don't create helpers/utils the repo doesn't already have.\n` +
            `7. **VITE_PRODUCT_ID checks**: Must use the exact enterprise product ID — no generic multi-product conditionals like \`=== '1' || === '2'\`.\n` +
            `8. **Enterprise app ONLY**: Do NOT modify or reference other product lines (SME, GST, TaxPro, etc.) — stay within enterprise scope.\n` +
            `9. **NEVER delete existing functions, components, or endpoints** — only add or modify.\n\n` +
            `## FORBIDDEN (F3 — File Path Restrictions)\n` +
            `You may ONLY modify files within the project directory.\n` +
            `FORBIDDEN: You must NEVER modify files in .git/, node_modules/, or package.json scripts.\n` +
            `FORBIDDEN: You must NEVER create shell scripts (.sh, .bash) or modify CI/CD files (.gitlab-ci.yml).\n\n` +
            `## Pre-approved implementation plan\n${approvedPlan}\n\n` +
            `## Jira ticket: ${TICKET} [${iType || "Task"} / ${iPriority || "Medium"}]\nTitle: ${summary}\nDescription:\n${sanitizeForPrompt(description)}\nAC: ${sanitizeForPrompt(ac)}\n` +
            `${extraDocs}${extraFeedback}${devFullContext}` +
            `${feedback ? `\n## Previous code review feedback (address this):\n${feedback}\n` : ""}` +
            `${state.data.previousAttemptSummary ? `\n## Previous attempt file changes (for reference):\n${state.data.previousAttemptSummary}\n` : ""}` +
            `${state.data.parentBranch ? `\n## Q4: Parent Branch Context\nThis ticket branches from parent feature branch: ${state.data.parentBranch}. Ensure your changes are compatible with parent branch changes.\n` : ""}` +
            `${decisionsBlock}` +
            `\n## Instructions\n` +
            `1. Read the files mentioned in the plan to understand existing code\n` +
            `2. Pay special attention to API specs, field names, and payloads from Jira comments — use EXACT names\n` +
            `3. Implement ALL changes from the plan by writing/editing files directly\n` +
            `4. After all changes, provide a brief summary:\n` +
            `   - What files you modified/created\n` +
            `   - What existing code you reused\n` +
            `   - What to test manually`,
        timeout: applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
        opts: { cwd: cfg.localRepo, maxTurns: DEVELOPER_MAX_TURNS, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
        state,
        checkpointKey: "_dev_single_result",
        required: true,
    });
    logOk("Developer Agent complete");
    // GQ7 + F3: Validate changes
    _validateDevChanges(state);
    // D10: Developer checkpoint
    state.data._dev_complete = true;
    state.data._dev_summary = devResult.substring(0, 2000);
    save(state);
    // Step 3 — Extract changes from git status
    logInfo("Extracting file changes from local repo…");
    let devFileChanges = localGetChanges(cfg.localRepo);
    if (devFileChanges.length === 0) {
        logWarn("Developer Agent made no file changes — retrying with simplified prompt…");
        logInfo(`Developer output (first 300 chars): ${devResult.substring(0, 300)}`);
        // Retry once: reset and try again with explicit instructions
        localResetRepo(cfg.localRepo);
        const retryResult = await runSingleAgent({
            name: "Developer Agent (Retry)",
            prompt: `You are a Developer. You MUST write code files to implement this plan.\n\n` +
                `## IMPORTANT\n` +
                `- Use the Write tool to create/overwrite files\n` +
                `- Use the Edit tool to modify existing files\n` +
                `- You MUST make changes to files on disk — do NOT just describe changes\n\n` +
                `## Plan\n${approvedPlan}\n\n` +
                `## Ticket: ${TICKET} [${iType || "Task"}]: ${summary}\n${sanitizeForPrompt(description)}\nAC: ${sanitizeForPrompt(ac)}\n` +
                `${devFullContext}` +
                `${feedback ? `Feedback: ${feedback}\n` : ""}` +
                `${decisionsBlock}` +
                `\n**IMPORTANT**: Enterprise app ONLY — use exact enterprise VITE_PRODUCT_ID, no generic multi-product checks.\n` +
                `\nRead the relevant files, then implement ALL changes from the plan.`,
            timeout: applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
            opts: { cwd: cfg.localRepo, maxTurns: DEVELOPER_MAX_TURNS, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
            state,
            checkpointKey: "_dev_retry_result",
            required: true,
        });
        devFileChanges = localGetChanges(cfg.localRepo);
        if (devFileChanges.length === 0) {
            logErr("Developer Agent still made no file changes after retry.");
            logErr("This usually means Claude couldn't use Write/Edit tools (check permissions).");
            logInfo(`Retry output (first 500 chars): ${retryResult.substring(0, 500)}`);
            state.data._dev_failed = true;
            save(state);
            await slack(`\ud83d\uded1 *Code Gen Failed — ${TICKET}*\nDeveloper Agent produced 0 file changes after retry.\nThis usually means Claude couldn't use Write/Edit tools.\n\ud83d\udccb ${jiraUrl(TICKET)}`, [cfg.slack.ownerId]);
            await jira.addComment(TICKET, `Code Generation Failed\n\nDeveloper Agent produced 0 file changes after retry. This usually means Claude couldn't use Write/Edit tools. Manual intervention required.`);
            throw new Error("Developer Agent produced 0 file changes after retry — manual intervention required");
        }
        logOk(`Retry successful: ${devFileChanges.length} file(s) changed`);
        // H3: The earlier _validateDevChanges call (line ~353) validated an
        // empty changeset from the first attempt. The retry produced real
        // changes — validate them now so GQ7/F3 aren't bypassed by the retry.
        _validateDevChanges(state);
    }
    logOk(`${devFileChanges.length} file(s) changed`);
}
/**
 * Shared validation for developer agent output (GQ7 + F3).
 */
function _validateDevChanges(state) {
    // GQ7: Import Resolution Validation
    //
    // Catches the AUT-8648 class of bug: Developer Agent writes
    // `import('./X')` or `export * from './X'` referencing a component the
    // Architect's plan named but never asked anyone to CREATE. Without this
    // guard the MR ships unbuildable code (broken React.lazy chunks, broken
    // barrel re-exports) and the human reviewer is the first to notice.
    //
    // Three patterns we must catch:
    //   1. Static import      :  import X from '../foo'   /  import '../foo'
    //   2. Static re-export   :  export * from '../foo'   /  export { x } from '../foo'
    //   3. Dynamic import     :  import('../foo')          (React.lazy / code-split)
    //
    // Path aliases (e.g. `@mi/foo`) are intentionally skipped — they resolve
    // via tsconfig paths and webpack/vite aliases that we don't replicate here.
    const unresolvedImports = [];
    try {
        const devChangedForImports = localGetChanges(cfg.localRepo);
        const STATIC_RE = /(?:^|[^.\w])(?:import|export)(?:[^'"\n]*?from\s+|\s+)['"](\.\.?\/[^'"]+)['"]/gm;
        const DYNAMIC_RE = /(?:^|[^.\w])import\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
        const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
        for (const c of devChangedForImports) {
            if (c.action === "delete" || !c.content)
                continue;
            if (!/\.(tsx?|jsx?)$/.test(c.file_path))
                continue;
            const fileDir = path.dirname(c.file_path);
            // Dedupe by importPath within a file — re-export + lazy import of the
            // same path otherwise gets reported twice.
            const seenInFile = new Set();
            const collect = (re, kind) => {
                for (const m of c.content.matchAll(re)) {
                    const importPath = m[1];
                    if (!importPath || seenInFile.has(importPath))
                        continue;
                    seenInFile.add(importPath);
                    const resolved = path.normalize(path.join(fileDir, importPath));
                    const found = RESOLVE_EXTENSIONS.some((ext) => fs.existsSync(path.join(cfg.localRepo, resolved + ext)));
                    if (!found)
                        unresolvedImports.push({ file: c.file_path, import: importPath, resolved, kind });
                }
            };
            collect(STATIC_RE, "static");
            collect(DYNAMIC_RE, "dynamic");
        }
    }
    catch (importErr) {
        logDebug(`GQ7: Import resolution check failed: ${importErr.message}`);
    }
    if (unresolvedImports.length > 0) {
        logErr(`GQ7: ${unresolvedImports.length} unresolved relative import(s) — failing Developer Agent so it retries:`);
        for (const ui of unresolvedImports.slice(0, 10)) {
            logErr(`  ${ui.file}: ${ui.kind} import '${ui.import}' → ${ui.resolved} (not found)`);
        }
        // Track in state for downstream visibility (reviewer + Jira summary).
        addWarning(state, "generate_code", `${unresolvedImports.length} unresolved imports — see GQ7`);
        // Hard fail: throwing here bubbles up to runAgentsTeam / runSingleAgent
        // and triggers the stage's TRANSIENT retry path. We also stash the error
        // detail into state.data.feedback so the retried Developer Agent sees it
        // in the `## Previous code review feedback` slot (developer.ts:172/263)
        // and gets a real chance to fix the mistake.
        const sample = unresolvedImports.slice(0, 10)
            .map((ui) => `  - ${ui.file}: ${ui.kind} import '${ui.import}' (resolves to ${ui.resolved} — file does not exist)`)
            .join("\n");
        const errorMsg = `GQ7: ${unresolvedImports.length} unresolved relative import(s). The Developer Agent referenced ` +
            `paths that don't exist on disk:\n${sample}\n\n` +
            `Either CREATE the missing files (using the Write tool — every \`import('./X')\`, \`import X from './X'\`, ` +
            `and \`export * from './X'\` MUST resolve to a real file), or change the imports to existing paths. ` +
            `Check sibling directories with Glob before guessing. Re-running with the same plan will fail again unless ` +
            `the missing files are written this time.`;
        state.data.feedback = errorMsg;
        save(state);
        // L10: Reset the worktree on GQ7 failure for consistency with the F3
        // path below. Leaving broken imports on disk made debugger inspection
        // ambiguous and risked a stray `localGetChanges` picking them up.
        try {
            localResetRepo(cfg.localRepo);
        }
        catch (e) {
            logWarn(`L10: post-GQ7 reset failed: ${e.message.substring(0, 100)}`);
        }
        throw new Error(errorMsg);
    }
    // F3: Validate changed files against forbidden paths.
    // C4 extension: include secret files that localResetRepo deliberately
    // preserves (.env*, .api-token, .state-secret) so an agent cannot
    // create-and-commit one. Also block npm/SSH/key materials.
    const devChangedFiles = localGetChanges(cfg.localRepo);
    const FORBIDDEN_PATHS = [
        /^\.git\//,
        /^node_modules\//,
        /\.gitlab-ci\.yml$/,
        /\.sh$/,
        /\.bash$/,
        /(^|\/)\.env(\..+)?$/,
        /(^|\/)\.api-token$/,
        /(^|\/)\.state-secret$/,
        /(^|\/)\.npmrc$/,
        /(^|\/)\.pem$/,
        /(^|\/)id_rsa(\.pub)?$/,
        /(^|\/)kubeconfig$/,
    ];
    const FORBIDDEN_PACKAGE_SCRIPTS = /^package\.json$/;
    const violations = [];
    for (const c of devChangedFiles) {
        for (const forbidden of FORBIDDEN_PATHS) {
            if (forbidden.test(c.file_path)) {
                violations.push(c.file_path);
                break;
            }
        }
        if (FORBIDDEN_PACKAGE_SCRIPTS.test(c.file_path)) {
            violations.push(`${c.file_path} (package.json modification)`);
        }
    }
    if (violations.length > 0) {
        logErr(`F3: Developer modified forbidden files: ${violations.join(", ")}`);
        logInfo("Reverting local repo to clean state…");
        localResetRepo(cfg.localRepo);
        throw new Error(`Developer Agent modified forbidden files: ${violations.join(", ")}. Pipeline halted.`);
    }
}
//# sourceMappingURL=developer.js.map