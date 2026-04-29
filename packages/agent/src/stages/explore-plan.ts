"use strict";

import type { PipelineState, PendingQuestion, QuestionAnswer } from '@mi/shared';

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { cfg, TICKET, POLL_INTERVAL, MAX_APPROVAL_TIMEOUT, MAX_CONTINUE_WAIT,
  MAX_PLAN_REJECTIONS, ANALYSIS_TIMEOUT_MS, applyComplexityTimeout, monotonicMs } = require("../lib/config");
const { STAGE_CLEARS } = require("../lib/constants");
const { logStep, logOk, logErr, logInfo, logWarn, logWait, C } = require("../lib/logging");
const { sleep } = require("../lib/http-client");
const { sanitizeForPrompt, truncateWithIndicator, matchApprovalWord, validateClaudeOutput, validateClaudeNotEmpty, addWarning } = require("../lib/utils");
const { adfText, adfToMarkdown, adfExtractUrls } = require("../lib/adf");
const { save, checkUIApproval } = require("../lib/state");
const { jira, jiraUrl, classifyDocUrl, getDocPasteInstructions, assessDocCriticality } = require("../lib/jira");
const { gl } = require("../lib/gitlab");
const { slack } = require("../lib/slack");
const { localGetTree } = require("../lib/local-repo");
const { runAgentsTeam, runSingleAgent } = require("../lib/agents-team");
const { isShuttingDown } = require("../lib/graceful-shutdown");
const { isChannelEnabled } = require("../lib/notification-config");

const PROJECT_ROOT = path.join(__dirname, "../..");

// ── OpenSpec CLI integration ─────────────────────────────────────

function scaffoldOpenSpec(ticket: string): any {
  const changeName = ticket.toLowerCase();
  const changeDir = path.join(PROJECT_ROOT, "openspec", "changes", changeName);

  try {
    if (!fs.existsSync(changeDir)) {
      logInfo(`OpenSpec: creating change '${changeName}'…`);
      execSync(`openspec new change "${changeName}"`, { cwd: PROJECT_ROOT, stdio: "pipe", timeout: 30000 });
    } else {
      logInfo(`OpenSpec: change '${changeName}' already exists`);
    }

    const statusRaw = execSync(`openspec status --change "${changeName}" --json`, { cwd: PROJECT_ROOT, stdio: "pipe", timeout: 15000 });
    const status = JSON.parse(statusRaw.toString().trim());

    const templates: Record<string, any> = {};
    const artifactIds = ["proposal", "design", "specs", "tasks"];
    for (const id of artifactIds) {
      try {
        const instrRaw = execSync(`openspec instructions ${id} --change "${changeName}" --json`, { cwd: PROJECT_ROOT, stdio: "pipe", timeout: 15000 });
        templates[id] = JSON.parse(instrRaw.toString().trim());
      } catch (err: any) {
        logWarn(`OpenSpec: failed to get instructions for '${id}': ${err.message}`);
        templates[id] = null;
      }
    }

    logOk(`OpenSpec: scaffolded '${changeName}' with ${Object.keys(templates).filter((k) => templates[k]).length} artifact templates`);
    return { changeName, changeDir, artifacts: status.artifacts || [], templates };
  } catch (err: any) {
    logErr(`OpenSpec scaffold failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract and validate the `---QUESTIONS---` JSON block from the Architect
 * agent's output. Returns a list of validated `PendingQuestion` entries.
 *
 * Graceful degradation: malformed JSON, missing required fields, and
 * out-of-bounds `recommend` indices are dropped with a warning. A missing
 * block simply returns `[]` — the pipeline proceeds as "no questions".
 *
 * Hard cap 10 entries; soft cap 3 (warning only).
 */
function parseQuestionsBlock(output: string): PendingQuestion[] {
  // Accept either `---END---` or the next `---SOMETHING---` marker as terminator
  const blockRe = /---QUESTIONS---\s*\n([\s\S]*?)(?:\n---END---|\n---[A-Z]+---|$)/i;
  const m = output.match(blockRe);
  if (!m) return [];

  const body = m[1].trim();
  if (!body) return [];

  // Strip optional fenced json (e.g. ```json ... ```)
  const stripped = body
    .replace(/^```(?:json)?\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err: any) {
    logWarn(`[architect] malformed QUESTIONS block: ${err.message}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    logWarn(`[architect] QUESTIONS block must be an array, got ${typeof parsed}`);
    return [];
  }

  const HARD_CAP = 10;
  const SOFT_CAP = 3;
  const now = Date.now();
  const accepted: PendingQuestion[] = [];

  for (const raw of parsed as any[]) {
    if (accepted.length >= HARD_CAP) {
      logWarn(`[architect] QUESTIONS block hard-cap reached (${HARD_CAP}); dropping remaining entries`);
      break;
    }
    if (!raw || typeof raw !== "object") {
      logWarn(`[architect] QUESTIONS entry is not an object — dropped`);
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    const options = Array.isArray(raw.options) ? raw.options.filter((o: any) => typeof o === "string" && o.trim().length > 0) : [];
    if (!id) { logWarn(`[architect] QUESTIONS entry missing 'id' — dropped`); continue; }
    if (!text) { logWarn(`[architect] QUESTIONS entry '${id}' missing 'text' — dropped`); continue; }
    if (options.length < 2) { logWarn(`[architect] QUESTIONS entry '${id}' needs >= 2 options — dropped`); continue; }

    const entry: PendingQuestion = {
      id,
      text,
      options: options.slice(0, 5),
      stage: "explore_plan",
      ts: now,
    };

    if (typeof raw.recommend === "number" && Number.isInteger(raw.recommend) && raw.recommend >= 0 && raw.recommend < entry.options.length) {
      entry.recommend = raw.recommend;
    }
    if (typeof raw.reason === "string" && raw.reason.trim().length > 0) {
      entry.reason = raw.reason.trim();
    }

    accepted.push(entry);
  }

  if (accepted.length > SOFT_CAP) {
    logWarn(`[architect] soft cap exceeded: ${accepted.length} questions admitted (max recommended: ${SOFT_CAP})`);
  }

  return accepted;
}

function parseAndWriteArtifacts(output: string, scaffoldInfo: any): any {
  const markers = ["---PROPOSAL---", "---DESIGN---", "---SPECS---", "---TASKS---"];
  const sections: Record<string, string> = {};

  try {
    for (let i = 0; i < markers.length; i++) {
      const markerRegex = new RegExp(`^${markers[i].replace(/[-]/g, "\\-")}\\s*$`, "m");
      const markerMatch = markerRegex.exec(output);
      if (!markerMatch) continue;
      const startIdx = markerMatch.index;
      const contentStart = startIdx + markerMatch[0].length;
      let endIdx = output.length;
      for (let j = i + 1; j < markers.length; j++) {
        const nextRegex = new RegExp(`^${markers[j].replace(/[-]/g, "\\-")}\\s*$`, "m");
        const nextMatch = nextRegex.exec(output.substring(contentStart));
        if (nextMatch) { endIdx = contentStart + nextMatch.index; break; }
      }
      const key = markers[i].replace(/---/g, "").toLowerCase();
      sections[key] = output.substring(contentStart, endIdx).trim();
    }

    if (!sections.proposal && !sections.tasks) {
      logWarn("OpenSpec: could not parse markers from architect output — using raw output");
      return null;
    }

    const { changeDir } = scaffoldInfo;
    fs.mkdirSync(changeDir, { recursive: true });

    if (sections.proposal) {
      fs.writeFileSync(path.join(changeDir, "proposal.md"), sections.proposal, "utf8");
    }
    if (sections.design) {
      fs.writeFileSync(path.join(changeDir, "design.md"), sections.design, "utf8");
    }
    if (sections.specs) {
      const specsDir = path.join(changeDir, "specs", "change");
      fs.mkdirSync(specsDir, { recursive: true });
      fs.writeFileSync(path.join(specsDir, "spec.md"), sections.specs, "utf8");
    }
    if (sections.tasks) {
      fs.writeFileSync(path.join(changeDir, "tasks.md"), sections.tasks, "utf8");
    }

    const yamlContent = `schema: spec-driven\nchange: ${scaffoldInfo.changeName}\ncreated: ${new Date().toISOString()}\n`;
    fs.writeFileSync(path.join(changeDir, ".openspec.yaml"), yamlContent, "utf8");

    logOk(`OpenSpec: wrote ${Object.keys(sections).length} artifacts to ${changeDir}`);
    return {
      proposal: sections.proposal || "",
      design: sections.design || "",
      specs: sections.specs || "",
      tasks: sections.tasks || "",
    };
  } catch (err: any) {
    logErr(`OpenSpec: parseAndWriteArtifacts failed: ${err.message}`);
    return null;
  }
}

async function stageExplorePlan(state: PipelineState): Promise<void> {
  logStep("1b", "Explore & Plan — analyzing ticket with agents team");

  const { summary, description, ac, attachments, externalUrls } = state.data.ticket as any;

  if ((state.data.ticket as any).ac_missing) {
    logInfo("No AC field in Jira — using ticket description + comments as context");
    (state.data.ticket as any).ac_missing = false;
    save(state);
  }

  // ── Q1: Smart inaccessible content detection + notification ──
  if (!state.data.explore_docs_checked) {
    const inaccessible: any[] = [];
    const ticketText = `${summary} ${description} ${ac}`;

    for (const url of (externalUrls || [])) {
      const docType = classifyDocUrl(url);
      if (docType !== "External Document") {
        const criticality = assessDocCriticality(docType, ticketText);
        inaccessible.push({ type: docType, url, criticality, instructions: getDocPasteInstructions(docType) });
      }
    }

    const authRequired: any[] = (state.data.ticket as any).authRequiredUrls || [];
    for (const ar of authRequired) {
      if (!inaccessible.some((d: any) => d.url === ar.url)) {
        const criticality = assessDocCriticality(ar.docType, ticketText);
        inaccessible.push({ type: ar.docType, url: ar.url, criticality, instructions: getDocPasteInstructions(ar.docType), reason: ar.reason });
      }
    }

    for (const att of (attachments || [])) {
      const ext = att.filename.split(".").pop().toLowerCase();
      if (["pdf", "docx", "xlsx", "pptx", "fig", "sketch"].includes(ext)) {
        inaccessible.push({ type: `Attachment (${ext})`, url: att.filename, criticality: "MEDIUM", instructions: "Please paste the document content as text" });
      }
    }

    state.data.explore_inaccessible = inaccessible;
    state.data.explore_docs_checked = true;
    save(state);

    if (inaccessible.length > 0) {
      const critOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
      inaccessible.sort((a: any, b: any) => (critOrder[a.criticality] || 9) - (critOrder[b.criticality] || 9));

      const hasCritical = inaccessible.some((d: any) => d.criticality === "CRITICAL");
      logErr(`Cannot access ${inaccessible.length} document(s)${hasCritical ? " (includes CRITICAL)" : ""}:`);
      inaccessible.forEach((d: any) => logErr(`  [${d.criticality}] ${d.type}: ${d.url}`));

      const docList = inaccessible.map((d: any, i: number) =>
        `${i + 1}. [${d.criticality}] ${d.type}: ${d.url}\n   ${d.instructions}${d.reason ? ` (${d.reason})` : ""}`
      ).join("\n");

      if (isChannelEnabled("explore_plan", "jira")) {
        await jira.addComment(TICKET,
          `${hasCritical ? "CRITICAL — " : ""}Documents Needed\n\n` +
          `I cannot access the following documents linked in this ticket:\n${docList}\n\n` +
          `Please paste the relevant content as a comment on this ticket, then comment "continue" to proceed.` +
          `${hasCritical ? "\n\nCRITICAL documents are essential for implementation — code quality may be significantly impacted without them." : ""}`,
        );
      }

      if (isChannelEnabled("explore_plan", "slack")) {
        await slack(
          `${hasCritical ? "🚨" : "⚠️"} *Documents Needed — ${TICKET}*${hasCritical ? " (CRITICAL)" : ""}\n` +
          `Agent cannot access:\n${docList}\n\n` +
          `Paste the relevant content on the Jira ticket and comment "continue".\n` +
          `📋 ${jiraUrl(TICKET)}`,
          [cfg.slack.ownerId],
        );
      }

      logWait("Waiting for you to provide document content on Jira…");
      state.data.explore_wait_at = new Date().toISOString();
      save(state);

      const continueStart = monotonicMs();
      let docPollCount = 0;
      while (true) {
        if (monotonicMs() - continueStart > MAX_CONTINUE_WAIT) {
          logWarn(`Document wait timed out after ${MAX_CONTINUE_WAIT / 60000} minutes — proceeding with available context`);
          if (isChannelEnabled("explore_plan", "slack")) {
            await slack(`⏰ *Document wait timed out — ${TICKET}*\nProceeding with available context.`, [cfg.slack.ownerId]);
          }
          break;
        }
        const comments: any[] = await jira.getComments(TICKET, state.data.explore_wait_at);
        const continueComment = comments.find((c: any) =>
          matchApprovalWord(adfText(c.body).toLowerCase().trim(), "continue", ["discontinued", "not continue"]),
        );
        if (continueComment) {
          const extraParts: string[] = [];
          for (const c of comments) {
            const md = adfToMarkdown(c.body);
            const plain = adfText(c.body).toLowerCase().trim();
            if (plain === "continue") continue;
            const lines = md.split("\n").filter((l: string) => l.trim().toLowerCase() !== "continue");
            const content = lines.join("\n").trim();
            if (content) {
              const author = c.author?.displayName || "Deleted User";
              extraParts.push(`[${author}]:\n${content}`);
            }
          }
          const extraContext = extraParts.join("\n\n");
          if (!extraContext) {
            logWarn("G11: 'continue' posted but no supplementary content found — re-prompting");
            try {
              if (isChannelEnabled("explore_plan", "jira")) {
                await jira.addComment(TICKET, "No supplementary content detected. Please paste the document content first, then comment 'continue'.");
              }
            } catch {}
            await sleep(POLL_INTERVAL);
            continue;
          }
          (state.data.ticket as any).supplementaryDocs = extraContext;
          save(state);
          logOk(`Received supplementary docs (${extraContext.length} chars)`);
          break;
        }
        docPollCount++;
        if (docPollCount % 6 === 0) {
          const waitMins = Math.floor((monotonicMs() - continueStart) / 60000);
          logInfo(`Waiting for document content… ${waitMins}m elapsed`);
        }
        await sleep(POLL_INTERVAL);
      }
    }
  }

  // ── Agents Team: Explore repo + build plan ──
  if (!state.data.explore_plan) {
    logInfo("Agents Team — launching exploration…");

    const tree: any[] = cfg.localRepo
      ? localGetTree(cfg.localRepo)
      : await gl.getTree("", cfg.branch.ts, true);
    const SRC_EXT = /\.(tsx?|jsx?|css|scss|less|json)$/i;
    const SKIP = /node_modules|\.next|dist\/|build\/|\.git\/|__pycache__|\.cache|\.husky|coverage|\.nyc|\.storybook|public\/static|assets\/(images|fonts|icons)|\.svg$|\.png$|\.jpg$|\.ico$|\.woff|\.ttf|\.map$|package-lock|yarn\.lock|\.eslint|\.prettier|\.spec\.|\.test\.|__tests__|__mocks__/i;
    const srcFiles = tree.filter((e: any) => e.type === "blob" && SRC_EXT.test(e.path) && !SKIP.test(e.path));

    const dirs = [...new Set(tree.filter((e: any) => e.type === "tree" && e.path.split("/").length <= 2 && !SKIP.test(e.path)).map((e: any) => e.path))];
    const folderOverview = dirs.slice(0, 30).join(", ");

    const keywords: string[] = (summary + " " + description).toLowerCase().match(/[a-z]{3,}/g) || [];
    let relevant = srcFiles.filter((e: any) => {
      const p = e.path.toLowerCase();
      return keywords.some((k: string) => p.includes(k)) || p.includes("invoice") || p.includes("import") || p.includes("edit") || p.includes("common") || p.includes("shared") || p.includes("hook") || p.includes("util") || p.includes("service") || p.includes("constant") || p.includes("type");
    });
    if (relevant.length === 0) {
      logWarn("No keyword-matched files found — falling back to first 50 source files");
      relevant = srcFiles.slice(0, 50);
    }
    const CONFIG_EP = ["tsconfig.json", "vite.config.ts", "vite.config.js"];
    const CONFIG_EP_PAT = [/^\.eslintrc/, /^\.prettierrc/, /^tsconfig\./];
    const allPaths = tree.map((e: any) => e.path);
    for (const cf of CONFIG_EP) {
      if (allPaths.includes(cf) && !relevant.some((e: any) => e.path === cf)) {
        relevant.push({ path: cf, type: "blob" });
      }
    }
    for (const pat of CONFIG_EP_PAT) {
      for (const tp of allPaths) {
        if (pat.test(path.basename(tp)) && !relevant.some((e: any) => e.path === tp)) {
          relevant.push({ path: tp, type: "blob" });
        }
      }
    }
    const treeList = relevant.slice(0, 100).map((e: any) => e.path).join("\n");
    logInfo(`Repo: ${tree.length} total, ${srcFiles.length} source files, ${relevant.length} relevant`);

    const supplementary = (state.data.ticket as any).supplementaryDocs
      ? `\n## Supplementary Docs (from user)\n${(state.data.ticket as any).supplementaryDocs}\n`
      : "";

    const { comments: ticketComments, linkedIssues, parent: parentEpic,
      attachmentContents, fetchedUrlContents, issueType: iType, priority: iPriority
    } = state.data.ticket as any;

    let fullContext = "";

    const COMMENTS_CAP = 20_000;
    const LINKED_ISSUES_MAX = 5;
    const LINKED_ISSUE_DESC_CAP = 2_000;
    const PARENT_DESC_CAP = 3_000;
    const ATTACHMENT_PER_CAP = 3_000;
    const ATTACHMENT_TOTAL_CAP = 10_000;
    const URL_PER_CAP = 5_000;
    const URL_TOTAL_CAP = 10_000;

    if (ticketComments && ticketComments.length > 0) {
      let commentsBlock = "";
      for (const c of ticketComments) {
        const entry = `### [${c.author}] (${c.created ? c.created.split("T")[0] : ""}):\n${c.body}\n\n`;
        if (commentsBlock.length + entry.length > COMMENTS_CAP) {
          commentsBlock += `\n…[${ticketComments.length - ticketComments.indexOf(c)} more comments truncated]\n`;
          break;
        }
        commentsBlock += entry;
      }
      fullContext += `\n## Jira Comments (read ALL — may contain API specs, requirement changes, design decisions)\n${commentsBlock}`;
    }

    if (linkedIssues && linkedIssues.length > 0) {
      fullContext += "\n## Linked Issues\n";
      for (const li of linkedIssues.slice(0, LINKED_ISSUES_MAX)) {
        fullContext += `### ${li.key} (${li.relationship}) — ${li.summary} [${li.status}]\n`;
        if (li.description) fullContext += `${truncateWithIndicator(li.description, LINKED_ISSUE_DESC_CAP)}\n`;
        fullContext += "\n";
      }
      if (linkedIssues.length > LINKED_ISSUES_MAX) {
        fullContext += `…[${linkedIssues.length - LINKED_ISSUES_MAX} more linked issues omitted]\n`;
      }
    }

    if (parentEpic) {
      fullContext += `\n## Parent Epic: ${parentEpic.key} — ${parentEpic.summary} [${parentEpic.status}]\n`;
      if (parentEpic.description) fullContext += `${truncateWithIndicator(parentEpic.description, PARENT_DESC_CAP)}\n`;
    }

    if (attachmentContents && attachmentContents.length > 0) {
      fullContext += "\n## Attachment Contents\n";
      let attTotal = 0;
      for (const att of attachmentContents) {
        const trimmed = truncateWithIndicator(att.content, ATTACHMENT_PER_CAP);
        if (attTotal + trimmed.length > ATTACHMENT_TOTAL_CAP) {
          fullContext += `\n…[remaining attachments truncated — total cap ${ATTACHMENT_TOTAL_CAP} chars]\n`;
          break;
        }
        fullContext += `### ${att.filename} (${att.mimeType})\n\`\`\`\n${trimmed}\n\`\`\`\n\n`;
        attTotal += trimmed.length;
      }
    }

    if (fetchedUrlContents && fetchedUrlContents.length > 0) {
      fullContext += "\n## Fetched External URLs\n";
      let urlTotal = 0;
      for (const fu of fetchedUrlContents) {
        const trimmed = truncateWithIndicator(fu.content, URL_PER_CAP);
        if (urlTotal + trimmed.length > URL_TOTAL_CAP) {
          fullContext += `\n…[remaining URLs truncated — total cap ${URL_TOTAL_CAP} chars]\n`;
          break;
        }
        fullContext += `### ${fu.url}\n\`\`\`\n${trimmed}\n\`\`\`\n\n`;
        urlTotal += trimmed.length;
      }
    }

    const connectorContents = (state.data.ticket as any).connectorContents;
    if (connectorContents && connectorContents.length > 0) {
      fullContext += "\n## Connector Documents\n";
      for (const cd of connectorContents) {
        fullContext += `### ${cd.title} (source: ${cd.source})\n${cd.content}\n\n`;
      }
    }

    const ticketCtx =
      `**${TICKET}: ${summary}** [${iType || "Task"} / ${iPriority || "Medium"}]\n\n` +
      `## Description\n${sanitizeForPrompt(description)}\n\n` +
      `## Acceptance Criteria\n${sanitizeForPrompt(ac) || "(none provided)"}\n` +
      `${supplementary ? sanitizeForPrompt(supplementary) : ""}${sanitizeForPrompt(fullContext)}`;

    let analysisResult: string = state.data._agent_analysis as string || "";

    if (!analysisResult) {
      logInfo("  → Analysis Team: launching 3 parallel sub-agents…");

      const analysisRules =
        `## MANDATORY RULES\n` +
        `1. **REUSE existing code**: Use the EXACT same components, hooks, utils, services, API calls, styles, constants.\n` +
        `2. **Match existing patterns EXACTLY**: Same import style, state management, error handling, naming, folder structure.\n` +
        `3. **Prefer modifying existing files** over creating new ones.\n` +
        `4. **Import from existing paths**: Same import aliases, relative paths, barrel exports.\n` +
        `5. **Copy structure from similar features**: If there's an existing edit form, table, modal — copy it.\n` +
        `6. **No unnecessary abstractions**: Don't create helpers/utils the repo doesn't already have.\n` +
        `7. **VITE_PRODUCT_ID checks**: Must use the exact enterprise product ID — no generic multi-product conditionals.\n` +
        `8. **Enterprise app ONLY**: Do NOT modify or reference other product lines (SME, GST, TaxPro, etc.).\n\n`;

      const refineCtx = state.data._refine_instructions
        ? `\n\n## User Refinement Instructions (PRIORITY — address these specifically)\n${state.data._refine_instructions}\n`
        : "";

      const requirementsPrompt =
        `You are the **Requirements Agent**. Extract all functional requirements from the ticket.\n\n` +
        `${analysisRules}${ticketCtx}\n\n${refineCtx}` +
        `## Required Output Format\n### Requirements\nProvide a comprehensive bullet list of:\n- Functional requirements and user flows\n- Business rules and validation logic\n- UI changes (components, layouts, interactions)\n- API interactions (endpoints, payloads, field names)\n- State management changes\n- Edge cases mentioned in the ticket\n\n### Recommended Approach\nBrief paragraph on the best implementation strategy based on the requirements.\n\nBe thorough and precise. Extract EVERY requirement from the ticket, comments, and linked issues.`;

      const explorerPrompt = cfg.localRepo
        ? `You are the **Code Explorer Agent**. YOU HAVE DIRECT ACCESS TO THE REPOSITORY — use Read, Grep, and Glob tools to explore the codebase.\n\n${analysisRules}${ticketCtx}\n\nFolder structure: ${folderOverview}\n\nRelevant source files (${relevant.length} of ${srcFiles.length}):\n${treeList}\n\n${refineCtx}## Required Output Format\n### Reusable Code\nFor each relevant file, provide:\n- Exact file path\n- What to reuse\n- How it should be used\n\nFocus on finding EXISTING patterns. Explore deeply using Read/Grep/Glob tools.\nBe thorough in exploration but concise in output.`
        : `You are the **Code Explorer Agent**. Find reusable code patterns.\n\n${analysisRules}${ticketCtx}\n\nFolder structure: ${folderOverview}\n\nRelevant source files (${relevant.length} of ${srcFiles.length}):\n${treeList}\n\n${refineCtx}## Required Output Format\n### Reusable Code\nExact file paths and what to reuse from each.\n\nBe brief.`;

      const riskPrompt =
        `You are the **Risk Analyst Agent**. Identify risks, gaps, and edge cases for this ticket.\n\n${analysisRules}${ticketCtx}\n\nFolder structure: ${folderOverview}\n\nRelevant source files (${relevant.length} of ${srcFiles.length}):\n${treeList}\n\n${refineCtx}## Required Output Format\n### Risks\nBullet list with severity: [HIGH], [MEDIUM], [LOW].\n\n### Suggestions\nFormat each as a bullet starting with [GAP], [RISK], or [REC].\n\nBe specific and actionable.`;

      const explorerOpts = cfg.localRepo
        ? { cwd: cfg.localRepo, maxTurns: 20, allowedTools: ["Read", "Grep", "Glob"] }
        : {};

      analysisResult = await runAgentsTeam({
        teamName: "Analysis Team",
        agents: [
          { name: "Requirements Agent", prompt: requirementsPrompt, timeout: applyComplexityTimeout(360_000, state), opts: {}, required: true, checkpointKey: "_agent_requirements" },
          { name: "Code Explorer Agent", prompt: explorerPrompt, timeout: applyComplexityTimeout(420_000, state), opts: explorerOpts, required: false, checkpointKey: "_agent_explorer" },
          { name: "Risk Analyst Agent", prompt: riskPrompt, timeout: applyComplexityTimeout(300_000, state), opts: {}, required: false, checkpointKey: "_agent_risk" },
        ],
        state,
        merge: (results: any[]) => {
          const sections: string[] = [];
          const reqResult = results.find((r: any) => r.name === "Requirements Agent");
          if (reqResult && reqResult.output) sections.push(reqResult.output);
          const explorerResult = results.find((r: any) => r.name === "Code Explorer Agent");
          if (explorerResult && explorerResult.output) { sections.push(explorerResult.output); }
          else { sections.push("### Reusable Code\n(Code exploration was not available)"); }
          const riskResult = results.find((r: any) => r.name === "Risk Analyst Agent");
          if (riskResult && riskResult.output) { sections.push(riskResult.output); }
          else { sections.push("### Risks\n(Risk analysis was not available)\n\n### Suggestions\n(No suggestions available)"); }
          return sections.join("\n\n");
        },
      });

      validateClaudeOutput(analysisResult, "Analysis Team", 50);
      validateClaudeNotEmpty(analysisResult, "Analysis Team");
      state.data._agent_analysis = analysisResult;

      const suggestionsMatch = analysisResult.match(/### Suggestions\n([\s\S]*?)(?=###|$)/);
      if (suggestionsMatch) {
        const sugLines = suggestionsMatch[1].trim().split("\n").filter((l: string) => l.trim().startsWith("-"));
        state.data._agent_suggestions = sugLines.map((l: string) => l.trim().replace(/^-\s*/, ""));
      }

      save(state);
      logOk("  Analysis Team complete");
    }

    logOk("Analysis complete");

    logInfo("  → OpenSpec: scaffolding change…");
    const scaffold = scaffoldOpenSpec(TICKET);

    const CAP = 16000;
    const trim = (s: string): string => {
      if (s.length <= CAP) return s;
      logWarn(`Analysis truncated from ${s.length} to ${CAP} chars for Architect`);
      return s.substring(0, CAP) + `\n…[truncated at ${CAP} of ${s.length} chars]`;
    };

    logInfo("  → OpenSpec Architect Agent: producing structured plan artifacts…");

    const architectOpts = cfg.localRepo
      ? { cwd: cfg.localRepo, maxTurns: 25, allowedTools: ["Read", "Grep", "Glob"] }
      : { maxTurns: 25 };

    let templateInstructions = "";
    if (scaffold && scaffold.templates) {
      const t = scaffold.templates;
      if (t.proposal) { templateInstructions += `\n## PROPOSAL Template\nOutput path: ${t.proposal.outputPath}\n${t.proposal.instruction}\nRules: ${(t.proposal.rules || []).join("; ")}\nTemplate:\n\`\`\`\n${t.proposal.template}\n\`\`\`\n`; }
      if (t.design) { templateInstructions += `\n## DESIGN Template\nOutput path: ${t.design.outputPath}\n${t.design.instruction}\nRules: ${(t.design.rules || []).join("; ")}\nTemplate:\n\`\`\`\n${t.design.template}\n\`\`\`\n`; }
      if (t.specs) { templateInstructions += `\n## SPECS Template\nOutput path: ${t.specs.outputPath}\n${t.specs.instruction}\nRules: ${(t.specs.rules || []).join("; ")}\nTemplate:\n\`\`\`\n${t.specs.template}\n\`\`\`\n`; }
      if (t.tasks) { templateInstructions += `\n## TASKS Template\nOutput path: ${t.tasks.outputPath}\n${t.tasks.instruction}\nRules: ${(t.tasks.rules || []).join("; ")}\nTemplate:\n\`\`\`\n${t.tasks.template}\n\`\`\`\n`; }
    }

    const archTicketCtx = state.data.ticket
      ? `## Ticket: ${(state.data.ticket as any).key || TICKET}\n**Summary**: ${(state.data.ticket as any).summary || "(none)"}\n**Acceptance Criteria**:\n${(state.data.ticket as any).ac || "(none)"}\n\n`
      : "";

    const prevArtifactsCtx = state.data._prev_openspec
      ? `\n## Previous Artifacts (for reference)\n### Previous Proposal\n${truncateWithIndicator((state.data._prev_openspec as any).proposal || "", 3000)}\n### Previous Tasks\n${truncateWithIndicator((state.data._prev_openspec as any).tasks || "", 3000)}\n`
      : "";

    const refineArchCtx = state.data._refine_instructions
      ? `\n## User Refinement Instructions (PRIORITY)\n${state.data._refine_instructions}\n`
      : "";

    // Previously-confirmed clarifying questions — the user already answered these
    // in a prior run. Do not re-ask them unless the assumption has moved.
    const priorAnswers = (state.data._qa_answers as QuestionAnswer[] | undefined) || [];
    const priorAnswersCtx = priorAnswers.length > 0
      ? `\n## Previously-confirmed decisions\n` +
        `The user has already answered these clarifying questions. Do NOT re-ask them unless the plan has moved and these answers would no longer be valid:\n` +
        priorAnswers.map(a => `- ${a.id}: "${a.optionText}"`).join("\n") + "\n"
      : "";

    const architectPrompt =
      `You are the **OpenSpec Architect Agent**. Produce a comprehensive implementation plan as 4 structured artifacts.\n\n` +
      `${archTicketCtx}## Analysis Results\n${trim(analysisResult)}\n\n` +
      `## Z6: VITE_PRODUCT_ID Enforcement\nAll product ID checks MUST use the exact enterprise product ID constant.\n\n` +
      (templateInstructions ? `## OpenSpec Artifact Templates\n${templateInstructions}\n` : "") +
      `${prevArtifactsCtx}${priorAnswersCtx}${refineArchCtx}` +
      `## When you are uncertain\n` +
      `If the ticket or plan has a MATERIAL ambiguity that changes which files/UX/data you modify, append a QUESTIONS block AFTER your \`---TASKS---\` section, in this exact format:\n\n` +
      `---QUESTIONS---\n` +
      `[\n` +
      `  {\n` +
      `    "id": "short-slug-name",\n` +
      `    "text": "Full question sentence",\n` +
      `    "options": ["Option A description", "Option B description"],\n` +
      `    "recommend": 0,\n` +
      `    "reason": "One-sentence rationale for option A"\n` +
      `  }\n` +
      `]\n` +
      `---END---\n\n` +
      `Rules:\n` +
      `- Maximum 3 questions. If you have more, the ticket itself is too ambiguous — flag this in the proposal instead.\n` +
      `- Only for decisions that MATERIALLY change implementation (file paths, data shape, UX affordance).\n` +
      `- NOT for cosmetic preferences, naming micro-choices, or things answered in Jira comments.\n` +
      `- \`id\` must be unique within this output, kebab-case, ≤ 40 chars.\n` +
      `- \`options\` must have 2–5 string entries; each a full standalone description.\n` +
      `- Always include \`recommend\` (0-based index) and a one-sentence \`reason\`.\n` +
      `- If you have zero questions, DO NOT emit the QUESTIONS block at all.\n\n` +
      `## OUTPUT FORMAT — CRITICAL\nYou MUST output exactly 4 sections:\n\n---PROPOSAL---\n---DESIGN---\n---SPECS---\n---TASKS---\n\nAll 4 markers are REQUIRED.`;

    const architectOutput: string = await runSingleAgent({
      name: "OpenSpec Architect Agent",
      prompt: architectPrompt,
      timeout: applyComplexityTimeout(ANALYSIS_TIMEOUT_MS * 1.5, state),
      opts: architectOpts,
      state,
      checkpointKey: "_architect_result",
      required: true,
    });

    let artifacts: any = null;
    if (scaffold) {
      artifacts = parseAndWriteArtifacts(architectOutput, scaffold);
    }

    if (artifacts) {
      state.data.explore_plan = artifacts.tasks;
      state.data.explore_openspec = {
        proposal: artifacts.proposal, design: artifacts.design, specs: artifacts.specs,
        tasks: artifacts.tasks, changeName: scaffold.changeName, artifactDir: scaffold.changeDir,
        suggestions: state.data._agent_suggestions || [],
      };
    } else {
      logWarn("OpenSpec artifact parsing failed — using raw architect output");
      state.data.explore_plan = architectOutput;
      state.data.explore_openspec = null;
    }

    // Extract clarifying questions raised by the Architect. Also clear any
    // prior answers whose id is being re-raised (user must re-answer since
    // the underlying assumption may have moved).
    const pendingQuestions = parseQuestionsBlock(architectOutput);
    state.data._pending_questions = pendingQuestions;
    if (pendingQuestions.length > 0) {
      logInfo(`Architect raised ${pendingQuestions.length} clarifying question(s)`);
      const newIds = new Set(pendingQuestions.map(q => q.id));
      const existingAnswers = (state.data._qa_answers as QuestionAnswer[] | undefined) || [];
      const survivingAnswers = existingAnswers.filter(a => !newIds.has(a.id));
      if (survivingAnswers.length !== existingAnswers.length) {
        logInfo(`Cleared ${existingAnswers.length - survivingAnswers.length} stale answer(s) — questions were re-raised`);
      }
      state.data._qa_answers = survivingAnswers;
    }

    state.data.explore_agents = { analysis: analysisResult };
    save(state);
    logOk(`Implementation plan ready (2 agents completed${artifacts ? " + OpenSpec artifacts" : ""})`);
  }

  // ── Z7: Track plan rejection iterations ──
  if ((state.data.ticket as any).planFeedback && state.data._plan_was_posted_before) {
    state.data._plan_rejections = ((state.data._plan_rejections as number) || 0) + 1;
    logInfo(`Plan rejection iteration: ${state.data._plan_rejections}/${MAX_PLAN_REJECTIONS}`);
    if ((state.data._plan_rejections as number) >= MAX_PLAN_REJECTIONS) {
      logErr(`Plan rejected ${state.data._plan_rejections} times (max: ${MAX_PLAN_REJECTIONS}) — halting pipeline`);
      if (isChannelEnabled("explore_plan", "slack")) {
        await slack(`🛑 *Plan Rejection Limit — ${TICKET}*\nPlan was rejected ${state.data._plan_rejections} times. Pipeline halted.`, [cfg.slack.ownerId]);
      }
      save(state);
      throw new Error(`Plan rejected ${state.data._plan_rejections} times — exceeded MAX_PLAN_REJECTIONS (${MAX_PLAN_REJECTIONS})`);
    }
  }

  // ── Post plan for approval ──
  if (!state.data.explore_plan_posted) {
    const os = state.data.explore_openspec as any;
    if (isChannelEnabled("explore_plan", "slack")) {
      await slack(`📋 *Implementation Plan Ready — ${TICKET}*\n*${(state.data.ticket as any).summary}*\n\n${os ? "Full OpenSpec plan." : "Plan ready."}\nReview on Web UI → Approve, Reject, or Refine.\n🌐 http://localhost:3000`, [cfg.slack.ownerId]);
    }
    state.data.explore_plan_posted = true;
    state.data.explore_plan_at = new Date().toISOString();
    state.data._plan_was_posted_before = true;
    save(state);
    logOk("Plan ready on Web UI — waiting for your approval");
  }

  logWait("Waiting for plan approval (Web UI)…");

  const planPollStart = monotonicMs();
  let planPollCount = 0;
  while (true) {
    if (isShuttingDown()) { save(state); throw new Error("Shutdown in progress — exiting explore_plan"); }
    if (monotonicMs() - planPollStart > MAX_APPROVAL_TIMEOUT) {
      logErr(`Plan approval timeout after ${MAX_APPROVAL_TIMEOUT / 3600000}h`);
      if (isChannelEnabled("explore_plan", "slack")) { await slack(`⏰ *Plan Approval Timeout — ${TICKET}*`, [cfg.slack.ownerId]); }
      save(state);
      throw new Error(`Plan approval timeout after ${MAX_APPROVAL_TIMEOUT / 3600000}h`);
    }

    const uiResult: any = checkUIApproval(state, "explore_plan");
    if (uiResult) {
      if (uiResult.approved) {
        logOk("Plan approved via Web UI — proceeding to code generation");
        state.stage = "generate_code";
        save(state);
        return;
      } else {
        logErr("Plan rejected via Web UI — regenerating with feedback…");
        const feedback = uiResult.feedback || "";
        for (const field of (STAGE_CLEARS.explore_plan || [])) { state.data[field] = null; }
        state.data.explore_plan_ui_approved = null;
        state.data.explore_plan_ui_rejected = null;
        state.data.explore_plan_ui_feedback = null;
        (state.data.ticket as any).planFeedback = feedback;
        save(state);
        return stageExplorePlan(state);
      }
    }

    const uiRefine: string | null = checkUIRefine(state);
    if (uiRefine) {
      logInfo(`Plan refine via Web UI: "${truncateWithIndicator(uiRefine, 100)}"`);
      if (state.data.explore_openspec) { state.data._prev_openspec = { ...(state.data.explore_openspec as any) }; }
      state.data._refine_instructions = uiRefine;
      for (const field of (STAGE_CLEARS.explore_plan || [])) { state.data[field] = null; }
      state.data.explore_plan_ui_refine = null;
      state.data.explore_plan_ui_refine_instructions = null;
      save(state);
      return stageExplorePlan(state);
    }

    const comments: any[] = await jira.getComments(TICKET, state.data.explore_plan_at);
    for (const c of comments) {
      const text: string = adfText(c.body).toLowerCase().trim();
      const rawText: string = adfText(c.body).trim();

      if (text.startsWith("refine:")) {
        const instructions = rawText.substring(rawText.toLowerCase().indexOf("refine:") + 7).trim();
        if (instructions) {
          logInfo(`Plan refine via Jira: "${truncateWithIndicator(instructions, 100)}"`);
          if (state.data.explore_openspec) { state.data._prev_openspec = { ...(state.data.explore_openspec as any) }; }
          state.data._refine_instructions = instructions;
          for (const field of (STAGE_CLEARS.explore_plan || [])) { state.data[field] = null; }
          save(state);
          return stageExplorePlan(state);
        }
      }

      if (matchApprovalWord(text, "approved", ["not approved", "unapproved", "disapproved"])) {
        const extras = comments
          .filter((cc: any) => { const t = adfText(cc.body).toLowerCase().trim(); return !matchApprovalWord(t, "approved", []) && !matchApprovalWord(t, "rejected", []) && !t.startsWith("refine:"); })
          .map((cc: any) => adfText(cc.body)).join("\n\n");
        if (extras) { (state.data.ticket as any).planFeedback = extras; save(state); }
        logOk("Plan approved — proceeding to code generation");
        state.stage = "generate_code";
        save(state);
        return;
      }

      if (matchApprovalWord(text, "rejected", ["not rejected"])) {
        logErr("Plan rejected — regenerating with feedback…");
        const feedback = adfText(c.body);
        for (const field of (STAGE_CLEARS.explore_plan || [])) { state.data[field] = null; }
        (state.data.ticket as any).planFeedback = feedback;
        save(state);
        return stageExplorePlan(state);
      }
    }

    planPollCount++;
    if (planPollCount % 6 === 0) {
      const waitMins = Math.floor((monotonicMs() - planPollStart) / 60000);
      logInfo(`Waiting for plan approval… ${waitMins}m elapsed`);
    }
    await sleep(POLL_INTERVAL);
  }
}

function checkUIRefine(state: PipelineState): string | null {
  try {
    const rawParsed = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, `state-${TICKET}.json`), "utf8"));
    const fresh = (rawParsed && rawParsed._version === 2 && rawParsed.state) ? rawParsed.state : rawParsed;
    if (fresh.data.explore_plan_ui_refine && fresh.data.explore_plan_ui_refine_instructions) {
      state.data.explore_plan_ui_refine = true;
      state.data.explore_plan_ui_refine_instructions = fresh.data.explore_plan_ui_refine_instructions;
      return fresh.data.explore_plan_ui_refine_instructions;
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

export { stageExplorePlan, parseQuestionsBlock };
