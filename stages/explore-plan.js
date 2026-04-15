"use strict";

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

const PROJECT_ROOT = path.join(__dirname, "..");

// ── OpenSpec CLI integration ─────────────────────────────────────

/**
 * Scaffold an OpenSpec change for the ticket.
 * Runs: openspec new change, openspec status --json, openspec instructions --json for each artifact.
 * @param {string} ticket - Jira ticket ID (e.g. "AUT-1234")
 * @returns {{ changeName: string, changeDir: string, artifacts: object[], templates: object }} | null
 */
function scaffoldOpenSpec(ticket) {
  const changeName = ticket.toLowerCase();
  const changeDir = path.join(PROJECT_ROOT, "openspec", "changes", changeName);

  try {
    // Create the change if it doesn't already exist
    if (!fs.existsSync(changeDir)) {
      logInfo(`OpenSpec: creating change '${changeName}'…`);
      execSync(`openspec new change "${changeName}"`, { cwd: PROJECT_ROOT, stdio: "pipe", timeout: 30000 });
    } else {
      logInfo(`OpenSpec: change '${changeName}' already exists`);
    }

    // Get status with artifact list
    const statusRaw = execSync(`openspec status --change "${changeName}" --json`, { cwd: PROJECT_ROOT, stdio: "pipe", timeout: 15000 });
    const status = JSON.parse(statusRaw.toString().trim());

    // Get instructions for each artifact
    const templates = {};
    const artifactIds = ["proposal", "design", "specs", "tasks"];
    for (const id of artifactIds) {
      try {
        const instrRaw = execSync(`openspec instructions ${id} --change "${changeName}" --json`, { cwd: PROJECT_ROOT, stdio: "pipe", timeout: 15000 });
        templates[id] = JSON.parse(instrRaw.toString().trim());
      } catch (err) {
        logWarn(`OpenSpec: failed to get instructions for '${id}': ${err.message}`);
        templates[id] = null;
      }
    }

    logOk(`OpenSpec: scaffolded '${changeName}' with ${Object.keys(templates).filter((k) => templates[k]).length} artifact templates`);
    return { changeName, changeDir, artifacts: status.artifacts || [], templates };
  } catch (err) {
    logErr(`OpenSpec scaffold failed: ${err.message}`);
    return null;
  }
}

/**
 * Parse architect output by markers and write artifacts to disk.
 * Markers: ---PROPOSAL---, ---DESIGN---, ---SPECS---, ---TASKS---
 * @param {string} output - Raw architect output
 * @param {{ changeName: string, changeDir: string }} scaffoldInfo
 * @returns {{ proposal: string, design: string, specs: string, tasks: string }} | null
 */
function parseAndWriteArtifacts(output, scaffoldInfo) {
  const markers = ["---PROPOSAL---", "---DESIGN---", "---SPECS---", "---TASKS---"];
  const sections = {};

  try {
    // T2.5: Use line-anchored regex to avoid matching markers inside code blocks
    for (let i = 0; i < markers.length; i++) {
      const markerRegex = new RegExp(`^${markers[i].replace(/[-]/g, "\\-")}\\s*$`, "m");
      const markerMatch = markerRegex.exec(output);
      if (!markerMatch) continue;
      const startIdx = markerMatch.index;
      const contentStart = startIdx + markerMatch[0].length;
      // Find end: next marker or end of output
      let endIdx = output.length;
      for (let j = i + 1; j < markers.length; j++) {
        const nextRegex = new RegExp(`^${markers[j].replace(/[-]/g, "\\-")}\\s*$`, "m");
        const nextMatch = nextRegex.exec(output.substring(contentStart));
        if (nextMatch) { endIdx = contentStart + nextMatch.index; break; }
      }
      const key = markers[i].replace(/---/g, "").toLowerCase();
      sections[key] = output.substring(contentStart, endIdx).trim();
    }

    // Require at least proposal and tasks
    if (!sections.proposal && !sections.tasks) {
      logWarn("OpenSpec: could not parse markers from architect output — using raw output");
      return null;
    }

    // Write artifacts to disk
    const { changeDir } = scaffoldInfo;
    fs.mkdirSync(changeDir, { recursive: true });

    if (sections.proposal) {
      fs.writeFileSync(path.join(changeDir, "proposal.md"), sections.proposal, "utf8");
    }
    if (sections.design) {
      fs.writeFileSync(path.join(changeDir, "design.md"), sections.design, "utf8");
    }
    if (sections.specs) {
      // Write specs to specs/ subdirectory — use a single spec file for simplicity
      const specsDir = path.join(changeDir, "specs", "change");
      fs.mkdirSync(specsDir, { recursive: true });
      fs.writeFileSync(path.join(specsDir, "spec.md"), sections.specs, "utf8");
    }
    if (sections.tasks) {
      fs.writeFileSync(path.join(changeDir, "tasks.md"), sections.tasks, "utf8");
    }

    // Write .openspec.yaml marker
    const yamlContent = `schema: spec-driven\nchange: ${scaffoldInfo.changeName}\ncreated: ${new Date().toISOString()}\n`;
    fs.writeFileSync(path.join(changeDir, ".openspec.yaml"), yamlContent, "utf8");

    logOk(`OpenSpec: wrote ${Object.keys(sections).length} artifacts to ${changeDir}`);
    return {
      proposal: sections.proposal || "",
      design: sections.design || "",
      specs: sections.specs || "",
      tasks: sections.tasks || "",
    };
  } catch (err) {
    logErr(`OpenSpec: parseAndWriteArtifacts failed: ${err.message}`);
    return null;
  }
}

async function stageExplorePlan(state) {
  logStep("1b", "Explore & Plan — analyzing ticket with agents team");

  const { summary, description, ac, attachments, externalUrls } = state.data.ticket;

  // ── F5: No-AC Ticket Handling (skipped — no AC field in Jira) ──
  if (state.data.ticket.ac_missing) {
    logInfo("No AC field in Jira — using ticket description + comments as context");
    state.data.ticket.ac_missing = false;
    save(state);
  }

  // ── Q1: Smart inaccessible content detection + notification ──
  if (!state.data.explore_docs_checked) {
    const inaccessible = [];
    const ticketText = `${summary} ${description} ${ac}`;

    // Check external URLs for known doc types the agent cannot access
    for (const url of (externalUrls || [])) {
      const docType = classifyDocUrl(url);
      if (docType !== "External Document") {
        const criticality = assessDocCriticality(docType, ticketText);
        inaccessible.push({ type: docType, url, criticality, instructions: getDocPasteInstructions(docType) });
      }
    }

    // Q1: Include auth-required URLs detected during fetch
    const authRequired = state.data.ticket.authRequiredUrls || [];
    for (const ar of authRequired) {
      // Avoid duplicates
      if (!inaccessible.some((d) => d.url === ar.url)) {
        const criticality = assessDocCriticality(ar.docType, ticketText);
        inaccessible.push({ type: ar.docType, url: ar.url, criticality, instructions: getDocPasteInstructions(ar.docType), reason: ar.reason });
      }
    }

    // Check attachments the agent cannot parse
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
      // Q1: Sort by criticality (CRITICAL first)
      const critOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
      inaccessible.sort((a, b) => (critOrder[a.criticality] || 9) - (critOrder[b.criticality] || 9));

      const hasCritical = inaccessible.some((d) => d.criticality === "CRITICAL");
      logErr(`Cannot access ${inaccessible.length} document(s)${hasCritical ? " (includes CRITICAL)" : ""}:`);
      inaccessible.forEach((d) => logErr(`  [${d.criticality}] ${d.type}: ${d.url}`));

      // Q1: Smart per-type paste instructions
      const docList = inaccessible.map((d, i) =>
        `${i + 1}. [${d.criticality}] ${d.type}: ${d.url}\n   ${d.instructions}${d.reason ? ` (${d.reason})` : ""}`
      ).join("\n");

      // Ask user for help via Jira + Slack with smart instructions
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

      // Wait for user to provide docs and say "continue"
      logWait("Waiting for you to provide document content on Jira…");
      state.data.explore_wait_at = new Date().toISOString();
      save(state);

      const continueStart = monotonicMs(); // V9
      let docPollCount = 0;
      while (true) {
        if (monotonicMs() - continueStart > MAX_CONTINUE_WAIT) {
          logWarn(`Document wait timed out after ${MAX_CONTINUE_WAIT / 60000} minutes — proceeding with available context`);
          if (isChannelEnabled("explore_plan", "slack")) {
            await slack(`⏰ *Document wait timed out — ${TICKET}*\nProceeding with available context.`, [cfg.slack.ownerId]);
          }
          break;
        }
        const comments = await jira.getComments(TICKET, state.data.explore_wait_at);
        const continueComment = comments.find((c) =>
          matchApprovalWord(adfText(c.body).toLowerCase().trim(), "continue", ["discontinued", "not continue"]),
        );
        if (continueComment) {
          // Collect supplementary context from ALL comments (including "continue" comment itself)
          const extraParts = [];
          for (const c of comments) {
            const md = adfToMarkdown(c.body);
            const plain = adfText(c.body).toLowerCase().trim();
            if (plain === "continue") continue; // Skip pure "continue" comments
            // If a comment contains "continue" mixed with content, extract the content part
            const lines = md.split("\n").filter((l) => l.trim().toLowerCase() !== "continue");
            const content = lines.join("\n").trim();
            if (content) {
              const author = c.author?.displayName || "Deleted User";
              extraParts.push(`[${author}]:\n${content}`);
            }
          }
          const extraContext = extraParts.join("\n\n");
          // G11: Guard — if "continue" posted but no content comments found, re-prompt
          if (!extraContext) {
            logWarn("G11: 'continue' posted but no supplementary content found — re-prompting");
            try {
              if (isChannelEnabled("explore_plan", "jira")) {
                await jira.addComment(TICKET, "No supplementary content detected. Please paste the document content first, then comment 'continue'.");
              }
            } catch {}
            await sleep(POLL_INTERVAL);
            continue; // Resume waiting — don't break out of loop
          }
          state.data.ticket.supplementaryDocs = extraContext;
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

    // Build a compact tree: only source code files, directories for structure
    const tree = cfg.localRepo
      ? localGetTree(cfg.localRepo)
      : await gl.getTree("", cfg.branch.ts, true);
    const SRC_EXT = /\.(tsx?|jsx?|css|scss|less|json)$/i;
    // GQ5: Use SKIP_ALWAYS for developer tree (includes test files), full SKIP for reviewer
    const SKIP = /node_modules|\.next|dist\/|build\/|\.git\/|__pycache__|\.cache|\.husky|coverage|\.nyc|\.storybook|public\/static|assets\/(images|fonts|icons)|\.svg$|\.png$|\.jpg$|\.ico$|\.woff|\.ttf|\.map$|package-lock|yarn\.lock|\.eslint|\.prettier|\.spec\.|\.test\.|__tests__|__mocks__/i;
    const srcFiles = tree.filter((e) => e.type === "blob" && SRC_EXT.test(e.path) && !SKIP.test(e.path));

    // Get unique top-level directories for folder overview
    const dirs = [...new Set(tree.filter((e) => e.type === "tree" && e.path.split("/").length <= 2 && !SKIP.test(e.path)).map((e) => e.path))];
    const folderOverview = dirs.slice(0, 30).join(", ");

    // Only show files relevant to the ticket keywords
    const keywords = (summary + " " + description).toLowerCase().match(/[a-z]{3,}/g) || [];
    let relevant = srcFiles.filter((e) => {
      const p = e.path.toLowerCase();
      return keywords.some((k) => p.includes(k)) || p.includes("invoice") || p.includes("import") || p.includes("edit") || p.includes("common") || p.includes("shared") || p.includes("hook") || p.includes("util") || p.includes("service") || p.includes("constant") || p.includes("type");
    });
    // H17: Fallback if keyword match returns 0 files
    if (relevant.length === 0) {
      logWarn("No keyword-matched files found — falling back to first 50 source files");
      relevant = srcFiles.slice(0, 50);
    }
    // GQ6: Ensure TypeScript/lint config files are always included in relevant list
    const CONFIG_EP = ["tsconfig.json", "vite.config.ts", "vite.config.js"];
    const CONFIG_EP_PAT = [/^\.eslintrc/, /^\.prettierrc/, /^tsconfig\./];
    const allPaths = tree.map((e) => e.path);
    for (const cf of CONFIG_EP) {
      if (allPaths.includes(cf) && !relevant.some((e) => e.path === cf)) {
        relevant.push({ path: cf, type: "blob" });
      }
    }
    for (const pat of CONFIG_EP_PAT) {
      for (const tp of allPaths) {
        if (pat.test(path.basename(tp)) && !relevant.some((e) => e.path === tp)) {
          relevant.push({ path: tp, type: "blob" });
        }
      }
    }
    const treeList = relevant.slice(0, 100).map((e) => e.path).join("\n");
    logInfo(`Repo: ${tree.length} total, ${srcFiles.length} source files, ${relevant.length} relevant`);

    const supplementary = state.data.ticket.supplementaryDocs
      ? `\n## Supplementary Docs (from user)\n${state.data.ticket.supplementaryDocs}\n`
      : "";

    // Build comprehensive context from all gathered sources
    const { comments: ticketComments, linkedIssues, parent: parentEpic,
      attachmentContents, fetchedUrlContents, issueType: iType, priority: iPriority
    } = state.data.ticket;

    let fullContext = "";

    // Context budgeting caps (supplementary context only — core ticket desc + AC are never truncated)
    const COMMENTS_CAP = 20_000;
    const LINKED_ISSUES_MAX = 5;
    const LINKED_ISSUE_DESC_CAP = 2_000;
    const PARENT_DESC_CAP = 3_000;
    const ATTACHMENT_PER_CAP = 3_000;
    const ATTACHMENT_TOTAL_CAP = 10_000;
    const URL_PER_CAP = 5_000;
    const URL_TOTAL_CAP = 10_000;

    // Comments context (budgeted to COMMENTS_CAP)
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

    // Linked issues context (max LINKED_ISSUES_MAX, descriptions capped)
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

    // Parent epic context (description capped)
    if (parentEpic) {
      fullContext += `\n## Parent Epic: ${parentEpic.key} — ${parentEpic.summary} [${parentEpic.status}]\n`;
      if (parentEpic.description) fullContext += `${truncateWithIndicator(parentEpic.description, PARENT_DESC_CAP)}\n`;
    }

    // Downloaded attachment content (budgeted per-item and total)
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

    // Fetched URL content (budgeted per-item and total)
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

    // Connector documents (dedicated 15KB per-item budget)
    const connectorContents = ticket.connectorContents;
    if (connectorContents && connectorContents.length > 0) {
      fullContext += "\n## Connector Documents\n";
      for (const cd of connectorContents) {
        fullContext += `### ${cd.title} (source: ${cd.source})\n${cd.content}\n\n`;
      }
    }

    // D1: Sanitize user-sourced content for prompt injection defense
    const ticketCtx =
      `**${TICKET}: ${summary}** [${iType || "Task"} / ${iPriority || "Medium"}]\n\n` +
      `## Description\n${sanitizeForPrompt(description)}\n\n` +
      `## Acceptance Criteria\n${sanitizeForPrompt(ac) || "(none provided)"}\n` +
      `${supplementary ? sanitizeForPrompt(supplementary) : ""}${sanitizeForPrompt(fullContext)}`;

    // Agent 1 — Analysis Team: 3 parallel sub-agents (Requirements + Code Explorer + Risk)
    let analysisResult = state.data._agent_analysis || "";

    if (!analysisResult) {
      logInfo("  → Analysis Team: launching 3 parallel sub-agents…");

      // H12: MANDATORY RULES shared across all sub-agents
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

      // Sub-agent 1: Requirements Agent
      const requirementsPrompt =
        `You are the **Requirements Agent**. Extract all functional requirements from the ticket.\n\n` +
        `${analysisRules}` +
        `${ticketCtx}\n\n` +
        `${refineCtx}` +
        `## Required Output Format\n` +
        `### Requirements\n` +
        `Provide a comprehensive bullet list of:\n` +
        `- Functional requirements and user flows\n` +
        `- Business rules and validation logic\n` +
        `- UI changes (components, layouts, interactions)\n` +
        `- API interactions (endpoints, payloads, field names)\n` +
        `- State management changes\n` +
        `- Edge cases mentioned in the ticket\n\n` +
        `### Recommended Approach\n` +
        `Brief paragraph on the best implementation strategy based on the requirements.\n\n` +
        `Be thorough and precise. Extract EVERY requirement from the ticket, comments, and linked issues.`;

      // Sub-agent 2: Code Explorer Agent
      const explorerPrompt = cfg.localRepo
        ? `You are the **Code Explorer Agent**. YOU HAVE DIRECT ACCESS TO THE REPOSITORY — use Read, Grep, and Glob tools to explore the codebase.\n\n` +
          `${analysisRules}` +
          `${ticketCtx}\n\n` +
          `Folder structure: ${folderOverview}\n\n` +
          `Relevant source files (${relevant.length} of ${srcFiles.length}):\n${treeList}\n\n` +
          `${refineCtx}` +
          `## Required Output Format\n` +
          `### Reusable Code\n` +
          `For each relevant file, provide:\n` +
          `- Exact file path\n` +
          `- What to reuse (components, hooks, utils, services, constants, types)\n` +
          `- How it should be used for this ticket\n\n` +
          `Focus on finding EXISTING patterns in the codebase that should be reused. Explore deeply using Read/Grep/Glob tools.\n` +
          `Be thorough in exploration but concise in output.`
        : `You are the **Code Explorer Agent**. Find reusable code patterns.\n\n` +
          `${analysisRules}` +
          `${ticketCtx}\n\n` +
          `Folder structure: ${folderOverview}\n\n` +
          `Relevant source files (${relevant.length} of ${srcFiles.length}):\n${treeList}\n\n` +
          `${refineCtx}` +
          `## Required Output Format\n` +
          `### Reusable Code\n` +
          `Exact file paths and what to reuse from each (components, hooks, utils, services, constants, types).\n\n` +
          `Be brief.`;

      // Sub-agent 3: Risk Analyst Agent
      const riskPrompt =
        `You are the **Risk Analyst Agent**. Identify risks, gaps, and edge cases for this ticket.\n\n` +
        `${analysisRules}` +
        `${ticketCtx}\n\n` +
        `Folder structure: ${folderOverview}\n\n` +
        `Relevant source files (${relevant.length} of ${srcFiles.length}):\n${treeList}\n\n` +
        `${refineCtx}` +
        `## Required Output Format\n` +
        `### Risks\n` +
        `Bullet list with severity: [HIGH], [MEDIUM], [LOW]. Include:\n` +
        `- Missing requirements or ambiguous acceptance criteria\n` +
        `- Missing API specs or undefined field names\n` +
        `- Edge cases and error handling gaps\n` +
        `- Potential breaking changes to existing functionality\n` +
        `- Performance concerns\n\n` +
        `### Suggestions\n` +
        `Identify actionable gaps and recommendations. For each suggestion, provide:\n` +
        `- **Gaps**: Unclear requirements, missing API specs, ambiguous acceptance criteria, undefined error handling\n` +
        `- **Risks**: Edge cases not covered, potential breaking changes, performance concerns\n` +
        `- **Recommendations**: Modules to explore for patterns, requirements to clarify with the team, similar features to reuse\n` +
        `Format each as a bullet starting with [GAP], [RISK], or [REC].\n\n` +
        `Be specific and actionable.`;

      const explorerOpts = cfg.localRepo
        ? { cwd: cfg.localRepo, maxTurns: 20, allowedTools: ["Read", "Grep", "Glob"] }
        : {};

      analysisResult = await runAgentsTeam({
        teamName: "Analysis Team",
        agents: [
          {
            name: "Requirements Agent",
            prompt: requirementsPrompt,
            timeout: applyComplexityTimeout(360_000, state), // 6 min
            opts: {},
            required: true,
            checkpointKey: "_agent_requirements",
          },
          {
            name: "Code Explorer Agent",
            prompt: explorerPrompt,
            timeout: applyComplexityTimeout(420_000, state), // 7 min
            opts: explorerOpts,
            required: false,
            checkpointKey: "_agent_explorer",
          },
          {
            name: "Risk Analyst Agent",
            prompt: riskPrompt,
            timeout: applyComplexityTimeout(300_000, state), // 5 min
            opts: {},
            required: false,
            checkpointKey: "_agent_risk",
          },
        ],
        state,
        merge: (results) => {
          const sections = [];
          const reqResult = results.find((r) => r.name === "Requirements Agent");
          if (reqResult && reqResult.output) sections.push(reqResult.output);

          const explorerResult = results.find((r) => r.name === "Code Explorer Agent");
          if (explorerResult && explorerResult.output) {
            sections.push(explorerResult.output);
          } else {
            sections.push("### Reusable Code\n(Code exploration was not available — Architect should explore the repo directly)");
          }

          const riskResult = results.find((r) => r.name === "Risk Analyst Agent");
          if (riskResult && riskResult.output) {
            sections.push(riskResult.output);
          } else {
            sections.push("### Risks\n(Risk analysis was not available)\n\n### Suggestions\n(No suggestions available)");
          }
          return sections.join("\n\n");
        },
      });

      // H15: Validate analysis output
      validateClaudeOutput(analysisResult, "Analysis Team", 50);
      // W7: Validate non-empty
      validateClaudeNotEmpty(analysisResult, "Analysis Team");
      state.data._agent_analysis = analysisResult;

      // Extract suggestions from merged output (from Risk Analyst)
      const suggestionsMatch = analysisResult.match(/### Suggestions\n([\s\S]*?)(?=###|$)/);
      if (suggestionsMatch) {
        const sugLines = suggestionsMatch[1].trim().split("\n").filter((l) => l.trim().startsWith("-"));
        state.data._agent_suggestions = sugLines.map((l) => l.trim().replace(/^-\s*/, ""));
      }

      save(state);
      logOk("  Analysis Team complete");
    }

    logOk("Analysis complete");

    // ── OpenSpec scaffold ──
    logInfo("  → OpenSpec: scaffolding change…");
    const scaffold = scaffoldOpenSpec(TICKET);

    // Agent 2 — OpenSpec Architect: produce 4 structured artifacts
    const CAP = 16000;
    const trim = (s) => {
      if (s.length <= CAP) return s;
      logWarn(`Analysis truncated from ${s.length} to ${CAP} chars for Architect`);
      return s.substring(0, CAP) + `\n…[truncated at ${CAP} of ${s.length} chars]`;
    };

    logInfo("  → OpenSpec Architect Agent: producing structured plan artifacts…");

    const architectOpts = cfg.localRepo
      ? { cwd: cfg.localRepo, maxTurns: 25, allowedTools: ["Read", "Grep", "Glob"] }
      : { maxTurns: 25 };

    // Build template instructions from OpenSpec CLI
    let templateInstructions = "";
    if (scaffold && scaffold.templates) {
      const t = scaffold.templates;
      if (t.proposal) {
        templateInstructions += `\n## PROPOSAL Template & Instructions\n` +
          `Output path: ${t.proposal.outputPath}\n` +
          `${t.proposal.instruction}\n` +
          `Rules: ${(t.proposal.rules || []).join("; ")}\n` +
          `Template:\n\`\`\`\n${t.proposal.template}\n\`\`\`\n`;
      }
      if (t.design) {
        templateInstructions += `\n## DESIGN Template & Instructions\n` +
          `Output path: ${t.design.outputPath}\n` +
          `${t.design.instruction}\n` +
          `Rules: ${(t.design.rules || []).join("; ")}\n` +
          `Template:\n\`\`\`\n${t.design.template}\n\`\`\`\n`;
      }
      if (t.specs) {
        templateInstructions += `\n## SPECS Template & Instructions\n` +
          `Output path: ${t.specs.outputPath}\n` +
          `${t.specs.instruction}\n` +
          `Rules: ${(t.specs.rules || []).join("; ")}\n` +
          `Template:\n\`\`\`\n${t.specs.template}\n\`\`\`\n`;
      }
      if (t.tasks) {
        templateInstructions += `\n## TASKS Template & Instructions\n` +
          `Output path: ${t.tasks.outputPath}\n` +
          `${t.tasks.instruction}\n` +
          `Rules: ${(t.tasks.rules || []).join("; ")}\n` +
          `Template:\n\`\`\`\n${t.tasks.template}\n\`\`\`\n`;
      }
    }

    const archTicketCtx = state.data.ticket
      ? `## Ticket: ${state.data.ticket.key || TICKET}\n` +
        `**Summary**: ${state.data.ticket.summary || "(none)"}\n` +
        `**Acceptance Criteria**:\n${state.data.ticket.ac || "(none)"}\n\n`
      : "";

    // Include previous artifacts as reference if this is a refinement iteration
    const prevArtifactsCtx = state.data._prev_openspec
      ? `\n## Previous Artifacts (for reference — improve upon these)\n` +
        `### Previous Proposal\n${truncateWithIndicator(state.data._prev_openspec.proposal || "", 3000)}\n` +
        `### Previous Tasks\n${truncateWithIndicator(state.data._prev_openspec.tasks || "", 3000)}\n`
      : "";

    const refineArchCtx = state.data._refine_instructions
      ? `\n## User Refinement Instructions (PRIORITY)\n${state.data._refine_instructions}\n`
      : "";

    const architectPrompt =
      `You are the **OpenSpec Architect Agent**. Produce a comprehensive implementation plan as 4 structured artifacts.\n\n` +
      `${archTicketCtx}` +
      `## Analysis Results\n${trim(analysisResult)}\n\n` +
      `## Z6: VITE_PRODUCT_ID Enforcement\n` +
      `All product ID checks MUST use the exact enterprise product ID constant. No generic multi-product conditionals. Enterprise scope ONLY.\n\n` +
      (templateInstructions ? `## OpenSpec Artifact Templates\nFollow these templates from the OpenSpec framework:\n${templateInstructions}\n` : "") +
      `${prevArtifactsCtx}${refineArchCtx}` +
      `## OUTPUT FORMAT — CRITICAL\n` +
      `You MUST output exactly 4 sections, each preceded by its marker on a line by itself:\n\n` +
      `---PROPOSAL---\n(proposal content following the template above)\n\n` +
      `---DESIGN---\n(design content following the template above)\n\n` +
      `---SPECS---\n(specs content following the template above — WHEN/THEN scenarios)\n\n` +
      `---TASKS---\n(tasks content following the template above — numbered checkbox steps)\n\n` +
      `All 4 markers are REQUIRED. Use the repo (Read/Grep/Glob) to gather implementation details.\n` +
      `Be thorough but concise. Every task must be actionable and verifiable.`;

    const architectOutput = await runSingleAgent({
      name: "OpenSpec Architect Agent",
      prompt: architectPrompt,
      timeout: applyComplexityTimeout(ANALYSIS_TIMEOUT_MS * 1.5, state),
      opts: architectOpts,
      state,
      checkpointKey: "_architect_result",
      required: true,
    });

    // Parse and write artifacts
    let artifacts = null;
    if (scaffold) {
      artifacts = parseAndWriteArtifacts(architectOutput, scaffold);
    }

    if (artifacts) {
      // Store structured artifacts
      state.data.explore_plan = artifacts.tasks; // backward-compat for Developer Agent
      state.data.explore_openspec = {
        proposal: artifacts.proposal,
        design: artifacts.design,
        specs: artifacts.specs,
        tasks: artifacts.tasks,
        changeName: scaffold.changeName,
        artifactDir: scaffold.changeDir,
        suggestions: state.data._agent_suggestions || [],
      };
    } else {
      // Fallback: use raw architect output as plan (graceful degradation)
      logWarn("OpenSpec artifact parsing failed — using raw architect output");
      state.data.explore_plan = architectOutput;
      state.data.explore_openspec = null;
    }

    state.data.explore_agents = { analysis: analysisResult };
    save(state);
    logOk(`Implementation plan ready (2 agents completed${artifacts ? " + OpenSpec artifacts" : ""})`);
  }

  // ── Z7: Track plan rejection iterations ──
  // Only count as a rejection iteration if the plan was previously posted and rejected
  if (state.data.ticket.planFeedback && state.data._plan_was_posted_before) {
    state.data._plan_rejections = (state.data._plan_rejections || 0) + 1;
    logInfo(`Plan rejection iteration: ${state.data._plan_rejections}/${MAX_PLAN_REJECTIONS}`);
    if (state.data._plan_rejections >= MAX_PLAN_REJECTIONS) {
      logErr(`Plan rejected ${state.data._plan_rejections} times (max: ${MAX_PLAN_REJECTIONS}) — halting pipeline`);
      if (isChannelEnabled("explore_plan", "slack")) {
        await slack(
          `🛑 *Plan Rejection Limit — ${TICKET}*\nPlan was rejected ${state.data._plan_rejections} times (max: ${MAX_PLAN_REJECTIONS}). Pipeline halted. Please refine the ticket requirements and restart.`,
          [cfg.slack.ownerId],
        );
      }
      save(state);
      throw new Error(`Plan rejected ${state.data._plan_rejections} times — exceeded MAX_PLAN_REJECTIONS (${MAX_PLAN_REJECTIONS})`);
    }
  }

  // ── Post plan for approval (Web UI only — no Jira comment) ──
  if (!state.data.explore_plan_posted) {
    const os = state.data.explore_openspec;

    if (isChannelEnabled("explore_plan", "slack")) {
      await slack(
        `📋 *Implementation Plan Ready — ${TICKET}*\n` +
        `*${state.data.ticket.summary}*\n\n` +
        `${os ? "Full OpenSpec plan with Proposal/Design/Specs/Tasks." : "Plan ready for review."}\n` +
        `${(os && os.suggestions && os.suggestions.length > 0) ? `⚡ ${os.suggestions.length} suggestion(s) from the agent.\n` : ""}` +
        `Review on the Agent Web UI → Approve, Reject, or Refine.\n` +
        `🌐 http://localhost:3000`,
        [cfg.slack.ownerId],
      );
    }

    state.data.explore_plan_posted = true;
    state.data.explore_plan_at = new Date().toISOString();
    state.data._plan_was_posted_before = true; // Z7: track for rejection counting
    save(state);
    logOk("Plan ready on Web UI — waiting for your approval");
  }

  // ── Wait for approval or rejection ──
  logWait("Waiting for plan approval (Web UI)…");

  const planPollStart = monotonicMs(); // V9: monotonic clock
  let planPollCount = 0;
  while (true) {
    if (isShuttingDown()) {
      save(state);
      throw new Error("Shutdown in progress — exiting explore_plan");
    }
    if (monotonicMs() - planPollStart > MAX_APPROVAL_TIMEOUT) {
      logErr(`Plan approval timeout after ${MAX_APPROVAL_TIMEOUT / 3600000}h`);
      if (isChannelEnabled("explore_plan", "slack")) {
        await slack(`⏰ *Plan Approval Timeout — ${TICKET}*\nPipeline halted.`, [cfg.slack.ownerId]);
      }
      save(state);
      throw new Error(`Plan approval timeout after ${MAX_APPROVAL_TIMEOUT / 3600000}h`);
    }
    // Check Web UI approval/rejection/refine first
    const uiResult = checkUIApproval(state, "explore_plan");
    if (uiResult) {
      if (uiResult.approved) {
        logOk("Plan approved via Web UI — proceeding to code generation");
        state.stage = "generate_code";
        save(state);
        return;
      } else {
        logErr("Plan rejected via Web UI — regenerating with feedback…");
        const feedback = uiResult.feedback || "";
        // Fix 3a/3b: Use STAGE_CLEARS to clear all downstream fields (including _agent_analysis)
        for (const field of (STAGE_CLEARS.explore_plan || [])) {
          state.data[field] = null;
        }
        state.data.explore_plan_ui_approved = null;
        state.data.explore_plan_ui_rejected = null;
        state.data.explore_plan_ui_feedback = null;
        state.data.ticket.planFeedback = feedback;
        save(state);
        return stageExplorePlan(state);
      }
    }

    // Check Web UI refine request
    const uiRefine = checkUIRefine(state);
    if (uiRefine) {
      logInfo(`Plan refine via Web UI: "${truncateWithIndicator(uiRefine, 100)}"`);
      // Store previous artifacts for reference
      if (state.data.explore_openspec) {
        state.data._prev_openspec = { ...state.data.explore_openspec };
      }
      state.data._refine_instructions = uiRefine;
      // Clear plan data to trigger regeneration
      for (const field of (STAGE_CLEARS.explore_plan || [])) {
        state.data[field] = null;
      }
      state.data.explore_plan_ui_refine = null;
      state.data.explore_plan_ui_refine_instructions = null;
      save(state);
      return stageExplorePlan(state);
    }

    // Then check Jira comments
    const comments = await jira.getComments(TICKET, state.data.explore_plan_at);

    for (const c of comments) {
      const text = adfText(c.body).toLowerCase().trim();
      const rawText = adfText(c.body).trim();

      // Check for "refine:" prefix (new interactive refinement)
      if (text.startsWith("refine:")) {
        const instructions = rawText.substring(rawText.toLowerCase().indexOf("refine:") + 7).trim();
        if (instructions) {
          logInfo(`Plan refine via Jira: "${truncateWithIndicator(instructions, 100)}"`);
          // Store previous artifacts for reference
          if (state.data.explore_openspec) {
            state.data._prev_openspec = { ...state.data.explore_openspec };
          }
          state.data._refine_instructions = instructions;
          // Clear plan data to trigger regeneration
          for (const field of (STAGE_CLEARS.explore_plan || [])) {
            state.data[field] = null;
          }
          save(state);
          return stageExplorePlan(state);
        }
      }

      if (matchApprovalWord(text, "approved", ["not approved", "unapproved", "disapproved"])) {
        // Collect any extra comments as additional context for code gen
        const extras = comments
          .filter((cc) => {
            const t = adfText(cc.body).toLowerCase().trim();
            return !matchApprovalWord(t, "approved", []) && !matchApprovalWord(t, "rejected", []) && !t.startsWith("refine:");
          })
          .map((cc) => adfText(cc.body))
          .join("\n\n");
        if (extras) {
          state.data.ticket.planFeedback = extras;
          save(state);
        }

        logOk("Plan approved — proceeding to code generation");
        state.stage = "generate_code";
        save(state);
        return;
      }

      if (matchApprovalWord(text, "rejected", ["not rejected"])) {
        logErr("Plan rejected — regenerating with feedback…");
        const feedback = adfText(c.body);
        // Fix 3a/3b: Use STAGE_CLEARS to clear all downstream fields (including _agent_analysis)
        for (const field of (STAGE_CLEARS.explore_plan || [])) {
          state.data[field] = null;
        }
        state.data.ticket.planFeedback = feedback;
        save(state);
        // Loop back — will re-enter this function and rebuild plan
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

/**
 * Check if the user requested a plan refinement via Web UI.
 * Reads fresh state from disk (same pattern as checkUIApproval).
 */
function checkUIRefine(state) {
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

module.exports = { stageExplorePlan };
