import type { PipelineState } from '@mi/shared';
declare function incrementRejectionCounter(state: PipelineState, gate: string): boolean;
declare function stageGateCodeReview(state: PipelineState): Promise<void>;
export { stageGateCodeReview, incrementRejectionCounter };
//# sourceMappingURL=gate-code-review.d.ts.map