/**
 * A comment extracted from a Jira issue, converted to markdown.
 * Built in stageFetchTicket() from JiraComment objects.
 */
export interface TicketComment {
    /** Display name of the comment author */
    author: string;
    /** Creation timestamp (ISO 8601) */
    created: string;
    /** Comment body converted to markdown via adfToMarkdown() */
    body: string;
    /** URLs extracted from the comment's ADF body via adfExtractUrls() */
    urls: readonly string[];
}
/**
 * A linked issue with full context fetched from Jira.
 * Built in stageFetchTicket() Layer 3 (linked issues).
 */
export interface LinkedIssue {
    /** Issue key (e.g., "AUT-8031") */
    key: string;
    /** Human-readable relationship label (e.g., "blocks", "is blocked by") */
    relationship: string;
    /** Link direction relative to the parent ticket */
    direction: 'inward' | 'outward';
    /** Link type name (e.g., "Blocks", "Relates") */
    linkType: string;
    /** Issue summary */
    summary: string;
    /** Issue description converted to markdown */
    description: string;
    /** Current issue status name (e.g., "In Progress") */
    status: string;
    /** Issue type name (e.g., "Bug", "Story") */
    type: string;
}
/**
 * Content downloaded from a parseable Jira attachment.
 * Built in stageFetchTicket() Layer 5 (downloadable attachments).
 */
export interface AttachmentContent {
    /** Original filename */
    filename: string;
    /** MIME type (e.g., "application/json", "text/plain") */
    mimeType: string;
    /** Text content of the attachment (may be truncated) */
    content: string;
}
/**
 * Content fetched from an accessible external URL.
 * Built in stageFetchTicket() Layer 7 (external URL fetching).
 */
export interface FetchedUrlContent {
    /** The URL that was fetched */
    url: string;
    /** Text content of the response (may be truncated) */
    content: string;
}
/**
 * Content fetched from an authenticated connector (Google Drive, Figma, Postman).
 * Built in stageFetchTicket() Layer 6b (connector URL routing).
 */
export interface ConnectorContent {
    /** Connector source identifier ("gdrive", "figma", "postman") */
    source: string;
    /** Original URL or "attachment:{filename}" for inline Postman collections */
    url: string;
    /** Document title */
    title: string;
    /** Document content (text/markdown) */
    content: string;
    /** Content size in bytes */
    sizeBytes: number;
}
/**
 * A URL that requires authentication and could not be fetched automatically.
 * Built in stageFetchTicket() Q1 (auth-required URL detection).
 */
export interface AuthRequiredUrl {
    /** The URL that requires authentication */
    url: string;
    /** Reason the URL could not be fetched (e.g., "HTTP 401", "Redirects to login page") */
    reason: string;
    /** Classified document type (e.g., "Google Doc", "Figma Design") */
    docType: string;
}
/**
 * Parent epic/task context attached to the ticket.
 * Built in stageFetchTicket() Layer 4 (parent epic context).
 */
export interface ParentIssueContext {
    /** Parent issue key (e.g., "AUT-8000") */
    key: string;
    /** Parent issue summary */
    summary: string;
    /** Parent issue status name */
    status: string;
    /** Parent issue description converted to markdown */
    description: string;
}
/**
 * Ticket complexity classification result.
 * Built by classifyTicketComplexity() in lib/jira.js.
 */
export interface TicketComplexity {
    /** Complexity level */
    level: 'LOW' | 'MEDIUM' | 'HIGH';
    /** Numeric complexity score */
    score: number;
    /** Multiplier applied to stage timeouts based on complexity */
    timeoutMultiplier: number;
}
/**
 * Raw attachment metadata from Jira (before download).
 */
export interface AttachmentMeta {
    /** Original filename */
    filename: string;
    /** Download URL */
    url: string;
    /** MIME type */
    mimeType: string;
    /** File size in bytes */
    size: number;
}
/**
 * Full ticket context object built by stageFetchTicket().
 * Stored in state.data.ticket and consumed by all downstream stages.
 */
export interface TicketContext {
    /** Jira issue key (e.g., "AUT-8031") */
    key: string;
    /** Issue summary (title) */
    summary: string;
    /** Issue description converted to markdown via adfToMarkdown() */
    description: string;
    /** Acceptance criteria (extracted from description or custom field) */
    ac: string;
    /** Whether AC is missing from the ticket */
    ac_missing: boolean;
    /** Issue type name (e.g., "Bug", "Story", "Task") */
    issueType: string;
    /** Priority name (e.g., "High", "Medium") */
    priority: string;
    /** Parent epic/task context (Layer 4) */
    parent?: ParentIssueContext;
    /** All comments from the ticket (Layer 2) */
    comments: TicketComment[];
    /** Linked issues with full context (Layer 3) */
    linkedIssues: LinkedIssue[];
    /** Raw attachment metadata (Layer 5) */
    attachments: AttachmentMeta[];
    /** Downloaded attachment contents (Layer 5) */
    attachmentContents: AttachmentContent[];
    /** External URLs found in description, AC, and comments (Layer 6) */
    externalUrls: string[];
    /** Content fetched from accessible external URLs (Layer 7) */
    fetchedUrlContents: FetchedUrlContent[];
    /** Content fetched from authenticated connectors (Layer 6b) */
    connectorContents: ConnectorContent[];
    /** URLs that require authentication (Q1) */
    authRequiredUrls: AuthRequiredUrl[];
    /** Ticket complexity classification (X7) */
    complexity?: TicketComplexity;
    /** Supplementary docs pasted by user */
    supplementaryDocs?: string;
    /** Plan feedback from user */
    planFeedback?: string;
    /** Dynamic properties for custom fields or future extensions */
    [key: string]: unknown;
}
//# sourceMappingURL=tickets.d.ts.map