"use strict";

import type { PipelineState } from '@mi/shared';

const fs = require("fs");
const path = require("path");
const { cfg, TICKET, DEVELOPER_TIMEOUT_MS, applyComplexityTimeout } = require("../../lib/config");
const { logInfo, logOk, logErr, logWarn, logDebug } = require("../../lib/logging");
const { sanitizeForPrompt, addWarning, validateClaudeNotEmpty } = require("../../lib/utils");
const { save } = require("../../lib/state");
const { runAgentsTeam, runSingleAgent } = require("../../lib/agents-team");
const { localResetRepo, localGetChanges } = require("../../lib/local-repo");
const { jira, jiraUrl } = require("../../lib/jira");
const { slack } = require("../../lib/slack");

// Parse tasks.md into independent task groups
function parseTaskGroups(tasksMarkdown: string): Array<{title: string; content: string; files: string[]}> {
  if (!tasksMarkdown || typeof tasksMarkdown !== "string") return [];

  const lines = tasksMarkdown.split("\n");
  const groups: Array<{title: string; content: string; files: string[]}> = [];
  let currentGroup: {title: string; content: string; files: string[]} | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { title: headingMatch[1].trim(), content: "", files: [] };
    }
    if (currentGroup) {
      currentGroup.content += line + "\n";
    }
  }
  if (currentGroup) groups.push(currentGroup);

  if (groups.length === 0) return [];

  // Extract file paths from each group
  const FILE_PATH_RE = /(?:src|lib|app|apps|pages|components|hooks|utils|services|constants|types|styles|modules)\/[\w\-./]+\.\w+/g;
  for (const g of groups) {
    const matches = g.content.match(FILE_PATH_RE) || [];
    g.files = [...new Set(matches)];
  }

  // Union-Find to merge groups that share files
  const parent = groups.map((_: any, i: number) => i);
  function find(x: number): number { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
  function union(a: number, b: number): void { parent[find(a)] = find(b); }

  // Build file → group index map
  const fileToGroups: Record<string, number> = {};
  for (let i = 0; i < groups.length; i++) {
    for (const f of groups[i].files) {
      if (fileToGroups[f] !== undefined) {
        union(fileToGroups[f], i);
      } else {
        fileToGroups[f] = i;
      }
    }
  }

  // Merge into disjoint sets
  const merged: Record<number, {title: string; content: string; files: Set<string>}> = {};
  for (let i = 0; i < groups.length; i++) {
    const root = find(i);
    if (!merged[root]) {
      merged[root] = { title: groups[root].title, content: "", files: new Set() };
    }
    if (root !== i) {
      merged[root].title += " + " + groups[i].title;
    }
    merged[root].content += groups[i].content;
    for (const f of groups[i].files) merged[root].files.add(f);
  }

  return Object.values(merged).map((g) => ({
    title: g.title,
    content: g.content.trim(),
    files: [...g.files],
  }));
}

/**
 * Run Developer Agent — writes code directly to local repo.
 */
async function runDeveloperAgent(ctx: any): Promise<void> {
  const { state, approvedPlan, devFullContext, extraDocs, extraFeedback, feedback } = ctx;
  const { summary, description, ac, issueType: iType, priority: iPriority } = (state as PipelineState).data.ticket as any;

  // Step 1 — Reset local repo to clean enterprise-ts state
  localResetRepo(cfg.localRepo);

  // Step 2 — Try parallel developer agents via task group splitting
  const taskGroups = parseTaskGroups(approvedPlan);
  const canParallelize = taskGroups.length >= 2 && taskGroups.length <= 5;

  if (canParallelize) {
    logInfo(`Agents Team — ${taskGroups.length} parallel Developer Agents (task-group split)`);
    for (let i = 0; i < taskGroups.length; i++) {
      logInfo(`  Group ${i}: "${taskGroups[i].title}" — ${taskGroups[i].files.length} file(s)`);
    }

    // Build FORBIDDEN file lists — each group can only touch its own files
    const groupAgents = taskGroups.map((group, idx) => {
      const otherFiles = taskGroups
        .filter((_: any, i: number) => i !== idx)
        .flatMap((g) => g.files);
      const forbiddenList = otherFiles.length > 0
        ? `\n## FORBIDDEN FILES (owned by other agents — do NOT modify)\n${otherFiles.map((f) => `- ${f}`).join("\n")}\n`
        : "";

      const groupPrompt =
        `You are **Developer Agent ${idx + 1}** at MasterIndia. Write production-ready code for your assigned task group ONLY.\n\n` +
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
        `\n## Instructions\n` +
        `1. Read the files mentioned in YOUR task group to understand existing code\n` +
        `2. Implement ONLY the changes in your assigned task group\n` +
        `3. After all changes, provide a brief summary of what you modified/created`;

      return {
        name: `Dev Agent ${idx + 1}: ${group.title.substring(0, 50)}`,
        prompt: groupPrompt,
        timeout: applyComplexityTimeout(600_000, state), // 10 min per group
        opts: { cwd: cfg.localRepo, maxTurns: 15, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
        required: true,
        checkpointKey: `_dev_group_${idx}`,
      };
    });

    try {
      const mergedSummary = await runAgentsTeam({
        teamName: "Developer Team",
        agents: groupAgents,
        state,
        merge: (results: any[]) => {
          return results
            .filter((r: any) => r.output)
            .map((r: any) => `## ${r.name}\n${r.output}`)
            .join("\n\n");
        },
      });

      // Post-merge: check for conflicts via git diff
      const { execSync } = require("child_process");
      try {
        const diffStat = execSync("git diff --stat", { cwd: cfg.localRepo, timeout: 10_000, stdio: "pipe" }).toString();
        logInfo(`Post-merge diff stat:\n${diffStat.substring(0, 500)}`);
      } catch {}

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
      (state.data as any)._dev_complete = true;
      (state.data as any)._dev_summary = mergedSummary.substring(0, 2000);
      save(state);
      return;
    } catch (teamErr: any) {
      logWarn(`Parallel developer agents failed: ${teamErr.message.substring(0, 300)}`);
      logInfo("Falling back to single Developer Agent…");
      // Clear group checkpoints and reset
      for (let i = 0; i < taskGroups.length; i++) {
        (state.data as any)[`_dev_group_${i}`] = null;
      }
      localResetRepo(cfg.localRepo);
      // Fall through to single-agent mode below
    }
  }

  // Single Developer Agent (original path, or fallback)
  logInfo("Agents Team — Developer Agent: writing code directly…");
  logInfo(`  cwd: ${cfg.localRepo} | maxTurns: 25 | timeout: ${DEVELOPER_TIMEOUT_MS / 1000}s`);
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
      `${(state.data as any).previousAttemptSummary ? `\n## Previous attempt file changes (for reference):\n${(state.data as any).previousAttemptSummary}\n` : ""}` +
      `${(state.data as any).parentBranch ? `\n## Q4: Parent Branch Context\nThis ticket branches from parent feature branch: ${(state.data as any).parentBranch}. Ensure your changes are compatible with parent branch changes.\n` : ""}` +
      `\n## Instructions\n` +
      `1. Read the files mentioned in the plan to understand existing code\n` +
      `2. Pay special attention to API specs, field names, and payloads from Jira comments — use EXACT names\n` +
      `3. Implement ALL changes from the plan by writing/editing files directly\n` +
      `4. After all changes, provide a brief summary:\n` +
      `   - What files you modified/created\n` +
      `   - What existing code you reused\n` +
      `   - What to test manually`,
    timeout: applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
    opts: { cwd: cfg.localRepo, maxTurns: 25, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
    state,
    checkpointKey: "_dev_single_result",
    required: true,
  });
  logOk("Developer Agent complete");

  // GQ7 + F3: Validate changes
  _validateDevChanges(state);

  // D10: Developer checkpoint
  (state.data as any)._dev_complete = true;
  (state.data as any)._dev_summary = devResult.substring(0, 2000);
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
        `\n**IMPORTANT**: Enterprise app ONLY — use exact enterprise VITE_PRODUCT_ID, no generic multi-product checks.\n` +
        `\nRead the relevant files, then implement ALL changes from the plan.`,
      timeout: applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
      opts: { cwd: cfg.localRepo, maxTurns: 25, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
      state,
      checkpointKey: "_dev_retry_result",
      required: true,
    });
    devFileChanges = localGetChanges(cfg.localRepo);

    if (devFileChanges.length === 0) {
      logErr("Developer Agent still made no file changes after retry.");
      logErr("This usually means Claude couldn't use Write/Edit tools (check permissions).");
      logInfo(`Retry output (first 500 chars): ${retryResult.substring(0, 500)}`);
      (state.data as any)._dev_failed = true;
      save(state);
      await slack(
        `\ud83d\uded1 *Code Gen Failed — ${TICKET}*\nDeveloper Agent produced 0 file changes after retry.\nThis usually means Claude couldn't use Write/Edit tools.\n\ud83d\udccb ${jiraUrl(TICKET)}`,
        [cfg.slack.ownerId],
      );
      await jira.addComment(TICKET,
        `Code Generation Failed\n\nDeveloper Agent produced 0 file changes after retry. This usually means Claude couldn't use Write/Edit tools. Manual intervention required.`);
      throw new Error("Developer Agent produced 0 file changes after retry — manual intervention required");
    }
    logOk(`Retry successful: ${devFileChanges.length} file(s) changed`);
  }
  logOk(`${devFileChanges.length} file(s) changed`);
}

/**
 * Shared validation for developer agent output (GQ7 + F3).
 */
function _validateDevChanges(state: PipelineState): void {
  // GQ7: Import Resolution Validation
  try {
    const devChangedForImports = localGetChanges(cfg.localRepo);
    const unresolvedImports: Array<{file: string; import: string; resolved: string}> = [];
    for (const c of devChangedForImports) {
      if (c.action === "delete" || !c.content) continue;
      if (!/\.(tsx?|jsx?)$/.test(c.file_path)) continue;
      const importMatches = c.content.match(/(?:import\s+.*?from\s+['"])(\.\.?\/[^'"]+)(?:['"])/g) || [];
      for (const imp of importMatches) {
        const pathMatch = imp.match(/['"](\.\/?[^'"]+)['"]/);
        if (!pathMatch) continue;
        const importPath = pathMatch[1];
        const fileDir = path.dirname(c.file_path);
        const resolved = path.normalize(path.join(fileDir, importPath));
        const extensions = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
        let found = false;
        for (const ext of extensions) {
          const fullPath = path.join(cfg.localRepo, resolved + ext);
          if (fs.existsSync(fullPath)) { found = true; break; }
        }
        if (!found) {
          unresolvedImports.push({ file: c.file_path, import: importPath, resolved });
        }
      }
    }
    if (unresolvedImports.length > 0) {
      logWarn(`GQ7: ${unresolvedImports.length} unresolved relative import(s) detected:`);
      for (const ui of unresolvedImports.slice(0, 10)) {
        logWarn(`  ${ui.file}: import '${ui.import}' → ${ui.resolved} (not found)`);
      }
      addWarning(state, "generate_code", `${unresolvedImports.length} unresolved imports detected`);
    }
  } catch (importErr: any) {
    logDebug(`GQ7: Import resolution check failed: ${importErr.message}`);
  }

  // F3: Validate changed files against forbidden paths
  const devChangedFiles = localGetChanges(cfg.localRepo);
  const FORBIDDEN_PATHS = [/^\.git\//, /^node_modules\//, /\.gitlab-ci\.yml$/, /\.sh$/, /\.bash$/];
  const FORBIDDEN_PACKAGE_SCRIPTS = /^package\.json$/;
  const violations: string[] = [];
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

export { runDeveloperAgent, parseTaskGroups };
