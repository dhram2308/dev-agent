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
 * Orchestrates the full code generation pipeline:
 *   1. Check rejection counter (halt if exceeded MAX_REJECTIONS)
 *   2. Skip if code already generated and no new feedback
 *   3. Build full context from ticket data
 *   4. Run developer agent
 *   5. Check for zero-files warning
 *   6. Run reviewer + security agents
 *   7. If rejected: run fixer, re-review (up to MAX_REJECTIONS)
 *   8. Optional build check
 *   9. Optional runtime tests
 *   10. Push to GitLab (branch + commit + MR)
 *
 * Advances state to "gate_code_review" via pushCodeToGitLab.
 */
export declare function stageGenerateCode(state: PipelineState): Promise<void>;
