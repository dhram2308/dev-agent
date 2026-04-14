import type { PipelineState } from '@shared/types';
/** Dependencies for environment setup */
export interface EnvSetupDeps {
    /** Whether browser verification is enabled */
    browserVerify: boolean;
    /** npm install timeout */
    buildInstallTimeout: number;
    /** Save state */
    save: (state: PipelineState) => void;
    /** Check if a dev server process is alive */
    isProcessAlive: (pid: number) => boolean;
}
/**
 * Phase 0: Ensure the local repo environment is ready for browser verification.
 *
 * @param state - Pipeline state
 * @param clonePath - Path to .repo-cache
 * @param deps - Injected dependencies
 * @returns true if environment is ready
 */
export declare function ensureEnvironment(state: PipelineState, clonePath: string, deps: EnvSetupDeps): Promise<boolean>;
/**
 * Write .env file for the enterprise app if missing or incomplete.
 */
export declare function writeEnvFile(clonePath: string): void;
/**
 * Verify node_modules health by checking .bin/nx exists.
 * If broken, run npm install.
 */
export declare function verifyNodeModules(clonePath: string, state: PipelineState, deps: EnvSetupDeps): Promise<boolean>;
/**
 * Ensure Playwright chromium browser is installed.
 */
export declare function ensurePlaywright(): Promise<boolean>;
