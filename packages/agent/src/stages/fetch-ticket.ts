"use strict";

import type { PipelineState, TicketContext, ConnectorContent } from '@mi/shared';

const { cfg, TICKET, FETCH_CONCURRENCY, MAX_TOTAL_COMMENTS, MAX_TOTAL_ATTACHMENTS,
  MAX_TOTAL_URL_CONTENT, URL_FETCH_TIMEOUT } = require("../lib/config");
const { logStep, logOk, logErr, logInfo, logWarn } = require("../lib/logging");
const { req } = require("../lib/http-client");
const { isBinaryContent, truncateWithIndicator, addWarning } = require("../lib/utils");
const { adfText, adfToMarkdown, adfExtractUrls } = require("../lib/adf");
const { save } = require("../lib/state");
const { jira, jiraUrl, classifyDocUrl, isImageFile, callAnthropicVision, classifyTicketComplexity } = require("../lib/jira");
const { gl } = require("../lib/gitlab");
const { slack } = require("../lib/slack");
const { isChannelEnabled } = require("../lib/notification-config");
const gdrive = require("../lib/gdrive");
const figma = require("../lib/figma");
const postman = require("../lib/postman");

async function stageFetchTicket(state: PipelineState): Promise<void> {
  logStep(1, "Fetch Jira ticket + full context");

  // ── Q3: Pre-flight task validation ──────────────────────────
  if (!state.data._preflight_done) {
    logInfo("Q3: Running pre-flight validation…");
    const preflightIssue: any = await jira.getIssue(TICKET);

    // 1. Check ticket status — halt if Done/Closed
    const ticketStatus = (preflightIssue.fields?.status?.name || "").toLowerCase();
    if (ticketStatus === "done" || ticketStatus === "closed" || ticketStatus === "cancelled") {
      logErr(`Q3: Ticket ${TICKET} is "${preflightIssue.fields.status.name}" — cannot proceed`);
      if (isChannelEnabled("fetch_ticket", "slack")) {
        await slack(`🛑 *Pre-flight HALT — ${TICKET}*\nTicket status is "${preflightIssue.fields.status.name}". Pipeline stopped.`, [cfg.slack.ownerId]);
      }
      throw new Error(`Ticket ${TICKET} is already "${preflightIssue.fields.status.name}" — halting pipeline`);
    }

    // 2. Check GitLab for existing branch
    const branch = `enterprise-ts-${TICKET}`;
    try {
      const branchCheck: any = await req(gl.u(`/repository/branches/${encodeURIComponent(branch)}`), { headers: gl.h() });
      if (branchCheck.status === 200) {
        logWarn(`Q3: Branch "${branch}" already exists on GitLab`);
        state.data._preflight_existing_branch = true;
      }
    } catch { /* branch doesn't exist — good */ }

    // 3. Check for open MR
    try {
      const mrCheck: any = await req(
        gl.u(`/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened&per_page=1`),
        { headers: gl.h() },
      );
      if (mrCheck.status === 200 && Array.isArray(mrCheck.data) && mrCheck.data.length > 0) {
        const existingMR = mrCheck.data[0];
        logWarn(`Q3: Open MR already exists: !${existingMR.iid} (${existingMR.web_url})`);
        state.data._preflight_existing_mr = { iid: existingMR.iid, url: existingMR.web_url };
      }
    } catch (e: any) {
      logWarn(`Q3: Could not check for existing MR: ${e.message}`);
    }

    // 4. Check parent task
    if (preflightIssue.fields.parent) {
      const parentKey = preflightIssue.fields.parent.key;
      const parentStatus = (preflightIssue.fields.parent.fields?.status?.name || "").toLowerCase();
      logInfo(`Q3: Parent task: ${parentKey} (status: ${parentStatus})`);

      // Q4: Check if parent has a feature branch
      const parentBranch = `enterprise-ts-${parentKey}`;
      try {
        const parentBranchCheck: any = await req(gl.u(`/repository/branches/${encodeURIComponent(parentBranch)}`), { headers: gl.h() });
        if (parentBranchCheck.status === 200) {
          logOk(`Q4: Parent branch "${parentBranch}" found — will branch from it`);
          state.data.parentBranch = parentBranch;
        }
      } catch { /* no parent branch */ }
    }

    // X3: Jira Workflow Discovery — fetch available transitions and store
    try {
      const transResp: any = await req(`${cfg.jira.base}/rest/api/3/issue/${TICKET}/transitions`, { headers: jira.h() });
      if (transResp.status === 200 && transResp.data && transResp.data.transitions) {
        state.data._jira_transitions = transResp.data.transitions.map((t: any) => ({ id: t.id, name: t.name }));
        logOk(`X3: ${(state.data._jira_transitions as any[]).length} Jira transitions available: ${(state.data._jira_transitions as any[]).map((t: any) => t.name).join(", ")}`);
      }
    } catch (e: any) {
      logWarn(`X3: Could not fetch Jira transitions: ${e.message}`);
    }

    state.data._preflight_done = true;
    save(state);
    logOk("Q3: Pre-flight validation passed");
  }

  // Retry jira.getIssue with exponential backoff on transient network errors
  let issue: any;
  const TRANSIENT_CODES = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"];
  for (let _retry = 0; _retry <= 3; _retry++) {
    try {
      issue = await jira.getIssue(TICKET);
      break;
    } catch (e: any) {
      const isTransient = TRANSIENT_CODES.some(c => (e.code || e.message || "").includes(c));
      if (!isTransient || _retry === 3) {
        logErr(`Jira fetch failed after ${_retry + 1} attempt(s): ${e.message}`);
        throw e;
      }
      const delay = Math.pow(2, _retry) * 1000; // 1s, 2s, 4s
      logWarn(`Jira fetch failed (${e.code || e.message}), retrying in ${delay / 1000}s... (attempt ${_retry + 1}/3)`);
      await new Promise((r: any) => setTimeout(r, delay));
    }
  }
  const summary: string = issue.fields?.summary || "(No summary)";
  const descMarkdown: string = issue.fields?.description ? adfToMarkdown(issue.fields.description) : "";
  const descText: string = issue.fields?.description ? adfText(issue.fields.description) : "";

  // Issue type + priority (Layer 9)
  const issueType: string = issue.fields?.issuetype?.name || "Task";
  const priority: string = issue.fields?.priority?.name || "Medium";

  // AC: No dedicated AC field in this Jira instance — use description as AC fallback
  const ac: string = descMarkdown || "";
  const acMissing = false;

  logOk(`Ticket : [${issueType}/${priority}] ${summary}`);
  if (descText) logInfo(`Desc   : ${descText.substring(0, 120).replace(/\n/g, " ")}…`);

  state.data.ticket = { key: TICKET, summary, description: descMarkdown, ac, issueType, priority, ac_missing: acMissing };

  // ── Layer 4: Parent epic context ─────────────────────────────
  if (issue.fields.parent) {
    const parent = issue.fields.parent;
    let parentDesc = "";
    try {
      const parentIssue: any = await jira.getIssue(parent.key);
      parentDesc = adfToMarkdown(parentIssue.fields.description);
      logOk(`Parent : ${parent.key} — ${parent.fields.summary}`);
    } catch (e: any) {
      logWarn(`Could not fetch parent ${parent.key}: ${e.message}`);
      parentDesc = "";
    }
    (state.data.ticket as any).parent = {
      key: parent.key,
      summary: parent.fields.summary,
      status: (parent.fields.status && parent.fields.status.name) || "",
      description: parentDesc,
    };
  }

  // ── Layer 2: Read ALL pre-existing comments ──────────────────
  logInfo("Reading all Jira comments…");
  const allComments: any[] = [];
  try {
    const commentsData: any[] = await jira.getComments(TICKET);
    for (const c of commentsData) {
      const body = adfToMarkdown(c.body);
      const author = c.author?.displayName || "Deleted User";
      const created = c.created || "";
      // Extract URLs from comment ADF too
      const commentUrls = adfExtractUrls(c.body);
      allComments.push({ author, created, body, urls: commentUrls });
    }
    if (allComments.length > 0) {
      logOk(`Comments: ${allComments.length} found`);
    }
    // P4: Cap total comments — keep newest, summarize rest
    if (allComments.length > MAX_TOTAL_COMMENTS) {
      const omitted = allComments.length - MAX_TOTAL_COMMENTS;
      logWarn(`Capping comments from ${allComments.length} to newest ${MAX_TOTAL_COMMENTS} (${omitted} older omitted)`);
      addWarning(state, "fetch_ticket", `${omitted} older comments omitted (cap: ${MAX_TOTAL_COMMENTS})`);
      // allComments is ordered by -created (newest first), keep first MAX_TOTAL_COMMENTS
      allComments.splice(MAX_TOTAL_COMMENTS);
    }
  } catch (e: any) {
    logWarn(`Could not fetch comments: ${e.message}`);
  }
  (state.data.ticket as any).comments = allComments;

  // ── Layer 3: Read linked issues (P3: parallel batched fetching) ──
  const linkedIssues: any[] = [];
  const issueLinks = issue.fields.issuelinks || [];
  // T3: Store full relationship direction (inward/outward)
  const linkMeta: any[] = issueLinks.map((link: any) => {
    const linkType = (link.type && link.type.name) || "Related";
    const linked = link.outwardIssue || link.inwardIssue;
    if (!linked) return null;
    const isOutward = !!link.outwardIssue;
    const dirLabel = isOutward
      ? (link.type && link.type.outward) || linkType
      : (link.type && link.type.inward) || linkType;
    return { key: linked.key, dirLabel, direction: isOutward ? "outward" : "inward", linkTypeName: linkType, fields: linked.fields };
  }).filter(Boolean);

  // P3: Fetch in parallel batches of FETCH_CONCURRENCY
  for (let i = 0; i < linkMeta.length; i += FETCH_CONCURRENCY) {
    const batch = linkMeta.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((lm: any) => jira.getIssue(lm.key)));
    for (let j = 0; j < batch.length; j++) {
      const lm = batch[j];
      const result = results[j];
      if (result.status === "fulfilled") {
        const linkedFull: any = result.value;
        linkedIssues.push({
          key: lm.key,
          relationship: lm.dirLabel,
          direction: lm.direction,
          linkType: lm.linkTypeName,
          summary: linkedFull.fields.summary,
          description: adfToMarkdown(linkedFull.fields.description),
          status: (linkedFull.fields.status && linkedFull.fields.status.name) || "",
          type: (linkedFull.fields.issuetype && linkedFull.fields.issuetype.name) || "",
        });
        logOk(`Linked : ${lm.key} (${lm.dirLabel} [${lm.direction}]) — ${linkedFull.fields.summary}`);
      } else {
        logWarn(`Could not fetch linked issue ${lm.key}: ${result.reason?.message || result.reason}`);
        linkedIssues.push({
          key: lm.key,
          relationship: lm.dirLabel,
          direction: lm.direction,
          linkType: lm.linkTypeName,
          summary: (lm.fields && lm.fields.summary) || "",
          description: "",
          status: (lm.fields && lm.fields.status && lm.fields.status.name) || "",
          type: (lm.fields && lm.fields.issuetype && lm.fields.issuetype.name) || "",
        });
      }
    }
  }
  (state.data.ticket as any).linkedIssues = linkedIssues;

  // ── Layer 5: Download parseable attachments (P4: capped) ─────
  let rawAttachments: any[] = (issue.fields.attachment || []).map((a: any) => ({
    filename: a.filename,
    url: a.content,
    mimeType: a.mimeType,
    size: a.size || 0,
  }));
  // P4: Cap total attachments
  if (rawAttachments.length > MAX_TOTAL_ATTACHMENTS) {
    logWarn(`Capping attachments from ${rawAttachments.length} to ${MAX_TOTAL_ATTACHMENTS}`);
    addWarning(state, "fetch_ticket", `${rawAttachments.length - MAX_TOTAL_ATTACHMENTS} attachments omitted (cap: ${MAX_TOTAL_ATTACHMENTS})`);
    rawAttachments = rawAttachments.slice(0, MAX_TOTAL_ATTACHMENTS);
  }
  const attachments = rawAttachments;
  const attachmentContents: any[] = [];
  const PARSEABLE_TYPES = /^(text\/|application\/json|application\/xml|application\/html)/i;
  const MAX_ATTACHMENT_SIZE = 500_000; // 500KB limit
  for (const att of attachments) {
    if (PARSEABLE_TYPES.test(att.mimeType) && att.size < MAX_ATTACHMENT_SIZE) {
      try {
        logInfo(`Downloading attachment: ${att.filename} (${att.mimeType})…`);
        // G14: Only pass Jira auth headers if URL hostname matches Jira base URL
        const jiraHost = new URL(cfg.jira.base).hostname;
        let attHeaders: any = {};
        try {
          const attHost = new URL(att.url).hostname;
          if (attHost === jiraHost || attHost.endsWith(".atlassian.net")) {
            attHeaders = jira.h();
          } else {
            logWarn(`  Attachment URL host (${attHost}) differs from Jira host (${jiraHost}) — omitting auth headers`);
          }
        } catch { attHeaders = jira.h(); } // Fallback: pass auth if URL parse fails
        const r: any = await req(att.url, { headers: attHeaders });
        if (r.status === 200) {
          let content: string = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
          // M3: Truncate with indicator
          content = truncateWithIndicator(content, 100_000);
          // L1: Skip binary content
          if (isBinaryContent(content)) {
            logWarn(`  Attachment ${att.filename} appears binary — skipping content`);
            continue;
          }
          attachmentContents.push({ filename: att.filename, mimeType: att.mimeType, content });
          logOk(`  Downloaded ${att.filename} (${content.length} chars)`);
        }
      } catch (e: any) {
        logWarn(`  Could not download ${att.filename}: ${e.message}`);
      }
    }
  }
  // ── Q2: Image attachment vision (optional — requires ANTHROPIC_API_KEY) ──
  if (process.env.ANTHROPIC_API_KEY) {
    const MAX_IMAGE_SIZE = 5_000_000; // 5MB
    const imageAtts = attachments.filter((att: any) => isImageFile(att.filename) && att.size < MAX_IMAGE_SIZE);
    if (imageAtts.length > 0) {
      logInfo(`Q2: Processing ${imageAtts.length} image attachment(s) with vision…`);
      for (const att of imageAtts.slice(0, 5)) { // cap at 5 images
        try {
          const jiraHost = new URL(cfg.jira.base).hostname;
          let attHeaders: any = {};
          try {
            const attHost = new URL(att.url).hostname;
            if (attHost === jiraHost || attHost.endsWith(".atlassian.net")) {
              attHeaders = jira.h();
            }
          } catch { attHeaders = jira.h(); }
          const imgResp: any = await req(att.url, { headers: attHeaders });
          if (imgResp.status === 200 && imgResp.data) {
            // Response data may be a string — convert to buffer for base64
            const rawData = typeof imgResp.data === "string" ? imgResp.data : JSON.stringify(imgResp.data);
            const base64 = Buffer.from(rawData, "binary").toString("base64");
            const mediaType = att.mimeType || "image/png";
            const visionResult = await callAnthropicVision(base64, mediaType, att.filename);
            if (visionResult) {
              attachmentContents.push({ filename: att.filename, mimeType: mediaType, content: `[Image Description]\n${visionResult}` });
              logOk(`  Vision: ${att.filename} → ${visionResult.length} chars description`);
            }
          }
        } catch (e: any) {
          logWarn(`  Vision failed for ${att.filename}: ${e.message}`);
        }
      }
    }
  }

  (state.data.ticket as any).attachments = attachments;
  (state.data.ticket as any).attachmentContents = attachmentContents;

  // ── Layer 6: Extract URLs from ADF properly ──────────────────
  // Walk ADF tree (not flattened text) for description + AC + comments
  const descAdfUrls: string[] = adfExtractUrls(issue.fields.description);
  const acAdfUrls: string[] = [];
  for (const f of ["customfield_10035", "customfield_10036", "customfield_10037"]) {
    const v = issue.fields[f];
    if (v && typeof v === "object") { adfExtractUrls(v, acAdfUrls); break; }
  }
  const commentAdfUrls: string[] = allComments.flatMap((c: any) => c.urls || []);
  // T8: Extract URLs from plain-text AC field (not ADF)
  const acPlainTextUrls: string[] = [];
  if (ac && typeof ac === "string") {
    const urlMatches = ac.match(/https?:\/\/[^\s)>\]]+/g) || [];
    acPlainTextUrls.push(...urlMatches);
  }
  const allUrls = [...new Set([...descAdfUrls, ...acAdfUrls, ...commentAdfUrls, ...acPlainTextUrls])];
  // Filter out Jira internal URLs
  const externalUrls: string[] = allUrls.filter((u: string) =>
    !u.includes("atlassian.net/browse") &&
    !u.includes("atlassian.net/rest") &&
    !u.includes("atlassian.net/wiki")
  );
  (state.data.ticket as any).externalUrls = externalUrls;
  if (externalUrls.length > 0) {
    logInfo(`External URLs found: ${externalUrls.length}`);
    externalUrls.forEach((u: string) => logInfo(`  → ${u}`));
  }

  // ── Layer 6b: Connector URL routing (before UNFETCHABLE filter) ──
  const authRequiredUrls: any[] = [];
  // Hard cap on connector fetches per ticket. Tickets with more than 3
  // connector-routable URLs (gdrive + figma + postman combined) push the
  // overflow to the manual-paste path with reason "Connector limit reached"
  // regardless of OAuth state. Adjust with care: each connector fetch budgets
  // ~15 KB content, so raising this raises the per-ticket context size.
  const MAX_CONNECTOR_ITEMS = 3;
  const connectorContents: any[] = (state.data.ticket as any).connectorContents || [];
  const aliasUrls: string[] = [];
  const { parseBoolean } = require("../lib/config-schema");

  if (connectorContents.length === 0) {
    // Route connector URLs to authenticated modules
    const connectorUrls: any[] = [];
    const remainingUrls: string[] = [];

    // [oauth-connectors Decision 11] Unset enable-flag falls back to OAuth-token
    // presence: completing OAuth in the UI is itself a strong signal of intent
    // to use the connector. Explicit true/false still wins (kill switch preserved).
    const gdriveOn = parseBoolean(process.env.GDRIVE_ENABLED) ?? !!process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    // Figma supports both OAuth and PAT. Either credential (OAUTH access token
    // or FIGMA_TOKEN PAT) should auto-enable the connector. Explicit FIGMA_ENABLED
    // still wins as a kill switch.
    const figmaOn = parseBoolean(process.env.FIGMA_ENABLED)
      ?? (!!process.env.FIGMA_OAUTH_ACCESS_TOKEN || !!process.env.FIGMA_TOKEN);
    const postmanOn = parseBoolean(process.env.POSTMAN_ENABLED); // no OAuth path — explicit only
    for (const url of externalUrls) {
      let matched = false;
      if (gdriveOn && gdrive.matchUrl(url)) {
        connectorUrls.push({ url, connector: "gdrive", match: gdrive.matchUrl(url) });
        matched = true;
      } else if (figmaOn && figma.matchUrl(url)) {
        connectorUrls.push({ url, connector: "figma", match: figma.matchUrl(url) });
        matched = true;
      } else if (postmanOn && postman.matchUrl(url)) {
        connectorUrls.push({ url, connector: "postman", match: postman.matchUrl(url) });
        matched = true;
      }
      if (!matched) remainingUrls.push(url);
    }

    if (connectorUrls.length > 0) {
      // Dedupe by connector identity so two URLs that resolve to the same
      // underlying document (e.g. a Figma file at the same node-id with
      // different tracking params) don't each consume a cap slot.
      const dedupKey = (cu: any): string => {
        if (cu.connector === "gdrive") return `gdrive:${cu.match.fileId}${cu.match.gid ? `#${cu.match.gid}` : ""}`;
        if (cu.connector === "figma") return `figma:${cu.match.fileKey}${cu.match.nodeId ? `#${cu.match.nodeId}` : ""}`;
        if (cu.connector === "postman") return `postman:${cu.match.collectionId}`;
        return `unknown:${cu.url}`;
      };
      const seen = new Set<string>();
      const uniqueConnectorUrls: any[] = [];
      for (const cu of connectorUrls) {
        const key = dedupKey(cu);
        if (seen.has(key)) {
          aliasUrls.push(cu.url);
          continue;
        }
        seen.add(key);
        uniqueConnectorUrls.push(cu);
      }
      if (aliasUrls.length > 0) {
        logInfo(`Deduped ${aliasUrls.length} connector URL(s) pointing to documents already queued`);
      }

      logInfo(`Connector URLs found: ${uniqueConnectorUrls.length} (cap: ${MAX_CONNECTOR_ITEMS})`);
      // Enforce 3-item cap
      const toProcess = uniqueConnectorUrls.slice(0, MAX_CONNECTOR_ITEMS);
      const overflow = uniqueConnectorUrls.slice(MAX_CONNECTOR_ITEMS);

      // Fetch in parallel
      const connResults = await Promise.allSettled(toProcess.map(async (cu: any) => {
        logInfo(`  Connector fetch [${cu.connector}]: ${cu.url}`);
        if (cu.connector === "gdrive") {
          const m = cu.match;
          if (m.type === "doc" || m.type === "file") return { ...(await gdrive.fetchGoogleDoc(m.fileId)), source: "gdrive", url: cu.url };
          if (m.type === "sheet") return { ...(await gdrive.fetchGoogleSheet(m.fileId, m.gid)), source: "gdrive", url: cu.url };
        }
        if (cu.connector === "figma") {
          const m = cu.match;
          const result: any = await figma.fetchFigmaFile(m.fileKey, m.nodeId);
          // Optional Vision path
          if (result.ok && result.frameIds && result.frameIds.length > 0 &&
              parseBoolean(process.env.FIGMA_VISION_ENABLED) && process.env.ANTHROPIC_API_KEY) {
            const visionText = await figma.describeFramesWithVision(result.fileKey, result.frameIds, callAnthropicVision);
            if (visionText) result.content += visionText;
          }
          return { ...result, source: "figma", url: cu.url };
        }
        if (cu.connector === "postman") {
          const m = cu.match;
          return { ...(await postman.fetchCollection(m.collectionId)), source: "postman", url: cu.url };
        }
        return { ok: false, error: "Unknown connector", source: cu.connector, url: cu.url };
      }));

      for (const r of connResults) {
        if (r.status === "fulfilled" && (r.value as any).ok) {
          const val = r.value as any;
          connectorContents.push({
            source: val.source,
            url: val.url,
            title: val.title,
            content: val.content,
            sizeBytes: val.content.length,
          });
          logOk(`  Connector OK [${val.source}]: ${val.title} (${val.content.length} chars)`);
        } else {
          const val: any = r.status === "fulfilled" ? r.value : { url: "unknown", error: (r as any).reason?.message || "Fetch failed", source: "unknown" };
          authRequiredUrls.push({ url: val.url, reason: val.error || "Connector fetch failed", docType: classifyDocUrl(val.url) });
          logWarn(`  Connector FAIL [${val.source}]: ${val.error}`);
        }
      }

      // Overflow URLs get paste instructions
      for (const cu of overflow) {
        authRequiredUrls.push({ url: cu.url, reason: "Connector limit reached — paste content manually", docType: classifyDocUrl(cu.url) });
      }

      // Replace externalUrls with only non-connector URLs for further processing
      externalUrls.splice(0, externalUrls.length, ...remainingUrls);
    }

    // ── Postman attachment detection (zero-auth path) ──
    if (connectorContents.length < MAX_CONNECTOR_ITEMS && parseBoolean(process.env.POSTMAN_ENABLED) !== false) {
      for (const att of attachmentContents) {
        if (connectorContents.length >= MAX_CONNECTOR_ITEMS) break;
        if (att.mimeType === "application/json" && att.content) {
          if (postman.detectPostmanAttachment(att.content)) {
            try {
              const parsed = typeof att.content === "string" ? JSON.parse(att.content) : att.content;
              const content: string = postman.flattenCollection(parsed);
              connectorContents.push({
                source: "postman",
                url: `attachment:${att.filename}`,
                title: att.filename,
                content,
                sizeBytes: content.length,
              });
              logOk(`  Postman attachment detected: ${att.filename} (${content.length} chars)`);
            } catch (e: any) {
              logWarn(`  Postman attachment parse failed for ${att.filename}: ${e.message}`);
            }
          }
        }
      }
    }

    (state.data.ticket as any).connectorContents = connectorContents;
    // Persist any deduped alias URLs so explore-plan can treat them as fetched
    // (content lives on the primary URL; aliases point to the same document).
    if (aliasUrls.length > 0) {
      (state.data.ticket as any).connectorAliases = aliasUrls;
    }
    save(state);
  } else {
    logInfo(`Connector contents already populated (${connectorContents.length} items) — skipping re-fetch`);
    // Remove connector URLs from externalUrls to avoid UNFETCHABLE filter noise
    const remainingUrls = externalUrls.filter((url: string) =>
      !gdrive.matchUrl(url) && !figma.matchUrl(url) && !postman.matchUrl(url)
    );
    externalUrls.splice(0, externalUrls.length, ...remainingUrls);
  }

  // ── Layer 7: Fetch accessible external URLs (P2: parallel batches) ──
  // Q1: Expanded unfetchable URL patterns (includes auth-gated services)
  const UNFETCHABLE = /figma\.com|docs\.google\.com|sheets\.google\.com|drive\.google\.com|lovable\.app|canva\.com|miro\.com|postman\.com|getpostman\.com|confluence\.|notion\.so|\.sharepoint\.com|swagger\/api-docs/i;
  // G9: Private IP patterns to block SSRF
  const PRIVATE_IP = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|localhost)$/i;
  const fetchedUrlContents: any[] = [];
  let totalUrlContentSize = 0;

  // Filter fetchable URLs first
  const fetchableUrls: string[] = externalUrls.filter((url: string) => {
    if (UNFETCHABLE.test(url)) { logInfo(`  Skipping unfetchable: ${url}`); return false; }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { logWarn(`  Skipping non-HTTP URL: ${url} (protocol: ${parsed.protocol})`); return false; }
      if (PRIVATE_IP.test(parsed.hostname)) { logWarn(`  Skipping private/localhost URL: ${url}`); return false; }
    } catch { logWarn(`  Skipping invalid URL: ${url}`); return false; }
    return true;
  });

  // P2: Helper to fetch one URL
  async function fetchOneUrl(url: string): Promise<any> {
    logInfo(`  Fetching: ${url}…`);
    const r: any = await req(url, { headers: { Accept: "text/html,application/json,text/plain" } });
    if (r.status === 200) {
      let content: string = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
      if (content.length > 50_000) content = truncateWithIndicator(content, 50_000);
      return { url, content };
    }
    logWarn(`  HTTP ${r.status} for ${url}`);
    return null;
  }

  // P2: Fetch in parallel batches with total timeout
  const urlFetchStart = Date.now();
  for (let i = 0; i < fetchableUrls.length; i += FETCH_CONCURRENCY) {
    // P2: Total URL fetch timeout
    if (Date.now() - urlFetchStart > URL_FETCH_TIMEOUT) {
      logWarn(`URL fetch total timeout (${URL_FETCH_TIMEOUT / 1000}s) — ${fetchableUrls.length - i} URLs skipped`);
      addWarning(state, "fetch_ticket", `URL fetch timeout after ${i} URLs, ${fetchableUrls.length - i} skipped`);
      break;
    }
    // P4: Total URL content cap
    if (totalUrlContentSize >= MAX_TOTAL_URL_CONTENT) {
      logWarn(`Total URL content cap (${MAX_TOTAL_URL_CONTENT / 1000}KB) reached — ${fetchableUrls.length - i} URLs skipped`);
      addWarning(state, "fetch_ticket", `URL content cap reached after ${i} URLs, ${fetchableUrls.length - i} skipped`);
      break;
    }
    const batch = fetchableUrls.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((url: string) => fetchOneUrl(url)));
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        // P4: Check total URL content cap
        totalUrlContentSize += result.value.content.length;
        if (totalUrlContentSize > MAX_TOTAL_URL_CONTENT) {
          logWarn(`Total URL content exceeds ${MAX_TOTAL_URL_CONTENT / 1000}KB — truncating this URL`);
          const remaining = MAX_TOTAL_URL_CONTENT - (totalUrlContentSize - result.value.content.length);
          result.value.content = truncateWithIndicator(result.value.content, Math.max(remaining, 1000));
        }
        fetchedUrlContents.push(result.value);
        logOk(`  Fetched ${result.value.url} (${result.value.content.length} chars)`);
      } else if (result.status === "rejected") {
        logWarn(`  URL fetch failed: ${result.reason?.message || result.reason}`);
      }
    }
  }
  (state.data.ticket as any).fetchedUrlContents = fetchedUrlContents;

  // ── Q1: Detect auth-required URLs (401/403 or redirect to login) ──
  for (const url of fetchableUrls) {
    const fetched = fetchedUrlContents.find((f: any) => f.url === url);
    if (fetched) continue; // successfully fetched, skip
    // Check if URL returned auth error during fetch
    try {
      const probeResp: any = await req(url, { headers: { Accept: "text/html,application/json" } });
      if (probeResp.status === 401 || probeResp.status === 403) {
        authRequiredUrls.push({ url, reason: `HTTP ${probeResp.status}`, docType: classifyDocUrl(url) });
      } else if (probeResp.status >= 200 && probeResp.status < 400 && typeof probeResp.data === "string") {
        // Check for login page redirect patterns
        const content: string = probeResp.data.substring(0, 2000).toLowerCase();
        if (content.includes("login") && (content.includes("password") || content.includes("sign in") || content.includes("authenticate"))) {
          authRequiredUrls.push({ url, reason: "Redirects to login page", docType: classifyDocUrl(url) });
        }
      }
    } catch {
      // Probe failed — ignore, already handled
    }
  }
  (state.data.ticket as any).authRequiredUrls = authRequiredUrls;
  if (authRequiredUrls.length > 0) {
    logWarn(`Q1: ${authRequiredUrls.length} URL(s) require authentication`);
    authRequiredUrls.forEach((u: any) => logWarn(`  ${u.docType}: ${u.url} (${u.reason})`));
  }

  // ── Summary ──────────────────────────────────────────────────
  const contextSummary = [
    `Description: ${descMarkdown.length} chars (markdown)`,
    ac ? `AC: ${ac.length} chars` : null,
    allComments.length > 0 ? `Comments: ${allComments.length}` : null,
    linkedIssues.length > 0 ? `Linked issues: ${linkedIssues.length}` : null,
    (state.data.ticket as any).parent ? `Parent: ${(state.data.ticket as any).parent.key}` : null,
    attachmentContents.length > 0 ? `Attachment content: ${attachmentContents.length} files` : null,
    fetchedUrlContents.length > 0 ? `Fetched URLs: ${fetchedUrlContents.length}` : null,
    connectorContents.length > 0 ? `Connector docs: ${connectorContents.length}` : null,
    externalUrls.length > 0 ? `External URLs: ${externalUrls.length}` : null,
  ].filter(Boolean);
  logOk(`Context gathered: ${contextSummary.join(" | ")}`);

  // ── X7: Ticket complexity classification ──────────────────────
  const complexity: any = classifyTicketComplexity(state.data.ticket);
  (state.data.ticket as any).complexity = complexity;
  logInfo(`X7: Complexity: ${complexity.level} (score: ${complexity.score}, timeout multiplier: ${complexity.timeoutMultiplier}x)`);

  state.stage = "explore_plan";
  save(state);
}

export { stageFetchTicket };
