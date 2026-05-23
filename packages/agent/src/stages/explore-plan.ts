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

// ── Discovery cache (fix A from AUT-8648 post-mortem) ─────────────
//
// Front-loaded discovery work (Requirements/Explorer/Risk/Architect) is
// expensive — typically 10–15 minutes per pipeline cycle. Without this
// cache, every `explore_plan` re-entry (caused by rollback after a failed
// generate_code, or by STAGE_CLEARS firing on a plain restart) replays
// that work from scratch, even when the ticket inputs and repo HEAD have
// not changed.
//
// Cache key is content-addressed over the inputs the architect actually
// sees: ticket fields + supplementary docs + plan feedback + refine
// instructions + repo HEAD SHA. When ANY of those change (user refines,
// architect prompt bumped, parent branch advanced), the key changes and
// we naturally re-run. When NONE change (a pure restart), the cache hits
// and we skip the four agents.
//
// Cache is intentionally NOT listed in STAGE_CLEARS so it survives the
// stage rollback that triggers re-entry. The cache stores ONE entry at a
// time — older entries are overwritten when the architect succeeds.
const DISCOVERY_CACHE_VERSION = 1;

function _computeDiscoveryCacheKey(state: any): string {
  const crypto = require("crypto");
  const t = state.data.ticket || {};
  const parts = [
    `v${DISCOVERY_CACHE_VERSION}`,
    `summary:${(t.summary || "").trim()}`,
    `desc:${(t.description || "").trim()}`,
    `ac:${(t.ac || "").trim()}`,
    `supp:${(t.supplementaryDocs || "").trim()}`,
    `feedback:${(t.planFeedback || "").trim()}`,
    `refine:${(state.data._refine_instructions || "").trim()}`,
  ];
  // Repo HEAD SHA pins the cache to a code state. A `git pull` that
  // changes HEAD will invalidate the cache and force a fresh exploration
  // — the architect's plan may depend on what's now on disk.
  if (cfg.localRepo) {
    try {
      const { execFileSync } = require("child_process");
      const sha = execFileSync("git", ["-C", cfg.localRepo, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 }).toString().trim();
      parts.push(`sha:${sha}`);
    } catch { /* no HEAD yet — leave key sha-less */ }
  }
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

// Gap H: validate a cached explore_plan against Fix C's size constraints
// before restoring. The architect is non-deterministic across runs —
// if Fix A locked in a bad plan (kitchen-sink groups exceeding
// TASK_GROUP_FILES_HARD), every restart would inherit that bad plan
// and burn Dev-Agent budgets on it. Discarding the cache when this
// happens forces a fresh architect run, giving Fix C a chance to
// produce a better plan.
//
// Lazy require to avoid a circular import between explore-plan.ts and
// developer.ts (both are stage modules in the same package).
function _isCachedPlanStructurallyValid(plan: string | undefined | null): { ok: boolean; hardCount: number; warnCount: number } {
  if (!plan || typeof plan !== 'string' || !plan.trim()) {
    return { ok: false, hardCount: 0, warnCount: 0 };
  }
  try {
    const { parseTaskGroups, TASK_GROUP_FILES_HARD, TASK_GROUP_FILES_WARN } =
      require('./generate-code/developer');
    const groups = parseTaskGroups(plan);
    let hardCount = 0;
    let warnCount = 0;
    for (const g of groups) {
      if (g.files.length >= TASK_GROUP_FILES_HARD) hardCount++;
      else if (g.files.length >= TASK_GROUP_FILES_WARN) warnCount++;
    }
    // Reject only on hard violations. Warn-level groups are acceptable
    // (Fix B's adaptive max-turns can rescue them); hard violations
    // (≥ 10 files in one group) are kitchen-sink groups that should
    // be re-architected.
    return { ok: hardCount === 0, hardCount, warnCount };
  } catch (e: any) {
    // If the validation pipeline itself fails (unusual), prefer to
    // restore from cache rather than block on a check-side bug.
    logWarn(`[Discovery cache] plan validation threw: ${e.message.substring(0, 200)} — accepting cached plan defensively`);
    return { ok: true, hardCount: 0, warnCount: 0 };
  }
}

function _tryRestoreFromDiscoveryCache(state: any, currentKey: string): boolean {
  const cache: any = (state.data as any)._discovery_cache;
  if (!cache || !cache.key) return false;
  if (cache.version !== DISCOVERY_CACHE_VERSION) {
    logInfo(`[Discovery cache] schema version mismatch (cache=v${cache.version}, code=v${DISCOVERY_CACHE_VERSION}) — ignoring`);
    return false;
  }
  if (cache.key !== currentKey) return false;
  if (!cache.explore_plan) return false;

  // Gap H: structural validation. Re-architect rather than locking in a
  // bad cached plan.
  const validation = _isCachedPlanStructurallyValid(cache.explore_plan);
  if (!validation.ok) {
    logWarn(
      `[Discovery cache] REJECTING cached plan — ${validation.hardCount} kitchen-sink group(s) ` +
      `exceed TASK_GROUP_FILES_HARD threshold. Invalidating cache; architect will re-run with ` +
      `Fix C's sizing constraints (which may produce a smaller plan).`,
    );
    // Drop the cache so subsequent restarts also force a re-architect
    // until a structurally valid plan is produced.
    (state.data as any)._discovery_cache = null;
    return false;
  }
  if (validation.warnCount > 0) {
    logInfo(`[Discovery cache] Cached plan has ${validation.warnCount} warn-level oversized group(s) but no hard violations — accepting (Fix B handles via adaptive max-turns).`);
  }

  // Restore. Each field is best-effort — a partial cache still gives some
  // savings (e.g. analysisResult may be cached even if openspec parse
  // failed). The existing `if (!state.data.explore_plan)` guard at the
  // top of the agents block keys off `explore_plan` specifically, so as
  // long as we set that, the heavy work is skipped.
  state.data._agent_analysis = cache.analysisResult;
  state.data._architect_result = cache.architectOutput;
  state.data.explore_plan = cache.explore_plan;
  state.data.explore_openspec = cache.explore_openspec;
  state.data.explore_agents = cache.explore_agents;
  state.data._pending_questions = cache.pendingQuestions || [];
  state.data._agent_suggestions = cache.suggestions || [];
  if (cache.agentCheckpoints) {
    if (cache.agentCheckpoints._agent_requirements) state.data._agent_requirements = cache.agentCheckpoints._agent_requirements;
    if (cache.agentCheckpoints._agent_explorer) state.data._agent_explorer = cache.agentCheckpoints._agent_explorer;
    if (cache.agentCheckpoints._agent_risk) state.data._agent_risk = cache.agentCheckpoints._agent_risk;
  }

  const ageMs = Date.now() - new Date(cache.createdAt).getTime();
  const ageMin = Math.round(ageMs / 60_000);
  logOk(`[Discovery cache] HIT — restored architect plan from ${ageMin}m ago (key ${cache.key.substring(0, 12)}). Skipping Requirements/Explorer/Risk/Architect (~10–15min saved).`);
  return true;
}

function _writeDiscoveryCache(state: any, key: string, analysisResult: string, architectOutput: string): void {
  (state.data as any)._discovery_cache = {
    version: DISCOVERY_CACHE_VERSION,
    key,
    createdAt: new Date().toISOString(),
    analysisResult,
    architectOutput,
    explore_plan: state.data.explore_plan,
    explore_openspec: state.data.explore_openspec,
    explore_agents: state.data.explore_agents,
    pendingQuestions: state.data._pending_questions || [],
    suggestions: state.data._agent_suggestions || [],
    agentCheckpoints: {
      _agent_requirements: state.data._agent_requirements,
      _agent_explorer: state.data._agent_explorer,
      _agent_risk: state.data._agent_risk,
    },
  };
  logInfo(`[Discovery cache] Wrote entry for key ${key.substring(0, 12)} — future restarts will skip discovery if inputs unchanged.`);
}

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

    // URLs whose content was already retrieved -- via OAuth connectors
    // (Google Drive, Figma) or via the generic HTTP fetch loop. These
    // must NOT be flagged as inaccessible.
    const fetchedUrls = new Set<string>();
    const connectorContents = ((state.data.ticket as any).connectorContents as Array<{ url: string }> | undefined) || [];
    for (const c of connectorContents) fetchedUrls.add(c.url);
    const fetchedUrlContents = ((state.data.ticket as any).fetchedUrlContents as Array<{ url: string }> | undefined) || [];
    for (const c of fetchedUrlContents) fetchedUrls.add(c.url);
    // URLs deduped at fetch time -- their content lives on the primary URL
    // we already added above, so they're effectively "fetched".
    const connectorAliases = ((state.data.ticket as any).connectorAliases as string[] | undefined) || [];
    for (const u of connectorAliases) fetchedUrls.add(u);

    // Real failures recorded during fetch (connector errors, auth probes).
    const authRequired: any[] = (state.data.ticket as any).authRequiredUrls || [];
    for (const ar of authRequired) {
      const criticality = assessDocCriticality(ar.docType, ticketText);
      inaccessible.push({ type: ar.docType, url: ar.url, criticality, instructions: getDocPasteInstructions(ar.docType), reason: ar.reason });
    }

    // Recognised-service URLs not fetched and not already recorded as
    // auth-required (e.g. UNFETCHABLE-matched, silently skipped).
    for (const url of (externalUrls || [])) {
      if (fetchedUrls.has(url)) continue;
      if (inaccessible.some((d: any) => d.url === url)) continue;
      const docType = classifyDocUrl(url);
      if (docType === "External Document") continue;
      const criticality = assessDocCriticality(docType, ticketText);
      inaccessible.push({ type: docType, url, criticality, instructions: getDocPasteInstructions(docType) });
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

  // ── Discovery cache check (fix A) ──
  // Before launching the expensive 4-agent discovery cycle, see if a
  // prior run already produced a plan for the same inputs. Hits the
  // common case where a `generate_code` failure rolled back to this
  // stage with no user-visible change to the ticket or repo. Misses
  // (intentionally) when planFeedback / _refine_instructions change.
  const discoveryCacheKey = _computeDiscoveryCacheKey(state);
  if (!state.data.explore_plan) {
    if (_tryRestoreFromDiscoveryCache(state, discoveryCacheKey)) {
      save(state);
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
      `## TASK GROUP SIZING — CRITICAL (Fix C from AUT-8648 post-mortem)\n` +
      `The \`---TASKS---\` section uses \`##\` headings to define INDEPENDENT task groups.\n` +
      `Each group is handed to ONE parallel Developer Agent with a bounded turn budget (~75 file operations max).\n` +
      `Groups that exceed this budget make the Dev Agent fail with \`Reached max turns\` — wasting 10+ minutes per attempt.\n\n` +
      `Rules for the TASKS section:\n` +
      `1. **Each \`##\` group must be implementable in ≤ 30 file operations.** Count: each Read/Write/Edit/Grep/Glob is one operation. < 5 files touched per group is a good target.\n` +
      `2. **Prefer 4–6 small groups over 1–2 large ones.** Smaller groups parallelize better, tolerate retries, and surface partial progress.\n` +
      `3. **Each group should touch ≤ 5 source files.** If a group naturally needs more files, SPLIT it along file boundaries into 2+ groups.\n` +
      `4. **No cross-group dependencies.** Groups run in PARALLEL. If group B needs a file created by group A, either merge A+B or restructure so A's output is also in shared/types.\n` +
      `5. **Bundle related changes; separate unrelated changes.** Example: auth in one group; routing in another; localization in a third; tests in their own group.\n` +
      `6. **No kitchen-sink groups.** Any group titled "Misc", "Cleanup", "Various", or "Polish" will exceed the budget — break it up.\n` +
      `7. **Reference files explicitly.** List the exact file paths the group touches under each \`##\` heading (the post-parser uses this to detect cross-group collisions).\n\n` +
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

    // Fix A: persist the architect's output to the content-addressed
    // discovery cache so a future restart with the same inputs can skip
    // this entire block. Cache key was computed at function entry; we
    // re-use it here to avoid drift if the ticket inputs were mutated
    // mid-stage (they shouldn't be, but defensive).
    _writeDiscoveryCache(state, discoveryCacheKey, analysisResult, architectOutput);

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

// Internal helpers exported for unit tests only.
export {
  stageExplorePlan,
  parseQuestionsBlock,
  _computeDiscoveryCacheKey,
  _tryRestoreFromDiscoveryCache,
  _writeDiscoveryCache,
  _isCachedPlanStructurallyValid,
  DISCOVERY_CACHE_VERSION,
};
