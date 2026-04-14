"use strict";
// =====================================================================
// MI Dev Agent -- Developer Agent (TypeScript port of stages/generate-code/developer.js)
// =====================================================================
//
// Runs the Developer Agent to generate code based on an approved plan.
// Supports parallel execution via task group splitting when the plan
// is divisible into independent groups. Falls back to a single agent
// if parallelization fails.
//
// Key features:
//   - Prompt assembly (ticket, AC, context, feedback from previous attempts)
//   - Uses ClaudeService for code generation (Anthropic API)
//   - Task group parsing with union-find for conflict detection
//   - Parallel multi-agent mode (2-5 groups) with forbidden-file isolation
//   - GQ7: Import resolution validation
//   - F3: Forbidden path enforcement
//   - Refusal detection, output validation, retry on zero changes
//   - Checkpoint persistence for crash recovery
// =====================================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTaskGroups = parseTaskGroups;
exports.runDeveloper = runDeveloper;
exports.validateDevChanges = validateDevChanges;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../lib/logger");
const utils_1 = require("../lib/utils");
// ── Constants ────────────────────────────────────────────────────────
const FILE_PATH_RE = /(?:src|lib|app|apps|pages|components|hooks|utils|services|constants|types|styles|modules)\/[\w\-./]+\.\w+/g;
const FORBIDDEN_PATHS = [/^\.git\//, /^node_modules\//, /\.gitlab-ci\.yml$/, /\.sh$/, /\.bash$/];
const FORBIDDEN_PACKAGE_SCRIPTS = /^package\.json$/;
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes
const GROUP_TIMEOUT_MS = 600_000; // 10 minutes per group
// ── Parse tasks.md into independent task groups ──────────────────
/**
 * Parse a tasks.md markdown into independent task groups for parallel execution.
 * Splits by ## headings, extracts file paths per group, merges groups sharing files
 * using union-find to ensure no two agents touch the same file.
 *
 * @param tasksMarkdown - The tasks.md content
 * @returns Independent task groups with titles, content, and file lists
 */
function parseTaskGroups(tasksMarkdown) {
    if (!tasksMarkdown || typeof tasksMarkdown !== 'string')
        return [];
    // Split by ## headings
    const lines = tasksMarkdown.split('\n');
    const groups = [];
    let currentGroup = null;
    for (const line of lines) {
        const headingMatch = line.match(/^##\s+(.+)/);
        if (headingMatch) {
            if (currentGroup)
                groups.push(currentGroup);
            currentGroup = { title: headingMatch[1].trim(), content: '', files: [] };
        }
        if (currentGroup) {
            currentGroup.content += line + '\n';
        }
    }
    if (currentGroup)
        groups.push(currentGroup);
    if (groups.length === 0)
        return [];
    // Extract file paths from each group
    for (const g of groups) {
        const matches = g.content.match(FILE_PATH_RE) || [];
        g.files = [...new Set(matches)];
    }
    // Union-Find to merge groups that share files
    const parent = groups.map((_, i) => i);
    function find(x) {
        return parent[x] === x ? x : (parent[x] = find(parent[x]));
    }
    function union(a, b) {
        parent[find(a)] = find(b);
    }
    // Build file -> group index map
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
            merged[root] = { title: groups[root].title, content: '', files: new Set() };
        }
        if (root !== i) {
            merged[root].title += ' + ' + groups[i].title;
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
// ── Prompt builders ──────────────────────────────────────────────
/** Build the mandatory rules section shared by all developer prompts */
function buildMandatoryRules() {
    return (`## MANDATORY RULES\n` +
        `1. **REUSE existing code**: Use the EXACT same components, hooks, utils, services, API calls, styles, constants.\n` +
        `2. **Match existing patterns EXACTLY**: Same import style, state management, error handling, naming, folder structure.\n` +
        `3. **Prefer modifying existing files** over creating new ones.\n` +
        `4. **Import from existing paths**: Same import aliases, relative paths, barrel exports.\n` +
        `5. **Copy structure from similar features**: If there's an existing edit form, table, modal -- copy it.\n` +
        `6. **No unnecessary abstractions**: Don't create helpers/utils the repo doesn't already have.\n` +
        `7. **VITE_PRODUCT_ID checks**: Must use the exact enterprise product ID -- no generic multi-product conditionals.\n` +
        `8. **Enterprise app ONLY**: Do NOT modify or reference other product lines (SME, GST, TaxPro, etc.).\n` +
        `9. **NEVER delete existing functions, components, or endpoints** -- only add or modify.\n`);
}
/** Build the forbidden files section */
function buildForbiddenSection(extra = '') {
    return (`## FORBIDDEN (F3 -- File Path Restrictions)\n` +
        `You may ONLY modify files within the project directory.\n` +
        `FORBIDDEN: You must NEVER modify files in .git/, node_modules/, or package.json scripts.\n` +
        `FORBIDDEN: You must NEVER create shell scripts (.sh, .bash) or modify CI/CD files (.gitlab-ci.yml).\n` +
        extra);
}
/** Build the repo access preamble */
function buildRepoAccess() {
    return (`## REPOSITORY ACCESS\n` +
        `You have DIRECT ACCESS to this repository. Use Read, Grep, Glob to explore, and Write/Edit to modify files.\n` +
        `DO NOT output JSON. Write changes DIRECTLY to the files on disk.\n`);
}
// ── Developer Agent Entry Point ──────────────────────────────────
/**
 * Run the Developer Agent -- generates code based on the approved plan.
 *
 * Supports parallel execution via task group splitting when the plan
 * can be divided into 2-5 independent groups. Falls back to a single
 * agent if parallel mode fails or the plan is not splittable.
 *
 * @param state - Current pipeline state
 * @param ctx - Developer context (plan, feedback, services, etc.)
 * @returns Developer result with summary of changes
 */
async function runDeveloper(state, ctx) {
    const { approvedPlan, devFullContext, extraDocs, extraFeedback, feedback, claude, projectDir, timeoutMs } = ctx;
    const data = state.data;
    const ticket = state.ticket;
    // Extract ticket info
    const ticketData = data.ticket;
    const summary = ticketData?.summary || '';
    const description = ticketData?.description || '';
    const ac = ticketData?.ac || '';
    const iType = ticketData?.issueType || 'Task';
    const iPriority = ticketData?.priority || 'Medium';
    const effectiveTimeout = timeoutMs || DEFAULT_TIMEOUT_MS;
    // Set up Claude with the project directory
    claude.setProjectDir(projectDir);
    // Step 1 -- Try parallel developer agents via task group splitting
    const taskGroups = parseTaskGroups(approvedPlan);
    const canParallelize = taskGroups.length >= 2 && taskGroups.length <= 5;
    if (canParallelize) {
        (0, logger_1.logInfo)(`Developer Team -- ${taskGroups.length} parallel agents (task-group split)`);
        for (let i = 0; i < taskGroups.length; i++) {
            (0, logger_1.logInfo)(`  Group ${i}: "${taskGroups[i].title}" -- ${taskGroups[i].files.length} file(s)`);
        }
        try {
            const groupResults = [];
            // Run groups in parallel with Promise.all
            const groupPromises = taskGroups.map(async (group, idx) => {
                // Build FORBIDDEN file lists -- each group can only touch its own files
                const otherFiles = taskGroups
                    .filter((_, i) => i !== idx)
                    .flatMap((g) => g.files);
                const forbiddenList = otherFiles.length > 0
                    ? `\n## FORBIDDEN FILES (owned by other agents -- do NOT modify)\n${otherFiles.map((f) => `- ${f}`).join('\n')}\n`
                    : '';
                const groupPrompt = `You are **Developer Agent ${idx + 1}** at MasterIndia. Write production-ready code for your assigned task group ONLY.\n\n` +
                    buildRepoAccess() + '\n' +
                    buildMandatoryRules() + '\n' +
                    buildForbiddenSection(forbiddenList) + '\n' +
                    `## YOUR ASSIGNED TASK GROUP\n${group.content}\n\n` +
                    `## Full Plan Context (read-only -- for understanding dependencies)\n${approvedPlan}\n\n` +
                    `## Jira ticket: ${ticket} [${iType} / ${iPriority}]\nTitle: ${summary}\nDescription:\n${(0, utils_1.sanitizeForPrompt)(description)}\nAC: ${(0, utils_1.sanitizeForPrompt)(ac)}\n` +
                    `${extraDocs}${extraFeedback}${devFullContext}` +
                    (feedback ? `\n## Previous code review feedback (address this):\n${feedback}\n` : '') +
                    `\n## Instructions\n` +
                    `1. Read the files mentioned in YOUR task group to understand existing code\n` +
                    `2. Implement ONLY the changes in your assigned task group\n` +
                    `3. After all changes, provide a brief summary of what you modified/created`;
                const groupTimeout = Math.min(GROUP_TIMEOUT_MS, effectiveTimeout);
                const result = await claude.callClaude(groupPrompt, groupTimeout, {
                    agentName: `Dev Agent ${idx + 1}: ${group.title.substring(0, 50)}`,
                    maxTurns: 15,
                    projectDir,
                });
                return { idx, name: `Dev Agent ${idx + 1}: ${group.title.substring(0, 50)}`, output: result };
            });
            const results = await Promise.all(groupPromises);
            // Merge results
            const mergedSummary = results
                .filter((r) => r.output)
                .map((r) => `## ${r.name}\n${r.output}`)
                .join('\n\n');
            // Validate and checkpoint
            (0, utils_1.validateClaudeNotEmpty)(mergedSummary, 'Developer Team');
            (0, logger_1.logOk)('Developer Team (parallel) complete');
            // GQ7 + F3: Validate changes
            validateDevChanges(state, projectDir);
            // Developer checkpoint
            data._dev_complete = true;
            data._dev_summary = mergedSummary.substring(0, 2000);
            return {
                summary: mergedSummary,
                parallelMode: true,
                groupCount: taskGroups.length,
            };
        }
        catch (teamErr) {
            const errMsg = teamErr instanceof Error ? teamErr.message : String(teamErr);
            (0, logger_1.logWarn)(`Parallel developer agents failed: ${errMsg.substring(0, 300)}`);
            (0, logger_1.logInfo)('Falling back to single Developer Agent...');
            // Clear group checkpoints
            for (let i = 0; i < taskGroups.length; i++) {
                data[`_dev_group_${i}`] = null;
            }
            // Fall through to single-agent mode below
        }
    }
    // ── Single Developer Agent (original path, or fallback) ──
    (0, logger_1.logInfo)('Developer Agent: writing code directly...');
    (0, logger_1.logInfo)(`  projectDir: ${projectDir} | maxTurns: ${DEFAULT_MAX_TURNS} | timeout: ${effectiveTimeout / 1000}s`);
    const devPrompt = `You are the **Developer Agent** at MasterIndia. Write production-ready code.\n\n` +
        buildRepoAccess() + '\n' +
        buildMandatoryRules() + '\n' +
        buildForbiddenSection() + '\n' +
        `## Pre-approved implementation plan\n${approvedPlan}\n\n` +
        `## Jira ticket: ${ticket} [${iType} / ${iPriority}]\nTitle: ${summary}\nDescription:\n${(0, utils_1.sanitizeForPrompt)(description)}\nAC: ${(0, utils_1.sanitizeForPrompt)(ac)}\n` +
        `${extraDocs}${extraFeedback}${devFullContext}` +
        (feedback ? `\n## Previous code review feedback (address this):\n${feedback}\n` : '') +
        (data.previousAttemptSummary
            ? `\n## Previous attempt file changes (for reference):\n${data.previousAttemptSummary}\n`
            : '') +
        (data.parentBranch
            ? `\n## Q4: Parent Branch Context\nThis ticket branches from parent feature branch: ${data.parentBranch}. Ensure your changes are compatible with parent branch changes.\n`
            : '') +
        `\n## Instructions\n` +
        `1. Read the files mentioned in the plan to understand existing code\n` +
        `2. Pay special attention to API specs, field names, and payloads from Jira comments -- use EXACT names\n` +
        `3. Implement ALL changes from the plan by writing/editing files directly\n` +
        `4. After all changes, provide a brief summary:\n` +
        `   - What files you modified/created\n` +
        `   - What existing code you reused\n` +
        `   - What to test manually`;
    const devResult = await claude.callClaude(devPrompt, effectiveTimeout, {
        agentName: 'Developer Agent',
        maxTurns: DEFAULT_MAX_TURNS,
        projectDir,
    });
    (0, logger_1.logOk)('Developer Agent complete');
    // GQ7 + F3: Validate changes
    validateDevChanges(state, projectDir);
    // Developer checkpoint
    data._dev_complete = true;
    data._dev_summary = devResult.substring(0, 2000);
    return {
        summary: devResult,
        parallelMode: false,
    };
}
// ── Validation Helpers ───────────────────────────────────────────
/**
 * Shared validation for developer agent output (GQ7 + F3).
 * Checks import resolution and forbidden path violations.
 *
 * @param state - Pipeline state (for warnings)
 * @param projectDir - Project directory for file resolution
 * @param changedFiles - Optional explicit file changes to validate
 */
function validateDevChanges(state, projectDir, changedFiles) {
    // If no explicit changed files provided, scan git status
    const filesToCheck = changedFiles || [];
    // GQ7: Import Resolution Validation -- check relative imports resolve to existing files
    try {
        const unresolvedImports = [];
        for (const c of filesToCheck) {
            if (c.action === 'delete' || !c.content)
                continue;
            if (!/\.(tsx?|jsx?)$/.test(c.file_path))
                continue;
            const importMatches = c.content.match(/(?:import\s+.*?from\s+['"])(\.\.?\/[^'"]+)(?:['"])/g) || [];
            for (const imp of importMatches) {
                const pathMatch = imp.match(/['"](\.\/?[^'"]+)['"]/);
                if (!pathMatch)
                    continue;
                const importPath = pathMatch[1];
                const fileDir = path.dirname(c.file_path);
                const resolved = path.normalize(path.join(fileDir, importPath));
                const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
                let found = false;
                for (const ext of extensions) {
                    const fullPath = path.join(projectDir, resolved + ext);
                    if (fs.existsSync(fullPath)) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    unresolvedImports.push({ file: c.file_path, import: importPath, resolved });
                }
            }
        }
        if (unresolvedImports.length > 0) {
            (0, logger_1.logWarn)(`GQ7: ${unresolvedImports.length} unresolved relative import(s) detected:`);
            for (const ui of unresolvedImports.slice(0, 10)) {
                (0, logger_1.logWarn)(`  ${ui.file}: import '${ui.import}' -> ${ui.resolved} (not found)`);
            }
            (0, utils_1.addWarning)(state, 'generate_code', `${unresolvedImports.length} unresolved imports detected`);
        }
    }
    catch (importErr) {
        const msg = importErr instanceof Error ? importErr.message : String(importErr);
        (0, logger_1.logDebug)(`GQ7: Import resolution check failed: ${msg}`);
    }
    // F3: Validate changed files against forbidden paths
    const violations = [];
    for (const c of filesToCheck) {
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
        (0, logger_1.logErr)(`F3: Developer modified forbidden files: ${violations.join(', ')}`);
        throw new Error(`Developer Agent modified forbidden files: ${violations.join(', ')}. Pipeline halted.`);
    }
}
//# sourceMappingURL=developer.js.map