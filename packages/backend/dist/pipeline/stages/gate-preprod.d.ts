import { JiraService } from '../../services/jira';
import { SlackService } from '../../services/slack';
import type { PipelineState, StageHandler } from '@shared/types';
interface GatePreprodDeps {
    jira: JiraService;
    slack: SlackService;
}
/**
 * Wait for approval via Jira comments and/or Web UI.
 *
 * @param state - Pipeline state
 * @param deps - Jira + Slack service instances
 * @param sinceKey - Data key holding the ISO timestamp of when the request was posted
 * @param requiredCount - Number of approvals required
 * @param requiredIds - Jira account IDs that must approve (empty = anyone)
 * @param uiPrefix - UI gate prefix for checkUIApproval
 * @returns Approval result
 */
export declare function waitForApproval(state: PipelineState, deps: {
    jira: JiraService;
    slack: SlackService;
}, sinceKey: string, requiredCount?: number, requiredIds?: string[], uiPrefix?: string | null): Promise<{
    approved: boolean;
    by?: string[];
    feedback?: string;
}>;
export declare function createGatePreprodHandler(deps: GatePreprodDeps): StageHandler;
export {};
