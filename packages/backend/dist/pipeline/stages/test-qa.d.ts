import { JiraService } from '../../services/jira';
import { SlackService } from '../../services/slack';
import type { StageHandler } from '@shared/types';
interface TestQaDeps {
    jira: JiraService;
    slack: SlackService;
}
export declare function createTestQaHandler(deps: TestQaDeps): StageHandler;
export {};
