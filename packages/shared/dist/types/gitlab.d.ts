/** GitLab user (assignee, author, approver, etc.) */
export interface GitLabUser {
    /** User ID */
    id: number;
    /** Username (login handle) */
    username: string;
    /** Display name */
    name: string;
    /** Current state ("active", "blocked", etc.) */
    state?: string;
    /** Avatar URL */
    avatar_url?: string;
    /** Profile web URL */
    web_url?: string;
    [key: string]: unknown;
}
/** GitLab project metadata */
export interface GitLabProject {
    /** Project ID */
    id: number;
    /** Project name */
    name: string;
    /** Full path with namespace (e.g., "group/project") */
    path_with_namespace: string;
    /** Web URL for the project */
    web_url: string;
    /** Default branch name */
    default_branch?: string;
    /** Project description */
    description?: string;
    /** SSH URL for cloning */
    ssh_url_to_repo?: string;
    /** HTTPS URL for cloning */
    http_url_to_repo?: string;
    [key: string]: unknown;
}
/** GitLab branch metadata returned by GET /repository/branches/{name} */
export interface GitLabBranch {
    /** Branch name */
    name: string;
    /** Whether this branch is merged into the default branch */
    merged?: boolean;
    /** Whether this branch is protected */
    protected?: boolean;
    /** Whether developers can push to this branch */
    developers_can_push?: boolean;
    /** Whether developers can merge to this branch */
    developers_can_merge?: boolean;
    /** The latest commit on this branch */
    commit?: GitLabCommit;
    /** Web URL */
    web_url?: string;
    [key: string]: unknown;
}
/**
 * GitLab commit action for the Commits API (POST /repository/commits).
 * Used by gl.commit() in lib/gitlab.js.
 */
export interface GitLabCommitAction {
    /** Action type */
    action: 'create' | 'delete' | 'move' | 'update' | 'chmod';
    /** File path relative to repository root */
    file_path: string;
    /** File content (required for create/update) */
    content?: string;
    /** Previous path (required for move action) */
    previous_path?: string;
    /** File encoding ("text" or "base64") */
    encoding?: 'text' | 'base64';
    /** Last known file commit ID (for optimistic locking on update) */
    last_commit_id?: string;
    /** Whether to execute file mode change */
    execute_filemode?: boolean;
    [key: string]: unknown;
}
/** GitLab commit metadata */
export interface GitLabCommit {
    /** Commit SHA */
    id: string;
    /** Short SHA */
    short_id: string;
    /** Commit title (first line of message) */
    title: string;
    /** Full commit message */
    message: string;
    /** Author name */
    author_name: string;
    /** Author email */
    author_email: string;
    /** Authored date (ISO 8601) */
    authored_date?: string;
    /** Committer name */
    committer_name?: string;
    /** Committer email */
    committer_email?: string;
    /** Committed date (ISO 8601) */
    committed_date?: string;
    /** Created at (ISO 8601) */
    created_at?: string;
    /** Parent commit SHAs */
    parent_ids?: readonly string[];
    /** Web URL for this commit */
    web_url?: string;
    [key: string]: unknown;
}
/** GitLab diff for a single file in an MR or commit */
export interface GitLabDiff {
    /** Old file path (before rename) */
    old_path: string;
    /** New file path */
    new_path: string;
    /** "a" mode (e.g., "100644") */
    a_mode?: string;
    /** "b" mode */
    b_mode?: string;
    /** Whether this is a new file */
    new_file: boolean;
    /** Whether this file was renamed */
    renamed_file: boolean;
    /** Whether this file was deleted */
    deleted_file: boolean;
    /** Unified diff content */
    diff: string;
    [key: string]: unknown;
}
/** GitLab repository tree item returned by GET /repository/tree */
export interface GitLabTreeItem {
    /** Item ID (blob/tree SHA) */
    id: string;
    /** Item name (filename or directory name) */
    name: string;
    /** "tree" for directories, "blob" for files */
    type: 'tree' | 'blob';
    /** Full path relative to repository root */
    path: string;
    /** File mode (e.g., "040000" for dirs, "100644" for files) */
    mode: string;
    [key: string]: unknown;
}
/** GitLab file metadata returned by GET /repository/files/{path} */
export interface GitLabFile {
    /** Filename */
    file_name: string;
    /** Full file path */
    file_path: string;
    /** File size in bytes */
    size: number;
    /** Content encoding ("base64") */
    encoding: string;
    /** Base64-encoded file content */
    content: string;
    /** Content SHA256 */
    content_sha256: string;
    /** Git ref (branch/tag/commit) */
    ref: string;
    /** Blob ID */
    blob_id: string;
    /** Last commit ID that modified this file */
    commit_id: string;
    /** Last commit that modified this file */
    last_commit_id: string;
    [key: string]: unknown;
}
/**
 * GitLab merge request returned by MR API endpoints.
 * Used by gl.createMR(), gl.getMR(), gl.mergeMR() in lib/gitlab.js.
 */
export interface GitLabMergeRequest {
    /** MR internal ID */
    id: number;
    /** MR IID (project-scoped numeric identifier, e.g., !42) */
    iid: number;
    /** MR title */
    title: string;
    /** MR description (markdown) */
    description: string | null;
    /** Current state: "opened", "closed", "merged", "locked" */
    state: 'opened' | 'closed' | 'merged' | 'locked';
    /** Source branch name */
    source_branch: string;
    /** Target branch name */
    target_branch: string;
    /** Author of the MR */
    author?: GitLabUser;
    /** Assignee */
    assignee?: GitLabUser | null;
    /** All assignees */
    assignees?: readonly GitLabUser[];
    /** Reviewers */
    reviewers?: readonly GitLabUser[];
    /** Merge status: "can_be_merged", "cannot_be_merged", "checking", etc. */
    merge_status?: string;
    /** Detailed merge status (newer GitLab versions) */
    detailed_merge_status?: string;
    /** Whether the MR is a draft/WIP */
    draft?: boolean;
    /** Whether the MR is a WIP (legacy) */
    work_in_progress?: boolean;
    /** Whether source branch should be removed after merge */
    should_remove_source_branch?: boolean;
    /** Web URL for the MR */
    web_url: string;
    /** Creation timestamp (ISO 8601) */
    created_at?: string;
    /** Last update timestamp (ISO 8601) */
    updated_at?: string;
    /** Merge timestamp (ISO 8601, null if not merged) */
    merged_at?: string;
    /** Closed timestamp (ISO 8601, null if not closed) */
    closed_at?: string;
    /** SHA of the head commit of source branch */
    sha?: string;
    /** Merge commit SHA (after merge) */
    merge_commit_sha?: string | null;
    /** Squash commit SHA (after squash merge) */
    squash_commit_sha?: string | null;
    /** Head pipeline */
    head_pipeline?: GitLabPipeline | null;
    /** Labels */
    labels?: readonly string[];
    /** Whether there are merge conflicts */
    has_conflicts?: boolean;
    [key: string]: unknown;
}
/** GitLab MR note (comment) returned by GET /merge_requests/{iid}/notes */
export interface GitLabNote {
    /** Note ID */
    id: number;
    /** Note body (markdown) */
    body: string;
    /** Author */
    author: GitLabUser;
    /** Creation timestamp (ISO 8601) */
    created_at: string;
    /** Last update timestamp (ISO 8601) */
    updated_at?: string;
    /** Whether this is a system-generated note */
    system: boolean;
    /** Whether this note is resolvable (e.g., discussion thread) */
    resolvable?: boolean;
    /** Whether this note has been resolved */
    resolved?: boolean;
    /** Resolved by user */
    resolved_by?: GitLabUser | null;
    /** Note type ("DiffNote", "DiscussionNote", null for regular notes) */
    type?: string | null;
    /** Position information for diff notes */
    position?: {
        old_path?: string;
        new_path?: string;
        old_line?: number | null;
        new_line?: number | null;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
/** GitLab CI/CD pipeline returned by pipeline API endpoints */
export interface GitLabPipeline {
    /** Pipeline ID */
    id: number;
    /** Pipeline status: "running", "pending", "success", "failed", "canceled", "skipped", "manual" */
    status: 'running' | 'pending' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual' | 'created';
    /** Git ref (branch/tag) this pipeline ran on */
    ref: string;
    /** Commit SHA */
    sha?: string;
    /** Web URL for the pipeline */
    web_url?: string;
    /** Creation timestamp (ISO 8601) */
    created_at?: string;
    /** Last update timestamp (ISO 8601) */
    updated_at?: string;
    /** Pipeline source (e.g., "push", "web", "api") */
    source?: string;
    [key: string]: unknown;
}
/**
 * GitLab MR approvals returned by GET /merge_requests/{iid}/approvals.
 * Used by gl.getMRApprovals() in lib/gitlab.js.
 */
export interface GitLabMRApprovals {
    /** Whether the MR is approved */
    approved: boolean;
    /** Number of approvals required */
    approvals_required?: number;
    /** Number of approvals given */
    approvals_left?: number;
    /** List of users who approved */
    approved_by: ReadonlyArray<{
        user: GitLabUser;
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
}
//# sourceMappingURL=gitlab.d.ts.map