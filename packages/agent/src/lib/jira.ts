/**
 * jira.ts -- Jira API client + ticket helpers
 *
 * Converted from lib/jira.js (zero functional changes).
 * Uses shared types from @mi/shared for JiraIssue, JiraComment, JiraTransition.
 */

import type {
  JiraIssue,
  JiraComment,
  JiraTransition,
  HttpResponse,
  IssueCategory,
} from '@mi/shared';

// TODO: Replace require() with imports once these modules are converted
const { cfg, JIRA_COMMENTS } = require('./config') as {
  cfg: {
    jira: { base: string; auth: string };
    [key: string]: any;
  };
  JIRA_COMMENTS: boolean;
};
const { req } = require('./http-client') as {
  req: (url: string, opts?: any) => Promise<HttpResponse<any>>;
};
const { logWarn, logErr, logInfo } = require('./logging') as {
  logWarn: (msg: string) => void;
  logErr: (msg: string) => void;
  logInfo: (msg: string) => void;
};

// ── Jira API ──────────────────────────────────────────────────────

interface JiraHeaders {
  Authorization: string;
  'Content-Type': string;
  Accept: string;
}

interface JiraApi {
  h(): JiraHeaders;
  getIssue(key: string): Promise<JiraIssue>;
  addComment(key: string, text: string): Promise<any>;
  getComments(key: string, since?: string): Promise<JiraComment[]>;
  transition(key: string, name: string): Promise<void>;
}

export const jira: JiraApi = {
  h(): JiraHeaders {
    return {
      Authorization: `Basic ${cfg.jira.auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  },

  async getIssue(key: string): Promise<JiraIssue> {
    const r = await req(`${cfg.jira.base}/rest/api/3/issue/${key}`, { headers: this.h() });
    if (r.status !== 200) throw new Error(`Jira GET ${key}: ${r.status}`);
    if (!r.data || typeof r.data !== 'object' || !r.data.fields) {
      throw new Error(`Jira GET ${key}: malformed response — missing 'fields' (got ${typeof r.data})`);
    }
    return r.data as JiraIssue;
  },

  async addComment(key: string, text: string): Promise<any> {
    if (!JIRA_COMMENTS) { logInfo('Jira comment skipped (disabled)'); return; }
    const MAX_COMMENT_LEN = 30000;
    let commentText = text;
    const serializedLen = JSON.stringify(text).length * 2;
    if (serializedLen > MAX_COMMENT_LEN) {
      const ratio = MAX_COMMENT_LEN / serializedLen;
      const truncAt = Math.floor(text.length * ratio * 0.8);
      commentText = text.substring(0, truncAt) + `\n\n[...truncated at ${truncAt} chars, full is ${text.length} chars...]`;
      logWarn(`Jira comment truncated from ${text.length} to ${truncAt} chars (serialized would exceed ${MAX_COMMENT_LEN})`);
    }
    const r = await req(`${cfg.jira.base}/rest/api/3/issue/${key}/comment`, {
      method: 'POST', headers: this.h(),
      body: {
        body: { type: 'doc', version: 1,
          content: commentText.split('\n').map((line: string) => ({
            type: 'paragraph',
            content: [{ type: 'text', text: line }],
          })),
        },
      },
    });
    if (r.status !== 201) throw new Error(`Jira comment: ${r.status}`);
    return r.data;
  },

  async getComments(key: string, since?: string): Promise<JiraComment[]> {
    let all: JiraComment[] = [];
    let startAt = 0;
    const maxResults = 50;
    while (true) {
      const r = await req(
        `${cfg.jira.base}/rest/api/3/issue/${key}/comment?orderBy=-created&startAt=${startAt}&maxResults=${maxResults}`,
        { headers: this.h() },
      );
      if (r.status !== 200) throw new Error(`Jira comments: ${r.status}`);
      const comments: JiraComment[] = r.data.comments || [];
      all = all.concat(comments);
      const total: number = r.data.total || 0;
      startAt += comments.length;
      if (startAt >= total || comments.length === 0) break;
    }
    return since ? all.filter((c) => new Date(c.created) > new Date(since)) : all;
  },

  async transition(key: string, name: string): Promise<void> {
    const r = await req(`${cfg.jira.base}/rest/api/3/issue/${key}/transitions`, {
      headers: this.h(),
    });
    if (r.status !== 200) throw new Error(`Jira transitions: ${r.status}`);
    const transitions: JiraTransition[] = r.data.transitions || [];
    const nameLower = name.toLowerCase();

    let t: JiraTransition | undefined = transitions.find((tr) => tr.name.toLowerCase() === nameLower);
    if (!t) {
      const matches = transitions.filter((tr) => tr.name.toLowerCase().includes(nameLower));
      if (matches.length === 1) {
        t = matches[0];
      } else if (matches.length > 1) {
        t = matches.sort((a, b) => a.name.length - b.name.length)[0];
        logWarn(`Multiple transitions match "${name}": ${matches.map((m) => m.name).join(', ')} — using "${t!.name}"`);
      }
    }

    if (!t) {
      const avail = transitions.map((x) => `"${x.name}" (id:${x.id})`).join(', ');
      logErr(`Available transitions for ${key}: ${avail}`);
      throw new Error(`Transition "${name}" not found. Available: ${avail}`);
    }
    const m = await req(`${cfg.jira.base}/rest/api/3/issue/${key}/transitions`, {
      method: 'POST', headers: this.h(),
      body: { transition: { id: t.id } },
    });
    if (m.status !== 204) throw new Error(`Jira transition POST: ${m.status}`);
  },
};

export function jiraUrl(key: string): string { return `${cfg.jira.base}/browse/${key}`; }

// ── C4: Resolve email addresses to Jira account IDs ───────────────
export async function resolveJiraAccountId(emailOrId: string | undefined): Promise<string | undefined> {
  if (!emailOrId || !emailOrId.includes('@')) return emailOrId;
  try {
    const r = await req(`${cfg.jira.base}/rest/api/3/user/search?query=${encodeURIComponent(emailOrId)}`, { headers: jira.h() });
    if (r.status === 200 && Array.isArray(r.data) && r.data.length > 0) return r.data[0].accountId;
    logWarn(`C4: Could not resolve Jira account for: ${emailOrId}`);
  } catch (e: any) {
    logWarn(`C4: Jira account resolution failed for ${emailOrId}: ${e.message}`);
  }
  return emailOrId;
}

// ── Q1: Classify inaccessible URL by document type ────────────────
export function classifyDocUrl(url: string | undefined): string {
  const lower = (url || '').toLowerCase();
  if (lower.includes('docs.google.com') || lower.includes('drive.google.com')) return 'Google Doc';
  if (lower.includes('sheets.google.com')) return 'Google Sheet';
  if (lower.includes('figma.com')) return 'Figma Design';
  if (lower.includes('postman.com') || lower.includes('getpostman.com')) return 'Postman Collection';
  if (lower.includes('confluence.') || lower.includes('confluence/')) return 'Confluence Page';
  if (lower.includes('notion.so')) return 'Notion Page';
  if (lower.includes('.sharepoint.com')) return 'SharePoint';
  if (lower.includes('swagger') || lower.includes('api-docs')) return 'API Docs';
  if (lower.includes('miro.com')) return 'Miro Board';
  if (lower.includes('canva.com')) return 'Canva Design';
  if (lower.includes('lovable.app')) return 'Lovable App';
  return 'External Document';
}

export function getDocPasteInstructions(docType: string): string {
  const instructions: Record<string, string> = {
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

export function assessDocCriticality(docType: string, ticketText: string): string {
  const lower = (ticketText || '').toLowerCase();
  if ((docType === 'API Docs' || docType === 'Postman Collection') &&
      (lower.includes('api') || lower.includes('endpoint') || lower.includes('payload'))) return 'CRITICAL';
  if (docType === 'Figma Design' &&
      (lower.includes('ui') || lower.includes('design') || lower.includes('layout') || lower.includes('screen'))) return 'HIGH';
  if ((docType === 'Google Doc' || docType === 'Google Sheet') &&
      (lower.includes('spec') || lower.includes('mapping') || lower.includes('requirement'))) return 'HIGH';
  return 'MEDIUM';
}

// ── Q2: Image attachment vision ───────────────────────────────────
export function isImageFile(filename: string | undefined): boolean {
  return /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(filename || '');
}

export async function callAnthropicVision(
  base64Data: string,
  mediaType: string,
  filename: string,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
          { type: 'text', text: `Describe this image attachment "${filename}" from a Jira ticket. Focus on: UI layout, component structure, data fields, API schemas, error messages, or any technical details visible. Be concise but thorough.` },
        ],
      }],
    });
    const r = await req('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body,
    });
    if (r.status === 200 && r.data && r.data.content && r.data.content.length > 0) {
      return r.data.content.map((c: any) => c.text || '').join('\n').trim();
    }
    logWarn(`Vision API returned ${r.status} for ${filename}`);
    return null;
  } catch (e: any) {
    logWarn(`Vision API error for ${filename}: ${e.message}`);
    return null;
  }
}

// ── X7: Ticket complexity classifier ──────────────────────────────

interface TicketForComplexity {
  description?: string;
  ac?: string;
  linkedIssues?: any[];
  comments?: any[];
  issueType?: string;
}

interface ComplexityResult {
  level: 'HIGH' | 'MEDIUM' | 'LOW';
  score: number;
  timeoutMultiplier: number;
}

export function classifyTicketComplexity(ticket: TicketForComplexity): ComplexityResult {
  let score = 0;
  const desc = ticket.description || '';
  const ac = ticket.ac || '';
  if (desc.length > 2000) score += 2;
  else if (desc.length > 500) score += 1;
  const acLines = ac.split('\n').filter((l) => l.trim()).length;
  if (acLines > 10) score += 2;
  else if (acLines > 5) score += 1;
  const linked = (ticket.linkedIssues || []).length;
  if (linked > 3) score += 2;
  else if (linked > 0) score += 1;
  const comments = (ticket.comments || []).length;
  if (comments > 10) score += 2;
  else if (comments > 3) score += 1;
  const issueType = (ticket.issueType || '').toLowerCase();
  if (issueType === 'epic' || issueType === 'story') score += 2;
  else if (issueType === 'bug') score += 1;
  if (score >= 7) return { level: 'HIGH', score, timeoutMultiplier: 1.5 };
  if (score >= 4) return { level: 'MEDIUM', score, timeoutMultiplier: 1.2 };
  return { level: 'LOW', score, timeoutMultiplier: 1.0 };
}

// ── X5: Issue-specific fixer strategy ─────────────────────────────
export function categorizeIssues(reviewOutput: string | undefined, securityOutput: string | undefined): IssueCategory[] {
  const categories: IssueCategory[] = [];
  if (securityOutput && /CRITICAL|vulnerability|injection|xss/i.test(securityOutput)) {
    categories.push({ priority: 1, type: 'SECURITY', label: '[SECURITY-CRITICAL]', content: securityOutput });
  }
  if (reviewOutput && /CRITICAL|must fix|breaking|compilation|import error|cannot find/i.test(reviewOutput)) {
    categories.push({ priority: 0, type: 'COMPILATION', label: '[COMPILATION-ERROR]', content: reviewOutput });
  }
  if (reviewOutput && /reuse|pattern|violation|deviat/i.test(reviewOutput)) {
    categories.push({ priority: 2, type: 'CODE_REVIEW', label: '[REVIEWER-CRITICAL]', content: reviewOutput });
  }
  if (reviewOutput && /lint|eslint|prettier|format/i.test(reviewOutput)) {
    categories.push({ priority: 3, type: 'LINT', label: '[LINT-WARN]', content: reviewOutput });
  }
  if (categories.length === 0) {
    if (reviewOutput) categories.push({ priority: 2, type: 'CODE_REVIEW', label: '[REVIEWER-CRITICAL]', content: reviewOutput });
    if (securityOutput) categories.push({ priority: 1, type: 'SECURITY', label: '[SECURITY-HIGH]', content: securityOutput });
  }
  return categories.sort((a, b) => a.priority - b.priority);
}
