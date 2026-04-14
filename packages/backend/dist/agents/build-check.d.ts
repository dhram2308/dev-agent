import type { PipelineState } from '@shared/types';
/** A single file change */
export interface FileChange {
    action: string;
    file_path: string;
    content?: string;
}
/** Dependencies for the build check */
export interface BuildCheckDeps {
    cfg: {
        localRepo: string;
    };
    /** Timeout values */
    buildInstallTimeout: number;
    buildTscTimeout: number;
    buildEslintTimeout: number;
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
 * Q5: Build verification -- tsc + eslint + Build Fixer Agent.
 *
 * @param state - pipeline state
 * @param fileChanges - current file changes array
 * @param originalFiles - map of file_path -> original content (mutated in place)
 * @param deps - injected dependencies
 * @returns updated fileChanges after build fixer (if any)
 */
export declare function runBuildCheck(state: PipelineState, fileChanges: FileChange[], originalFiles: Record<string, string>, deps: BuildCheckDeps): Promise<FileChange[]>;
