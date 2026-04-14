import { GitLabService } from '../../services/gitlab';
import { SlackService } from '../../services/slack';
import type { PipelineState, StageHandler } from '@shared/types';
interface GateCodeReviewDeps {
    gl: GitLabService;
    slack: SlackService;
}
export declare function incrementRejectionCounter(state: PipelineState, gate: string, maxRejections: number): boolean;
export declare function createGateCodeReviewHandler(deps: GateCodeReviewDeps): StageHandler;
export {};
