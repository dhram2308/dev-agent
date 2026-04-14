"use strict";
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
exports.stageExplorePlan = stageExplorePlan;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const constants_1 = require("@shared/constants");
const logger_1 = require("../../lib/logger");
const utils_1 = require("../../lib/utils");
const graceful_shutdown_1 = require("../../lib/graceful-shutdown");
// ── OpenSpec CLI integration ─────────────────────────────────────────
/**
 * Scaffold an OpenSpec change for the ticket.
 * Runs: openspec new change, openspec status --json, openspec instructions --json for each artifact.
 */
function scaffoldOpenSpec(ticket, projectRoot) {
    const changeName = ticket.toLowerCase();
    const changeDir = path.join(projectRoot, 'openspec', 'changes', changeName);
    try {
        // Create the change if it doesn't already exist
        if (!fs.existsSync(changeDir)) {
            (0, logger_1.logInfo)(`OpenSpec: creating change '${changeName}'...`);
            (0, child_process_1.execSync)(`openspec new change "${changeName}"`, {
                cwd: projectRoot, stdio: 'pipe', timeout: 30000,
            });
        }
        else {
            (0, logger_1.logInfo)(`OpenSpec: change '${changeName}' already exists`);
        }
        // Get status with artifact list
        const statusRaw = (0, child_process_1.execSync)(`openspec status --change "${changeName}" --json`, {
            cwd: projectRoot, stdio: 'pipe', timeout: 15000,
        });
        const status = JSON.parse(statusRaw.toString().trim());
        // Get instructions for each artifact
        const templates = {};
        const artifactIds = ['proposal', 'design', 'specs', 'tasks'];
        for (const id of artifactIds) {
            try {
                const instrRaw = (0, child_process_1.execSync)(`openspec instructions ${id} --change "${changeName}" --json`, {
                    cwd: projectRoot, stdio: 'pipe', timeout: 15000,
                });
                templates[id] = JSON.parse(instrRaw.toString().trim());
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                (0, logger_1.logWarn)(`OpenSpec: failed to get instructions for '${id}': ${msg}`);
                templates[id] = null;
            }
        }
        const templateCount = Object.keys(templates).filter((k) => templates[k]).length;
        (0, logger_1.logOk)(`OpenSpec: scaffolded '${changeName}' with ${templateCount} artifact templates`);
        return { changeName, changeDir, artifacts: status.artifacts || [], templates };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (0, logger_1.logErr)(`OpenSpec scaffold failed: ${msg}`);
        return null;
    }
}
/**
 * Parse architect output by markers and write artifacts to disk.
 * Markers: ---PROPOSAL---, ---DESIGN---, ---SPECS---, ---TASKS---
 */
function parseAndWriteArtifacts(output, scaffoldInfo) {
    const markers = ['---PROPOSAL---', '---DESIGN---', '---SPECS---', '---TASKS---'];
    const sections = {};
    try {
        // T2.5: Use line-anchored regex to avoid matching markers inside code blocks
        for (let i = 0; i < markers.length; i++) {
            const markerRegex = new RegExp(`^${markers[i].replace(/-/g, '\\-')}\\s*$`, 'm');
            const markerMatch = markerRegex.exec(output);
            if (!markerMatch)
                continue;
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
            (0, logger_1.logWarn)('OpenSpec: could not parse markers from architect output -- using raw output');
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
        (0, logger_1.logOk)(`OpenSpec: wrote ${Object.keys(sections).length} artifacts to ${changeDir}`);
        return {
            proposal: sections.proposal || '',
            design: sections.design || '',
            specs: sections.specs || '',
            tasks: sections.tasks || '',
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (0, logger_1.logErr)(`OpenSpec: parseAndWriteArtifacts failed: ${msg}`);
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
async function stageExplorePlan(state, deps) {
    (0, logger_1.logStep)('1b', 'Explore & Plan -- analyzing ticket with agents team');
    const { cfg, save, jira, slack, sleep, adfText, adfToMarkdown } = deps;
    const TICKET = cfg.ticket;
    const data = state.data;
    const ticket = data.ticket;
    if (!ticket) {
        throw new Error('No ticket data in state -- fetch_ticket must run first');
    }
    const summary = ticket.summary || '';
    const description = ticket.description || '';
    const ac = ticket.ac || '';
    const attachments = ticket.attachments || [];
    const externalUrls = ticket.externalUrls || [];
    // No-AC handling
    if (ticket.ac_missing) {
        (0, logger_1.logInfo)('No AC field in Jira -- using ticket description + comments as context');
        ticket.ac_missing = false;
        save(state);
    }
    // Q1: Smart inaccessible content detection + notification
    if (!data.explore_docs_checked) {
        const inaccessible = [];
        const ticketText = `${summary} ${description} ${ac}`;
        // Check external URLs for known doc types
        for (const url of externalUrls) {
            const docType = deps.classifyDocUrl(url);
            if (docType !== 'External Document') {
                const criticality = deps.assessDocCriticality(docType, ticketText);
                inaccessible.push({
                    type: docType,
                    url,
                    criticality,
                    instructions: deps.getDocPasteInstructions(docType),
                });
            }
        }
        // Auth-required URLs detected during fetch
        const authRequired = ticket.authRequiredUrls || [];
        for (const ar of authRequired) {
            if (!inaccessible.some((d) => d.url === ar.url)) {
                const criticality = deps.assessDocCriticality(ar.docType, ticketText);
                inaccessible.push({
                    type: ar.docType,
                    url: ar.url,
                    criticality,
                    instructions: deps.getDocPasteInstructions(ar.docType),
                    reason: ar.reason,
                });
            }
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
            const critOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
            inaccessible.sort((a, b) => (critOrder[a.criticality] ?? 9) - (critOrder[b.criticality] ?? 9));
            const hasCritical = inaccessible.some((d) => d.criticality === 'CRITICAL');
            (0, logger_1.logErr)(`Cannot access ${inaccessible.length} document(s)${hasCritical ? ' (includes CRITICAL)' : ''}:`);
            inaccessible.forEach((d) => (0, logger_1.logErr)(`  [${d.criticality}] ${d.type}: ${d.url}`));
            const docList = inaccessible.map((d, i) => `${i + 1}. [${d.criticality}] ${d.type}: ${d.url}\n   ${d.instructions}${d.reason ? ` (${d.reason})` : ''}`).join('\n');
            // Ask user for help via Jira + Slack
            await jira.addComment(TICKET, `${hasCritical ? 'CRITICAL -- ' : ''}Documents Needed\n\n` +
                `I cannot access the following documents linked in this ticket:\n${docList}\n\n` +
                `Please paste the relevant content as a comment on this ticket, then comment "continue" to proceed.` +
                `${hasCritical ? '\n\nCRITICAL documents are essential for implementation.' : ''}`);
            await slack(`*Documents Needed -- ${TICKET}*${hasCritical ? ' (CRITICAL)' : ''}\n` +
                `Agent cannot access:\n${docList}\n\n` +
                `Paste the relevant content on the Jira ticket and comment "continue".\n` +
                `${deps.jiraUrl(TICKET)}`, [cfg.slack.ownerId]);
            // Wait for user to provide docs and say "continue"
            (0, logger_1.logWait)('Waiting for you to provide document content on Jira...');
            data.explore_wait_at = new Date().toISOString();
            save(state);
            const continueStart = deps.monotonicMs();
            let docPollCount = 0;
            while (true) {
                if (deps.monotonicMs() - continueStart > deps.maxContinueWait) {
                    (0, logger_1.logWarn)(`Document wait timed out after ${deps.maxContinueWait / 60000} minutes -- proceeding with available context`);
                    await slack(`*Document wait timed out -- ${TICKET}*\nProceeding with available context.`, [cfg.slack.ownerId]);
                    break;
                }
                const comments = await jira.getComments(TICKET, data.explore_wait_at);
                const continueComment = comments.find((c) => (0, utils_1.matchApprovalWord)(adfText(c.body).toLowerCase().trim(), 'continue', ['discontinued', 'not continue']));
                if (continueComment) {
                    // Collect supplementary context from ALL comments
                    const extraParts = [];
                    for (const c of comments) {
                        const md = adfToMarkdown(c.body);
                        const plain = adfText(c.body).toLowerCase().trim();
                        if (plain === 'continue')
                            continue;
                        const lines = md.split('\n').filter((l) => l.trim().toLowerCase() !== 'continue');
                        const content = lines.join('\n').trim();
                        if (content) {
                            const author = c.author?.displayName || 'Deleted User';
                            extraParts.push(`[${author}]:\n${content}`);
                        }
                    }
                    const extraContext = extraParts.join('\n\n');
                    // G11: Guard -- if no content, re-prompt
                    if (!extraContext) {
                        (0, logger_1.logWarn)("G11: 'continue' posted but no supplementary content found -- re-prompting");
                        try {
                            await jira.addComment(TICKET, "No supplementary content detected. Please paste the document content first, then comment 'continue'.");
                        }
                        catch { /* best effort */ }
                        await sleep(deps.pollInterval);
                        continue;
                    }
                    ticket.supplementaryDocs = extraContext;
                    save(state);
                    (0, logger_1.logOk)(`Received supplementary docs (${extraContext.length} chars)`);
                    break;
                }
                docPollCount++;
                if (docPollCount % 6 === 0) {
                    const waitMins = Math.floor((deps.monotonicMs() - continueStart) / 60000);
                    (0, logger_1.logInfo)(`Waiting for document content... ${waitMins}m elapsed`);
                }
                await sleep(deps.pollInterval);
            }
        }
    }
    // ── Agents Team: Explore repo + build plan ──
    if (!data.explore_plan) {
        (0, logger_1.logInfo)('Agents Team -- launching exploration...');
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
            (0, logger_1.logWarn)('No keyword-matched files found -- falling back to first 50 source files');
            relevant = srcFiles.slice(0, 50);
        }
        const treeList = relevant.slice(0, 100).map((e) => e.path).join('\n');
        (0, logger_1.logInfo)(`Repo: ${tree.length} total, ${srcFiles.length} source files, ${relevant.length} relevant`);
        const supplementary = ticket.supplementaryDocs
            ? `\n## Supplementary Docs (from user)\n${ticket.supplementaryDocs}\n`
            : '';
        const iType = ticket.issueType || 'Task';
        const iPriority = ticket.priority || 'Medium';
        // D1: Sanitize user-sourced content
        const ticketCtx = `**${TICKET}: ${summary}** [${iType} / ${iPriority}]\n\n` +
            `## Description\n${(0, utils_1.sanitizeForPrompt)(description)}\n\n` +
            `## Acceptance Criteria\n${(0, utils_1.sanitizeForPrompt)(ac) || '(none provided)'}\n` +
            `${supplementary ? (0, utils_1.sanitizeForPrompt)(supplementary) : ''}`;
        // Agent 1 -- Analysis Team
        let analysisResult = data._agent_analysis || '';
        if (!analysisResult) {
            (0, logger_1.logInfo)('  -> Analysis Team: launching 3 parallel sub-agents...');
            const analysisRules = `## MANDATORY RULES\n` +
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
                    const sections = [];
                    const reqResult = results.find((r) => r.name === 'Requirements Agent');
                    if (reqResult?.output)
                        sections.push(reqResult.output);
                    const explorerResult = results.find((r) => r.name === 'Code Explorer Agent');
                    sections.push(explorerResult?.output || '### Reusable Code\n(Code exploration was not available)');
                    const riskResult = results.find((r) => r.name === 'Risk Analyst Agent');
                    sections.push(riskResult?.output || '### Risks\n(Risk analysis was not available)\n\n### Suggestions\n(No suggestions available)');
                    return sections.join('\n\n');
                },
            });
            (0, utils_1.validateClaudeOutput)(analysisResult, 'Analysis Team', 50);
            (0, utils_1.validateClaudeNotEmpty)(analysisResult, 'Analysis Team');
            data._agent_analysis = analysisResult;
            // Extract suggestions
            const suggestionsMatch = analysisResult.match(/### Suggestions\n([\s\S]*?)(?=###|$)/);
            if (suggestionsMatch) {
                const sugLines = suggestionsMatch[1].trim().split('\n').filter((l) => l.trim().startsWith('-'));
                data._agent_suggestions = sugLines.map((l) => l.trim().replace(/^-\s*/, ''));
            }
            save(state);
            (0, logger_1.logOk)('  Analysis Team complete');
        }
        (0, logger_1.logOk)('Analysis complete');
        // OpenSpec scaffold
        (0, logger_1.logInfo)('  -> OpenSpec: scaffolding change...');
        const scaffold = scaffoldOpenSpec(TICKET, deps.projectRoot);
        // Architect Agent
        const CAP = 16000;
        const trim = (s) => {
            if (s.length <= CAP)
                return s;
            (0, logger_1.logWarn)(`Analysis truncated from ${s.length} to ${CAP} chars for Architect`);
            return s.substring(0, CAP) + `\n...[truncated at ${CAP} of ${s.length} chars]`;
        };
        (0, logger_1.logInfo)('  -> OpenSpec Architect Agent: producing structured plan artifacts...');
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
                `### Previous Proposal\n${(0, utils_1.truncateWithIndicator)(data._prev_openspec.proposal || '', 3000)}\n` +
                `### Previous Tasks\n${(0, utils_1.truncateWithIndicator)(data._prev_openspec.tasks || '', 3000)}\n`
            : '';
        const refineArchCtx = data._refine_instructions
            ? `\n## User Refinement Instructions (PRIORITY)\n${data._refine_instructions}\n`
            : '';
        const architectPrompt = `You are the **OpenSpec Architect Agent**. Produce a comprehensive implementation plan as 4 structured artifacts.\n\n` +
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
        let artifacts = null;
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
                changeName: scaffold.changeName,
                artifactDir: scaffold.changeDir,
                suggestions: data._agent_suggestions || [],
            };
        }
        else {
            (0, logger_1.logWarn)('OpenSpec artifact parsing failed -- using raw architect output');
            data.explore_plan = architectOutput;
            data.explore_openspec = null;
        }
        data.explore_agents = { analysis: analysisResult };
        save(state);
        (0, logger_1.logOk)(`Implementation plan ready (2 agents completed${artifacts ? ' + OpenSpec artifacts' : ''})`);
    }
    // Z7: Track plan rejection iterations
    if (ticket.planFeedback && data._plan_was_posted_before) {
        data._plan_rejections = (data._plan_rejections || 0) + 1;
        (0, logger_1.logInfo)(`Plan rejection iteration: ${data._plan_rejections}/${deps.maxPlanRejections}`);
        if (data._plan_rejections >= deps.maxPlanRejections) {
            (0, logger_1.logErr)(`Plan rejected ${data._plan_rejections} times (max: ${deps.maxPlanRejections}) -- halting pipeline`);
            await slack(`*Plan Rejection Limit -- ${TICKET}*\nPlan was rejected ${data._plan_rejections} times. Pipeline halted.`, [cfg.slack.ownerId]);
            save(state);
            throw new Error(`Plan rejected ${data._plan_rejections} times -- exceeded MAX_PLAN_REJECTIONS`);
        }
    }
    // Post plan for approval
    if (!data.explore_plan_posted) {
        const os = data.explore_openspec;
        await slack(`*Implementation Plan Ready -- ${TICKET}*\n` +
            `*${summary}*\n\n` +
            `${os ? 'Full OpenSpec plan with Proposal/Design/Specs/Tasks.' : 'Plan ready for review.'}\n` +
            `Review on the Agent Web UI -> Approve, Reject, or Refine.\n` +
            `http://localhost:3000`, [cfg.slack.ownerId]);
        data.explore_plan_posted = true;
        data.explore_plan_at = new Date().toISOString();
        data._plan_was_posted_before = true;
        save(state);
        (0, logger_1.logOk)('Plan ready on Web UI -- waiting for your approval');
    }
    // Wait for approval or rejection
    (0, logger_1.logWait)('Waiting for plan approval (Web UI)...');
    const planPollStart = deps.monotonicMs();
    let planPollCount = 0;
    while (true) {
        if ((0, graceful_shutdown_1.isShuttingDown)()) {
            save(state);
            throw new Error('Shutdown in progress -- exiting explore_plan');
        }
        if (deps.monotonicMs() - planPollStart > deps.maxApprovalTimeout) {
            (0, logger_1.logErr)(`Plan approval timeout after ${deps.maxApprovalTimeout / 3600000}h`);
            await slack(`*Plan Approval Timeout -- ${TICKET}*\nPipeline halted.`, [cfg.slack.ownerId]);
            save(state);
            throw new Error(`Plan approval timeout`);
        }
        // Check Web UI approval/rejection
        const uiResult = deps.checkUIApproval(state, 'explore_plan');
        if (uiResult) {
            if (uiResult.approved) {
                (0, logger_1.logOk)('Plan approved via Web UI -- proceeding to code generation');
                state.stage = 'generate_code';
                save(state);
                return;
            }
            else {
                (0, logger_1.logErr)('Plan rejected via Web UI -- regenerating with feedback...');
                const feedback = uiResult.feedback || '';
                for (const field of (constants_1.STAGE_CLEARS.explore_plan || [])) {
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
        // Check Jira comments
        const comments = await jira.getComments(TICKET, data.explore_plan_at);
        for (const c of comments) {
            const text = adfText(c.body).toLowerCase().trim();
            const rawText = adfText(c.body).trim();
            // Check for "refine:" prefix
            if (text.startsWith('refine:')) {
                const instructions = rawText.substring(rawText.toLowerCase().indexOf('refine:') + 7).trim();
                if (instructions) {
                    (0, logger_1.logInfo)(`Plan refine via Jira: "${(0, utils_1.truncateWithIndicator)(instructions, 100)}"`);
                    if (data.explore_openspec) {
                        data._prev_openspec = { ...data.explore_openspec };
                    }
                    data._refine_instructions = instructions;
                    for (const field of (constants_1.STAGE_CLEARS.explore_plan || [])) {
                        data[field] = null;
                    }
                    save(state);
                    return stageExplorePlan(state, deps);
                }
            }
            if ((0, utils_1.matchApprovalWord)(text, 'approved', ['not approved', 'unapproved', 'disapproved'])) {
                (0, logger_1.logOk)('Plan approved -- proceeding to code generation');
                state.stage = 'generate_code';
                save(state);
                return;
            }
            if ((0, utils_1.matchApprovalWord)(text, 'rejected', ['not rejected'])) {
                (0, logger_1.logErr)('Plan rejected -- regenerating with feedback...');
                const feedback = adfText(c.body);
                for (const field of (constants_1.STAGE_CLEARS.explore_plan || [])) {
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
            (0, logger_1.logInfo)(`Waiting for plan approval... ${waitMins}m elapsed`);
        }
        await sleep(deps.pollInterval);
    }
}
//# sourceMappingURL=explore-plan.js.map