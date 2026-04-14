import type { AppConfig } from '@shared/types';
/** GitLab file retrieved from the repository */
export interface GitLabFile {
    file_name: string;
    file_path: string;
    size: number;
    encoding: string;
    content_sha256: string;
    ref: string;
    blob_id: string;
    commit_id: string;
    last_commit_id: string;
    content: string;
}
/** GitLab repository tree item */
export interface GitLabTreeItem {
    id: string;
    name: string;
    type: 'blob' | 'tree';
    path: string;
    mode: string;
}
/** GitLab branch */
export interface GitLabBranch {
    name: string;
    merged: boolean;
    protected: boolean;
    default: boolean;
    developers_can_push: boolean;
    developers_can_merge: boolean;
    can_push: boolean;
    web_url: string;
    commit: {
        id: string;
        short_id: string;
        title: string;
        message: string;
        author_name: string;
        author_email: string;
        authored_date: string;
        committed_date: string;
        committer_name: string;
        committer_email: string;
        parent_ids: string[];
        web_url: string;
    };
}
/** Options for creating a merge request */
export interface CreateMROptions {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string;
    removeSourceBranch?: boolean;
    assigneeId?: number | null;
}
/** GitLab merge request */
export interface GitLabMR {
    id: number;
    iid: number;
    title: string;
    description: string;
    state: 'opened' | 'closed' | 'merged' | 'locked';
    merged_by: {
        name: string;
        username: string;
    } | null;
    merged_at: string | null;
    created_at: string;
    updated_at: string;
    source_branch: string;
    target_branch: string;
    web_url: string;
    merge_status: string;
    detailed_merge_status?: string;
    work_in_progress: boolean;
    draft: boolean;
    sha: string;
    merge_commit_sha: string | null;
    diff_refs: {
        base_sha: string;
        head_sha: string;
        start_sha: string;
    } | null;
    has_conflicts: boolean;
    changes_count: string | null;
    assignee: {
        id: number;
        name: string;
        username: string;
    } | null;
    [key: string]: unknown;
}
/** GitLab merge request approvals */
export interface GitLabApprovals {
    approved: boolean;
    approved_by: Array<{
        user: {
            id: number;
            name: string;
            username: string;
        };
    }>;
    approvals_required: number;
    approvals_left: number;
    [key: string]: unknown;
}
/** GitLab merge request note (comment) */
export interface GitLabNote {
    id: number;
    body: string;
    author: {
        id: number;
        name: string;
        username: string;
    };
    created_at: string;
    updated_at: string;
    system: boolean;
    noteable_type: string;
    resolvable: boolean;
    resolved?: boolean;
    [key: string]: unknown;
}
/** GitLab pipeline */
export interface GitLabPipeline {
    id: number;
    iid: number;
    status: 'created' | 'waiting_for_resource' | 'preparing' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual' | 'scheduled';
    ref: string;
    sha: string;
    web_url: string;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}
/** GitLab diff entry for a commit or MR */
export interface GitLabDiff {
    old_path: string;
    new_path: string;
    a_mode: string;
    b_mode: string;
    diff: string;
    new_file: boolean;
    renamed_file: boolean;
    deleted_file: boolean;
}
/** GitLab branch comparison result */
export interface GitLabCompare {
    commit: {
        id: string;
        short_id: string;
        title: string;
        message: string;
        author_name: string;
        author_email: string;
    } | null;
    commits: Array<{
        id: string;
        short_id: string;
        title: string;
        message: string;
        author_name: string;
        author_email: string;
        created_at: string;
    }>;
    diffs: GitLabDiff[];
    compare_timeout: boolean;
    compare_same_ref: boolean;
}
/** GitLab commit action for the Commits API */
export interface GitLabCommitAction {
    action: 'create' | 'delete' | 'move' | 'update' | 'chmod';
    file_path: string;
    content?: string;
    previous_path?: string;
    encoding?: 'text' | 'base64';
    last_commit_id?: string;
    execute_filemode?: boolean;
}
/** GitLab commit result */
export interface GitLabCommit {
    id: string;
    short_id: string;
    title: string;
    message: string;
    author_name: string;
    author_email: string;
    authored_date: string;
    committed_date: string;
    web_url: string;
    parent_ids: string[];
}
/** GitLab code search result */
export interface GitLabSearchResult {
    basename: string;
    data: string;
    path: string;
    filename: string;
    id: string | null;
    ref: string;
    startline: number;
    project_id: number;
}
export declare class GitLabService {
    private readonly baseUrl;
    private readonly token;
    private readonly projectId;
    private readonly sourceBranch;
    private readonly qaBranch;
    private readonly ciPoll;
    private readonly ciTimeout;
    constructor(config?: AppConfig);
    /** Build standard GitLab API headers */
    private headers;
    /** Build project-scoped API URL */
    private url;
    /**
     * Get a file from the repository.
     * GET /projects/{id}/repository/files/{path}
     *
     * Returns decoded file content as a string, or null if not found.
     *
     * @param filePath - File path relative to repo root
     * @param ref - Branch or commit ref (defaults to QA branch)
     */
    getFile(filePath: string, ref?: string): Promise<string | null>;
    /**
     * Get the raw GitLabFile metadata (without decoding content).
     * Useful when you need the commit ID or SHA.
     */
    getFileRaw(filePath: string, ref?: string): Promise<GitLabFile | null>;
    /**
     * Get repository tree (directory listing).
     * GET /projects/{id}/repository/tree
     *
     * Paginates automatically up to MAX_TREE_ITEMS.
     *
     * @param dir - Directory path (empty string for root)
     * @param ref - Branch or commit ref (defaults to source branch)
     * @param recursive - Whether to recurse into subdirectories
     */
    getTree(dir?: string, ref?: string, recursive?: boolean): Promise<GitLabTreeItem[]>;
    /**
     * Search code in the repository.
     * GET /projects/{id}/search?scope=blobs
     *
     * @param query - Search query string
     * @param ref - Branch or commit ref (defaults to QA branch)
     */
    searchCode(query: string, ref?: string): Promise<GitLabSearchResult[]>;
    /**
     * Get a branch by name.
     * GET /projects/{id}/repository/branches/{name}
     *
     * Returns null if the branch does not exist.
     */
    getBranch(name: string): Promise<GitLabBranch | null>;
    /**
     * Create a new branch.
     * POST /projects/{id}/repository/branches
     *
     * If the branch already exists (400/409), attempts to find and return
     * the existing branch (idempotent create).
     *
     * @param name - New branch name
     * @param ref - Source branch or commit to branch from
     */
    createBranch(name: string, ref: string): Promise<GitLabBranch>;
    /**
     * Delete a branch.
     * DELETE /projects/{id}/repository/branches/{name}
     *
     * Returns true if deleted, false if already gone (404).
     */
    deleteBranch(name: string): Promise<boolean>;
    /**
     * Create a commit with file actions.
     * POST /projects/{id}/repository/commits
     *
     * @param branch - Target branch
     * @param message - Commit message
     * @param actions - Array of file actions (create, update, delete, etc.)
     * @param authorName - Optional commit author name
     * @param authorEmail - Optional commit author email
     */
    commit(branch: string, message: string, actions: GitLabCommitAction[], authorName?: string, authorEmail?: string): Promise<GitLabCommit>;
    /**
     * Get diffs for a specific commit.
     * GET /projects/{id}/repository/commits/{sha}/diff
     */
    getCommitDiffs(sha: string): Promise<GitLabDiff[]>;
    /**
     * Compare two branches or commits.
     * GET /projects/{id}/repository/compare
     *
     * @param from - Source branch/commit
     * @param to - Target branch/commit
     */
    compareBranches(from: string, to: string): Promise<GitLabCompare>;
    /**
     * Create a merge request.
     * POST /projects/{id}/merge_requests
     *
     * Handles MR-already-exists (409/400) by finding and returning the
     * existing MR (idempotent create).
     */
    createMR(opts: CreateMROptions): Promise<GitLabMR>;
    /**
     * Get a merge request by IID.
     * GET /projects/{id}/merge_requests/{iid}
     */
    getMR(iid: number): Promise<GitLabMR>;
    /**
     * Merge a merge request.
     * PUT /projects/{id}/merge_requests/{iid}/merge
     *
     * Retries up to 10 times if the merge status is "checking",
     * and handles already-merged and unmergeable states.
     */
    mergeMR(iid: number): Promise<GitLabMR>;
    /**
     * Get merge request approvals.
     * GET /projects/{id}/merge_requests/{iid}/approvals
     *
     * Returns a default "not approved" object if the API call fails.
     */
    getMRApprovals(iid: number): Promise<GitLabApprovals>;
    /**
     * Get merge request notes (comments).
     * GET /projects/{id}/merge_requests/{iid}/notes
     *
     * Paginates automatically up to 500 notes.
     *
     * @param iid - Merge request IID
     * @param since - Optional ISO date string; only return notes created after this time
     */
    getMRNotes(iid: number, since?: string): Promise<GitLabNote[]>;
    /**
     * Add a note (comment) to a merge request.
     * POST /projects/{id}/merge_requests/{iid}/notes
     */
    addMRNote(iid: number, body: string): Promise<void>;
    /**
     * Trigger a pipeline on a ref (branch or tag).
     * POST /projects/{id}/pipeline
     */
    triggerPipeline(ref: string): Promise<GitLabPipeline>;
    /**
     * Wait for a CI pipeline to complete on a ref.
     *
     * Polls the GitLab pipelines API at the configured interval until:
     * - Pipeline succeeds or is skipped (returns pipeline)
     * - Pipeline fails or is canceled (throws)
     * - Timeout is reached (throws)
     * - No pipeline found after 3 polls (throws)
     *
     * @param ref - Branch or tag to monitor
     */
    waitPipeline(ref: string): Promise<GitLabPipeline>;
}
/** Create a new GitLabService instance with optional config override. */
export declare function createGitLabService(config?: AppConfig): GitLabService;
