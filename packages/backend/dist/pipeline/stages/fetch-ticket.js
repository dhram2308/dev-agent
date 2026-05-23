"use strict";
// =====================================================================
// MI Dev Agent -- Fetch Ticket Stage
// =====================================================================
// TypeScript port of stages/fetch-ticket.js
//
// Gathers all context from Jira:
//   - Issue fields, comments, attachments
//   - ADF content converted to markdown
//   - URLs extracted from ADF (smart links)
//   - External URLs fetched if accessible
//   - Issue type, priority, linked issues, parent epic
//   - Config snapshot captured at pipeline start
//   - Pre-flight validation (ticket status, existing branch/MR, parent)
//   - Jira workflow discovery (available transitions)
//   - Image attachment vision processing (optional)
//   - Ticket complexity classification
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.stageFetchTicket = stageFetchTicket;
const logger_1 = require("../../lib/logger");
const client_1 = require("../../http/client");
const utils_1 = require("../../lib/utils");
const adf_parser_1 = require("../../lib/adf-parser");
const gdrive_1 = require("../../lib/gdrive");
const figma_1 = require("../../lib/figma");
const state_manager_1 = require("../../state/state-manager");
const loader_1 = require("../../config/loader");
const jira_1 = require("../../services/jira");
const gitlab_1 = require("../../services/gitlab");
// =====================================================================
// Constants
// =====================================================================
/** Mime types that can be parsed as text. */
const PARSEABLE_TYPES = /^(text\/|application\/json|application\/xml|application\/html)/i;
/** Maximum attachment size to download (500KB). */
const MAX_ATTACHMENT_SIZE = 500_000;
/** Maximum image attachment size for vision processing (5MB). */
const MAX_IMAGE_SIZE = 5_000_000;
/** Maximum images to process with vision per ticket. */
const MAX_VISION_IMAGES = 5;
/**
 * Patterns for URLs that cannot be fetched (auth-gated services).
 *
 * Note: Google Drive and Figma URLs are intentionally NOT in this list --
 * when the respective OAuth connector is connected, the URL fetch loop
 * routes them through `lib/gdrive.ts` / `lib/figma.ts` which use the
 * stored OAuth tokens (or a PAT for Figma). If the connector isn't
 * connected, the fetcher returns an error and the URL falls through to
 * auth-required detection like any other failure.
 */
const UNFETCHABLE = /lovable\.app|canva\.com|miro\.com|postman\.com|getpostman\.com|confluence\.|notion\.so|\.sharepoint\.com|swagger\/api-docs/i;
/** Private IP patterns to block SSRF. */
const PRIVATE_IP = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|localhost)$/i;
/** Transient error codes for retry. */
const TRANSIENT_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'];
// =====================================================================
// Stage Handler
// =====================================================================
/**
 * Fetch Ticket stage handler.
 *
 * Gathers all context from Jira and external sources:
 *   1. Pre-flight validation (status, existing branch/MR, parent task)
 *   2. Issue fields with retry on transient errors
 *   3. Parent epic context
 *   4. All comments (paginated, capped)
 *   5. Linked issues (parallel batched)
 *   6. Downloadable attachments (text + images with vision)
 *   7. URLs extracted from ADF (description, AC, comments)
 *   8. External URL content (parallel batched, capped)
 *   9. Auth-required URL detection
 *   10. Ticket complexity classification
 *
 * Advances state to "explore_plan" on completion.
 */
async function stageFetchTicket(state) {
    (0, logger_1.logStep)(1, 'Fetch Jira ticket + full context');
    const config = (0, loader_1.loadConfig)();
    const ext = (0, loader_1.loadExtendedConfig)();
    const ticket = config.ticket || state.ticket;
    const jira = new jira_1.JiraService(config);
    const gitlab = new gitlab_1.GitLabService(config);
    const data = state.data;
    // ── Pre-flight validation ────────────────────────────────────────
    if (!data._preflight_done) {
        (0, logger_1.logInfo)('Q3: Running pre-flight validation...');
        const preflightIssue = await jira.getIssue(ticket);
        // 1. Check ticket status -- halt if Done/Closed
        const ticketStatus = (preflightIssue.fields?.status?.name || '').toLowerCase();
        if (ticketStatus === 'done' || ticketStatus === 'closed' || ticketStatus === 'cancelled') {
            (0, logger_1.logErr)(`Q3: Ticket ${ticket} is "${preflightIssue.fields.status.name}" -- cannot proceed`);
            throw new Error(`Ticket ${ticket} is already "${preflightIssue.fields.status.name}" -- halting pipeline`);
        }
        // 2. Check GitLab for existing branch
        const branch = `enterprise-ts-${ticket}`;
        try {
            const existingBranch = await gitlab.getBranch(branch);
            if (existingBranch) {
                (0, logger_1.logWarn)(`Q3: Branch "${branch}" already exists on GitLab`);
                data._preflight_existing_branch = true;
            }
        }
        catch { /* branch doesn't exist -- good */ }
        // 3. Check for open MR
        try {
            const mrUrl = `${config.gitlab.base}/api/v4/projects/${config.gitlab.projectId}` +
                `/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened&per_page=1`;
            const mrCheck = await (0, client_1.req)(mrUrl, {
                headers: { 'PRIVATE-TOKEN': config.gitlab.token },
            });
            if (mrCheck.status === 200 && Array.isArray(mrCheck.data) && mrCheck.data.length > 0) {
                const existingMR = mrCheck.data[0];
                (0, logger_1.logWarn)(`Q3: Open MR already exists: !${existingMR.iid} (${existingMR.web_url})`);
                data._preflight_existing_mr = { iid: existingMR.iid, url: existingMR.web_url };
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logWarn)(`Q3: Could not check for existing MR: ${msg}`);
        }
        // 4. Check parent task
        if (preflightIssue.fields.parent) {
            const parentKey = preflightIssue.fields.parent.key;
            const parentStatus = (preflightIssue.fields.parent.fields?.status?.name || '').toLowerCase();
            (0, logger_1.logInfo)(`Q3: Parent task: ${parentKey} (status: ${parentStatus})`);
            // Q4: Check if parent has a feature branch
            const parentBranch = `enterprise-ts-${parentKey}`;
            try {
                const parentBranchExists = await gitlab.getBranch(parentBranch);
                if (parentBranchExists) {
                    (0, logger_1.logOk)(`Q4: Parent branch "${parentBranch}" found -- will branch from it`);
                    data.parentBranch = parentBranch;
                }
            }
            catch { /* no parent branch */ }
        }
        // X3: Jira Workflow Discovery -- fetch available transitions
        try {
            const transitions = await jira.getTransitions(ticket);
            data._jira_transitions = transitions.map((t) => ({ id: t.id, name: t.name }));
            (0, logger_1.logOk)(`X3: ${transitions.length} Jira transitions available: ` +
                transitions.map((t) => t.name).join(', '));
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logWarn)(`X3: Could not fetch Jira transitions: ${msg}`);
        }
        data._preflight_done = true;
        (0, state_manager_1.save)(state);
        (0, logger_1.logOk)('Q3: Pre-flight validation passed');
    }
    // ── Fetch issue with retry on transient errors ───────────────────
    let issue;
    for (let retry = 0; retry <= 3; retry++) {
        try {
            issue = await jira.getIssue(ticket);
            break;
        }
        catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            const errCode = err.code || err.message || '';
            const isTransient = TRANSIENT_CODES.some((c) => errCode.includes(c));
            if (!isTransient || retry === 3) {
                (0, logger_1.logErr)(`Jira fetch failed after ${retry + 1} attempt(s): ${err.message}`);
                throw err;
            }
            const delay = Math.pow(2, retry) * 1000;
            (0, logger_1.logWarn)(`Jira fetch failed (${errCode}), retrying in ${delay / 1000}s... (attempt ${retry + 1}/3)`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    if (!issue) {
        throw new Error(`Failed to fetch Jira issue ${ticket} after all retries`);
    }
    const summary = issue.fields?.summary || '(No summary)';
    const descNode = issue.fields?.description;
    const descMarkdown = descNode ? (0, adf_parser_1.adfToMarkdown)(descNode) : '';
    const descText = descNode ? (0, adf_parser_1.adfText)(descNode) : '';
    // Issue type + priority
    const issueType = issue.fields?.issuetype?.name || 'Task';
    const priority = issue.fields?.priority?.name || 'Medium';
    // AC: No dedicated AC field -- use description as fallback
    const ac = descMarkdown || '';
    const acMissing = false;
    (0, logger_1.logOk)(`Ticket : [${issueType}/${priority}] ${summary}`);
    if (descText) {
        (0, logger_1.logInfo)(`Desc   : ${descText.substring(0, 120).replace(/\n/g, ' ')}...`);
    }
    data.ticket = {
        key: ticket,
        summary,
        description: descMarkdown,
        ac,
        issueType,
        priority,
        ac_missing: acMissing,
    };
    // ── Parent epic context ──────────────────────────────────────────
    if (issue.fields.parent) {
        const parent = issue.fields.parent;
        let parentDesc = '';
        try {
            const parentIssue = await jira.getIssue(parent.key);
            parentDesc = (0, adf_parser_1.adfToMarkdown)(parentIssue.fields.description);
            (0, logger_1.logOk)(`Parent : ${parent.key} -- ${parent.fields.summary}`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logWarn)(`Could not fetch parent ${parent.key}: ${msg}`);
        }
        data.ticket.parent = {
            key: parent.key,
            summary: parent.fields.summary,
            status: parent.fields.status?.name || '',
            description: parentDesc,
        };
    }
    // ── Read ALL pre-existing comments ───────────────────────────────
    (0, logger_1.logInfo)('Reading all Jira comments...');
    const allComments = [];
    try {
        const commentsData = await jira.getComments(ticket);
        for (const c of commentsData) {
            const body = (0, adf_parser_1.adfToMarkdown)(c.body);
            const author = c.author?.displayName || 'Deleted User';
            const created = c.created || '';
            const commentUrls = (0, adf_parser_1.adfExtractUrls)(c.body);
            allComments.push({ author, created, body, urls: commentUrls });
        }
        if (allComments.length > 0) {
            (0, logger_1.logOk)(`Comments: ${allComments.length} found`);
        }
        // Cap total comments
        if (allComments.length > ext.maxTotalComments) {
            const omitted = allComments.length - ext.maxTotalComments;
            (0, logger_1.logWarn)(`Capping comments from ${allComments.length} to newest ${ext.maxTotalComments} (${omitted} older omitted)`);
            (0, utils_1.addWarning)(state, 'fetch_ticket', `${omitted} older comments omitted (cap: ${ext.maxTotalComments})`);
            allComments.splice(ext.maxTotalComments);
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logWarn)(`Could not fetch comments: ${msg}`);
    }
    data.ticket.comments = allComments;
    // ── Linked issues (parallel batched) ─────────────────────────────
    const linkedIssues = [];
    const issueLinks = issue.fields.issuelinks || [];
    // Build link metadata with direction info
    const linkMeta = issueLinks.map((link) => {
        const linkType = link.type?.name || 'Related';
        const linked = link.outwardIssue || link.inwardIssue;
        if (!linked)
            return null;
        const isOutward = !!link.outwardIssue;
        const dirLabel = isOutward
            ? (link.type?.outward || linkType)
            : (link.type?.inward || linkType);
        return {
            key: linked.key,
            dirLabel,
            direction: (isOutward ? 'outward' : 'inward'),
            linkTypeName: linkType,
            fields: linked.fields,
        };
    }).filter(Boolean);
    // Fetch in parallel batches
    for (let i = 0; i < linkMeta.length; i += ext.fetchConcurrency) {
        const batch = linkMeta.slice(i, i + ext.fetchConcurrency);
        const results = await Promise.allSettled(batch.map((lm) => jira.getIssue(lm.key)));
        for (let j = 0; j < batch.length; j++) {
            const lm = batch[j];
            const result = results[j];
            if (result.status === 'fulfilled') {
                const linkedFull = result.value;
                linkedIssues.push({
                    key: lm.key,
                    relationship: lm.dirLabel,
                    direction: lm.direction,
                    linkType: lm.linkTypeName,
                    summary: linkedFull.fields.summary,
                    description: (0, adf_parser_1.adfToMarkdown)(linkedFull.fields.description),
                    status: linkedFull.fields.status?.name || '',
                    type: linkedFull.fields.issuetype?.name || '',
                });
                (0, logger_1.logOk)(`Linked : ${lm.key} (${lm.dirLabel} [${lm.direction}]) -- ${linkedFull.fields.summary}`);
            }
            else {
                const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
                (0, logger_1.logWarn)(`Could not fetch linked issue ${lm.key}: ${reason}`);
                linkedIssues.push({
                    key: lm.key,
                    relationship: lm.dirLabel,
                    direction: lm.direction,
                    linkType: lm.linkTypeName,
                    summary: lm.fields?.summary || '',
                    description: '',
                    status: lm.fields?.status?.name || '',
                    type: lm.fields?.issuetype?.name || '',
                });
            }
        }
    }
    data.ticket.linkedIssues = linkedIssues;
    // ── Download parseable attachments ───────────────────────────────
    let rawAttachments = (issue.fields.attachment || []).map((a) => ({
        filename: a.filename,
        url: a.content,
        mimeType: a.mimeType,
        size: a.size || 0,
    }));
    // Cap total attachments
    if (rawAttachments.length > ext.maxTotalAttachments) {
        (0, logger_1.logWarn)(`Capping attachments from ${rawAttachments.length} to ${ext.maxTotalAttachments}`);
        (0, utils_1.addWarning)(state, 'fetch_ticket', `${rawAttachments.length - ext.maxTotalAttachments} attachments omitted (cap: ${ext.maxTotalAttachments})`);
        rawAttachments = rawAttachments.slice(0, ext.maxTotalAttachments);
    }
    const attachments = rawAttachments;
    const attachmentContents = [];
    const jiraHost = new URL(config.jira.base).hostname;
    const jiraAuthHeader = Buffer.from(`${config.jira.email}:${config.jira.token}`).toString('base64');
    for (const att of attachments) {
        if (PARSEABLE_TYPES.test(att.mimeType) && att.size < MAX_ATTACHMENT_SIZE) {
            try {
                (0, logger_1.logInfo)(`Downloading attachment: ${att.filename} (${att.mimeType})...`);
                // Only send Jira auth headers to Jira/Atlassian hosts
                let attHeaders = {};
                try {
                    const attHost = new URL(att.url).hostname;
                    if (attHost === jiraHost || attHost.endsWith('.atlassian.net')) {
                        attHeaders = {
                            Authorization: `Basic ${jiraAuthHeader}`,
                            Accept: 'application/json',
                        };
                    }
                    else {
                        (0, logger_1.logWarn)(`  Attachment URL host (${attHost}) differs from Jira host (${jiraHost}) -- omitting auth headers`);
                    }
                }
                catch {
                    attHeaders = {
                        Authorization: `Basic ${jiraAuthHeader}`,
                        Accept: 'application/json',
                    };
                }
                const r = await (0, client_1.req)(att.url, { headers: attHeaders });
                if (r.status === 200) {
                    let content = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2);
                    content = (0, utils_1.truncateWithIndicator)(content, 100_000);
                    if ((0, utils_1.isBinaryContent)(content)) {
                        (0, logger_1.logWarn)(`  Attachment ${att.filename} appears binary -- skipping content`);
                        continue;
                    }
                    attachmentContents.push({ filename: att.filename, mimeType: att.mimeType, content });
                    (0, logger_1.logOk)(`  Downloaded ${att.filename} (${content.length} chars)`);
                }
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                (0, logger_1.logWarn)(`  Could not download ${att.filename}: ${msg}`);
            }
        }
    }
    // Q2: Image attachment vision (optional -- requires ANTHROPIC_API_KEY)
    if (ext.anthropicApiKey) {
        const imageAtts = attachments.filter((att) => (0, jira_1.isImageFile)(att.filename) && att.size < MAX_IMAGE_SIZE);
        if (imageAtts.length > 0) {
            (0, logger_1.logInfo)(`Q2: Processing ${imageAtts.length} image attachment(s) with vision...`);
            // Note: callAnthropicVision would need to be implemented in claude.ts
            // For now, log and skip -- this is an optional feature
            (0, logger_1.logInfo)('Q2: Image vision processing not yet available in TypeScript port -- skipping');
        }
    }
    data.ticket.attachments = attachments;
    data.ticket.attachmentContents = attachmentContents;
    // ── Extract URLs from ADF ────────────────────────────────────────
    const descAdfUrls = (0, adf_parser_1.adfExtractUrls)(issue.fields.description);
    const acAdfUrls = [];
    // Check custom AC fields
    for (const f of ['customfield_10035', 'customfield_10036', 'customfield_10037']) {
        const v = issue.fields[f];
        if (v && typeof v === 'object') {
            (0, adf_parser_1.adfExtractUrls)(v, acAdfUrls);
            break;
        }
    }
    const commentAdfUrls = allComments.flatMap((c) => c.urls || []);
    // Extract URLs from plain-text AC field
    const acPlainTextUrls = [];
    if (ac && typeof ac === 'string') {
        const urlMatches = ac.match(/https?:\/\/[^\s)>\]]+/g) || [];
        acPlainTextUrls.push(...urlMatches);
    }
    const allUrls = [...new Set([...descAdfUrls, ...acAdfUrls, ...commentAdfUrls, ...acPlainTextUrls])];
    // Filter out Jira internal URLs
    const externalUrls = allUrls.filter((u) => !u.includes('atlassian.net/browse') &&
        !u.includes('atlassian.net/rest') &&
        !u.includes('atlassian.net/wiki'));
    data.ticket.externalUrls = externalUrls;
    if (externalUrls.length > 0) {
        (0, logger_1.logInfo)(`External URLs found: ${externalUrls.length}`);
        externalUrls.forEach((u) => (0, logger_1.logInfo)(`  -> ${u}`));
    }
    // ── Connector routing (Google Drive + Figma via OAuth/PAT) ───────
    // Run BEFORE the generic URL fetch loop. Successful connector fetches
    // populate ticket.connectorContents (consumed by generate-code). Failures
    // populate ticket.authRequiredUrls so explore-plan halts and asks the user
    // to paste the content. The probe-based auth detection below can't classify
    // these URLs (Drive returns 200 HTML when unauthenticated; Figma always
    // returns its SPA shell on direct GETs).
    const connectorContentsExisting = data.ticket.connectorContents;
    const connectorContents = connectorContentsExisting ?? [];
    const connectorAuthRequired = [];
    const gdriveUrls = new Set();
    const figmaUrls = new Set();
    if (connectorContents.length === 0) {
        for (const url of externalUrls) {
            if ((0, gdrive_1.matchUrl)(url)) {
                gdriveUrls.add(url);
                (0, logger_1.logInfo)(`  Connector fetch [gdrive]: ${url}`);
                const gd = await (0, gdrive_1.fetchByUrl)(url);
                if (gd && gd.ok && gd.content) {
                    const title = gd.title ?? `Google Drive ${url}`;
                    const content = gd.content;
                    connectorContents.push({
                        source: 'gdrive',
                        url,
                        title,
                        content,
                        sizeBytes: content.length,
                    });
                    (0, logger_1.logOk)(`  Connector OK [gdrive]: ${title} (${content.length} chars)`);
                }
                else {
                    const reason = (gd && gd.error) || 'Connector fetch returned no result';
                    connectorAuthRequired.push({
                        url,
                        reason,
                        docType: (0, jira_1.classifyDocUrl)(url),
                    });
                    (0, logger_1.logWarn)(`  Connector FAIL [gdrive]: ${reason}`);
                }
                continue;
            }
            if ((0, figma_1.matchUrl)(url)) {
                figmaUrls.add(url);
                (0, logger_1.logInfo)(`  Connector fetch [figma]: ${url}`);
                const fg = await (0, figma_1.fetchByUrl)(url);
                if (fg && fg.ok && fg.content) {
                    const title = fg.title ?? `Figma ${url}`;
                    const content = fg.content;
                    connectorContents.push({
                        source: 'figma',
                        url,
                        title,
                        content,
                        sizeBytes: content.length,
                    });
                    (0, logger_1.logOk)(`  Connector OK [figma]: ${title} (${content.length} chars)`);
                }
                else {
                    const reason = (fg && fg.error) || 'Connector fetch returned no result';
                    connectorAuthRequired.push({
                        url,
                        reason,
                        docType: (0, jira_1.classifyDocUrl)(url),
                    });
                    (0, logger_1.logWarn)(`  Connector FAIL [figma]: ${reason}`);
                }
                continue;
            }
        }
        data.ticket.connectorContents = connectorContents;
    }
    else {
        (0, logger_1.logInfo)(`Connector contents already populated (${connectorContents.length} items) -- skipping re-fetch`);
        // Track URLs that map to a connector so the generic fetch loop doesn't re-probe them.
        for (const url of externalUrls) {
            if ((0, gdrive_1.matchUrl)(url))
                gdriveUrls.add(url);
            if ((0, figma_1.matchUrl)(url))
                figmaUrls.add(url);
        }
    }
    // ── Fetch accessible external URLs ───────────────────────────────
    const fetchableUrls = externalUrls.filter((url) => {
        if (gdriveUrls.has(url) || figmaUrls.has(url)) {
            // Already handled by connector routing above.
            return false;
        }
        if (UNFETCHABLE.test(url)) {
            (0, logger_1.logInfo)(`  Skipping unfetchable: ${url}`);
            return false;
        }
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                (0, logger_1.logWarn)(`  Skipping non-HTTP URL: ${url} (protocol: ${parsed.protocol})`);
                return false;
            }
            if (PRIVATE_IP.test(parsed.hostname)) {
                (0, logger_1.logWarn)(`  Skipping private/localhost URL: ${url}`);
                return false;
            }
        }
        catch {
            (0, logger_1.logWarn)(`  Skipping invalid URL: ${url}`);
            return false;
        }
        return true;
    });
    const fetchedUrlContents = [];
    let totalUrlContentSize = 0;
    const urlFetchStart = Date.now();
    const urlFetchTimeout = ext.fetchConcurrency > 0
        ? (config.timeouts.stageTimeouts.urlFetch || 120_000)
        : 120_000;
    for (let i = 0; i < fetchableUrls.length; i += ext.fetchConcurrency) {
        // Total timeout check
        if (Date.now() - urlFetchStart > urlFetchTimeout) {
            (0, logger_1.logWarn)(`URL fetch total timeout (${urlFetchTimeout / 1000}s) -- ${fetchableUrls.length - i} URLs skipped`);
            (0, utils_1.addWarning)(state, 'fetch_ticket', `URL fetch timeout after ${i} URLs, ${fetchableUrls.length - i} skipped`);
            break;
        }
        // Total content cap check
        if (totalUrlContentSize >= ext.maxTotalUrlContent) {
            (0, logger_1.logWarn)(`Total URL content cap (${ext.maxTotalUrlContent / 1000}KB) reached -- ${fetchableUrls.length - i} URLs skipped`);
            (0, utils_1.addWarning)(state, 'fetch_ticket', `URL content cap reached after ${i} URLs, ${fetchableUrls.length - i} skipped`);
            break;
        }
        const batch = fetchableUrls.slice(i, i + ext.fetchConcurrency);
        const results = await Promise.allSettled(batch.map(async (url) => {
            (0, logger_1.logInfo)(`  Fetching: ${url}...`);
            const r = await (0, client_1.req)(url, {
                headers: { Accept: 'text/html,application/json,text/plain' },
            });
            if (r.status === 200) {
                let content = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2);
                if (content.length > 50_000)
                    content = (0, utils_1.truncateWithIndicator)(content, 50_000);
                return { url, content };
            }
            (0, logger_1.logWarn)(`  HTTP ${r.status} for ${url}`);
            return null;
        }));
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                totalUrlContentSize += result.value.content.length;
                if (totalUrlContentSize > ext.maxTotalUrlContent) {
                    (0, logger_1.logWarn)(`Total URL content exceeds ${ext.maxTotalUrlContent / 1000}KB -- truncating this URL`);
                    const remaining = ext.maxTotalUrlContent - (totalUrlContentSize - result.value.content.length);
                    result.value.content = (0, utils_1.truncateWithIndicator)(result.value.content, Math.max(remaining, 1000));
                }
                fetchedUrlContents.push(result.value);
                (0, logger_1.logOk)(`  Fetched ${result.value.url} (${result.value.content.length} chars)`);
            }
            else if (result.status === 'rejected') {
                const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
                (0, logger_1.logWarn)(`  URL fetch failed: ${reason}`);
            }
        }
    }
    data.ticket.fetchedUrlContents = fetchedUrlContents;
    // ── Detect auth-required URLs ────────────────────────────────────
    const authRequiredUrls = [];
    for (const url of fetchableUrls) {
        const fetched = fetchedUrlContents.find((f) => f.url === url);
        if (fetched)
            continue; // Successfully fetched -- skip
        try {
            const probeResp = await (0, client_1.req)(url, {
                headers: { Accept: 'text/html,application/json' },
            });
            if (probeResp.status === 401 || probeResp.status === 403) {
                authRequiredUrls.push({
                    url,
                    reason: `HTTP ${probeResp.status}`,
                    docType: (0, jira_1.classifyDocUrl)(url),
                });
            }
            else if (probeResp.status >= 200 && probeResp.status < 400 && typeof probeResp.data === 'string') {
                const content = probeResp.data.substring(0, 2000).toLowerCase();
                if (content.includes('login') &&
                    (content.includes('password') || content.includes('sign in') || content.includes('authenticate'))) {
                    authRequiredUrls.push({
                        url,
                        reason: 'Redirects to login page',
                        docType: (0, jira_1.classifyDocUrl)(url),
                    });
                }
            }
        }
        catch {
            // Probe failed -- ignore, already handled
        }
    }
    // Merge connector-routing failures (gdrive etc.) — these can't be detected
    // by the probe-based logic above because Google returns 200 HTML for unauth.
    for (const ar of connectorAuthRequired) {
        if (!authRequiredUrls.some((u) => u.url === ar.url)) {
            authRequiredUrls.push(ar);
        }
    }
    data.ticket.authRequiredUrls = authRequiredUrls;
    if (authRequiredUrls.length > 0) {
        (0, logger_1.logWarn)(`Q1: ${authRequiredUrls.length} URL(s) require authentication`);
        authRequiredUrls.forEach((u) => (0, logger_1.logWarn)(`  ${u.docType}: ${u.url} (${u.reason})`));
    }
    // ── Summary ──────────────────────────────────────────────────────
    const ticketData = data.ticket;
    const parentData = ticketData.parent;
    const contextSummary = [
        `Description: ${descMarkdown.length} chars (markdown)`,
        ac ? `AC: ${ac.length} chars` : null,
        allComments.length > 0 ? `Comments: ${allComments.length}` : null,
        linkedIssues.length > 0 ? `Linked issues: ${linkedIssues.length}` : null,
        parentData ? `Parent: ${parentData.key}` : null,
        attachmentContents.length > 0 ? `Attachment content: ${attachmentContents.length} files` : null,
        fetchedUrlContents.length > 0 ? `Fetched URLs: ${fetchedUrlContents.length}` : null,
        externalUrls.length > 0 ? `External URLs: ${externalUrls.length}` : null,
    ].filter(Boolean);
    (0, logger_1.logOk)(`Context gathered: ${contextSummary.join(' | ')}`);
    // ── Ticket complexity classification ─────────────────────────────
    const complexity = (0, jira_1.classifyTicketComplexity)({
        description: descMarkdown,
        ac,
        linkedIssues,
        comments: allComments,
        issueType,
    });
    data.ticket.complexity = complexity;
    (0, logger_1.logInfo)(`X7: Complexity: ${complexity.level} (score: ${complexity.score}, timeout multiplier: ${complexity.timeoutMultiplier}x)`);
    // Advance to next stage
    state.stage = 'explore_plan';
    (0, state_manager_1.save)(state);
}
//# sourceMappingURL=fetch-ticket.js.map