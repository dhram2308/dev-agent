import type { PipelineState } from '@mi/shared';
/**
 * Phase 0: Ensure the local repo environment is ready for browser verification.
 * - Write .env file for enterprise app
 * - Verify/fix node_modules health
 * - Install Playwright chromium if needed
 */
declare function ensureEnvironment(state: PipelineState, clonePath: string): Promise<boolean>;
/**
 * Write .env file for the enterprise app if missing or incomplete.
 */
declare function writeEnvFile(clonePath: string): void;
/**
 * Verify node_modules health by checking .bin/nx exists.
 * If broken, run npm install.
 */
declare function verifyNodeModules(clonePath: string, state: PipelineState): Promise<boolean>;
/**
 * Ensure Playwright chromium browser is installed.
 */
declare function ensurePlaywright(): Promise<boolean>;
export { ensureEnvironment, writeEnvFile, verifyNodeModules, ensurePlaywright };
//# sourceMappingURL=env-setup.d.ts.map