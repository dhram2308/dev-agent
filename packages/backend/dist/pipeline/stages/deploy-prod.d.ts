import { GitLabService } from '../../services/gitlab';
import { SlackService } from '../../services/slack';
import type { StageHandler } from '@shared/types';
interface DeployProdDeps {
    gl: GitLabService;
    slack: SlackService;
}
export declare function createDeployProdHandler(deps: DeployProdDeps): StageHandler;
export {};
