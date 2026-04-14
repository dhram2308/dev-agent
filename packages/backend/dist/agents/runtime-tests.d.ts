import type { PipelineState } from '@shared/types';
/** A single file change */
export interface FileChange {
    action: string;
    file_path: string;
    content?: string;
}
/** Dependencies for runtime tests */
export interface RuntimeTestDeps {
    cfg: {
        localRepo: string;
        ticket: string;
    };
    /** Timeout values */
    developerTimeoutMs: number;
    testFixerTimeoutMs: number;
    buildInstallTimeout: number;
    unitTestsTimeout: number;
    e2eTestsTimeout: number;
    viteBuildTimeout: number;
    vitePreviewTimeout: number;
    maxUnitTestRetries: number;
    maxE2eTestRetries: number;
    consoleWarningThreshold: number;
    testArtifactsDir: string;
    playwrightBrowser: string;
    vitePreviewPortStart: number;
    vitePreviewPortEnd: number;
    /** Apply complexity timeout multiplier */
    applyComplexityTimeout: (baseMs: number, state: PipelineState) => number;
    /** Monotonic clock */
    monotonicMs: () => number;
    /** Whether runtime tests are enabled */
    runRuntimeTests: boolean;
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
 * Run the full Runtime Testing Pipeline.
 *
 * Phase 0: Environment Bootstrap
 * Phase 1: Vite Build Verification
 * Phase 2: Unit Tests (Jest with retry + fixer)
 * Phase 3: E2E Browser Smoke Tests (Playwright)
 *
 * @param state - pipeline state
 * @param fileChanges - current file changes
 * @param originalFiles - map of file_path -> original content (mutated in place)
 * @param deps - injected dependencies
 * @returns updated fileChanges after cleanup
 */
export declare function runRuntimeTests(state: PipelineState, fileChanges: FileChange[], originalFiles: Record<string, string>, deps: RuntimeTestDeps): Promise<FileChange[]>;
