import type { PipelineState } from '@shared/types';
import type { ClaudeService } from '../services/claude';
/** Task group parsed from tasks.md */
export interface TaskGroup {
    title: string;
    content: string;
    files: string[];
}
/** Context needed by the developer agent */
export interface DeveloperContext {
    /** The approved implementation plan */
    approvedPlan: string;
    /** Full developer context (repo structure, file contents, etc.) */
    devFullContext: string;
    /** Extra documentation context */
    extraDocs: string;
    /** Extra feedback context from previous rounds */
    extraFeedback: string;
    /** Feedback from code review rejection */
    feedback?: string;
    /** Claude service instance */
    claude: ClaudeService;
    /** Project directory (target repo) */
    projectDir: string;
    /** Timeout for developer agent in ms */
    timeoutMs: number;
    /** Complexity-adjusted timeout multiplier */
    timeoutMultiplier?: number;
}
/** Result from running the developer agent */
export interface DeveloperResult {
    /** Summary of changes made */
    summary: string;
    /** Whether parallel mode was used */
    parallelMode: boolean;
    /** Number of task groups (if parallel) */
    groupCount?: number;
}
/**
 * Parse a tasks.md markdown into independent task groups for parallel execution.
 * Splits by ## headings, extracts file paths per group, merges groups sharing files
 * using union-find to ensure no two agents touch the same file.
 *
 * @param tasksMarkdown - The tasks.md content
 * @returns Independent task groups with titles, content, and file lists
 */
export declare function parseTaskGroups(tasksMarkdown: string): TaskGroup[];
/**
 * Run the Developer Agent -- generates code based on the approved plan.
 *
 * Supports parallel execution via task group splitting when the plan
 * can be divided into 2-5 independent groups. Falls back to a single
 * agent if parallel mode fails or the plan is not splittable.
 *
 * @param state - Current pipeline state
 * @param ctx - Developer context (plan, feedback, services, etc.)
 * @returns Developer result with summary of changes
 */
export declare function runDeveloper(state: PipelineState, ctx: DeveloperContext): Promise<DeveloperResult>;
/**
 * Shared validation for developer agent output (GQ7 + F3).
 * Checks import resolution and forbidden path violations.
 *
 * @param state - Pipeline state (for warnings)
 * @param projectDir - Project directory for file resolution
 * @param changedFiles - Optional explicit file changes to validate
 */
export declare function validateDevChanges(state: PipelineState, projectDir: string, changedFiles?: Array<{
    file_path: string;
    action: string;
    content?: string;
}>): void;
