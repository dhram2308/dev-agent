"use strict";
// =====================================================================
// MI Dev Agent -- Jira Service (TypeScript port of lib/jira.js)
// =====================================================================
//
// Fully typed Jira API client. All methods use the typed HTTP client
// and return properly typed responses.
//
// Auth: Basic auth header using email:token base64 encoded.
// Base URL: from AppConfig.jira.base (e.g., https://mastersindia-sols.atlassian.net)
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.JiraService = void 0;
exports.classifyDocUrl = classifyDocUrl;
exports.getDocPasteInstructions = getDocPasteInstructions;
exports.assessDocCriticality = assessDocCriticality;
exports.isImageFile = isImageFile;
exports.classifyTicketComplexity = classifyTicketComplexity;
exports.categorizeIssues = categorizeIssues;
exports.createJiraService = createJiraService;
const client_1 = require("../http/client");
const loader_1 = require("../config/loader");
const logger_1 = require("../lib/logger");
// =====================================================================
// Jira Service Class
// =====================================================================
class JiraService {
    baseUrl;
    authHeader;
    commentsEnabled;
    constructor(config) {
        const cfg = config || (0, loader_1.loadConfig)();
        this.baseUrl = cfg.jira.base;
        // Basic auth: base64(email:token)
        this.authHeader = Buffer.from(`${cfg.jira.email}:${cfg.jira.token}`).toString('base64');
        const ext = (0, loader_1.loadExtendedConfig)();
        this.commentsEnabled = ext.jiraCommentsEnabled;
    }
    /** Build standard Jira API headers */
    headers() {
        return {
            Authorization: `Basic ${this.authHeader}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
    }
    // ── Issue Operations ──────────────────────────────────────────────
    /**
     * Fetch a Jira issue by key.
     * GET /rest/api/3/issue/{key}
     */
    async getIssue(key) {
        const r = await (0, client_1.req)(`${this.baseUrl}/rest/api/3/issue/${key}`, { headers: this.headers() });
        if (r.status !== 200) {
            throw new Error(`Jira GET ${key}: ${r.status}`);
        }
        if (!r.data || typeof r.data !== 'object' || !r.data.fields) {
            throw new Error(`Jira GET ${key}: malformed response -- missing 'fields' (got ${typeof r.data})`);
        }
        return r.data;
    }
    // ── Comment Operations ────────────────────────────────────────────
    /**
     * Add a comment to a Jira issue in ADF format.
     * POST /rest/api/3/issue/{key}/comment
     *
     * Automatically truncates long comments and respects the JIRA_COMMENTS_ENABLED flag.
     */
    async addComment(key, text) {
        if (!this.commentsEnabled) {
            (0, logger_1.logInfo)('Jira comment skipped (disabled)');
            return;
        }
        const MAX_COMMENT_LEN = 30_000;
        let commentText = text;
        const serializedLen = JSON.stringify(text).length * 2;
        if (serializedLen > MAX_COMMENT_LEN) {
            const ratio = MAX_COMMENT_LEN / serializedLen;
            const truncAt = Math.floor(text.length * ratio * 0.8);
            commentText = text.substring(0, truncAt) +
                `\n\n[...truncated at ${truncAt} chars, full is ${text.length} chars...]`;
            (0, logger_1.logWarn)(`Jira comment truncated from ${text.length} to ${truncAt} chars ` +
                `(serialized would exceed ${MAX_COMMENT_LEN})`);
        }
        // Convert plain text to ADF format (one paragraph per line)
        const adfBody = {
            type: 'doc',
            version: 1,
            content: commentText.split('\n').map((line) => ({
                type: 'paragraph',
                content: [{ type: 'text', text: line }],
            })),
        };
        const r = await (0, client_1.req)(`${this.baseUrl}/rest/api/3/issue/${key}/comment`, {
            method: 'POST',
            headers: this.headers(),
            body: { body: adfBody },
        });
        if (r.status !== 201) {
            throw new Error(`Jira comment: ${r.status}`);
        }
    }
    /**
     * Fetch all comments for a Jira issue with pagination.
     * GET /rest/api/3/issue/{key}/comment
     *
     * @param key - Issue key
     * @param since - Optional ISO date string; only return comments created after this time
     */
    async getComments(key, since) {
        let all = [];
        let startAt = 0;
        const maxResults = 50;
        while (true) {
            const r = await (0, client_1.req)(`${this.baseUrl}/rest/api/3/issue/${key}/comment` +
                `?orderBy=-created&startAt=${startAt}&maxResults=${maxResults}`, { headers: this.headers() });
            if (r.status !== 200) {
                throw new Error(`Jira comments: ${r.status}`);
            }
            const comments = r.data.comments || [];
            all = all.concat(comments);
            const total = r.data.total || 0;
            startAt += comments.length;
            if (startAt >= total || comments.length === 0)
                break;
        }
        if (since) {
            const sinceDate = new Date(since);
            return all.filter((c) => new Date(c.created) > sinceDate);
        }
        return all;
    }
    // ── Transition Operations ─────────────────────────────────────────
    /**
     * Get available transitions for an issue.
     * GET /rest/api/3/issue/{key}/transitions
     */
    async getTransitions(key) {
        const r = await (0, client_1.req)(`${this.baseUrl}/rest/api/3/issue/${key}/transitions`, { headers: this.headers() });
        if (r.status !== 200) {
            throw new Error(`Jira transitions: ${r.status}`);
        }
        return r.data.transitions || [];
    }
    /**
     * Transition an issue by transition name (fuzzy match).
     * POST /rest/api/3/issue/{key}/transitions
     *
     * First fetches available transitions, finds the best match by name,
     * then performs the transition.
     *
     * @param key - Issue key
     * @param name - Transition name (case-insensitive, partial match supported)
     */
    async transitionIssue(key, name) {
        const transitions = await this.getTransitions(key);
        const nameLower = name.toLowerCase();
        // Exact match first
        let match = transitions.find((tr) => tr.name.toLowerCase() === nameLower);
        if (!match) {
            // Partial match
            const matches = transitions.filter((tr) => tr.name.toLowerCase().includes(nameLower));
            if (matches.length === 1) {
                match = matches[0];
            }
            else if (matches.length > 1) {
                // Prefer shortest name (most specific match)
                match = matches.sort((a, b) => a.name.length - b.name.length)[0];
                (0, logger_1.logWarn)(`Multiple transitions match "${name}": ` +
                    `${matches.map((m) => m.name).join(', ')} -- using "${match.name}"`);
            }
        }
        if (!match) {
            const avail = transitions
                .map((x) => `"${x.name}" (id:${x.id})`)
                .join(', ');
            (0, logger_1.logErr)(`Available transitions for ${key}: ${avail}`);
            throw new Error(`Transition "${name}" not found. Available: ${avail}`);
        }
        const r = await (0, client_1.req)(`${this.baseUrl}/rest/api/3/issue/${key}/transitions`, {
            method: 'POST',
            headers: this.headers(),
            body: { transition: { id: match.id } },
        });
        if (r.status !== 204) {
            throw new Error(`Jira transition POST: ${r.status}`);
        }
    }
    /**
     * Transition an issue by transition ID (direct).
     * POST /rest/api/3/issue/{key}/transitions
     *
     * @param key - Issue key
     * @param transitionId - Numeric transition ID
     */
    async transitionIssueById(key, transitionId) {
        const r = await (0, client_1.req)(`${this.baseUrl}/rest/api/3/issue/${key}/transitions`, {
            method: 'POST',
            headers: this.headers(),
            body: { transition: { id: transitionId } },
        });
        if (r.status !== 204) {
            throw new Error(`Jira transition POST: ${r.status}`);
        }
    }
    // ── Search Operations ─────────────────────────────────────────────
    /**
     * Search Jira issues using JQL.
     * GET /rest/api/3/search
     *
     * @param jql - JQL query string
     * @param maxResults - Maximum results to return (default 50)
     */
    async searchIssues(jql, maxResults = 50) {
        const params = new URLSearchParams({
            jql,
            maxResults: String(maxResults),
        });
        const r = await (0, client_1.req)(`${this.baseUrl}/rest/api/3/search?${params.toString()}`, { headers: this.headers() });
        if (r.status !== 200) {
            throw new Error(`Jira search: ${r.status}`);
        }
        return r.data.issues || [];
    }
    // ── Attachment Operations ─────────────────────────────────────────
    /**
     * Get attachments for a Jira issue.
     * Extracts from issue fields (no separate API call needed).
     *
     * @param key - Issue key
     */
    async getAttachments(key) {
        const issue = await this.getIssue(key);
        return issue.fields.attachment || [];
    }
    /**
     * Download attachment content by URL.
     * Returns raw Buffer for binary content.
     *
     * @param url - Attachment download URL (from JiraAttachment.content)
     */
    async downloadAttachment(url) {
        const r = await (0, client_1.req)(url, {
            headers: {
                Authorization: `Basic ${this.authHeader}`,
                Accept: '*/*',
            },
            raw: true,
        });
        if (r.status !== 200) {
            throw new Error(`Jira attachment download: ${r.status}`);
        }
        return r.data;
    }
    // ── User Operations ───────────────────────────────────────────────
    /**
     * Resolve an email address to a Jira account ID.
     * If the input is already an account ID (no @), returns it as-is.
     *
     * @param emailOrId - Email address or account ID
     */
    async resolveAccountId(emailOrId) {
        if (!emailOrId || !emailOrId.includes('@'))
            return emailOrId;
        try {
            const r = await (0, client_1.req)(`${this.baseUrl}/rest/api/3/user/search?query=${encodeURIComponent(emailOrId)}`, { headers: this.headers() });
            if (r.status === 200 && Array.isArray(r.data) && r.data.length > 0) {
                return r.data[0].accountId;
            }
            (0, logger_1.logWarn)(`Could not resolve Jira account for: ${emailOrId}`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logWarn)(`Jira account resolution failed for ${emailOrId}: ${msg}`);
        }
        return emailOrId;
    }
    // ── Utility: Build browse URL ─────────────────────────────────────
    /**
     * Build a Jira browse URL for an issue key.
     */
    issueUrl(key) {
        return `${this.baseUrl}/browse/${key}`;
    }
}
exports.JiraService = JiraService;
// =====================================================================
// Standalone Utility Functions (ported from lib/jira.js)
// =====================================================================
/**
 * Classify a URL by document type.
 * Returns a human-readable label for known document services.
 */
function classifyDocUrl(url) {
    const lower = (url || '').toLowerCase();
    if (lower.includes('docs.google.com') || lower.includes('drive.google.com'))
        return 'Google Doc';
    if (lower.includes('sheets.google.com'))
        return 'Google Sheet';
    if (lower.includes('figma.com'))
        return 'Figma Design';
    if (lower.includes('postman.com') || lower.includes('getpostman.com'))
        return 'Postman Collection';
    if (lower.includes('confluence.') || lower.includes('confluence/'))
        return 'Confluence Page';
    if (lower.includes('notion.so'))
        return 'Notion Page';
    if (lower.includes('.sharepoint.com'))
        return 'SharePoint';
    if (lower.includes('swagger') || lower.includes('api-docs'))
        return 'API Docs';
    if (lower.includes('miro.com'))
        return 'Miro Board';
    if (lower.includes('canva.com'))
        return 'Canva Design';
    if (lower.includes('lovable.app'))
        return 'Lovable App';
    return 'External Document';
}
/**
 * Get paste instructions for a given document type.
 * Returns a human-readable instruction for what content to extract.
 */
function getDocPasteInstructions(docType) {
    const instructions = {
        'Google Doc': 'Please paste the document text content, especially API endpoints, request/response payloads, and field mappings',
        'Google Sheet': 'Please paste the relevant rows/columns as text or CSV, especially field names, mappings, and data formats',
        'Figma Design': 'Please paste a screenshot or describe the layout, component hierarchy, spacing, and interaction patterns',
        'Postman Collection': 'Please paste API endpoints, HTTP methods, request headers, query params, request/response body JSON',
        'Confluence Page': 'Please paste the page content, especially technical specs, architecture decisions, and requirements',
        'Notion Page': 'Please paste the page content, especially requirements, acceptance criteria, and technical details',
        'SharePoint': 'Please paste the document content or provide a publicly accessible link',
        'API Docs': 'Please paste API endpoints, HTTP methods, request/response schemas, authentication details, and error codes',
        'Miro Board': 'Please describe the diagram, flow chart, or architecture depicted on the board',
        'Canva Design': 'Please paste a screenshot or describe the visual design, layout, and components',
    };
    return instructions[docType] || 'Please paste the relevant content from this document';
}
/**
 * Assess how critical a document is for the ticket context.
 *
 * @param docType - Document type from classifyDocUrl()
 * @param ticketText - Combined ticket description/summary text
 */
function assessDocCriticality(docType, ticketText) {
    const lower = (ticketText || '').toLowerCase();
    if ((docType === 'API Docs' || docType === 'Postman Collection') &&
        (lower.includes('api') || lower.includes('endpoint') || lower.includes('payload'))) {
        return 'CRITICAL';
    }
    if (docType === 'Figma Design' &&
        (lower.includes('ui') || lower.includes('design') || lower.includes('layout') || lower.includes('screen'))) {
        return 'HIGH';
    }
    if ((docType === 'Google Doc' || docType === 'Google Sheet') &&
        (lower.includes('spec') || lower.includes('mapping') || lower.includes('requirement'))) {
        return 'HIGH';
    }
    return 'MEDIUM';
}
/**
 * Check if a filename is an image file.
 */
function isImageFile(filename) {
    return /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(filename || '');
}
/**
 * Classify ticket complexity based on description, acceptance criteria,
 * linked issues, comments, and issue type.
 */
function classifyTicketComplexity(ticket) {
    let score = 0;
    const desc = ticket.description || '';
    const ac = ticket.ac || '';
    if (desc.length > 2000)
        score += 2;
    else if (desc.length > 500)
        score += 1;
    const acLines = ac.split('\n').filter((l) => l.trim()).length;
    if (acLines > 10)
        score += 2;
    else if (acLines > 5)
        score += 1;
    const linked = (ticket.linkedIssues || []).length;
    if (linked > 3)
        score += 2;
    else if (linked > 0)
        score += 1;
    const comments = (ticket.comments || []).length;
    if (comments > 10)
        score += 2;
    else if (comments > 3)
        score += 1;
    const issueType = (ticket.issueType || '').toLowerCase();
    if (issueType === 'epic' || issueType === 'story')
        score += 2;
    else if (issueType === 'bug')
        score += 1;
    if (score >= 7)
        return { level: 'HIGH', score, timeoutMultiplier: 1.5 };
    if (score >= 4)
        return { level: 'MEDIUM', score, timeoutMultiplier: 1.2 };
    return { level: 'LOW', score, timeoutMultiplier: 1.0 };
}
/**
 * Categorize review/security issues by priority.
 * Returns sorted array of issue categories (highest priority first).
 */
function categorizeIssues(reviewOutput, securityOutput) {
    const categories = [];
    if (securityOutput && /CRITICAL|vulnerability|injection|xss/i.test(securityOutput)) {
        categories.push({
            priority: 1,
            type: 'SECURITY',
            label: '[SECURITY-CRITICAL]',
            content: securityOutput,
        });
    }
    if (reviewOutput && /CRITICAL|must fix|breaking|compilation|import error|cannot find/i.test(reviewOutput)) {
        categories.push({
            priority: 0,
            type: 'COMPILATION',
            label: '[COMPILATION-ERROR]',
            content: reviewOutput,
        });
    }
    if (reviewOutput && /reuse|pattern|violation|deviat/i.test(reviewOutput)) {
        categories.push({
            priority: 2,
            type: 'CODE_REVIEW',
            label: '[REVIEWER-CRITICAL]',
            content: reviewOutput,
        });
    }
    if (reviewOutput && /lint|eslint|prettier|format/i.test(reviewOutput)) {
        categories.push({
            priority: 3,
            type: 'LINT',
            label: '[LINT-WARN]',
            content: reviewOutput,
        });
    }
    // Default categories if nothing matched
    if (categories.length === 0) {
        if (reviewOutput) {
            categories.push({
                priority: 2,
                type: 'CODE_REVIEW',
                label: '[REVIEWER-CRITICAL]',
                content: reviewOutput,
            });
        }
        if (securityOutput) {
            categories.push({
                priority: 1,
                type: 'SECURITY',
                label: '[SECURITY-HIGH]',
                content: securityOutput,
            });
        }
    }
    return categories.sort((a, b) => a.priority - b.priority);
}
// =====================================================================
// Factory + default instance
// =====================================================================
/** Create a new JiraService instance with optional config override. */
function createJiraService(config) {
    return new JiraService(config);
}
//# sourceMappingURL=jira.js.map