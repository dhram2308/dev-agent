import type { PipelineState, PendingQuestion } from '@mi/shared';
declare const DISCOVERY_CACHE_VERSION = 1;
declare function _computeDiscoveryCacheKey(state: any): string;
declare function _isCachedPlanStructurallyValid(plan: string | undefined | null): {
    ok: boolean;
    hardCount: number;
    warnCount: number;
};
declare function _tryRestoreFromDiscoveryCache(state: any, currentKey: string): boolean;
declare function _writeDiscoveryCache(state: any, key: string, analysisResult: string, architectOutput: string): void;
/**
 * Extract and validate the `---QUESTIONS---` JSON block from the Architect
 * agent's output. Returns a list of validated `PendingQuestion` entries.
 *
 * Graceful degradation: malformed JSON, missing required fields, and
 * out-of-bounds `recommend` indices are dropped with a warning. A missing
 * block simply returns `[]` — the pipeline proceeds as "no questions".
 *
 * Hard cap 10 entries; soft cap 3 (warning only).
 */
declare function parseQuestionsBlock(output: string): PendingQuestion[];
declare function stageExplorePlan(state: PipelineState): Promise<void>;
export { stageExplorePlan, parseQuestionsBlock, _computeDiscoveryCacheKey, _tryRestoreFromDiscoveryCache, _writeDiscoveryCache, _isCachedPlanStructurallyValid, DISCOVERY_CACHE_VERSION, };
//# sourceMappingURL=explore-plan.d.ts.map