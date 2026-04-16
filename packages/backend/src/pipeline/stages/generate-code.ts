// =====================================================================
// MI Dev Agent -- Generate Code Stage (Full 3-Step Pipeline)
// =====================================================================
// Complete TypeScript port of stages/generate-code/index.js
//
// Orchestrates the full code generation pipeline:
//
//   STEP 1: Developer Agent
//     - Parse task groups (union-find)
//     - Parallel developer agents (if 2-5 groups)
//     - Single developer agent (fallback)
//     - GQ7: Import resolution validation
//     - F3: Forbidden file path validation
//     - Retry on zero files
//
//   STEP 2: Test & Verify
//     - Reviewer + Security agents (parallel)
//     - Fixer agent (conditional, priority-ordered)
//     - Q5: Build check (tsc + eslint + build fixer)
//     - Runtime tests (unit + e2e)
//     - Q6: AC verification (with retry)
//
//   STEP 3: Create MR
//     - Validate & deduplicate changes
//     - Create branch (Q4: parent branch awareness)
//     - Commit files (GQ2, T2.18, M5)
//     - GQ4: Conflict detection
//     - GQ8/T2.19: Divergence check
//     - Rich MR description (quality report, test results, known gaps)
//     - Slack notification (no Jira comment)
//
// Key behaviors:
//   - saveAndThrow guard at all throw sites
//   - Skip completed sub-stages on re-entry (D10 checkpoint support)
//   - Config mode switch guard (R6: local vs legacy)
//   - Full context assembly from all gathered ticket sources
//   - H1/H4: Rejection counter with max limit
// =====================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';
import type { PipelineState, AppConfig } from '@shared/types';
import {
  logStep, logOk, logInfo, logErr, logWarn, logDebug,
} from '../../lib/logger';
import {
  sanitizeForPrompt,
  truncateWithIndicator,
  addWarning,
} from '../../lib/utils';
import { save } from '../../state/state-manager';
import { loadConfig, loadExtendedConfig } from '../../config/loader';
import { SlackService } from '../../services/slack';
import { ClaudeService, ClaudeCLIService } from '../../services/claude';
import { req } from '../../http/client';
import type { GitLabCommitAction } from '../../services/gitlab';

// =====================================================================
// Types
// =====================================================================

/** Context object shared by sub-modules. */
export interface CodeGenContext {
  state: PipelineState;
  approvedPlan: string;
  devFullContext: string;
  extraDocs: string;
  extraFeedback: string;
  feedback: string;
}

/** File change from local repo or API. */
export interface FileChange {
  file_path: string;
  action: 'create' | 'update' | 'delete';
  content?: string;
}

/** Code changes result object compatible with pushCodeToGitLab. */
export interface CodeChanges {
  changes: FileChange[];
  summary: string;
  test_notes: string;
}

/** Task group parsed from plan markdown. */
interface TaskGroup {
  title: string;
  content: string;
  files: string[];
}

/** Claude service union type. */
type Claude = ClaudeService | ClaudeCLIService;

// =====================================================================
// Constants
// =====================================================================

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.zip', '.gz', '.tar', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.exe', '.dll', '.so', '.dylib',
  '.bin', '.dat', '.db', '.sqlite',
]);

const FORBIDDEN_PATHS = [/^\.git\//, /^node_modules\//, /\.gitlab-ci\.yml$/, /\.sh$/, /\.bash$/];
const FORBIDDEN_PACKAGE_SCRIPTS = /^package\.json$/;

const FILE_PATH_RE = /(?:src|lib|app|apps|pages|components|hooks|utils|services|constants|types|styles|modules)\/[\w\-./]+\.\w+/g;

// =====================================================================
// Helpers
// =====================================================================

function saveAndThrow(state: PipelineState, message: string): never {
  try { save(state); } catch { /* best effort */ }
  throw new Error(message);
}

function d(state: PipelineState): Record<string, unknown> {
  return state.data as Record<string, unknown>;
}

function ticket(state: PipelineState): Record<string, unknown> {
  return d(state).ticket as Record<string, unknown>;
}

// =====================================================================
// Local Repo Helpers
// =====================================================================

function localResetRepo(clonePath: string): void {
  logInfo('Resetting local repo to clean state...');
  execFileSync('git', ['-C', clonePath, 'checkout', '-f', '.'], { stdio: 'pipe', timeout: 30_000 });
  execFileSync('git', ['-C', clonePath, 'clean', '-fd', '-e', '.env', '-e', '.env.*', '-e', '.api-token', '-e', '.state-secret', '-e', '.debug'], { stdio: 'pipe', timeout: 30_000 });
  logOk('Local repo reset to clean state');
}

function localGetFile(clonePath: string, filePath: string): string | null {
  try {
    const resolved = path.resolve(clonePath, filePath);
    if (!resolved.startsWith(path.resolve(clonePath))) return null;

    // G6: Symlink escape guard
    try {
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(path.resolve(clonePath))) { logWarn(`G6: Symlink escape blocked: ${filePath}`); return null; }
    } catch { /* file doesn't exist yet */ }

    // D7: Binary file guard
    const ext = (filePath.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      try {
        const stat = fs.statSync(resolved);
        return `[Binary file: ${path.basename(filePath)}, ${stat.size} bytes]`;
      } catch { return null; }
    }

    const content = fs.readFileSync(resolved, 'utf8');
    if (content.includes('\0')) {
      return `[Binary file: ${path.basename(filePath)}]`;
    }
    return content;
  } catch {
    return null;
  }
}

function localGetChanges(clonePath: string): FileChange[] {
  const output: string = execFileSync('git', ['-C', clonePath, 'status', '--porcelain'], { encoding: 'utf8', timeout: 15_000 }).trim();
  if (!output) return [];

  let diffOutput = '';
  try {
    diffOutput = execFileSync('git', ['-C', clonePath, 'diff', '--name-status', 'HEAD'], { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch { /* no HEAD yet */ }

  const changes: FileChange[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    const status = line.substring(0, 2).trim();
    let filePath = line.substring(3).trim();
    if (!filePath) continue;

    // G8: Strip quotes from filenames
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }

    // D6: Handle renames
    if (status.startsWith('R') && filePath.includes(' -> ')) {
      const parts = filePath.split(' -> ');
      const oldPath = parts[0].trim().replace(/^"|"$/g, '');
      const newPath = parts[1].trim().replace(/^"|"$/g, '');
      changes.push({ action: 'delete', file_path: oldPath, content: '' });
      const content = localGetFile(clonePath, newPath);
      if (content !== null) changes.push({ action: 'create', file_path: newPath, content });
      continue;
    }

    let action: 'create' | 'update' | 'delete';
    if (status === 'D') action = 'delete';
    else if (status === '??' || status === 'A') action = 'create';
    else action = 'update';

    if (action === 'delete') {
      changes.push({ action, file_path: filePath, content: '' });
    } else {
      let content = localGetFile(clonePath, filePath);
      if (content !== null) {
        // GQ3: Strip BOM
        if (typeof content === 'string' && content.length > 0 && content.charCodeAt(0) === 0xFEFF) {
          content = content.substring(1);
          logDebug(`GQ3: Stripped BOM from ${filePath}`);
        }
        if (typeof content === 'string' && content.includes('\0')) {
          logWarn(`GQ3: Skipping binary file (null bytes): ${filePath}`);
          continue;
        }
        changes.push({ action, file_path: filePath, content });
      }
    }
  }

  // D6: Also parse git diff --name-status for renames missed by porcelain
  if (diffOutput) {
    for (const line of diffOutput.split('\n')) {
      const m = line.match(/^R\d*\t(.+?)\t(.+)$/);
      if (m) {
        const oldPath = m[1].trim().replace(/^"|"$/g, '');
        const newPath = m[2].trim().replace(/^"|"$/g, '');
        if (!changes.some((c) => c.file_path === oldPath && c.action === 'delete')) {
          changes.push({ action: 'delete', file_path: oldPath, content: '' });
        }
        if (!changes.some((c) => c.file_path === newPath)) {
          const content = localGetFile(clonePath, newPath);
          if (content !== null) changes.push({ action: 'create', file_path: newPath, content });
        }
      }
    }
  }

  return changes;
}

function localGetOriginal(clonePath: string, filePath: string): string | null {
  try {
    return execFileSync('git', ['-C', clonePath, 'show', `HEAD:${filePath}`], { encoding: 'utf8', timeout: 10_000 });
  } catch {
    return null;
  }
}

// =====================================================================
// Context Builder
// =====================================================================

function buildFullContext(state: PipelineState): string {
  const ticketData = ticket(state);
  if (!ticketData) return '';

  const ticketComments = ticketData.comments as Array<{ author: string; created?: string; body: string }> | undefined;
  const linkedIssues = ticketData.linkedIssues as Array<{ key: string; relationship: string; summary: string }> | undefined;
  const parentEpic = ticketData.parent as { key: string; summary: string } | undefined;
  const attachmentContents = ticketData.attachmentContents as Array<{ filename: string; content: string }> | undefined;
  const fetchedUrlContents = ticketData.fetchedUrlContents as Array<{ url: string; content: string }> | undefined;
  const connectorContents = ticketData.connectorContents as Array<{ title: string; source: string; content: string }> | undefined;

  let context = '';

  if (ticketComments && ticketComments.length > 0) {
    context += '\n## Jira Comments (IMPORTANT -- may contain API specs, field names, payloads)\n';
    for (const c of ticketComments) {
      const date = c.created ? c.created.split('T')[0] : '';
      context += `### [${c.author}] (${date}):\n${sanitizeForPrompt(c.body)}\n\n`;
    }
  }
  if (linkedIssues && linkedIssues.length > 0) {
    context += '\n## Linked Issues (business context)\n';
    for (const li of linkedIssues) {
      context += `- ${li.key} (${li.relationship}): ${sanitizeForPrompt(li.summary)}\n`;
    }
  }
  if (parentEpic) {
    context += `\n## Parent Epic: ${parentEpic.key} -- ${sanitizeForPrompt(parentEpic.summary)}\n`;
  }
  if (attachmentContents && attachmentContents.length > 0) {
    context += '\n## Attachment Contents\n';
    for (const att of attachmentContents) {
      const content = truncateWithIndicator(att.content, 5000);
      context += `### ${att.filename}\n\`\`\`\n${sanitizeForPrompt(content)}\n\`\`\`\n\n`;
    }
  }
  if (fetchedUrlContents && fetchedUrlContents.length > 0) {
    context += '\n## Fetched External URLs\n';
    for (const fu of fetchedUrlContents) {
      const content = truncateWithIndicator(fu.content, 5000);
      context += `### ${fu.url}\n\`\`\`\n${sanitizeForPrompt(content)}\n\`\`\`\n\n`;
    }
  }
  if (connectorContents && connectorContents.length > 0) {
    context += '\n## Connector Documents\n';
    for (const cd of connectorContents) {
      const content = truncateWithIndicator(cd.content, 15000);
      context += `### ${cd.title} (source: ${cd.source})\n${sanitizeForPrompt(content)}\n\n`;
    }
  }

  return context;
}

// =====================================================================
// Parse Task Groups (Union-Find)
// =====================================================================

function parseTaskGroups(tasksMarkdown: string): TaskGroup[] {
  if (!tasksMarkdown || typeof tasksMarkdown !== 'string') return [];

  const lines = tasksMarkdown.split('\n');
  const groups: TaskGroup[] = [];
  let currentGroup: TaskGroup | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { title: headingMatch[1].trim(), content: '', files: [] };
    }
    if (currentGroup) {
      currentGroup.content += line + '\n';
    }
  }
  if (currentGroup) groups.push(currentGroup);
  if (groups.length === 0) return [];

  // Extract file paths from each group
  for (const g of groups) {
    const matches = g.content.match(FILE_PATH_RE) || [];
    g.files = [...new Set(matches)];
  }

  // Union-Find to merge groups that share files
  const parent = groups.map((_, i) => i);
  function find(x: number): number { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
  function union(a: number, b: number): void { parent[find(a)] = find(b); }

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
  const merged: Record<number, { title: string; content: string; files: Set<string> }> = {};
  for (let i = 0; i < groups.length; i++) {
    const root = find(i);
    if (!merged[root]) {
      merged[root] = { title: groups[root].title, content: '', files: new Set() };
    }
    if (root !== i) {
      merged[root].title += ' + ' + groups[i].title;
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

// =====================================================================
// Parse Verdict (F1)
// =====================================================================

function parseVerdict(output: string, legacyPassWord: string): boolean {
  if (!output) return false;
  const verdictMatch = output.match(/VERDICT:\s*(PASS|FAIL)/i);
  if (verdictMatch) return verdictMatch[1].toUpperCase() === 'PASS';
  // T2.7: Check for negation before legacy word match
  const negationPattern = new RegExp(`\\b(not|no|isn't|isn\\'t|un|in)\\s*${legacyPassWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  if (negationPattern.test(output)) {
    logWarn(`Legacy word "${legacyPassWord}" found but negated -- treating as FAIL`);
    return false;
  }
  const wordPattern = new RegExp(`\\b${legacyPassWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  if (wordPattern.test(output)) return true;
  logWarn(`No VERDICT found in agent output and no "${legacyPassWord}" keyword -- treating as FAIL`);
  return false;
}

// =====================================================================
// Issue Categorizer
// =====================================================================

interface CategorizedIssue {
  label: string;
  type: string;
  content: string;
}

function categorizeIssues(reviewOutput: string | null, securityOutput: string | null): CategorizedIssue[] {
  const categories: CategorizedIssue[] = [];

  // Extract compilation errors (type errors, missing imports)
  if (reviewOutput) {
    const hasCompilation = /(?:typescript|type error|missing import|cannot find|TS\d{4})/i.test(reviewOutput);
    if (hasCompilation) {
      categories.push({ label: 'Compilation Errors', type: 'COMPILATION', content: reviewOutput });
    }
  }

  // Security issues get high priority
  if (securityOutput) {
    categories.push({ label: 'Security Issues', type: 'SECURITY', content: securityOutput });
  }

  // Code review issues
  if (reviewOutput && !categories.some((c) => c.type === 'COMPILATION')) {
    categories.push({ label: 'Code Review Issues', type: 'CODE_REVIEW', content: reviewOutput });
  }

  // If no categories matched, add generic
  if (categories.length === 0 && (reviewOutput || securityOutput)) {
    if (reviewOutput) categories.push({ label: 'Review Issues', type: 'CODE_REVIEW', content: reviewOutput });
    if (securityOutput) categories.push({ label: 'Security Issues', type: 'SECURITY', content: securityOutput });
  }

  return categories;
}

// =====================================================================
// Claude Agents Helpers
// =====================================================================

/**
 * Run multiple Claude agents in parallel, with checkpoint caching.
 */
async function runAgentsTeam<T>(opts: {
  teamName: string;
  agents: Array<{
    name: string;
    prompt: string;
    timeout: number;
    opts: Record<string, unknown>;
    required: boolean;
    checkpointKey: string;
  }>;
  state: PipelineState;
  claude: Claude;
  merge: (results: Array<{ name: string; output: string | null }>) => T;
}): Promise<T> {
  const data = d(opts.state);
  logInfo(`[${opts.teamName}] Running ${opts.agents.length} agent(s) in parallel`);

  const settled = await Promise.allSettled(
    opts.agents.map(async (agent) => {
      // Check checkpoint
      const cached = data[agent.checkpointKey];
      if (typeof cached === 'string' && cached.length > 0) {
        logInfo(`[${opts.teamName}] ${agent.name}: using cached result`);
        return { name: agent.name, output: cached };
      }

      try {
        logInfo(`[${opts.teamName}] ${agent.name}: starting (timeout=${agent.timeout}ms)`);
        const result = await opts.claude.callClaude(agent.prompt, agent.timeout, {
          agentName: agent.name,
          maxTurns: (agent.opts.maxTurns as number) || 15,
          projectDir: (agent.opts.cwd as string) || undefined,
        });
        data[agent.checkpointKey] = result;
        save(opts.state);
        logOk(`[${opts.teamName}] ${agent.name}: done (${result.length} chars)`);
        return { name: agent.name, output: result };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr(`[${opts.teamName}] ${agent.name} failed: ${msg}`);
        if (agent.required) throw err;
        return { name: agent.name, output: null };
      }
    }),
  );

  const results: Array<{ name: string; output: string | null }> = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results.push(s.value);
    } else {
      results.push({ name: opts.agents[i].name, output: null });
    }
  }

  return opts.merge(results);
}

/**
 * Run a single Claude agent with checkpoint caching.
 */
async function runSingleAgent(opts: {
  name: string;
  prompt: string;
  timeout: number;
  agentOpts: Record<string, unknown>;
  state: PipelineState;
  claude: Claude;
  checkpointKey: string;
  required: boolean;
}): Promise<string> {
  const data = d(opts.state);

  // Check checkpoint
  const cached = data[opts.checkpointKey];
  if (typeof cached === 'string' && cached.length > 0) {
    logInfo(`[${opts.name}] Using cached result`);
    return cached;
  }

  logInfo(`[${opts.name}] Starting (timeout=${opts.timeout}ms)`);
  try {
    const result = await opts.claude.callClaude(opts.prompt, opts.timeout, {
      agentName: opts.name,
      maxTurns: (opts.agentOpts.maxTurns as number) || 25,
      projectDir: (opts.agentOpts.cwd as string) || undefined,
    });
    data[opts.checkpointKey] = result;
    save(opts.state);
    logOk(`[${opts.name}] Done (${result.length} chars)`);
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr(`[${opts.name}] Failed: ${msg}`);
    if (opts.required) throw err;
    return '';
  }
}

/**
 * Apply complexity-based timeout adjustment.
 */
function applyComplexityTimeout(baseMs: number, state: PipelineState): number {
  const data = d(state);
  const complexity = data._complexity as string | undefined;
  if (complexity === 'high') return Math.round(baseMs * 1.5);
  if (complexity === 'very_high') return Math.round(baseMs * 2);
  return baseMs;
}

// =====================================================================
// STEP 1: Developer Agent
// =====================================================================

async function runDeveloperAgent(
  ctx: CodeGenContext,
  claude: Claude,
  config: AppConfig,
  localRepo: string,
): Promise<void> {
  const { state, approvedPlan, devFullContext, extraDocs, extraFeedback, feedback } = ctx;
  const data = d(state);
  const ticketData = ticket(state);
  const summary = (ticketData.summary as string) || '';
  const description = (ticketData.description as string) || '';
  const ac = (ticketData.ac as string) || '';
  const iType = (ticketData.issueType as string) || 'Task';
  const iPriority = (ticketData.priority as string) || 'Medium';

  const developerTimeout = config.timeouts.stageTimeouts.developer || 900_000;

  // Step 1: Reset local repo to clean enterprise-ts state
  localResetRepo(localRepo);

  // Step 2: Try parallel developer agents via task group splitting
  const taskGroups = parseTaskGroups(approvedPlan);
  const canParallelize = taskGroups.length >= 2 && taskGroups.length <= 5;

  if (canParallelize) {
    logInfo(`Agents Team -- ${taskGroups.length} parallel Developer Agents (task-group split)`);
    for (let i = 0; i < taskGroups.length; i++) {
      logInfo(`  Group ${i}: "${taskGroups[i].title}" -- ${taskGroups[i].files.length} file(s)`);
    }

    // Build FORBIDDEN file lists -- each group can only touch its own files
    const groupAgents = taskGroups.map((group, idx) => {
      const otherFiles = taskGroups
        .filter((_, i) => i !== idx)
        .flatMap((g) => g.files);
      const forbiddenList = otherFiles.length > 0
        ? `\n## FORBIDDEN FILES (owned by other agents -- do NOT modify)\n${otherFiles.map((f) => `- ${f}`).join('\n')}\n`
        : '';

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
        `5. **Copy structure from similar features**: If there's an existing edit form, table, modal -- copy it.\n` +
        `6. **No unnecessary abstractions**: Don't create helpers/utils the repo doesn't already have.\n` +
        `7. **VITE_PRODUCT_ID checks**: Must use the exact enterprise product ID -- no generic multi-product conditionals.\n` +
        `8. **Enterprise app ONLY**: Do NOT modify or reference other product lines (SME, GST, TaxPro, etc.).\n` +
        `9. **NEVER delete existing functions, components, or endpoints** -- only add or modify.\n\n` +
        `## FORBIDDEN (F3 -- File Path Restrictions)\n` +
        `FORBIDDEN: You must NEVER modify files in .git/, node_modules/, or package.json scripts.\n` +
        `FORBIDDEN: You must NEVER create shell scripts (.sh, .bash) or modify CI/CD files (.gitlab-ci.yml).\n` +
        `${forbiddenList}\n` +
        `## YOUR ASSIGNED TASK GROUP\n${group.content}\n\n` +
        `## Full Plan Context (read-only -- for understanding dependencies)\n${approvedPlan}\n\n` +
        `## Jira ticket: ${state.ticket} [${iType} / ${iPriority}]\nTitle: ${summary}\nDescription:\n${sanitizeForPrompt(description)}\nAC: ${sanitizeForPrompt(ac)}\n` +
        `${extraDocs}${extraFeedback}${devFullContext}` +
        `${feedback ? `\n## Previous code review feedback (address this):\n${feedback}\n` : ''}` +
        `\n## Instructions\n` +
        `1. Read the files mentioned in YOUR task group to understand existing code\n` +
        `2. Implement ONLY the changes in your assigned task group\n` +
        `3. After all changes, provide a brief summary of what you modified/created`;

      return {
        name: `Dev Agent ${idx + 1}: ${group.title.substring(0, 50)}`,
        prompt: groupPrompt,
        timeout: applyComplexityTimeout(600_000, state),
        opts: { cwd: localRepo, maxTurns: 15 },
        required: true,
        checkpointKey: `_dev_group_${idx}`,
      };
    });

    try {
      const mergedSummary = await runAgentsTeam({
        teamName: 'Developer Team',
        agents: groupAgents,
        state,
        claude,
        merge: (results) => {
          return results
            .filter((r) => r.output)
            .map((r) => `## ${r.name}\n${r.output}`)
            .join('\n\n');
        },
      });

      // Post-merge: check for conflicts via git diff
      try {
        const diffStat = execSync('git diff --stat', { cwd: localRepo, timeout: 10_000, stdio: 'pipe' }).toString();
        logInfo(`Post-merge diff stat:\n${diffStat.substring(0, 500)}`);
      } catch { /* ignore */ }

      if (!mergedSummary || mergedSummary.trim().length === 0) {
        throw new Error('Developer Team produced empty output');
      }
      logOk('Developer Team (parallel) complete');

      // GQ7 + F3: Validate changes
      validateDevChanges(state, localRepo);

      // T2.10: Verify file changes actually exist
      const parallelChanges = localGetChanges(localRepo);
      if (!parallelChanges || parallelChanges.length === 0) {
        throw new Error('Developer Team produced no file changes -- retry required');
      }
      data._dev_complete = true;
      data._dev_summary = mergedSummary.substring(0, 2000);
      save(state);
      return;
    } catch (teamErr: unknown) {
      const msg = teamErr instanceof Error ? teamErr.message : String(teamErr);
      logWarn(`Parallel developer agents failed: ${msg.substring(0, 300)}`);
      logInfo('Falling back to single Developer Agent...');
      // Clear group checkpoints and reset
      for (let i = 0; i < taskGroups.length; i++) {
        data[`_dev_group_${i}`] = null;
      }
      localResetRepo(localRepo);
      // Fall through to single-agent mode below
    }
  }

  // Single Developer Agent (original path, or fallback)
  logInfo('Agents Team -- Developer Agent: writing code directly...');
  logInfo(`  cwd: ${localRepo} | maxTurns: 25 | timeout: ${developerTimeout / 1000}s`);
  const devResult = await runSingleAgent({
    name: 'Developer Agent',
    prompt: `You are the **Developer Agent** at MasterIndia. Write production-ready code.\n\n` +
      `## REPOSITORY ACCESS\n` +
      `You have DIRECT ACCESS to this repository. Use Read, Grep, Glob to explore, and Write/Edit to modify files.\n` +
      `DO NOT output JSON. Write changes DIRECTLY to the files on disk.\n\n` +
      `## MANDATORY RULES\n` +
      `1. **REUSE existing code**: Use the EXACT same components, hooks, utils, services, API calls, styles, constants.\n` +
      `2. **Match existing patterns EXACTLY**: Same import style, state management, error handling, naming, folder structure.\n` +
      `3. **Prefer modifying existing files** over creating new ones.\n` +
      `4. **Import from existing paths**: Same import aliases, relative paths, barrel exports.\n` +
      `5. **Copy structure from similar features**: If there's an existing edit form, table, modal -- copy it.\n` +
      `6. **No unnecessary abstractions**: Don't create helpers/utils the repo doesn't already have.\n` +
      `7. **VITE_PRODUCT_ID checks**: Must use the exact enterprise product ID -- no generic multi-product conditionals like \`=== '1' || === '2'\`.\n` +
      `8. **Enterprise app ONLY**: Do NOT modify or reference other product lines (SME, GST, TaxPro, etc.) -- stay within enterprise scope.\n` +
      `9. **NEVER delete existing functions, components, or endpoints** -- only add or modify.\n\n` +
      `## FORBIDDEN (F3 -- File Path Restrictions)\n` +
      `You may ONLY modify files within the project directory.\n` +
      `FORBIDDEN: You must NEVER modify files in .git/, node_modules/, or package.json scripts.\n` +
      `FORBIDDEN: You must NEVER create shell scripts (.sh, .bash) or modify CI/CD files (.gitlab-ci.yml).\n\n` +
      `## Pre-approved implementation plan\n${approvedPlan}\n\n` +
      `## Jira ticket: ${state.ticket} [${iType} / ${iPriority}]\nTitle: ${summary}\nDescription:\n${sanitizeForPrompt(description)}\nAC: ${sanitizeForPrompt(ac)}\n` +
      `${extraDocs}${extraFeedback}${devFullContext}` +
      `${feedback ? `\n## Previous code review feedback (address this):\n${feedback}\n` : ''}` +
      `${data.previousAttemptSummary ? `\n## Previous attempt file changes (for reference):\n${data.previousAttemptSummary}\n` : ''}` +
      `${data.parentBranch ? `\n## Q4: Parent Branch Context\nThis ticket branches from parent feature branch: ${data.parentBranch}. Ensure your changes are compatible with parent branch changes.\n` : ''}` +
      `\n## Instructions\n` +
      `1. Read the files mentioned in the plan to understand existing code\n` +
      `2. Pay special attention to API specs, field names, and payloads from Jira comments -- use EXACT names\n` +
      `3. Implement ALL changes from the plan by writing/editing files directly\n` +
      `4. After all changes, provide a brief summary:\n` +
      `   - What files you modified/created\n` +
      `   - What existing code you reused\n` +
      `   - What to test manually`,
    timeout: applyComplexityTimeout(developerTimeout, state),
    agentOpts: { cwd: localRepo, maxTurns: 25 },
    state,
    claude,
    checkpointKey: '_dev_single_result',
    required: true,
  });
  logOk('Developer Agent complete');

  // GQ7 + F3: Validate changes
  validateDevChanges(state, localRepo);

  // D10: Developer checkpoint
  data._dev_complete = true;
  data._dev_summary = devResult.substring(0, 2000);
  save(state);

  // Step 3: Extract changes from git status
  logInfo('Extracting file changes from local repo...');
  let devFileChanges = localGetChanges(localRepo);

  if (devFileChanges.length === 0) {
    logWarn('Developer Agent made no file changes -- retrying with simplified prompt...');
    logInfo(`Developer output (first 300 chars): ${devResult.substring(0, 300)}`);

    // Retry once: reset and try again with explicit instructions
    localResetRepo(localRepo);
    const retryResult = await runSingleAgent({
      name: 'Developer Agent (Retry)',
      prompt: `You are a Developer. You MUST write code files to implement this plan.\n\n` +
        `## IMPORTANT\n` +
        `- Use the Write tool to create/overwrite files\n` +
        `- Use the Edit tool to modify existing files\n` +
        `- You MUST make changes to files on disk -- do NOT just describe changes\n\n` +
        `## Plan\n${approvedPlan}\n\n` +
        `## Ticket: ${state.ticket} [${iType}]: ${summary}\n${sanitizeForPrompt(description)}\nAC: ${sanitizeForPrompt(ac)}\n` +
        `${devFullContext}` +
        `${feedback ? `Feedback: ${feedback}\n` : ''}` +
        `\n**IMPORTANT**: Enterprise app ONLY -- use exact enterprise VITE_PRODUCT_ID, no generic multi-product checks.\n` +
        `\nRead the relevant files, then implement ALL changes from the plan.`,
      timeout: applyComplexityTimeout(developerTimeout, state),
      agentOpts: { cwd: localRepo, maxTurns: 25 },
      state,
      claude,
      checkpointKey: '_dev_retry_result',
      required: true,
    });
    devFileChanges = localGetChanges(localRepo);

    if (devFileChanges.length === 0) {
      logErr('Developer Agent still made no file changes after retry.');
      logErr('This usually means Claude couldn\'t use Write/Edit tools (check permissions).');
      logInfo(`Retry output (first 500 chars): ${retryResult.substring(0, 500)}`);
      data._dev_failed = true;
      save(state);
      // Send Slack alert
      try {
        const slackService = new SlackService(config.slack?.token || '', req as any);
        await slackService.send(
          `*Code Gen Failed -- ${state.ticket}*\nDeveloper Agent produced 0 file changes after retry.\nThis usually means Claude couldn't use Write/Edit tools.\n${config.jira.base}/browse/${state.ticket}`,
          config.slack.ownerSlackId ? [config.slack.ownerSlackId] : undefined,
        );
      } catch { /* best effort */ }
      throw new Error('Developer Agent produced 0 file changes after retry -- manual intervention required');
    }
    logOk(`Retry successful: ${devFileChanges.length} file(s) changed`);
  }
  logOk(`${devFileChanges.length} file(s) changed`);
}

/**
 * GQ7 + F3: Validate developer changes.
 */
function validateDevChanges(state: PipelineState, localRepo: string): void {
  // GQ7: Import Resolution Validation
  try {
    const devChangedForImports = localGetChanges(localRepo);
    const unresolvedImports: Array<{ file: string; import: string; resolved: string }> = [];
    for (const c of devChangedForImports) {
      if (c.action === 'delete' || !c.content) continue;
      if (!/\.(tsx?|jsx?)$/.test(c.file_path)) continue;
      const importMatches = c.content.match(/(?:import\s+.*?from\s+['"])(\.\.?\/[^'"]+)(?:['"])/g) || [];
      for (const imp of importMatches) {
        const pathMatch = imp.match(/['"](\.\/?[^'"]+)['"]/);
        if (!pathMatch) continue;
        const importPath = pathMatch[1];
        const fileDir = path.dirname(c.file_path);
        const resolved = path.normalize(path.join(fileDir, importPath));
        const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
        let found = false;
        for (const ext of extensions) {
          const fullPath = path.join(localRepo, resolved + ext);
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
        logWarn(`  ${ui.file}: import '${ui.import}' -> ${ui.resolved} (not found)`);
      }
      addWarning(state, 'generate_code', `${unresolvedImports.length} unresolved imports detected`);
    }
  } catch (importErr: unknown) {
    const msg = importErr instanceof Error ? importErr.message : String(importErr);
    logDebug(`GQ7: Import resolution check failed: ${msg}`);
  }

  // F3: Validate changed files against forbidden paths
  const devChangedFiles = localGetChanges(localRepo);
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
    logErr(`F3: Developer modified forbidden files: ${violations.join(', ')}`);
    logInfo('Reverting local repo to clean state...');
    localResetRepo(localRepo);
    throw new Error(`Developer Agent modified forbidden files: ${violations.join(', ')}. Pipeline halted.`);
  }
}

// =====================================================================
// STEP 2: Test & Verify
// =====================================================================

// ── 2a: Reviewer + Security (parallel) + Fixer ─────────────────────

async function runReviewerAndSecurity(
  ctx: CodeGenContext,
  fileChanges: FileChange[],
  originalFiles: Record<string, string>,
  claude: Claude,
  config: AppConfig,
  localRepo: string,
): Promise<FileChange[]> {
  const { state, approvedPlan } = ctx;
  const data = d(state);
  const ticketData = ticket(state);
  const summary = (ticketData.summary as string) || '';

  // D10: Skip if already reviewed on re-entry
  if (data._reviewed && data._fixed) {
    logOk('Reviewer + Fixer already complete (checkpoint) -- skipping');
    return fileChanges;
  }

  logInfo('Agents Team -- Reviewer + Security Agents (parallel)...');
  const changedFilesList = fileChanges.map((c) => `- ${c.action}: ${c.file_path}`).join('\n');

  // F9/Z2: Include approved plan for Reviewer
  const planDigest = approvedPlan ? truncateWithIndicator(approvedPlan, 8000) : '(no plan available)';

  const reviewerPrompt =
    `You are the **Reviewer Agent** at MasterIndia. Review the code changes in this repository.\n\n` +
    `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Use Read/Grep/Glob tools to verify code quality.\n\n` +
    `## Review checklist:\n` +
    `1. **Reuse violations**: Did the developer create new components/utils/hooks that already exist? Flag as CRITICAL.\n` +
    `2. **Pattern violations**: Does the code follow existing codebase patterns?\n` +
    `3. **Bugs & missing imports**: Any runtime errors, missing dependencies, broken references?\n` +
    `4. **Unnecessary new files**: Could any new file be an update to an existing file instead?\n` +
    `5. **Generic VITE_PRODUCT_ID checks**: Flag as CRITICAL if code uses generic multi-product conditionals.\n` +
    `6. **Plan Compliance**: Compare changes against the approved plan below. Flag if Developer skipped steps.\n` +
    `7. **Non-enterprise scope**: Flag as CRITICAL if code modifies other product lines.\n\n` +
    `## Approved Plan:\n${planDigest}\n\n` +
    `Ticket: ${state.ticket} -- ${sanitizeForPrompt(summary)}\n\n` +
    `## Changed files:\n${changedFilesList}\n\n` +
    `Read the changed files, compare against existing patterns, and list all issues found.\n\n` +
    `**IMPORTANT**: End your response with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``;

  const securityPrompt =
    `You are the **Security Agent**. Audit the code changes in this repository for security issues.\n\n` +
    `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Use Read/Grep tools to check code.\n\n` +
    `## Security checklist:\n` +
    `1. **XSS**: Unescaped user input? Unsafe innerHTML/dangerouslySetInnerHTML?\n` +
    `2. **Injection**: String concatenation in API calls, SQL, or shell commands?\n` +
    `3. **Auth/Permissions**: Missing auth checks or exposed sensitive data?\n` +
    `4. **Exposed secrets**: Hardcoded API keys, tokens, passwords?\n` +
    `5. **Input validation**: Missing validation on user inputs?\n` +
    `6. **Data Isolation**: Verify tenant/product data isolation is maintained.\n` +
    `7. **PII Handling**: Check for proper PII handling.\n` +
    `8. **Product Scope**: Ensure no cross-product data leakage.\n\n` +
    `Ticket: ${state.ticket} -- ${sanitizeForPrompt(summary)}\n\n` +
    `## Changed files:\n${changedFilesList}\n\n` +
    `Read the changed files and list all security issues with severity (CRITICAL/HIGH/MEDIUM/LOW).\n\n` +
    `**IMPORTANT**: End your response with EXACTLY one of: \`VERDICT: PASS\` or \`VERDICT: FAIL\``;

  const reviewerTimeout = config.timeouts.stageTimeouts.reviewer || 600_000;

  const { reviewResult, securityResult } = await runAgentsTeam({
    teamName: 'Review Team',
    agents: [
      {
        name: 'Reviewer Agent',
        prompt: reviewerPrompt,
        timeout: applyComplexityTimeout(reviewerTimeout, state),
        opts: { cwd: localRepo, maxTurns: 15 },
        required: true,
        checkpointKey: '_reviewer_result',
      },
      {
        name: 'Security Agent',
        prompt: securityPrompt,
        timeout: applyComplexityTimeout(reviewerTimeout, state),
        opts: { cwd: localRepo, maxTurns: 10 },
        required: false,
        checkpointKey: '_security_result',
      },
    ],
    state,
    claude,
    merge: (results) => {
      const rev = results.find((r) => r.name === 'Reviewer Agent');
      const sec = results.find((r) => r.name === 'Security Agent');
      return { reviewResult: rev?.output || '', securityResult: sec?.output || '' };
    },
  });
  logOk('Review Team complete');

  // D10: Reviewed checkpoint
  data._reviewed = true;
  save(state);

  // Step 6: Fixer (conditional) -- writes fixes directly
  const reviewPassed = parseVerdict(reviewResult, 'lgtm');
  const securityPassed = parseVerdict(securityResult, 'secure');
  const hasReviewIssues = !reviewPassed;
  const hasSecurityIssues = securityResult && securityResult.length > 20 && !securityPassed;

  if (hasReviewIssues || hasSecurityIssues) {
    const categorized = categorizeIssues(
      hasReviewIssues ? reviewResult : null,
      hasSecurityIssues ? securityResult : null,
    );
    const allIssues = categorized.map((c) => `## ${c.label} (${c.type})\n${c.content}`).join('\n\n');
    const priorityOrder = categorized.map((c) => c.type).join(' > ');
    logInfo(`X5: Issue categories (priority order): ${priorityOrder}`);

    logInfo('Agents Team -- Fixer Agent: resolving issues directly...');
    const developerTimeout = config.timeouts.stageTimeouts.developer || 900_000;
    await runSingleAgent({
      name: 'Fixer Agent',
      prompt: `You are the **Fixer Agent**. Fix ALL issues found by the Reviewer and Security agents.\n\n` +
        `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Read the flagged files and fix them directly using Write/Edit.\n` +
        `DO NOT output JSON. Write fixes DIRECTLY to the files on disk.\n\n` +
        `## X5: Fix Priority Order\nFix issues in this order: ${priorityOrder}\n` +
        `COMPILATION errors first (missing imports, type errors), then SECURITY vulnerabilities, then CODE REVIEW issues, then LINT warnings.\n\n` +
        `If reuse violations were flagged, replace custom code with existing repo components/utils/hooks.\n` +
        `If security issues were flagged, fix them following OWASP best practices.\n` +
        `If generic VITE_PRODUCT_ID checks were flagged, replace with the exact enterprise product ID constant.\n` +
        `If non-enterprise scope was flagged, remove all references to other product lines.\n\n` +
        `${allIssues}\n\n` +
        `## Changed files:\n${changedFilesList}\n\n` +
        `Read each flagged file, apply the fixes, and confirm what you changed.`,
      timeout: applyComplexityTimeout(developerTimeout, state),
      agentOpts: { cwd: localRepo, maxTurns: 20 },
      state,
      claude,
      checkpointKey: '_fixer_result',
      required: true,
    });
    logOk('Fixer Agent: issues resolved');

    // D10: Fixed checkpoint
    data._fixed = true;
    save(state);

    // Step 7: Re-extract changes after fixer ran
    logInfo('Re-extracting file changes after fixes...');
    fileChanges = localGetChanges(localRepo);
    for (const c of fileChanges) {
      if (c.action === 'update' && !originalFiles[c.file_path]) {
        const orig = localGetOriginal(localRepo, c.file_path);
        if (orig) originalFiles[c.file_path] = orig;
      }
    }
  } else {
    logOk('Review: LGTM -- Security: SECURE');
    data._fixed = true;
    save(state);
  }

  return fileChanges;
}

// ── 2b: Build Check (Q5) ───────────────────────────────────────────

async function runBuildCheck(
  state: PipelineState,
  fileChanges: FileChange[],
  originalFiles: Record<string, string>,
  claude: Claude,
  config: AppConfig,
  localRepo: string,
): Promise<FileChange[]> {
  const data = d(state);

  if (!config.flags.runBuildCheck) {
    logInfo('[Build] Build check disabled (RUN_BUILD_CHECK=false)');
    return fileChanges;
  }

  if (data._build_checked) {
    logOk('[Build] Already checked (checkpoint) -- skipping');
    return fileChanges;
  }

  logInfo('Q5: Running build verification (tsc + eslint)...');
  const buildErrors: Array<{ type: string; output: string }> = [];

  try {
    // 1. Ensure node_modules exists
    const nmPath = path.join(localRepo, 'node_modules');
    if (!fs.existsSync(nmPath)) {
      logInfo('  Installing dependencies (npm install --ignore-scripts)...');
      try {
        execSync('npm install --ignore-scripts', {
          cwd: localRepo,
          timeout: config.timeouts.stageTimeouts.buildInstall || 180_000,
          stdio: 'pipe',
        });
        logOk('  Dependencies installed');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logWarn(`  npm install failed: ${msg.substring(0, 200)}`);
      }
    }

    // 2. Run tsc --noEmit
    try {
      logInfo('  Running TypeScript check...');
      execSync('npx tsc --noEmit --pretty 2>&1 | head -50', {
        cwd: localRepo,
        timeout: config.timeouts.stageTimeouts.buildTsc || 120_000,
        stdio: 'pipe',
        shell: '/bin/bash',
      });
      logOk('  TypeScript: No errors');
      data._build_tsc = 'PASS';
    } catch (tscErr: unknown) {
      const err = tscErr as { stdout?: Buffer; stderr?: Buffer };
      const tscOutput = (err.stdout || err.stderr || '').toString().substring(0, 3000);
      logWarn(`  TypeScript errors found:\n${tscOutput.substring(0, 500)}`);
      buildErrors.push({ type: 'typescript', output: tscOutput });
      data._build_tsc = 'FAIL';
    }

    // 3. Run eslint on changed files
    const changedPaths = fileChanges.map((c) => c.file_path).filter((p) => /\.(tsx?|jsx?)$/.test(p));
    if (changedPaths.length > 0) {
      try {
        logInfo(`  Running ESLint on ${changedPaths.length} file(s)...`);
        const escapePath = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
        const eslintCmd = `npx eslint ${changedPaths.map(escapePath).join(' ')} --format json 2>&1`;
        execSync(eslintCmd, {
          cwd: localRepo,
          timeout: config.timeouts.stageTimeouts.buildEslint || 60_000,
          stdio: 'pipe',
          shell: '/bin/bash',
        });
        logOk('  ESLint: No errors');
        data._build_eslint = 'PASS';
      } catch (eslintErr: unknown) {
        const err = eslintErr as { stdout?: Buffer; stderr?: Buffer };
        const eslintOutput = (err.stdout || err.stderr || '').toString().substring(0, 3000);
        logWarn('  ESLint errors found');
        buildErrors.push({ type: 'eslint', output: eslintOutput });
        data._build_eslint = 'FAIL';
      }
    } else {
      data._build_eslint = 'SKIP';
    }

    // If build errors -> pass to Build Fixer Agent for one more attempt
    if (buildErrors.length > 0 && !data._build_fix_attempted) {
      logInfo('Q5: Build errors found -- sending to Fixer Agent...');
      data._build_fix_attempted = true;
      save(state);
      const buildIssues = buildErrors.map((e) => `## [BUILD-${e.type.toUpperCase()}]\n\`\`\`\n${e.output}\n\`\`\``).join('\n\n');
      const developerTimeout = config.timeouts.stageTimeouts.developer || 900_000;
      const fixResult = await runSingleAgent({
        name: 'Build Fixer Agent',
        prompt: `You are the **Build Fixer Agent**. Fix ALL build errors below.\n\n` +
          `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Read the flagged files and fix them directly using Write/Edit.\n\n` +
          `${buildIssues}\n\n` +
          `## Changed files:\n${fileChanges.map((c) => `- ${c.action}: ${c.file_path}`).join('\n')}\n\n` +
          `Read the erroring files, fix the build issues, and confirm what you changed.`,
        timeout: applyComplexityTimeout(developerTimeout, state),
        agentOpts: { cwd: localRepo, maxTurns: 15 },
        state,
        claude,
        checkpointKey: '_build_fix_result',
        required: false,
      });
      if (fixResult) {
        logOk('Build Fixer Agent complete -- re-extracting changes');
        fileChanges = localGetChanges(localRepo);
        for (const c of fileChanges) {
          if (c.action === 'update' && !originalFiles[c.file_path]) {
            const orig = localGetOriginal(localRepo, c.file_path);
            if (orig) originalFiles[c.file_path] = orig;
          }
        }
      } else {
        logWarn('Build Fixer Agent failed -- proceeding with build errors');
      }
    }
  } catch (buildErr: unknown) {
    const msg = buildErr instanceof Error ? buildErr.message : String(buildErr);
    logWarn(`Q5: Build verification error: ${msg}`);
  }
  data._build_checked = true;
  save(state);

  return fileChanges;
}

// ── 2c: Runtime Tests ───────────────────────────────────────────────

async function runRuntimeTests(
  state: PipelineState,
  fileChanges: FileChange[],
  originalFiles: Record<string, string>,
  config: AppConfig,
  localRepo: string,
): Promise<FileChange[]> {
  const data = d(state);

  if (!config.flags.runRuntimeTests) {
    logInfo('[Tests] Runtime tests disabled (RUN_RUNTIME_TESTS=false)');
    return fileChanges;
  }

  if (data._unit_tests_complete) {
    logOk('[Tests] Already complete (checkpoint) -- skipping');
    return fileChanges;
  }

  logInfo('[Tests] Running runtime tests...');

  // Unit tests via npm test
  try {
    const unitTimeout = config.timeouts.stageTimeouts.unitTests || 180_000;
    logInfo('  Running unit tests (npm test)...');
    const testOutput = execSync('npm test -- --passWithNoTests --reporter=verbose 2>&1 || true', {
      cwd: localRepo,
      timeout: unitTimeout,
      stdio: 'pipe',
      shell: '/bin/bash',
    }).toString();

    // Parse test output for pass/fail counts
    const passMatch = testOutput.match(/(\d+)\s+pass/i);
    const failMatch = testOutput.match(/(\d+)\s+fail/i);
    const totalMatch = testOutput.match(/(\d+)\s+test/i);

    const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
    const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
    const total = totalMatch ? parseInt(totalMatch[1], 10) : passed + failed;

    data._unit_tests_count = { passed, failed, total, flaky: 0 };

    if (failed > 0) {
      logWarn(`  Unit tests: ${passed}/${total} passed, ${failed} failed`);
      data._unit_tests_complete = 'FAIL';
    } else if (total > 0) {
      logOk(`  Unit tests: ${passed}/${total} passed`);
      data._unit_tests_complete = 'PASS';
    } else {
      logInfo('  Unit tests: No tests found');
      data._unit_tests_complete = 'PASS';
    }
  } catch (testErr: unknown) {
    const msg = testErr instanceof Error ? testErr.message : String(testErr);
    logWarn(`  Unit tests error: ${msg.substring(0, 200)}`);
    data._unit_tests_complete = 'INCONCLUSIVE';
  }

  save(state);
  return fileChanges;
}

// ── 2d: AC Verification (Q6) ───────────────────────────────────────

async function runACVerification(
  state: PipelineState,
  fileChanges: FileChange[],
  originalFiles: Record<string, string>,
  changes: CodeChanges,
  claude: Claude,
  config: AppConfig,
  localRepo: string,
): Promise<FileChange[]> {
  const data = d(state);
  const ac = (ticket(state).ac as string) || '';

  if (data._ac_verified || (ticket(state).ac_missing as boolean) || !ac || !ac.trim()) {
    if (ticket(state).ac_missing) {
      logInfo('Q6: Skipping AC verification (no acceptance criteria)');
      data._ac_verified = true;
      data._ac_verification = 'Skipped -- no acceptance criteria';
    }
    return fileChanges;
  }

  logInfo('Q6: Running AC Verification Agent...');

  // 7.1-7.3: Build test evidence section from runtime test results
  let testEvidence = '';
  if (data._unit_tests_count || data._e2e_tests_count) {
    testEvidence = '\n## Test Evidence\n';
    if (data._unit_tests_count) {
      const ut = data._unit_tests_count as { passed: number; total: number; flaky: number };
      testEvidence += `Unit Tests: ${ut.passed}/${ut.total} passed` +
        (ut.flaky > 0 ? ` (${ut.flaky} flaky)` : '') +
        ` -- Status: ${data._unit_tests_complete || 'N/A'}\n`;
    }
    if (data._e2e_tests_count) {
      const et = data._e2e_tests_count as { passed: number; total: number };
      testEvidence += `Browser Smoke: ${et.passed}/${et.total} passed` +
        ` -- Status: ${data._e2e_tests_complete || 'N/A'}\n`;
    }
    if ((data._e2e_console_errors as unknown[])?.length > 0) {
      const errors = data._e2e_console_errors as Array<{ severity: string; text?: string; message?: string }>;
      testEvidence += `Console Errors: ${errors.length} captured\n`;
      testEvidence += errors.slice(0, 5).map((e) =>
        `  - [${e.severity}] ${e.text || e.message || 'unknown'}`).join('\n') + '\n';
    }
    testEvidence += `\n**IMPORTANT**: If a test FAILED for a specific AC, weight your verdict toward PARTIAL or FAIL.\n` +
      `If a test PASSED for a specific AC, note higher confidence in PASS verdict.\n`;
  }

  const reviewerTimeout = config.timeouts.stageTimeouts.reviewer || 600_000;

  const acVerifyResult = await runSingleAgent({
    name: 'AC Verification Agent',
    prompt: `You are the **AC Verification Agent**. Compare the code changes against the acceptance criteria.\n\n` +
      `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Read the changed files to verify.\n\n` +
      `## Acceptance Criteria\n${sanitizeForPrompt(ac)}\n\n` +
      `## Changed files:\n${fileChanges.map((c) => `- ${c.action}: ${c.file_path}`).join('\n')}\n` +
      testEvidence + '\n' +
      `For EACH acceptance criterion, rate it:\n` +
      `- **PASS**: Fully implemented and working\n` +
      `- **PARTIAL**: Partially implemented, some aspects missing\n` +
      `- **FAIL**: Not implemented or incorrectly implemented\n` +
      `- **NOT_ADDRESSED**: Not relevant to the code changes\n\n` +
      `Format each as: "AC: [criterion text] -> [PASS/PARTIAL/FAIL/NOT_ADDRESSED]: [brief reason]"\n\n` +
      `End with a summary line: "OVERALL: [PASS/PARTIAL/FAIL]"`,
    timeout: applyComplexityTimeout(reviewerTimeout, state),
    agentOpts: { cwd: localRepo, maxTurns: 10 },
    state,
    claude,
    checkpointKey: '_ac_agent_result',
    required: false,
  });

  if (!acVerifyResult) {
    logWarn('Q6: AC Verification Agent failed -- will retry on next run');
    return fileChanges;
  }

  data._ac_verification = acVerifyResult;

  const failMatches = acVerifyResult.match(/->?\s*FAIL/gi) || [];
  const partialMatches = acVerifyResult.match(/->?\s*PARTIAL/gi) || [];
  const passMatches = acVerifyResult.match(/->?\s*PASS/gi) || [];

  // Fix 6b: Counter-based retry (up to 2 retries)
  data._ac_retry_count = (data._ac_retry_count as number) || 0;
  if (failMatches.length > 0 && (data._ac_retry_count as number) < 2) {
    logWarn(`Q6: ${failMatches.length} AC item(s) FAILED -- retry ${(data._ac_retry_count as number) + 1}/2`);
    data._ac_retry_count = (data._ac_retry_count as number) + 1;
    save(state);

    const developerTimeout = config.timeouts.stageTimeouts.developer || 900_000;
    const fixResult = await runSingleAgent({
      name: 'Developer Agent (AC Fix)',
      prompt: `You are the **Developer Agent**. The AC Verification Agent found FAILED acceptance criteria.\n\n` +
        `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Fix the issues directly.\n\n` +
        `## AC Verification Results\n${acVerifyResult}\n\n` +
        `## Acceptance Criteria\n${sanitizeForPrompt(ac)}\n\n` +
        `Focus ONLY on items marked FAIL. Read the relevant files and fix them.`,
      timeout: applyComplexityTimeout(developerTimeout, state),
      agentOpts: { cwd: localRepo, maxTurns: 15 },
      state,
      claude,
      checkpointKey: `_ac_fix_attempt_${data._ac_retry_count}`,
      required: false,
    });

    if (fixResult) {
      fileChanges = localGetChanges(localRepo);
      changes.changes = fileChanges;
      for (const c of fileChanges) {
        if (c.action === 'update' && !originalFiles[c.file_path]) {
          const orig = localGetOriginal(localRepo, c.file_path);
          if (orig) originalFiles[c.file_path] = orig;
        }
      }
      data.codeChanges = changes;
      save(state);
      logOk('Developer Agent fixed AC failures -- re-extracted changes');
    } else {
      logWarn('AC fix attempt failed -- proceeding with current code');
    }
  }

  // T1.5: Only mark verified AFTER retries
  if (failMatches.length > 0) {
    data._ac_known_gaps = acVerifyResult.split('\n').filter((l: string) => /->?\s*FAIL/i.test(l)).join('\n');
    if ((data._ac_retry_count as number) >= 2) {
      data._ac_verified = true;
      logWarn(`Q6: AC Verification complete with ${failMatches.length} known gap(s) after max retries`);
    }
  } else {
    data._ac_verified = true;
  }
  logOk(`Q6: AC Verification: ${passMatches.length} PASS, ${partialMatches.length} PARTIAL, ${failMatches.length} FAIL`);
  save(state);

  return fileChanges;
}

// =====================================================================
// STEP 3: Push to GitLab (Branch + Commit + MR + Slack)
// =====================================================================

async function pushCodeToGitLab(
  state: PipelineState,
  changes: CodeChanges,
  config: AppConfig,
): Promise<void> {
  const data = d(state);

  if (!changes.changes || changes.changes.length === 0) {
    throw new Error('No files to push -- ticket needs more detail.');
  }

  // L3: Validate changes array entries
  changes.changes = changes.changes.filter((c) => {
    if (!c.file_path || typeof c.file_path !== 'string' || c.file_path.trim() === '') {
      logWarn('Skipping change with empty file_path');
      return false;
    }
    if (c.action !== 'delete' && c.content === undefined) {
      logWarn(`Skipping change with undefined content: ${c.file_path}`);
      return false;
    }
    return true;
  });

  // L2: Deduplicate by file_path (keep last occurrence)
  const seen = new Map<string, FileChange>();
  for (const c of changes.changes) {
    seen.set(c.file_path, c);
  }
  changes.changes = [...seen.values()];

  if (changes.changes.length === 0) {
    throw new Error('No valid files to push after validation.');
  }

  const { GitLabService } = await import('../../services/gitlab');
  const gitlab = new GitLabService(config);
  const branch = `enterprise-ts-${state.ticket}`;
  const maxCommitFileSize = 512_000; // 512KB

  // ── Create branch ─────────────────────────────────────────────────
  if (!data.code_branch) {
    // Q4: Parent Branch Awareness
    const sourceBranch = (data.parentBranch as string) || config.branches.source;
    logInfo(`Creating branch ${branch} from ${sourceBranch}${data.parentBranch ? ' (parent feature branch)' : ''}...`);
    try {
      await gitlab.createBranch(branch, sourceBranch);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn(`Branch create: ${msg} -- may already exist`);
    }
    data.code_branch = branch;
    data.code_source_branch = sourceBranch;
    save(state);
    logOk(`Branch: ${branch} (from ${sourceBranch})`);
  }

  // ── Commit files ──────────────────────────────────────────────────
  if (!data.code_committed) {
    // Verify branch exists
    const branchInfo = await gitlab.getBranch(branch);
    if (!branchInfo) {
      logWarn(`Branch ${branch} not found on remote -- recreating...`);
      data.code_branch = null;
      save(state);
      const sourceBranch = (data.parentBranch as string) || config.branches.source;
      await gitlab.createBranch(branch, sourceBranch);
      data.code_branch = branch;
      data.code_source_branch = sourceBranch;
      save(state);
      logOk(`Branch recreated: ${branch}`);
    }

    // M5: Validate summary non-empty
    const commitSummary = ((ticket(state).summary as string) || '').trim();
    const commitMsg = commitSummary
      ? `feat(${state.ticket}): ${commitSummary}`
      : `feat(${state.ticket}): Implementation`;

    logInfo('Committing files...');

    // GQ2 + T2.18: Filter out oversized and binary files
    const validChanges: Array<{ action: string; file_path: string; content?: string }> = [];
    for (const c of changes.changes) {
      if (c.action !== 'delete') {
        // T2.18: Skip binary files
        const ext = (c.file_path.match(/\.[^.]+$/) || [''])[0].toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          logWarn(`T2.18: Skipping binary file: ${c.file_path}`);
          addWarning(state, 'generate_code', `Binary file skipped: ${c.file_path}`);
          continue;
        }
        if (c.content && c.content.includes('\0')) {
          logWarn(`T2.18: Skipping file with null bytes (binary): ${c.file_path}`);
          continue;
        }
        if (c.content && c.content.length > maxCommitFileSize) {
          logWarn(`GQ2: Skipping ${c.file_path} -- content size ${(c.content.length / 1024).toFixed(1)}KB exceeds limit ${(maxCommitFileSize / 1024).toFixed(0)}KB`);
          addWarning(state, 'generate_code', `File skipped (too large): ${c.file_path}`);
          continue;
        }
      }
      validChanges.push(c);
    }
    if (validChanges.length === 0) {
      throw new Error('No files to commit after size filtering');
    }

    const actions: GitLabCommitAction[] = validChanges.map((c) => {
      const entry: GitLabCommitAction = {
        action: (c.action as GitLabCommitAction['action']) || 'update',
        file_path: c.file_path,
      };
      if (c.action !== 'delete') entry.content = c.content || '';
      return entry;
    });

    // Attempt commit with inline recovery for known GL errors
    let commitResult: { id?: string; short_id?: string } = {};
    try {
      commitResult = await gitlab.commit(
        branch, commitMsg, actions,
        config.owner.name || 'Yogendra Singh',
        config.owner.email || 'yogendrasingh@mastersindia.co',
      );
    } catch (commitErr: unknown) {
      const errStr = commitErr instanceof Error ? commitErr.message : String(commitErr);
      // Handle "file already exists" -- switch create->update and retry
      if (/already exists/i.test(errStr) && actions.some((a) => a.action === 'create')) {
        logWarn('Some files already exist on branch -- switching create -> update and retrying commit');
        for (const a of actions) {
          if (a.action === 'create') a.action = 'update';
        }
        try {
          commitResult = await gitlab.commit(
            branch, commitMsg, actions,
            config.owner.name || 'Yogendra Singh',
            config.owner.email || 'yogendrasingh@mastersindia.co',
          );
        } catch (retryErr: unknown) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (/only create or edit files when you are on a branch/i.test(retryMsg)) {
            logWarn('Branch appears corrupt -- deleting and recreating...');
            try { await gitlab.deleteBranch(branch); } catch { /* ignore */ }
            const sourceBranch = (data.parentBranch as string) || config.branches.source;
            await gitlab.createBranch(branch, sourceBranch);
            logOk(`Branch recreated: ${branch}`);
            commitResult = await gitlab.commit(
              branch, commitMsg, actions,
              config.owner.name || 'Yogendra Singh',
              config.owner.email || 'yogendrasingh@mastersindia.co',
            );
          } else {
            throw retryErr;
          }
        }
      } else if (/only create or edit files when you are on a branch/i.test(errStr)) {
        logWarn('Branch appears corrupt -- deleting and recreating...');
        try { await gitlab.deleteBranch(branch); } catch { /* ignore */ }
        const sourceBranch = (data.parentBranch as string) || config.branches.source;
        await gitlab.createBranch(branch, sourceBranch);
        logOk(`Branch recreated: ${branch}`);
        commitResult = await gitlab.commit(
          branch, commitMsg, actions,
          config.owner.name || 'Yogendra Singh',
          config.owner.email || 'yogendrasingh@mastersindia.co',
        );
      } else {
        throw commitErr;
      }
    }

    data.code_committed = true;
    data._last_commit_sha = commitResult.id || null;
    save(state);
    logOk(`Committed ${commitResult.id ? commitResult.id.substring(0, 8) + ' ' : ''}as ${config.owner.name} <${config.owner.email}>`);
  }

  // ── GQ4: Merge conflict detection ─────────────────────────────────
  if (!data._conflict_check_done) {
    try {
      const compareResult = await gitlab.compareBranches(config.branches.qa, branch);
      if (compareResult) {
        const diffs = (compareResult as { diffs?: Array<{ new_file?: boolean; deleted_file?: boolean; renamed_file?: boolean }> }).diffs || [];
        // T2.20: Check for files modified in BOTH branches (actual conflict risk)
        const conflicts = diffs.filter((dd) => !dd.new_file && !dd.deleted_file && !dd.renamed_file);
        if (conflicts.length > 0) {
          logWarn(`GQ4: ${conflicts.length} file(s) modified in both branches -- potential merge conflicts`);
          addWarning(state, 'generate_code', `${conflicts.length} potential merge conflicts detected`);
        } else {
          logOk('GQ4: No merge conflicts detected');
        }
      }
    } catch (conflictErr: unknown) {
      const msg = conflictErr instanceof Error ? conflictErr.message : String(conflictErr);
      logDebug(`GQ4: Conflict detection failed: ${msg} -- proceeding anyway`);
    }
    data._conflict_check_done = true;
    save(state);
  }

  // ── T2.19/GQ8: Divergence check ──────────────────────────────────
  if (data.code_committed && !data._divergence_checked) {
    try {
      const remoteBranch = await gitlab.getBranch(branch);
      if (remoteBranch && remoteBranch.commit) {
        const remoteSha = remoteBranch.commit.id || '';
        if (data._last_commit_sha && data._last_commit_sha !== remoteSha) {
          logErr(`GQ8: Remote branch has diverged! Local SHA: ${(data._last_commit_sha as string).substring(0, 8)}, Remote SHA: ${remoteSha.substring(0, 8)}`);
          addWarning(state, 'generate_code', `Branch diverged: local ${(data._last_commit_sha as string).substring(0, 8)} vs remote ${remoteSha.substring(0, 8)}`);
          throw new Error(`Branch ${branch} has diverged -- remote HEAD differs from local commit. Manual resolution required.`);
        }
        logOk('GQ8: Remote branch verified -- no divergence');
      }
    } catch (divErr: unknown) {
      const msg = divErr instanceof Error ? divErr.message : String(divErr);
      if (msg.includes('diverged')) throw new Error(msg);
      logDebug(`GQ8: Divergence check failed: ${msg}`);
    }
    data._divergence_checked = true;
    save(state);
  }

  // ── Create MR ─────────────────────────────────────────────────────
  if (!data.code_mr_iid) {
    logInfo(`Creating MR: ${branch} -> ${config.branches.qa} (assigned to you)...`);

    const safeSummary = sanitizeForPrompt(changes.summary || '');
    const safeTestNotes = sanitizeForPrompt(changes.test_notes || '');

    // Q7: Quality Report
    const tscStatus = (data._build_tsc as string) || 'N/A';
    const eslintStatus = (data._build_eslint as string) || 'N/A';
    const acVerification = data._ac_verification
      ? (data._ac_known_gaps ? 'Partial -- see known gaps below' : 'All criteria met')
      : ((ticket(state).ac_missing as boolean) ? 'N/A (no AC)' : 'Not verified');
    const reviewStatus = data._reviewed ? 'Completed' : 'Pending';
    const securityStatus = data._fixed ? 'Fixed' : (data._reviewed ? 'Passed' : 'Pending');

    let qualitySection = `### Quality Report\n`;
    qualitySection += `- TypeScript: ${tscStatus === 'PASS' ? 'No errors' : tscStatus}\n`;
    qualitySection += `- ESLint: ${eslintStatus === 'PASS' ? 'No errors' : eslintStatus}\n`;
    qualitySection += `- Code Review: ${reviewStatus}\n`;
    qualitySection += `- Security: ${securityStatus}\n`;
    qualitySection += `- AC Verification: ${acVerification}\n`;

    // 8.1-8.5: Runtime Test Results
    let runtimeTestSection = '';
    if (config.flags.runRuntimeTests && (data._unit_tests_complete || data._e2e_tests_complete)) {
      runtimeTestSection = '\n### Runtime Test Results\n';
      if (data._unit_tests_complete) {
        const ut = (data._unit_tests_count || {}) as { passed?: number; total?: number; flaky?: number; failed?: number };
        if (data._unit_tests_complete === 'INCONCLUSIVE') {
          runtimeTestSection += `- Unit Tests: INCONCLUSIVE -- ${ut.failed || 0} tests could not be verified. Manual testing recommended.\n`;
        } else {
          runtimeTestSection += `- Unit Tests: ${ut.passed || 0}/${ut.total || 0} passed`;
          if ((ut.flaky || 0) > 0) runtimeTestSection += ` (${ut.flaky} flaky)`;
          runtimeTestSection += ` -- ${data._unit_tests_complete}\n`;
        }
      }
      if (data._e2e_tests_complete) {
        const et = (data._e2e_tests_count || {}) as { passed?: number; total?: number };
        if (data._e2e_tests_complete === 'INCONCLUSIVE') {
          runtimeTestSection += '- Browser Smoke: INCONCLUSIVE -- Manual testing recommended.\n';
        } else {
          runtimeTestSection += `- Browser Smoke: ${et.passed || 0}/${et.total || 0} passed -- ${data._e2e_tests_complete}\n`;
        }
        const e2eConsoleErrs = (data._e2e_console_errors || []) as Array<{ severity?: string; text?: string; message?: string }>;
        if (e2eConsoleErrs.length > 0) {
          runtimeTestSection += `- Console Warnings: ${e2eConsoleErrs.length} captured\n`;
        }
      }
      // 8.5: First 5 console errors
      const consoleErrors = (data._e2e_console_errors || []) as Array<{ severity?: string; text?: string; message?: string }>;
      if (consoleErrors.length > 0) {
        runtimeTestSection += '\n#### Console Warnings\n';
        consoleErrors.slice(0, 5).forEach((e) => {
          runtimeTestSection += `- [${e.severity || 'UNKNOWN'}] ${sanitizeForPrompt((e.text || e.message || '').substring(0, 200))}\n`;
        });
        if (consoleErrors.length > 5) runtimeTestSection += `- ... and ${consoleErrors.length - 5} more\n`;
      }
    } else if (!config.flags.runRuntimeTests || data._env_bootstrap_failed) {
      runtimeTestSection = `\n### Runtime Test Results\n- Runtime Tests: Skipped${data._env_bootstrap_failed ? ' (environment bootstrap failed)' : ''}\n`;
    }

    // Browser Verification section
    let browserVerifySection = '';
    if (config.flags.browserVerify && data._browser_verified) {
      browserVerifySection = '\n### Browser Verification\n';
      browserVerifySection += `- Status: ${data._browser_verified}\n`;
      if (data._verify_attempt) browserVerifySection += `- Attempts: ${data._verify_attempt}\n`;
      const routes = data._routes_detected as Array<{ route: string }> | undefined;
      if (routes && routes.length > 0) {
        browserVerifySection += `- Routes tested: ${routes.map((r) => r.route).join(', ')}\n`;
      }
    }

    // X9: Per-file change rationale from the plan
    let fileSection = '### Changes\n';
    const plan = (data.explore_plan as string) || '';
    for (const c of changes.changes) {
      const fileName = c.file_path.split('/').pop();
      const planLines = plan.split('\n');
      const rationale = planLines.find((l) => l.includes(fileName || '') || l.includes(c.file_path));
      fileSection += `- ${c.action}: \`${c.file_path}\`${rationale ? ` -- ${rationale.replace(/^[-*\u2022\s]+/, '').substring(0, 100)}` : ''}\n`;
    }

    // Known gaps from AC verification
    let gapSection = '';
    if (data._ac_known_gaps) {
      gapSection = `\n### Known Gaps\n${data._ac_known_gaps}\n`;
    }

    // S11: Redact secrets from MR description
    const mrDescription =
      `## ${state.ticket} -- ${(ticket(state).summary as string) || ''}\n\n` +
      `${safeSummary}\n\n` +
      `${qualitySection}\n` +
      `${runtimeTestSection ? runtimeTestSection + '\n' : ''}` +
      `${browserVerifySection ? browserVerifySection + '\n' : ''}` +
      `${fileSection}\n` +
      `### Test Notes\n${safeTestNotes}\n` +
      `${gapSection}\n` +
      `---\nAI Dev Agent | Branch: \`${(data.code_source_branch as string) || config.branches.source}\` -> \`${branch}\``;

    // T2.24: Sanitize MR title
    const mrTitle = `feat(${state.ticket}): ${((ticket(state).summary as string) || '').replace(/\n/g, ' ').replace(/[<>]/g, '').substring(0, 100)}`;

    const mr = await gitlab.createMR({
      sourceBranch: branch,
      targetBranch: config.branches.qa,
      title: mrTitle,
      description: mrDescription,
      assigneeId: config.owner.gitlabId ?? null,
      removeSourceBranch: false,
    });
    data.code_mr_iid = mr.iid;
    data.code_mr_url = mr.web_url;
    save(state);
    logOk(`MR !${mr.iid} created and assigned`);
  }

  // ── Slack notification only -- NO Jira comment ────────────────────
  if (!data.code_slack_sent) {
    try {
      const slackService = new SlackService(config.slack?.token || '', req as any);
      await slackService.send(
        `*Code Review Required -- ${state.ticket}*\n` +
        `Agent generated code for: *${(ticket(state).summary as string) || ''}*\n` +
        `MR: ${data.code_mr_url}\n` +
        `Approve the MR on GitLab to proceed.`,
        config.slack.ownerSlackId ? [config.slack.ownerSlackId] : undefined,
      );
      data.code_slack_sent = true;
      save(state);
      logOk('Slack notification sent (no Jira comment)');
    } catch (slackErr: unknown) {
      const msg = slackErr instanceof Error ? slackErr.message : String(slackErr);
      logWarn(`Slack notification failed: ${msg}`);
      data.code_slack_sent = true; // Don't retry
      save(state);
    }
  }

  state.stage = 'gate_code_review' as any;
  save(state);
}

// =====================================================================
// Main Stage Handler
// =====================================================================

/**
 * Generate Code stage handler.
 *
 * Orchestrates the full 3-step code generation pipeline:
 *
 *   STEP 1: Developer Agent (write code)
 *     - Parallel multi-agent (task group split) or single agent
 *     - GQ7 + F3 validation
 *     - Retry on zero files
 *
 *   STEP 2: Test & Verify
 *     - Reviewer + Security agents (parallel)
 *     - Fixer agent (conditional, priority-ordered)
 *     - Q5: Build check (tsc + eslint + build fixer)
 *     - Runtime tests (unit tests)
 *     - Q6: AC verification (with retry)
 *
 *   STEP 3: Create MR
 *     - Branch creation, commit, conflict detection, divergence check
 *     - Rich MR description with quality report
 *     - Slack notification
 */
export async function stageGenerateCode(state: PipelineState): Promise<void> {
  logStep('2-3', 'Generate code with Claude AI');

  const config = loadConfig();
  const ext = loadExtendedConfig();
  const data = d(state);

  const maxRejections = config.limits.maxRejections;

  // H1/H4: Track internal rejection counter
  const codegenRejections = (data._codegen_rejections as number) || 0;
  if (codegenRejections >= maxRejections) {
    logErr(`Code generation rejected ${codegenRejections} times (max: ${maxRejections}) -- halting pipeline`);
    try {
      const slackService = new SlackService(config.slack?.token || '', req as any);
      await slackService.send(
        `*Code Gen Rejection Limit -- ${state.ticket}*\nCode was rejected ${codegenRejections} times by internal reviewer/security. Pipeline halted.`,
        config.slack.ownerSlackId ? [config.slack.ownerSlackId] : undefined,
      );
    } catch { /* best effort */ }
    saveAndThrow(state, `Code generation exceeded MAX_REJECTIONS (${maxRejections})`);
  }

  // R6: Config mode switch guard
  const localRepo = (data._localRepo as string) || '';
  const currentMode = localRepo ? 'local' : 'legacy';
  const previousMode = data._codegen_mode as string | undefined;
  if (previousMode && previousMode !== currentMode) {
    logWarn(`R6: Code generation mode changed (${previousMode} -> ${currentMode}) -- clearing previous code`);
    data.codeChanges = undefined;
    data.plan = undefined;
  }
  data._codegen_mode = currentMode;

  // Skip if code already generated and no new feedback
  if (data.codeChanges && !data.feedback && data.plan) {
    logOk('Code already generated -- skipping to branch/commit/MR');
    const changes = data.codeChanges as CodeChanges;
    await pushCodeToGitLab(state, changes, config);
    return;
  }

  // Extract ticket data
  const ticketData = ticket(state);
  if (!ticketData) {
    saveAndThrow(state, 'No ticket data found -- fetch_ticket stage may not have completed');
  }

  const feedback = (data.feedback as string) || '';
  const approvedPlan = (data.explore_plan as string) || '';
  const supplementaryDocs = (ticketData.supplementaryDocs as string) || '';
  const planFeedback = (ticketData.planFeedback as string) || '';

  const extraDocs = supplementaryDocs ? `\nSupplementary docs:\n${supplementaryDocs}\n` : '';
  const extraFeedback = planFeedback ? `\nPlan feedback:\n${planFeedback}\n` : '';
  const devFullContext = buildFullContext(state);

  const ctx: CodeGenContext = { state, approvedPlan, devFullContext, extraDocs, extraFeedback, feedback };

  // Initialize Claude service
  const apiKey = ext.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '';
  let claudeService: Claude;
  if (apiKey) {
    claudeService = new ClaudeService(apiKey, req as never);
  } else {
    logInfo('[Claude] No ANTHROPIC_API_KEY -- using Claude CLI (browser auth)');
    claudeService = new ClaudeCLIService({ model: ext.claudeModel as string | undefined });
  }
  if (localRepo) {
    claudeService.setProjectDir(localRepo);
  }

  // ═══════════════════════════════════════════════════════════════════
  // LOCAL REPO MODE (preferred -- full pipeline)
  // ═══════════════════════════════════════════════════════════════════
  if (localRepo) {
    logInfo('Using local repo for code generation (file-based approach)');

    // D10: Skip completed sub-stages on re-entry -- only fast-path if ALL stages done
    const allStagesDone = data._dev_complete && data._reviewed && data._fixed
      && (!config.flags.runRuntimeTests || data._unit_tests_complete)
      && (!config.flags.browserVerify || data._browser_verified)
      && (data._ac_verified || !(ticketData.ac as string)?.trim());

    if (allStagesDone) {
      logOk('All sub-stages complete (dev/review/fix/tests/verify/AC) -- extracting final changes');
      const fileChanges = localGetChanges(localRepo);
      if (fileChanges.length > 0) {
        const originalFiles: Record<string, string> = {};
        for (const c of fileChanges) {
          if (c.action === 'update') {
            const orig = localGetOriginal(localRepo, c.file_path);
            if (orig) originalFiles[c.file_path] = orig;
          }
        }
        const changes: CodeChanges = {
          changes: fileChanges,
          summary: (data._dev_summary as string) || 'Resumed from checkpoint',
          test_notes: 'See developer summary',
        };
        data.original_files = originalFiles;
        data.codeChanges = changes;
        data.plan = approvedPlan;
        delete data.feedback;
        save(state);
        await pushCodeToGitLab(state, changes, config);
        try { localResetRepo(localRepo); } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logWarn(`Post-push reset failed: ${msg}`);
        }
        return;
      }
    }

    // ── STEP 1: Developer Agent ───────────────────────────────────
    if (!data._dev_complete) {
      await runDeveloperAgent(ctx, claudeService, config, localRepo);
    } else {
      logOk('Developer already complete (checkpoint) -- skipping to review');
    }

    // Fetch originals for diff viewer
    let fileChanges = localGetChanges(localRepo);
    const originalFiles: Record<string, string> = {};
    for (const c of fileChanges) {
      if (c.action === 'update') {
        const orig = localGetOriginal(localRepo, c.file_path);
        if (orig) originalFiles[c.file_path] = orig;
      }
    }

    // ── STEP 2: Test & Verify ─────────────────────────────────────

    // 2a: Reviewer + Security (parallel) + Fixer
    fileChanges = await runReviewerAndSecurity(ctx, fileChanges, originalFiles, claudeService, config, localRepo);
    logOk(`${fileChanges.length} file(s) ready`);

    // 2b: Q5 Build Check (may write via fixer)
    if (config.flags.runBuildCheck && !data._build_checked) {
      fileChanges = await runBuildCheck(state, fileChanges, originalFiles, claudeService, config, localRepo);
    }

    // 2c: Runtime Tests
    fileChanges = await runRuntimeTests(state, fileChanges, originalFiles, config, localRepo);

    // 2d: Q6 AC Verification
    const needsACVerification = !data._ac_verified && (ticketData.ac as string) &&
      (ticketData.ac as string).trim() && !(ticketData.ac_missing as boolean);
    if (needsACVerification) {
      const tempChanges: CodeChanges = {
        changes: fileChanges,
        summary: ((data._dev_summary as string) || '').substring(0, 2000),
        test_notes: 'See developer summary above',
      };
      fileChanges = await runACVerification(state, fileChanges, originalFiles, tempChanges, claudeService, config, localRepo);
    }

    // Re-fetch final file changes after all stages
    fileChanges = localGetChanges(localRepo);
    for (const c of fileChanges) {
      if (c.action === 'update' && !originalFiles[c.file_path]) {
        const orig = localGetOriginal(localRepo, c.file_path);
        if (orig) originalFiles[c.file_path] = orig;
      }
    }

    // Zero-files guard
    if (!fileChanges || fileChanges.length === 0) {
      logErr('No files were changed by code generation -- cannot push empty changeset');
      saveAndThrow(state, 'No files were changed by code generation');
    }

    // GAP-2: Mark test phase complete
    data._test_phase_complete = true;
    save(state);

    // ── STEP 3: Create MR ─────────────────────────────────────────

    const changes: CodeChanges = {
      changes: fileChanges,
      summary: ((data._dev_summary as string) || '').substring(0, 2000),
      test_notes: 'See developer summary above',
    };

    data.original_files = originalFiles;
    data.codeChanges = changes;
    data.plan = approvedPlan;
    if (data.feedback) {
      if (!data.rejectionHistory) data.rejectionHistory = [];
      (data.rejectionHistory as Array<{ feedback: string; ts: string }>).push({
        feedback: data.feedback as string,
        ts: new Date().toISOString(),
      });
    }
    delete data.feedback;
    save(state);

    await pushCodeToGitLab(state, changes, config);

    // Reset local repo after extracting all data
    try { localResetRepo(localRepo); } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn(`Post-push reset failed: ${msg}`);
    }

  } else {
    // ═══════════════════════════════════════════════════════════════
    // LEGACY MODE (API-based, simplified)
    // ═══════════════════════════════════════════════════════════════
    logInfo('Using legacy API-based code generation (no local repo)');

    // Step 1: Developer Agent (API mode -- returns text summary)
    if (!data._dev_complete) {
      const developerTimeout = config.timeouts.stageTimeouts.developer || 900_000;
      const devResult = await runSingleAgent({
        name: 'Developer Agent',
        prompt: `You are the **Developer Agent** at MasterIndia. Generate code changes as JSON.\n\n` +
          `## Task: ${state.ticket}\n${(ticketData.summary as string) || ''}\n\n` +
          `## Description\n${sanitizeForPrompt((ticketData.description as string) || '')}\n\n` +
          `## Plan\n${approvedPlan}\n\n` +
          `${devFullContext}${extraDocs}${extraFeedback}` +
          `${feedback ? `\n## Feedback:\n${feedback}\n` : ''}` +
          `\nReturn a JSON object with: { "changes": [{ "file_path": "...", "action": "create|update|delete", "content": "..." }], "summary": "...", "test_notes": "..." }`,
        timeout: applyComplexityTimeout(developerTimeout, state),
        agentOpts: { maxTurns: 15 },
        state,
        claude: claudeService,
        checkpointKey: '_dev_single_result',
        required: true,
      });

      data._dev_complete = true;
      data._dev_summary = devResult.substring(0, 5000);
      save(state);
      logOk('Developer Agent complete (legacy mode)');

      // Parse JSON response
      try {
        const jsonMatch = devResult.match(/\{[\s\S]*"changes"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          data.codeChanges = parsed;
        }
      } catch (parseErr: unknown) {
        logWarn('Could not parse developer JSON output -- will use raw text');
      }
    }

    // Step 2: Reviewer (simplified for legacy)
    if (!data._reviewed && data.codeChanges) {
      const changes = data.codeChanges as CodeChanges;
      const reviewerTimeout = config.timeouts.stageTimeouts.reviewer || 600_000;
      const reviewResult = await runSingleAgent({
        name: 'Reviewer Agent',
        prompt: `Review these code changes for ${state.ticket}:\n\n` +
          `${JSON.stringify((changes.changes || []).map((c: FileChange) => ({ action: c.action, file_path: c.file_path })), null, 2)}\n\n` +
          `Developer Summary: ${data._dev_summary || ''}\n\n` +
          `Check: reuse violations (CRITICAL), pattern compliance, bugs, security.\n` +
          `End with VERDICT: PASS or VERDICT: FAIL`,
        timeout: reviewerTimeout,
        agentOpts: { maxTurns: 10 },
        state,
        claude: claudeService,
        checkpointKey: '_reviewer_result',
        required: false,
      });

      data._reviewed = true;
      const isApproved = parseVerdict(reviewResult, 'lgtm');
      if (!isApproved) {
        data._codegen_rejections = codegenRejections + 1;
        logWarn(`[Review] Code rejected (${data._codegen_rejections}/${maxRejections})`);
      }
      data._fixed = true;
      save(state);
    }

    // Step 3: Push to GitLab
    if (data.codeChanges) {
      const changes = data.codeChanges as CodeChanges;
      data.plan = approvedPlan;
      if (data.feedback) {
        if (!data.rejectionHistory) data.rejectionHistory = [];
        (data.rejectionHistory as Array<{ feedback: string; ts: string }>).push({
          feedback: data.feedback as string,
          ts: new Date().toISOString(),
        });
      }
      delete data.feedback;
      save(state);

      await pushCodeToGitLab(state, changes, config);
    } else {
      saveAndThrow(state, 'Developer Agent produced no code changes (legacy mode)');
    }
  }
}