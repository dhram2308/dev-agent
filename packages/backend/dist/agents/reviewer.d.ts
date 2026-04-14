import type { PipelineState } from '@shared/types';
import type { ClaudeService } from '../services/claude';
import type { IssueCategory } from '../services/jira';
export { parseVerdict } from './fixer';
/** Context needed by the reviewer agent */
export interface ReviewerContext {
    /** The approved implementation plan */
    approvedPlan: string;
    /** Claude service instance */
    claude: ClaudeService;
    /** Project directory (target repo) */
    projectDir: string;
    /** Timeout for reviewer agent in ms */
    reviewerTimeoutMs: number;
    /** Timeout for fixer/developer agent in ms */
    developerTimeoutMs: number;
    /** Complexity-adjusted timeout multiplier */
    timeoutMultiplier?: number;
}
/** Result from running the reviewer agent */
export interface ReviewerResult {
    /** Whether the review passed without issues */
    passed: boolean;
    /** Whether the fixer was invoked */
    fixerRan: boolean;
    /** Reviewer output text */
    reviewOutput: string;
    /** Security output text */
    securityOutput: string;
    /** Issue categories found */
    categories?: IssueCategory[];
}
/** File change descriptor */
export interface FileChange {
    action: 'create' | 'update' | 'delete';
    file_path: string;
    content?: string;
}
/**
 * Run Reviewer + Security Agents in parallel, then Fixer if needed.
 *
 * @param state - Current pipeline state
 * @param ctx - Reviewer context (plan, services, timeouts)
 * @param fileChanges - Current file changes array
 * @returns ReviewerResult with pass/fail status and outputs
 */
export declare function runReviewer(state: PipelineState, ctx: ReviewerContext, fileChanges: FileChange[]): Promise<ReviewerResult>;
