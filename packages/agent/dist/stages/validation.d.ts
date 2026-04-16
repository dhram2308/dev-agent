import type { PipelineState } from '@mi/shared';
declare function validateStageEntry(state: PipelineState): void;
declare function validateCompletedGates(state: PipelineState): void;
declare function clearDownstreamData(state: PipelineState, targetStage: string): void;
export { validateStageEntry, validateCompletedGates, clearDownstreamData };
//# sourceMappingURL=validation.d.ts.map