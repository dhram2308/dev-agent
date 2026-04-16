import type { PipelineState } from '@mi/shared';
declare function classifyChanges(changes: any[]): string;
declare function findFreePort(start: number, end: number): Promise<number | null>;
/**
 * Run the full Runtime Testing Pipeline: Phase 0 -> 1 -> 2 -> 3 -> cleanup.
 */
declare function runRuntimeTests(state: PipelineState, fileChanges: any[], originalFiles: Record<string, string>): Promise<any[]>;
export { runRuntimeTests, classifyChanges, findFreePort };
//# sourceMappingURL=runtime-tests.d.ts.map