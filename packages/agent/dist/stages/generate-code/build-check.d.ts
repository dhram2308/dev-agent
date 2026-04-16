import type { PipelineState } from '@mi/shared';
/**
 * Q5: Build verification — tsc + eslint + Build Fixer Agent.
 */
declare function runBuildCheck(state: PipelineState, fileChanges: any[], originalFiles: Record<string, string>): Promise<any[]>;
export { runBuildCheck };
//# sourceMappingURL=build-check.d.ts.map