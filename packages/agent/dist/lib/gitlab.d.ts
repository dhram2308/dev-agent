/**
 * gitlab.ts -- GitLab API client
 *
 * Converted from lib/gitlab.js (zero functional changes).
 * Uses shared types from @mi/shared for GitLab API shapes.
 */
import type { GitLabBranch, GitLabCommit, GitLabCommitAction, GitLabMergeRequest, GitLabMRApprovals, GitLabNote, GitLabPipeline, GitLabTreeItem } from '@mi/shared';
interface GitLabHeaders {
    'PRIVATE-TOKEN'?: string;
    Authorization?: string;
    'Content-Type': string;
}
interface GitLabApi {
    h(): GitLabHeaders;
    u(p: string): string;
    getFile(filePath: string, ref?: string): Promise<string | null>;
    getTree(dir?: string, ref?: string, recursive?: boolean): Promise<GitLabTreeItem[]>;
    searchCode(query: string, ref?: string): Promise<any[]>;
    getBranch(name: string): Promise<GitLabBranch | null>;
    deleteBranch(name: string): Promise<boolean>;
    createBranch(name: string, ref: string): Promise<GitLabBranch>;
    commit(branch: string, message: string, actions: GitLabCommitAction[], authorName?: string, authorEmail?: string): Promise<GitLabCommit>;
    createMR(source: string, target: string, title: string, desc: string, removeSource?: boolean, assigneeId?: string | number | null): Promise<GitLabMergeRequest>;
    getMR(iid: number): Promise<GitLabMergeRequest>;
    getMRApprovals(iid: number): Promise<GitLabMRApprovals>;
    getMRNotes(iid: number, since?: string): Promise<GitLabNote[]>;
    mergeMR(iid: number): Promise<GitLabMergeRequest>;
    waitPipeline(ref: string): Promise<GitLabPipeline>;
}
export declare const gl: GitLabApi;
export {};
//# sourceMappingURL=gitlab.d.ts.map