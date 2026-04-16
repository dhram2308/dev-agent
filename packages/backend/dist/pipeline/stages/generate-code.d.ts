import type { PipelineState } from '@shared/types';
/** Context object shared by sub-modules. */
export interface CodeGenContext {
    state: PipelineState;
    approvedPlan: string;
    devFullContext: string;
    extraDocs: string;
    extraFeedback: string;
    feedback: string;
}
/** File change from local repo or API. */
export interface FileChange {
    file_path: string;
    action: 'create' | 'update' | 'delete';
    content?: string;
}
/** Code changes result object compatible with pushCodeToGitLab. */
export interface CodeChanges {
    changes: FileChange[];
    summary: string;
    test_notes: string;
}
/**
 * Generate Code stage handler.
 *
 * Orchestrates the full 3-step code generation pipeline:
 *
 *   STEP 1: Developer Agent (write code)
 *     - Parallel multi-agent (task group split) or single agent
 *     - GQ7 + F3 validation
 *     - Retry on zero files
 *
 *   STEP 2: Test & Verify
 *     - Reviewer + Security agents (parallel)
 *     - Fixer agent (conditional, priority-ordered)
 *     - Q5: Build check (tsc + eslint + build fixer)
 *     - Runtime tests (unit tests)
 *     - Q6: AC verification (with retry)
 *
 *   STEP 3: Create MR
 *     - Branch creation, commit, conflict detection, divergence check
 *     - Rich MR description with quality report
 *     - Slack notification
 */
export declare function stageGenerateCode(state: PipelineState): Promise<void>;
