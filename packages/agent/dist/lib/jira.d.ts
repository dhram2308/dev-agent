/**
 * jira.ts -- Jira API client + ticket helpers
 *
 * Converted from lib/jira.js (zero functional changes).
 * Uses shared types from @mi/shared for JiraIssue, JiraComment, JiraTransition.
 */
import type { JiraIssue, JiraComment, IssueCategory } from '@mi/shared';
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
export declare const jira: JiraApi;
export declare function jiraUrl(key: string): string;
export declare function resolveJiraAccountId(emailOrId: string | undefined): Promise<string | undefined>;
export declare function classifyDocUrl(url: string | undefined): string;
export declare function getDocPasteInstructions(docType: string): string;
export declare function assessDocCriticality(docType: string, ticketText: string): string;
export declare function isImageFile(filename: string | undefined): boolean;
export declare function callAnthropicVision(base64Data: string, mediaType: string, filename: string): Promise<string | null>;
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
export declare function classifyTicketComplexity(ticket: TicketForComplexity): ComplexityResult;
export declare function categorizeIssues(reviewOutput: string | undefined, securityOutput: string | undefined): IssueCategory[];
export {};
//# sourceMappingURL=jira.d.ts.map