import type { PipelineState } from '@mi/shared';
/**
 * Q6: AC Verification Agent — compares code changes against acceptance criteria.
 */
declare function runACVerification(state: PipelineState, fileChanges: any[], originalFiles: Record<string, string>, changes: any): Promise<any[]>;
export { runACVerification };
//# sourceMappingURL=ac-verification.d.ts.map