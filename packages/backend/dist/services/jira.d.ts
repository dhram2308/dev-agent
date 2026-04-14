import type { AppConfig } from '@shared/types';
/** Jira ADF (Atlassian Document Format) node */
export interface AdfNode {
    type: string;
    version?: number;
    content?: AdfNode[];
    text?: string;
    attrs?: Record<string, unknown>;
    marks?: Array<{
        type: string;
        attrs?: Record<string, unknown>;
    }>;
    [key: string]: unknown;
}
/** Jira issue fields */
export interface JiraFields {
    summary: string;
    description: AdfNode | string | null;
    status: {
        name: string;
        id: string;
        statusCategory: {
            key: string;
            name: string;
        };
    };
    issuetype: {
        name: string;
        id: string;
        subtask: boolean;
    };
    priority: {
        name: string;
        id: string;
    };
    assignee: {
        accountId: string;
        displayName: string;
        emailAddress?: string;
    } | null;
    reporter: {
        accountId: string;
        displayName: string;
        emailAddress?: string;
    } | null;
    creator: {
        accountId: string;
        displayName: string;
        emailAddress?: string;
    } | null;
    created: string;
    updated: string;
    labels: string[];
    components: Array<{
        name: string;
        id: string;
    }>;
    fixVersions: Array<{
        name: string;
        id: string;
    }>;
    parent?: {
        key: string;
        fields: {
            summary: string;
            issuetype: {
                name: string;
            };
            status: {
                name: string;
            };
        };
    };
    subtasks?: Array<{
        key: string;
        fields: {
            summary: string;
            issuetype: {
                name: string;
            };
            status: {
                name: string;
            };
        };
    }>;
    issuelinks?: Array<{
        type: {
            name: string;
            inward: string;
            outward: string;
        };
        inwardIssue?: {
            key: string;
            fields: {
                summary: string;
                status: {
                    name: string;
                };
                issuetype: {
                    name: string;
                };
            };
        };
        outwardIssue?: {
            key: string;
            fields: {
                summary: string;
                status: {
                    name: string;
                };
                issuetype: {
                    name: string;
                };
            };
        };
    }>;
    attachment?: JiraAttachment[];
    comment?: {
        comments: JiraComment[];
        total: number;
        maxResults: number;
        startAt: number;
    };
    [key: string]: unknown;
}
/** Jira issue */
export interface JiraIssue {
    id: string;
    key: string;
    self: string;
    fields: JiraFields;
    expand?: string;
}
/** Jira comment */
export interface JiraComment {
    id: string;
    self: string;
    body: AdfNode | string;
    author: {
        accountId: string;
        displayName: string;
        emailAddress?: string;
    };
    created: string;
    updated: string;
    [key: string]: unknown;
}
/** Jira transition */
export interface JiraTransition {
    id: string;
    name: string;
    to: {
        id: string;
        name: string;
        statusCategory: {
            key: string;
            name: string;
        };
    };
    hasScreen: boolean;
    isGlobal: boolean;
    isInitial: boolean;
    isConditional: boolean;
}
/** Jira attachment */
export interface JiraAttachment {
    id: string;
    self: string;
    filename: string;
    author: {
        accountId: string;
        displayName: string;
    };
    created: string;
    size: number;
    mimeType: string;
    content: string;
    thumbnail?: string;
}
/** Jira user search result */
export interface JiraUser {
    accountId: string;
    displayName: string;
    emailAddress?: string;
    active: boolean;
    accountType: string;
}
/** Document type classification result */
export interface DocClassification {
    docType: string;
    pasteInstructions: string;
    criticality: 'CRITICAL' | 'HIGH' | 'MEDIUM';
}
/** Ticket complexity classification result */
export interface TicketComplexity {
    level: 'HIGH' | 'MEDIUM' | 'LOW';
    score: number;
    timeoutMultiplier: number;
}
/** Issue category for review/security output */
export interface IssueCategory {
    priority: number;
    type: 'SECURITY' | 'COMPILATION' | 'CODE_REVIEW' | 'LINT';
    label: string;
    content: string;
}
export declare class JiraService {
    private readonly baseUrl;
    private readonly authHeader;
    private readonly commentsEnabled;
    constructor(config?: AppConfig);
    /** Build standard Jira API headers */
    private headers;
    /**
     * Fetch a Jira issue by key.
     * GET /rest/api/3/issue/{key}
     */
    getIssue(key: string): Promise<JiraIssue>;
    /**
     * Add a comment to a Jira issue in ADF format.
     * POST /rest/api/3/issue/{key}/comment
     *
     * Automatically truncates long comments and respects the JIRA_COMMENTS_ENABLED flag.
     */
    addComment(key: string, text: string): Promise<void>;
    /**
     * Fetch all comments for a Jira issue with pagination.
     * GET /rest/api/3/issue/{key}/comment
     *
     * @param key - Issue key
     * @param since - Optional ISO date string; only return comments created after this time
     */
    getComments(key: string, since?: string): Promise<JiraComment[]>;
    /**
     * Get available transitions for an issue.
     * GET /rest/api/3/issue/{key}/transitions
     */
    getTransitions(key: string): Promise<JiraTransition[]>;
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
    transitionIssue(key: string, name: string): Promise<void>;
    /**
     * Transition an issue by transition ID (direct).
     * POST /rest/api/3/issue/{key}/transitions
     *
     * @param key - Issue key
     * @param transitionId - Numeric transition ID
     */
    transitionIssueById(key: string, transitionId: string): Promise<void>;
    /**
     * Search Jira issues using JQL.
     * GET /rest/api/3/search
     *
     * @param jql - JQL query string
     * @param maxResults - Maximum results to return (default 50)
     */
    searchIssues(jql: string, maxResults?: number): Promise<JiraIssue[]>;
    /**
     * Get attachments for a Jira issue.
     * Extracts from issue fields (no separate API call needed).
     *
     * @param key - Issue key
     */
    getAttachments(key: string): Promise<JiraAttachment[]>;
    /**
     * Download attachment content by URL.
     * Returns raw Buffer for binary content.
     *
     * @param url - Attachment download URL (from JiraAttachment.content)
     */
    downloadAttachment(url: string): Promise<Buffer>;
    /**
     * Resolve an email address to a Jira account ID.
     * If the input is already an account ID (no @), returns it as-is.
     *
     * @param emailOrId - Email address or account ID
     */
    resolveAccountId(emailOrId: string): Promise<string>;
    /**
     * Build a Jira browse URL for an issue key.
     */
    issueUrl(key: string): string;
}
/**
 * Classify a URL by document type.
 * Returns a human-readable label for known document services.
 */
export declare function classifyDocUrl(url: string): string;
/**
 * Get paste instructions for a given document type.
 * Returns a human-readable instruction for what content to extract.
 */
export declare function getDocPasteInstructions(docType: string): string;
/**
 * Assess how critical a document is for the ticket context.
 *
 * @param docType - Document type from classifyDocUrl()
 * @param ticketText - Combined ticket description/summary text
 */
export declare function assessDocCriticality(docType: string, ticketText: string): 'CRITICAL' | 'HIGH' | 'MEDIUM';
/**
 * Check if a filename is an image file.
 */
export declare function isImageFile(filename: string): boolean;
/**
 * Classify ticket complexity based on description, acceptance criteria,
 * linked issues, comments, and issue type.
 */
export declare function classifyTicketComplexity(ticket: {
    description?: string;
    ac?: string;
    linkedIssues?: unknown[];
    comments?: unknown[];
    issueType?: string;
}): TicketComplexity;
/**
 * Categorize review/security issues by priority.
 * Returns sorted array of issue categories (highest priority first).
 */
export declare function categorizeIssues(reviewOutput: string | null, securityOutput: string | null): IssueCategory[];
/** Create a new JiraService instance with optional config override. */
export declare function createJiraService(config?: AppConfig): JiraService;
