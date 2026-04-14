import type { PipelineState } from '@shared/types';
/** A single file change in the changeset */
export interface FileChange {
    action: 'create' | 'update' | 'delete';
    file_path: string;
    content?: string;
}
/** Code changes object */
export interface CodeChanges {
    changes: FileChange[];
    summary?: string;
    test_notes?: string;
}
/** Dependencies injected into push-code */
export interface PushCodeDeps {
    cfg: {
        ticket: string;
        branch: {
            ts: string;
            qa: string;
        };
        git: {
            authorName: string;
            authorEmail: string;
            assigneeId: number;
        };
        slack: {
            ownerId: string;
        };
        localRepo?: string;
        flags?: {
            runRuntimeTests?: boolean;
            browserVerify?: boolean;
        };
    };
    /** Maximum commit file size in bytes */
    maxCommitFileSize: number;
    /** GitLab service */
    gl: {
        createBranch: (branch: string, ref: string) => Promise<void>;
        getBranch: (branch: string) => Promise<unknown>;
        deleteBranch: (branch: string) => Promise<void>;
        commit: (branch: string, message: string, actions: Array<{
            action: string;
            file_path: string;
            content?: string;
        }>, authorName: string, authorEmail: string) => Promise<{
            id?: string;
        }>;
        createMR: (source: string, target: string, title: string, description: string, removeSource: boolean, assigneeId: number) => Promise<{
            iid: number;
            web_url: string;
        }>;
        u: (path: string) => string;
        h: () => Record<string, string>;
    };
    /** HTTP request function */
    req: (url: string, opts: {
        headers: Record<string, string>;
    }) => Promise<{
        status: number;
        data?: Record<string, unknown>;
    }>;
    /** Slack notification */
    slack: (message: string, mentions?: string[]) => Promise<void>;
    /** Save pipeline state */
    save: (state: PipelineState) => void;
    /** Validate MR target branch */
    validateMRTarget: (branch: string) => void;
    /** Redact secrets from text */
    redactSecrets: (text: string) => string;
    /** Browser verify MR section builder (optional) */
    buildBrowserVerifyMRSection?: (state: PipelineState) => string;
}
/**
 * Push code changes to GitLab: branch creation, commit, MR creation.
 */
export declare function pushCodeToGitLab(state: PipelineState, changes: CodeChanges, deps: PushCodeDeps): Promise<void>;
