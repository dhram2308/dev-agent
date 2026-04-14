import type { PipelineState } from '@shared/types';
/** File change in JSON format */
export interface LegacyFileChange {
    action: 'create' | 'update' | 'delete';
    file_path: string;
    content: string;
}
/** Legacy changes object */
export interface LegacyChanges {
    changes: LegacyFileChange[];
    summary?: string;
    test_notes?: string;
}
/** Context for legacy codegen */
export interface LegacyCodegenContext {
    state: PipelineState;
    approvedPlan: string;
    devFullContext: string;
    extraDocs: string;
    extraFeedback: string;
    feedback: string;
}
/** Dependencies for legacy codegen */
export interface LegacyCodegenDeps {
    cfg: {
        ticket: string;
        branch: {
            ts: string;
            qa: string;
        };
        git: {
            authorName: string;
            authorEmail: string;
            assigneeId: number;
        };
        slack: {
            ownerId: string;
        };
    };
    /** Timeout values */
    developerTimeoutMs: number;
    reviewerTimeoutMs: number;
    /** Apply complexity timeout */
    applyComplexityTimeout: (baseMs: number, state: PipelineState) => number;
    /** Call Claude (direct API) */
    callClaude: (prompt: string, timeoutMs: number) => Promise<string>;
    /** Fetch repo context (tree + files) */
    fetchRepoContext: (ticket: string, summary: string, description: string, ac: string, feedback: string, state: PipelineState) => Promise<{
        treeStr: string;
        fileContext: string;
    }>;
    /** GitLab service (for fetching originals) */
    gl: {
        getFile: (filePath: string, branch: string) => Promise<string | null>;
    };
    /** Save state */
    save: (state: PipelineState) => void;
    /** Push code to GitLab */
    pushCodeToGitLab: (state: PipelineState, changes: LegacyChanges) => Promise<void>;
}
/**
 * Legacy JSON-based code generation (GitLab API only, no local repo).
 */
export declare function legacyJsonCodegen(ctx: LegacyCodegenContext, deps: LegacyCodegenDeps): Promise<void>;
