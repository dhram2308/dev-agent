import type { PipelineState } from '@shared/types';
/** A single file change */
export interface FileChange {
    action: string;
    file_path: string;
    content?: string;
}
/** Code changes container */
export interface CodeChanges {
    changes: FileChange[];
    summary?: string;
    test_notes?: string;
}
/** Dependencies for AC verification */
export interface ACVerificationDeps {
    cfg: {
        localRepo: string;
        ticket: string;
    };
    /** Timeout values */
    reviewerTimeoutMs: number;
    developerTimeoutMs: number;
    /** Apply complexity timeout multiplier */
    applyComplexityTimeout: (baseMs: number, state: PipelineState) => number;
    /** Save pipeline state */
    save: (state: PipelineState) => void;
    /** Run a single agent */
    runSingleAgent: (opts: {
        name: string;
        prompt: string;
        timeout: number;
        opts: Record<string, unknown>;
        state: PipelineState;
        checkpointKey: string;
        required: boolean;
    }) => Promise<string | null>;
    /** Get local repo changes */
    localGetChanges: (repoPath: string) => FileChange[];
    /** Get original file content from git */
    localGetOriginal: (repoPath: string, filePath: string) => string | null;
}
/**
 * Q6: AC Verification Agent -- compares code changes against acceptance criteria.
 *
 * @param state - pipeline state
 * @param fileChanges - current file changes
 * @param originalFiles - map of file_path -> original content (mutated in place)
 * @param changes - the changes object (changes.changes will be updated)
 * @param deps - injected dependencies
 * @returns updated fileChanges after any AC fix retries
 */
export declare function runACVerification(state: PipelineState, fileChanges: FileChange[], originalFiles: Record<string, string>, changes: CodeChanges, deps: ACVerificationDeps): Promise<FileChange[]>;
