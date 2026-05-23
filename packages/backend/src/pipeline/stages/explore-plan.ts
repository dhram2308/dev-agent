// =====================================================================
// MI Dev Agent -- Explore & Plan Stage (TypeScript port)
// =====================================================================
// Stage 1b: Analyze ticket with agents team, build implementation plan.
//
// Sub-stages:
//   1. Inaccessible document detection + user notification
//   2. Analysis Team (3 parallel sub-agents: Requirements, Code Explorer, Risk)
//   3. OpenSpec scaffold + Architect Agent (produces 4 structured artifacts)
//   4. Plan approval polling (Web UI + Jira comments)
//   5. Refinement loop (iterative plan improvement)
//
// Ported from: stages/explore-plan.js
// =====================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { PipelineState } from '@shared/types';
import { STAGE_CLEARS } from '@shared/constants';
import {
  logStep, logOk, logErr, logInfo, logWarn, logWait,
} from '../../lib/logger';
import {
  sanitizeForPrompt, truncateWithIndicator,
  matchApprovalWord, validateClaudeOutput, validateClaudeNotEmpty,
} from '../../lib/utils';
import { isShuttingDown } from '../../lib/graceful-shutdown';
import { isChannelEnabled } from '../../lib/notification-gates';

// ── Types ────────────────────────────────────────────────────────────

/** Inaccessible document entry */
interface InaccessibleDoc {
  type: string;
  url: string;
  criticality: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  instructions: string;
  reason?: string;
}

/** OpenSpec scaffold result */
interface ScaffoldResult {
  changeName: string;
  changeDir: string;
  artifacts: unknown[];
  templates: Record<string, TemplateInfo | null>;
}

/** OpenSpec template info from CLI */
interface TemplateInfo {
  outputPath: string;
  instruction: string;
  rules?: string[];
  template: string;
}

/** Parsed artifact sections */
interface ParsedArtifacts {
  proposal: string;
  design: string;
  specs: string;
  tasks: string;
}

/** Dependencies injected into the stage */
export interface ExplorePlanDeps {
  /** Project root path (for OpenSpec CLI) */
  projectRoot: string;
  /** Jira service */
  jira: {
    addComment: (ticket: string, body: string) => Promise<void>;
    getComments: (ticket: string, since?: string) => Promise<Array<{
      author?: { displayName?: string };
      body: unknown;
      created?: string;
    }>>;
  };
  /** GitLab service */
  gl: {
    getTree: (path: string, branch: string, recursive: boolean) => Promise<Array<{ path: string; type: string }>>;
  };
  /** Slack notification function */
  slack: (message: string, mentions?: string[]) => Promise<void>;
  /** Save pipeline state */
  save: (state: PipelineState) => void;
  /** Check UI approval */
  checkUIApproval: (state: PipelineState, key: string) => { approved: boolean; feedback?: string } | null;
  /** Agent runner */
  runAgentsTeam: (opts: AgentsTeamOpts) => Promise<string>;
  /** Single agent runner */
  runSingleAgent: (opts: SingleAgentOpts) => Promise<string>;
  /** Local repo tree function */
  localGetTree?: (repoPath: string) => Array<{ path: string; type: string }>;
  /** ADF text extraction */
  adfText: (body: unknown) => string;
  /** ADF to markdown conversion */
  adfToMarkdown: (body: unknown) => string;
  /** URL classifier */
  classifyDocUrl: (url: string) => string;
  /** Doc paste instructions */
  getDocPasteInstructions: (docType: string) => string;
  /** Assess document criticality */
  assessDocCriticality: (docType: string, ticketText: string) => 'CRITICAL' | 'HIGH' | 'MEDIUM';
  /** Jira URL builder */
  jiraUrl: (ticket: string) => string;
  /** Sleep function */
  sleep: (ms: number) => Promise<void>;
  /** Config */
  cfg: {
    ticket: string;
    localRepo?: string;
    branch: { ts: string };
    slack: { ownerId: string };
    urls?: { qa?: string };
  };
  /** Config timeouts */
  pollInterval: number;
  maxApprovalTimeout: number;
  maxContinueWait: number;
  maxPlanRejections: number;
  analysisTimeoutMs: number;
  /** Apply complexity timeout */
  applyComplexityTimeout: (baseMs: number, state: PipelineState) => number;
  /** Monotonic clock */
  monotonicMs: () => number;
}

/** Agent team options */
interface AgentsTeamOpts {
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
  merge: (results: Array<{ name: string; output: string | null }>) => string;
}

/** Single agent options */
interface SingleAgentOpts {
  name: string;
  prompt: string;
  timeout: number;
  opts: Record<string, unknown>;
  state: PipelineState;
  checkpointKey: string;
  required: boolean;
}

// ── OpenSpec CLI integration ─────────────────────────────────────────

/**
 * Scaffold an OpenSpec change for the ticket.
 * Runs: openspec new change, openspec status --json, openspec instructions --json for each artifact.
 */
function scaffoldOpenSpec(ticket: string, projectRoot: string): ScaffoldResult | null {
  const changeName = ticket.toLowerCase();
  const changeDir = path.join(projectRoot, 'openspec', 'changes', changeName);

  try {
    // Create the change if it doesn't already exist
    if (!fs.existsSync(changeDir)) {
      logInfo(`OpenSpec: creating change '${changeName}'...`);
      execSync(`openspec new change "${changeName}"`, {
        cwd: projectRoot, stdio: 'pipe', timeout: 30000,
      });
    } else {
      logInfo(`OpenSpec: change '${changeName}' already exists`);
    }

    // Get status with artifact list
    const statusRaw = execSync(`openspec status --change "${changeName}" --json`, {
      cwd: projectRoot, stdio: 'pipe', timeout: 15000,
    });
    const status = JSON.parse(statusRaw.toString().trim());

    // Get instructions for each artifact
    const templates: Record<string, TemplateInfo | null> = {};
    const artifactIds = ['proposal', 'design', 'specs', 'tasks'];
    for (const id of artifactIds) {
      try {
        const instrRaw = execSync(`openspec instructions ${id} --change "${changeName}" --json`, {
          cwd: projectRoot, stdio: 'pipe', timeout: 15000,
        });
        templates[id] = JSON.parse(instrRaw.toString().trim()) as TemplateInfo;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(`OpenSpec: failed to get instructions for '${id}': ${msg}`);
        templates[id] = null;
      }
    }

    const templateCount = Object.keys(templates).filter((k) => templates[k]).length;
    logOk(`OpenSpec: scaffolded '${changeName}' with ${templateCount} artifact templates`);
    return { changeName, changeDir, artifacts: status.artifacts || [], templates };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr(`OpenSpec scaffold failed: ${msg}`);
    return null;
  }
}

/**
 * Parse architect output by markers and write artifacts to disk.
 * Markers: ---PROPOSAL---, ---DESIGN---, ---SPECS---, ---TASKS---
 */
function parseAndWriteArtifacts(
  output: string,
  scaffoldInfo: { changeName: string; changeDir: string },
): ParsedArtifacts | null {
  const markers = ['---PROPOSAL---', '---DESIGN---', '---SPECS---', '---TASKS---'];
  const sections: Record<string, string> = {};

  try {
    // T2.5: Use line-anchored regex to avoid matching markers inside code blocks
    for (let i = 0; i < markers.length; i++) {
      const markerRegex = new RegExp(`^${markers[i].replace(/-/g, '\\-')}\\s*$`, 'm');
      const markerMatch = markerRegex.exec(output);
      if (!markerMatch) continue;
      const contentStart = markerMatch.index + markerMatch[0].length;
      // Find end: next marker or end of output
      let endIdx = output.length;
      for (let j = i + 1; j < markers.length; j++) {
        const nextRegex = new RegExp(`^${markers[j].replace(/-/g, '\\-')}\\s*$`, 'm');
        const nextMatch = nextRegex.exec(output.substring(contentStart));
        if (nextMatch) {
          endIdx = contentStart + nextMatch.index;
          break;
        }
      }
      const key = markers[i].replace(/---/g, '').toLowerCase();
      sections[key] = output.substring(contentStart, endIdx).trim();
    }

    // Require at least proposal and tasks
    if (!sections.proposal && !sections.tasks) {
      logWarn('OpenSpec: could not parse markers from architect output -- using raw output');
      return null;
    }

    // Write artifacts to disk
    const { changeDir } = scaffoldInfo;
    fs.mkdirSync(changeDir, { recursive: true });

    if (sections.proposal) {
      fs.writeFileSync(path.join(changeDir, 'proposal.md'), sections.proposal, 'utf8');
    }
    if (sections.design) {
      fs.writeFileSync(path.join(changeDir, 'design.md'), sections.design, 'utf8');
    }
    if (sections.specs) {
      const specsDir = path.join(changeDir, 'specs', 'change');
      fs.mkdirSync(specsDir, { recursive: true });
      fs.writeFileSync(path.join(specsDir, 'spec.md'), sections.specs, 'utf8');
    }
    if (sections.tasks) {
      fs.writeFileSync(path.join(changeDir, 'tasks.md'), sections.tasks, 'utf8');
    }

    // Write .openspec.yaml marker
    const yamlContent = `schema: spec-driven\nchange: ${scaffoldInfo.changeName}\ncreated: ${new Date().toISOString()}\n`;
    fs.writeFileSync(path.join(changeDir, '.openspec.yaml'), yamlContent, 'utf8');

    logOk(`OpenSpec: wrote ${Object.keys(sections).length} artifacts to ${changeDir}`);
    return {
      proposal: sections.proposal || '',
      design: sections.design || '',
      specs: sections.specs || '',
      tasks: sections.tasks || '',
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr(`OpenSpec: parseAndWriteArtifacts failed: ${msg}`);
    return null;
  }
}

// ── Main stage function ─────────────────────────────────────────────

/**
 * Stage 1b: Explore & Plan -- analyzing ticket with agents team.
 *
 * Performs analysis, builds OpenSpec artifacts, posts plan for approval,
 * and waits for user approval/rejection/refinement.
 */
export async function stageExplorePlan(
  state: PipelineState,
  deps: ExplorePlanDeps,
): Promise<void> {
  logStep('1b', 'Explore & Plan -- analyzing ticket with agents team');

  const { cfg, save, jira, slack, sleep, adfText, adfToMarkdown } = deps;
  const TICKET = cfg.ticket;
  const data = state.data as Record<string, unknown>;
  const ticket = data.ticket as Record<string, unknown> | undefined;

  if (!ticket) {
    throw new Error('No ticket data in state -- fetch_ticket must run first');
  }

  const summary = (ticket.summary as string) || '';
  const description = (ticket.description as string) || '';
  const ac = (ticket.ac as string) || '';
  const attachments = (ticket.attachments as Array<{ filename: string }>) || [];
  const externalUrls = (ticket.externalUrls as string[]) || [];

  // No-AC handling
  if (ticket.ac_missing) {
    logInfo('No AC field in Jira -- using ticket description + comments as context');
    ticket.ac_missing = false;
    save(state);
  }

  // Q1: Smart inaccessible content detection + notification
  if (!data.explore_docs_checked) {
    const inaccessible: InaccessibleDoc[] = [];
    const ticketText = `${summary} ${description} ${ac}`;

    // URLs whose content we already retrieved -- via OAuth connectors
    // (Google Drive, Figma) or via the generic HTTP fetch loop. Anything
    // in this set has usable content in ticket.connectorContents /
    // fetchedUrlContents and must NOT be flagged as inaccessible.
    const fetchedUrls = new Set<string>();
    const connectorContents = (ticket.connectorContents as Array<{ url: string }> | undefined) || [];
    for (const c of connectorContents) fetchedUrls.add(c.url);
    const fetchedUrlContents = (ticket.fetchedUrlContents as Array<{ url: string }> | undefined) || [];
    for (const c of fetchedUrlContents) fetchedUrls.add(c.url);

    // Auth-required URLs detected during fetch (probe failed, connector
    // returned an auth error, etc.) -- these are the real failures.
    const authRequired = (ticket.authRequiredUrls as Array<{
      url: string; docType: string; reason: string;
    }>) || [];
    for (const ar of authRequired) {
      const criticality = deps.assessDocCriticality(ar.docType, ticketText);
      inaccessible.push({
        type: ar.docType,
        url: ar.url,
        criticality,
        instructions: deps.getDocPasteInstructions(ar.docType),
        reason: ar.reason,
      });
    }

    // Recognised-service URLs that were neither fetched nor recorded as
    // auth-required (e.g. matched UNFETCHABLE and got skipped silently).
    // Still need a manual paste for those.
    for (const url of externalUrls) {
      if (fetchedUrls.has(url)) continue;
      if (inaccessible.some((d) => d.url === url)) continue;
      const docType = deps.classifyDocUrl(url);
      if (docType === 'External Document') continue;
      const criticality = deps.assessDocCriticality(docType, ticketText);
      inaccessible.push({
        type: docType,
        url,
        criticality,
        instructions: deps.getDocPasteInstructions(docType),
      });
    }

    // Check unparseable attachments
    for (const att of attachments) {
      const ext = att.filename.split('.').pop()?.toLowerCase() || '';
      if (['pdf', 'docx', 'xlsx', 'pptx', 'fig', 'sketch'].includes(ext)) {
        inaccessible.push({
          type: `Attachment (${ext})`,
          url: att.filename,
          criticality: 'MEDIUM',
          instructions: 'Please paste the document content as text',
        });
      }
    }

    data.explore_inaccessible = inaccessible;
    data.explore_docs_checked = true;
    save(state);

    if (inaccessible.length > 0) {
      // Sort by criticality (CRITICAL first)
      const critOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
      inaccessible.sort((a, b) => (critOrder[a.criticality] ?? 9) - (critOrder[b.criticality] ?? 9));
      const hasCritical = inaccessible.some((d) => d.criticality === 'CRITICAL');

      logErr(`Cannot access ${inaccessible.length} document(s)${hasCritical ? ' (includes CRITICAL)' : ''}:`);
      inaccessible.forEach((d) => logErr(`  [${d.criticality}] ${d.type}: ${d.url}`));

      const docList = inaccessible.map((d, i) =>
        `${i + 1}. [${d.criticality}] ${d.type}: ${d.url}\n   ${d.instructions}${d.reason ? ` (${d.reason})` : ''}`,
      ).join('\n');

      // Ask user for help via Jira + Slack
      if (isChannelEnabled('explore_plan', 'jira')) {
        await jira.addComment(TICKET,
          `${hasCritical ? 'CRITICAL -- ' : ''}Documents Needed\n\n` +
          `I cannot access the following documents linked in this ticket:\n${docList}\n\n` +
          `Please paste the relevant content as a comment on this ticket, then comment "continue" to proceed.` +
          `${hasCritical ? '\n\nCRITICAL documents are essential for implementation.' : ''}`,
        );
      }

      if (isChannelEnabled('explore_plan', 'slack')) {
        await slack(
          `*Documents Needed -- ${TICKET}*${hasCritical ? ' (CRITICAL)' : ''}\n` +
          `Agent cannot access:\n${docList}\n\n` +
          `Paste the relevant content on the Jira ticket and comment "continue".\n` +
          `${deps.jiraUrl(TICKET)}`,
          [cfg.slack.ownerId],
        );
      }

      // Wait for user to provide docs and say "continue"
      logWait('Waiting for you to provide document content on Jira...');
      data.explore_wait_at = new Date().toISOString();
      save(state);

      const continueStart = deps.monotonicMs();
      let docPollCount = 0;
      while (true) {
        if (deps.monotonicMs() - continueStart > deps.maxContinueWait) {
          logWarn(`Document wait timed out after ${deps.maxContinueWait / 60000} minutes -- proceeding with available context`);
          if (isChannelEnabled('explore_plan', 'slack')) {
            await slack(`*Document wait timed out -- ${TICKET}*\nProceeding with available context.`, [cfg.slack.ownerId]);
          }
          break;
        }
        const comments = await jira.getComments(TICKET, data.explore_wait_at as string);
        const continueComment = comments.find((c) =>
          matchApprovalWord(adfText(c.body).toLowerCase().trim(), 'continue', ['discontinued', 'not continue']),
        );
        if (continueComment) {
          // Collect supplementary context from ALL comments
          const extraParts: string[] = [];
          for (const c of comments) {
            const md = adfToMarkdown(c.body);
            const plain = adfText(c.body).toLowerCase().trim();
            if (plain === 'continue') continue;
            const lines = md.split('\n').filter((l: string) => l.trim().toLowerCase() !== 'continue');
            const content = lines.join('\n').trim();
            if (content) {
              const author = c.author?.displayName || 'Deleted User';
              extraParts.push(`[${author}]:\n${content}`);
            }
          }
          const extraContext = extraParts.join('\n\n');
          // G11: Guard -- if no content, re-prompt
          if (!extraContext) {
            logWarn("G11: 'continue' posted but no supplementary content found -- re-prompting");
            try {
              if (isChannelEnabled('explore_plan', 'jira')) {
                await jira.addComment(TICKET, "No supplementary content detected. Please paste the document content first, then comment 'continue'.");
              }
            } catch { /* best effort */ }
            await sleep(deps.pollInterval);
            continue;
          }
          ticket.supplementaryDocs = extraContext;
          save(state);
          logOk(`Received supplementary docs (${extraContext.length} chars)`);
          break;
        }
        docPollCount++;
        if (docPollCount % 6 === 0) {
          const waitMins = Math.floor((deps.monotonicMs() - continueStart) / 60000);
          logInfo(`Waiting for document content... ${waitMins}m elapsed`);
        }
        await sleep(deps.pollInterval);
      }
    }
  }

  // ── Agents Team: Explore repo + build plan ──
  if (!data.explore_plan) {
    logInfo('Agents Team -- launching exploration...');

    // Build a compact tree
    const tree = cfg.localRepo && deps.localGetTree
      ? deps.localGetTree(cfg.localRepo)
      : await deps.gl.getTree('', cfg.branch.ts, true);

    const SRC_EXT = /\.(tsx?|jsx?|css|scss|less|json)$/i;
    const SKIP = /node_modules|\.next|dist\/|build\/|\.git\/|__pycache__|\.cache|\.husky|coverage|\.nyc|\.storybook|public\/static|assets\/(images|fonts|icons)|\.svg$|\.png$|\.jpg$|\.ico$|\.woff|\.ttf|\.map$|package-lock|yarn\.lock|\.eslint|\.prettier|\.spec\.|\.test\.|__tests__|__mocks__/i;
    const srcFiles = tree.filter((e) => e.type === 'blob' && SRC_EXT.test(e.path) && !SKIP.test(e.path));

    // Top-level directories
    const dirs = [...new Set(tree.filter((e) => e.type === 'tree' && e.path.split('/').length <= 2 && !SKIP.test(e.path)).map((e) => e.path))];
    const folderOverview = dirs.slice(0, 30).join(', ');

    // Keyword-relevant files
    const keywords = (summary + ' ' + description).toLowerCase().match(/[a-z]{3,}/g) || [];
    let relevant = srcFiles.filter((e) => {
      const p = e.path.toLowerCase();
      return keywords.some((k) => p.includes(k)) || p.includes('invoice') || p.includes('import') ||
        p.includes('edit') || p.includes('common') || p.includes('shared') || p.includes('hook') ||
        p.includes('util') || p.includes('service') || p.includes('constant') || p.includes('type');
    });
    if (relevant.length === 0) {
      logWarn('No keyword-matched files found -- falling back to first 50 source files');
      relevant = srcFiles.slice(0, 50);
    }

    const treeList = relevant.slice(0, 100).map((e) => e.path).join('\n');
    logInfo(`Repo: ${tree.length} total, ${srcFiles.length} source files, ${relevant.length} relevant`);

    const supplementary = ticket.supplementaryDocs
      ? `\n## Supplementary Docs (from user)\n${ticket.supplementaryDocs}\n`
      : '';

    const iType = (ticket.issueType as string) || 'Task';
    const iPriority = (ticket.priority as string) || 'Medium';

    // D1: Sanitize user-sourced content
    const ticketCtx =
      `**${TICKET}: ${summary}** [${iType} / ${iPriority}]\n\n` +
      `## Description\n${sanitizeForPrompt(description)}\n\n` +
      `## Acceptance Criteria\n${sanitizeForPrompt(ac) || '(none provided)'}\n` +
      `${supplementary ? sanitizeForPrompt(supplementary as string) : ''}`;

    // Agent 1 -- Analysis Team
    let analysisResult = (data._agent_analysis as string) || '';

    if (!analysisResult) {
      logInfo('  -> Analysis Team: launching 3 parallel sub-agents...');

      const analysisRules =
        `## MANDATORY RULES\n` +
        `1. **REUSE existing code**: Use the EXACT same components, hooks, utils, services.\n` +
        `2. **Match existing patterns EXACTLY**: Same import style, state management, naming.\n` +
        `3. **Prefer modifying existing files** over creating new ones.\n` +
        `4. **Import from existing paths**: Same import aliases, relative paths.\n` +
        `5. **Copy structure from similar features**.\n` +
        `6. **No unnecessary abstractions**.\n` +
        `7. **VITE_PRODUCT_ID checks**: Must use exact enterprise product ID.\n` +
        `8. **Enterprise app ONLY**: Do NOT reference other product lines.\n\n`;

      const refineCtx = data._refine_instructions
        ? `\n\n## User Refinement Instructions (PRIORITY)\n${data._refine_instructions}\n`
        : '';

      const explorerOpts = cfg.localRepo
        ? { cwd: cfg.localRepo, maxTurns: 20, allowedTools: ['Read', 'Grep', 'Glob'] }
        : {};

      analysisResult = await deps.runAgentsTeam({
        teamName: 'Analysis Team',
        agents: [
          {
            name: 'Requirements Agent',
            prompt: `You are the **Requirements Agent**. Extract all functional requirements.\n\n${analysisRules}${ticketCtx}\n${refineCtx}\n## Required Output\n### Requirements\nComprehensive bullet list of functional requirements, business rules, UI changes, API interactions.\n### Recommended Approach\nBrief paragraph on best implementation strategy.`,
            timeout: deps.applyComplexityTimeout(360_000, state),
            opts: {},
            required: true,
            checkpointKey: '_agent_requirements',
          },
          {
            name: 'Code Explorer Agent',
            prompt: cfg.localRepo
              ? `You are the **Code Explorer Agent**. YOU HAVE DIRECT ACCESS TO THE REPOSITORY.\n\n${analysisRules}${ticketCtx}\nFolder structure: ${folderOverview}\nRelevant source files (${relevant.length}):\n${treeList}\n${refineCtx}\n## Required Output\n### Reusable Code\nFor each relevant file: exact path, what to reuse, how to use it.`
              : `You are the **Code Explorer Agent**. Find reusable code patterns.\n\n${analysisRules}${ticketCtx}\nFolder structure: ${folderOverview}\nRelevant files:\n${treeList}\n${refineCtx}\n## Required Output\n### Reusable Code\nExact file paths and what to reuse.`,
            timeout: deps.applyComplexityTimeout(420_000, state),
            opts: explorerOpts,
            required: false,
            checkpointKey: '_agent_explorer',
          },
          {
            name: 'Risk Analyst Agent',
            prompt: `You are the **Risk Analyst Agent**. Identify risks, gaps, edge cases.\n\n${analysisRules}${ticketCtx}\nFolder structure: ${folderOverview}\nRelevant files:\n${treeList}\n${refineCtx}\n## Required Output\n### Risks\nBullet list: [HIGH], [MEDIUM], [LOW].\n### Suggestions\n[GAP], [RISK], [REC] bullets.`,
            timeout: deps.applyComplexityTimeout(300_000, state),
            opts: {},
            required: false,
            checkpointKey: '_agent_risk',
          },
        ],
        state,
        merge: (results) => {
          const sections: string[] = [];
          const reqResult = results.find((r) => r.name === 'Requirements Agent');
          if (reqResult?.output) sections.push(reqResult.output);

          const explorerResult = results.find((r) => r.name === 'Code Explorer Agent');
          sections.push(explorerResult?.output || '### Reusable Code\n(Code exploration was not available)');

          const riskResult = results.find((r) => r.name === 'Risk Analyst Agent');
          sections.push(riskResult?.output || '### Risks\n(Risk analysis was not available)\n\n### Suggestions\n(No suggestions available)');
          return sections.join('\n\n');
        },
      });

      validateClaudeOutput(analysisResult, 'Analysis Team', 50);
      validateClaudeNotEmpty(analysisResult, 'Analysis Team');
      data._agent_analysis = analysisResult;

      // Extract suggestions
      const suggestionsMatch = analysisResult.match(/### Suggestions\n([\s\S]*?)(?=###|$)/);
      if (suggestionsMatch) {
        const sugLines = suggestionsMatch[1].trim().split('\n').filter((l: string) => l.trim().startsWith('-'));
        data._agent_suggestions = sugLines.map((l: string) => l.trim().replace(/^-\s*/, ''));
      }

      save(state);
      logOk('  Analysis Team complete');
    }

    logOk('Analysis complete');

    // OpenSpec scaffold
    logInfo('  -> OpenSpec: scaffolding change...');
    const scaffold = scaffoldOpenSpec(TICKET, deps.projectRoot);

    // Architect Agent
    const CAP = 16000;
    const trim = (s: string): string => {
      if (s.length <= CAP) return s;
      logWarn(`Analysis truncated from ${s.length} to ${CAP} chars for Architect`);
      return s.substring(0, CAP) + `\n...[truncated at ${CAP} of ${s.length} chars]`;
    };

    logInfo('  -> OpenSpec Architect Agent: producing structured plan artifacts...');

    const architectOpts = cfg.localRepo
      ? { cwd: cfg.localRepo, maxTurns: 25, allowedTools: ['Read', 'Grep', 'Glob'] }
      : { maxTurns: 25 };

    // Build template instructions
    let templateInstructions = '';
    if (scaffold?.templates) {
      const t = scaffold.templates;
      for (const id of ['proposal', 'design', 'specs', 'tasks']) {
        const tmpl = t[id];
        if (tmpl) {
          templateInstructions += `\n## ${id.toUpperCase()} Template & Instructions\n` +
            `Output path: ${tmpl.outputPath}\n${tmpl.instruction}\n` +
            `Rules: ${(tmpl.rules || []).join('; ')}\nTemplate:\n\`\`\`\n${tmpl.template}\n\`\`\`\n`;
        }
      }
    }

    const prevArtifactsCtx = data._prev_openspec
      ? `\n## Previous Artifacts (for reference)\n` +
        `### Previous Proposal\n${truncateWithIndicator((data._prev_openspec as Record<string, string>).proposal || '', 3000)}\n` +
        `### Previous Tasks\n${truncateWithIndicator((data._prev_openspec as Record<string, string>).tasks || '', 3000)}\n`
      : '';

    const refineArchCtx = data._refine_instructions
      ? `\n## User Refinement Instructions (PRIORITY)\n${data._refine_instructions}\n`
      : '';

    const architectPrompt =
      `You are the **OpenSpec Architect Agent**. Produce a comprehensive implementation plan as 4 structured artifacts.\n\n` +
      `## Ticket: ${TICKET}\n**Summary**: ${summary}\n**Acceptance Criteria**:\n${ac || '(none)'}\n\n` +
      `## Analysis Results\n${trim(analysisResult)}\n\n` +
      (templateInstructions ? `## OpenSpec Artifact Templates\n${templateInstructions}\n` : '') +
      `${prevArtifactsCtx}${refineArchCtx}` +
      `## OUTPUT FORMAT -- CRITICAL\n` +
      `Output exactly 4 sections, each preceded by its marker on a line by itself:\n\n` +
      `---PROPOSAL---\n(proposal content)\n\n` +
      `---DESIGN---\n(design content)\n\n` +
      `---SPECS---\n(specs content -- WHEN/THEN scenarios)\n\n` +
      `---TASKS---\n(tasks content -- numbered checkbox steps)\n\n` +
      `All 4 markers are REQUIRED. Be thorough but concise.`;

    const architectOutput = await deps.runSingleAgent({
      name: 'OpenSpec Architect Agent',
      prompt: architectPrompt,
      timeout: deps.applyComplexityTimeout(deps.analysisTimeoutMs * 1.5, state),
      opts: architectOpts,
      state,
      checkpointKey: '_architect_result',
      required: true,
    });

    // Parse and write artifacts
    let artifacts: ParsedArtifacts | null = null;
    if (scaffold) {
      artifacts = parseAndWriteArtifacts(architectOutput, scaffold);
    }

    if (artifacts) {
      data.explore_plan = artifacts.tasks;
      data.explore_openspec = {
        proposal: artifacts.proposal,
        design: artifacts.design,
        specs: artifacts.specs,
        tasks: artifacts.tasks,
        changeName: scaffold!.changeName,
        artifactDir: scaffold!.changeDir,
        suggestions: data._agent_suggestions || [],
      };
    } else {
      logWarn('OpenSpec artifact parsing failed -- using raw architect output');
      data.explore_plan = architectOutput;
      data.explore_openspec = null;
    }

    data.explore_agents = { analysis: analysisResult };
    save(state);
    logOk(`Implementation plan ready (2 agents completed${artifacts ? ' + OpenSpec artifacts' : ''})`);
  }

  // Z7: Track plan rejection iterations
  if (ticket.planFeedback && data._plan_was_posted_before) {
    data._plan_rejections = ((data._plan_rejections as number) || 0) + 1;
    logInfo(`Plan rejection iteration: ${data._plan_rejections}/${deps.maxPlanRejections}`);
    if ((data._plan_rejections as number) >= deps.maxPlanRejections) {
      logErr(`Plan rejected ${data._plan_rejections} times (max: ${deps.maxPlanRejections}) -- halting pipeline`);
      if (isChannelEnabled('explore_plan', 'slack')) {
        await slack(
          `*Plan Rejection Limit -- ${TICKET}*\nPlan was rejected ${data._plan_rejections} times. Pipeline halted.`,
          [cfg.slack.ownerId],
        );
      }
      save(state);
      throw new Error(`Plan rejected ${data._plan_rejections} times -- exceeded MAX_PLAN_REJECTIONS`);
    }
  }

  // Post plan for approval
  if (!data.explore_plan_posted) {
    const os = data.explore_openspec as Record<string, unknown> | null;

    if (isChannelEnabled('explore_plan', 'slack')) {
      await slack(
        `*Implementation Plan Ready -- ${TICKET}*\n` +
        `*${summary}*\n\n` +
        `${os ? 'Full OpenSpec plan with Proposal/Design/Specs/Tasks.' : 'Plan ready for review.'}\n` +
        `Review on the Agent Web UI -> Approve, Reject, or Refine.\n` +
        `http://localhost:3000`,
        [cfg.slack.ownerId],
      );
    }

    data.explore_plan_posted = true;
    data.explore_plan_at = new Date().toISOString();
    data._plan_was_posted_before = true;
    save(state);
    logOk('Plan ready on Web UI -- waiting for your approval');
  }

  // Wait for approval or rejection
  logWait('Waiting for plan approval (Web UI)...');

  const planPollStart = deps.monotonicMs();
  let planPollCount = 0;
  while (true) {
    if (isShuttingDown()) {
      save(state);
      throw new Error('Shutdown in progress -- exiting explore_plan');
    }
    if (deps.monotonicMs() - planPollStart > deps.maxApprovalTimeout) {
      logErr(`Plan approval timeout after ${deps.maxApprovalTimeout / 3600000}h`);
      if (isChannelEnabled('explore_plan', 'slack')) {
        await slack(`*Plan Approval Timeout -- ${TICKET}*\nPipeline halted.`, [cfg.slack.ownerId]);
      }
      save(state);
      throw new Error(`Plan approval timeout`);
    }

    // Check Web UI approval/rejection
    const uiResult = deps.checkUIApproval(state, 'explore_plan');
    if (uiResult) {
      if (uiResult.approved) {
        logOk('Plan approved via Web UI -- proceeding to code generation');
        state.stage = 'generate_code';
        save(state);
        return;
      } else {
        logErr('Plan rejected via Web UI -- regenerating with feedback...');
        const feedback = uiResult.feedback || '';
        for (const field of (STAGE_CLEARS.explore_plan || [])) {
          data[field] = null;
        }
        data.explore_plan_ui_approved = null;
        data.explore_plan_ui_rejected = null;
        data.explore_plan_ui_feedback = null;
        ticket.planFeedback = feedback;
        save(state);
        return stageExplorePlan(state, deps);
      }
    }

    // Check Jira comments (non-fatal -- Web UI is the primary approval path)
    let comments: Array<{ body: unknown; created: string }> = [];
    try {
      comments = await jira.getComments(TICKET, data.explore_plan_at as string);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`Jira comment poll failed (non-fatal): ${msg}`);
    }
    for (const c of comments) {
      const text = adfText(c.body).toLowerCase().trim();
      const rawText = adfText(c.body).trim();

      // Check for "refine:" prefix
      if (text.startsWith('refine:')) {
        const instructions = rawText.substring(rawText.toLowerCase().indexOf('refine:') + 7).trim();
        if (instructions) {
          logInfo(`Plan refine via Jira: "${truncateWithIndicator(instructions, 100)}"`);
          if (data.explore_openspec) {
            data._prev_openspec = { ...(data.explore_openspec as Record<string, unknown>) };
          }
          data._refine_instructions = instructions;
          for (const field of (STAGE_CLEARS.explore_plan || [])) {
            data[field] = null;
          }
          save(state);
          return stageExplorePlan(state, deps);
        }
      }

      if (matchApprovalWord(text, 'approved', ['not approved', 'unapproved', 'disapproved'])) {
        logOk('Plan approved -- proceeding to code generation');
        state.stage = 'generate_code';
        save(state);
        return;
      }

      if (matchApprovalWord(text, 'rejected', ['not rejected'])) {
        logErr('Plan rejected -- regenerating with feedback...');
        const feedback = adfText(c.body);
        for (const field of (STAGE_CLEARS.explore_plan || [])) {
          data[field] = null;
        }
        ticket.planFeedback = feedback;
        save(state);
        return stageExplorePlan(state, deps);
      }
    }

    planPollCount++;
    if (planPollCount % 6 === 0) {
      const waitMins = Math.floor((deps.monotonicMs() - planPollStart) / 60000);
      logInfo(`Waiting for plan approval... ${waitMins}m elapsed`);
    }
    await sleep(deps.pollInterval);
  }
}
