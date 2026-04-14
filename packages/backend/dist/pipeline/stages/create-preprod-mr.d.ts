import { GitLabService } from '../../services/gitlab';
import type { StageHandler } from '@shared/types';
interface CreatePreprodMrDeps {
    gl: GitLabService;
}
export declare function createCreatePreprodMrHandler(deps: CreatePreprodMrDeps): StageHandler;
export {};
