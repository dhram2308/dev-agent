import { JiraService } from '../../services/jira';
import { SlackService } from '../../services/slack';
import type { StageHandler } from '@shared/types';
interface DoneDeps {
    jira: JiraService;
    slack: SlackService;
}
export declare function createDoneHandler(deps: DoneDeps): StageHandler;
export {};
