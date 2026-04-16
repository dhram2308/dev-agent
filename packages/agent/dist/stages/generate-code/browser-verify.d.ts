import type { PipelineState } from '@mi/shared';
/**
 * Part 2: Browser-based verification of generated code.
 *
 * Launches Playwright, logs into the running dev server, navigates to feature routes,
 * collects evidence (accessibility tree, text, DOM, network, console), and runs
 * Gap Analysis Agent to evaluate against acceptance criteria.
 */
declare function runBrowserVerification(state: PipelineState, ctx: any): Promise<void>;
/**
 * Build MR description section for browser verification results.
 */
declare function buildBrowserVerifyMRSection(state: PipelineState): string;
export { runBrowserVerification, buildBrowserVerifyMRSection };
//# sourceMappingURL=browser-verify.d.ts.map