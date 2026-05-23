import type { PipelineState } from '@mi/shared';
declare function parseTaskGroups(tasksMarkdown: string): Array<{
    title: string;
    content: string;
    files: string[];
}>;
declare const TASK_GROUP_FILES_WARN = 6;
declare const TASK_GROUP_FILES_HARD = 10;
declare function _auditTaskGroupSizes(groups: Array<{
    title: string;
    content: string;
    files: string[];
}>, state: any): void;
declare function _canRetryParallelTeam(taskGroups: Array<{
    title: string;
    content: string;
    files: string[];
}>, state: any): {
    canRetry: boolean;
    succeededCount: number;
    failedCount: number;
    reason?: string;
};
/**
 * Run Developer Agent — writes code directly to local repo.
 */
declare function runDeveloperAgent(ctx: any): Promise<void>;
/**
 * Shared validation for developer agent output (GQ7 + F3).
 */
declare function _validateDevChanges(state: PipelineState): void;
export { runDeveloperAgent, parseTaskGroups, _validateDevChanges, _auditTaskGroupSizes, TASK_GROUP_FILES_WARN, TASK_GROUP_FILES_HARD, _canRetryParallelTeam, };
//# sourceMappingURL=developer.d.ts.map