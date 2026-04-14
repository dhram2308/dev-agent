import { JiraService } from '../../services/jira';
import { SlackService } from '../../services/slack';
import type { StageHandler } from '@shared/types';
interface GateDualDeps {
    jira: JiraService;
    slack: SlackService;
}
export declare function createGateDualHandler(deps: GateDualDeps): StageHandler;
export {};
