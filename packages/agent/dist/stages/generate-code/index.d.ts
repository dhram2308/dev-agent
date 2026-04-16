import type { PipelineState } from '@mi/shared';
/**
 * Stage: Generate Code with Claude AI.
 * Orchestrates: Developer → Reviewer+Security → Fixer → Build Check → Runtime Tests → AC Verification → Push.
 */
declare function stageGenerateCode(state: PipelineState): Promise<void>;
export { stageGenerateCode };
//# sourceMappingURL=index.d.ts.map