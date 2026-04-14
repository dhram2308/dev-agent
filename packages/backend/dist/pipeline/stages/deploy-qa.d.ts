import { GitLabService } from '../../services/gitlab';
import { SlackService } from '../../services/slack';
import type { StageHandler } from '@shared/types';
interface DeployQaDeps {
    gl: GitLabService;
    slack: SlackService;
}
export declare function createDeployQaHandler(deps: DeployQaDeps): StageHandler;
export {};
