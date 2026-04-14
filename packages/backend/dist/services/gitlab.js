"use strict";
// =====================================================================
// MI Dev Agent -- GitLab Service (TypeScript port of lib/gitlab.js)
// =====================================================================
//
// Fully typed GitLab API client. All methods use the typed HTTP client
// and return properly typed responses.
//
// Auth: PRIVATE-TOKEN header.
// Base URL: from AppConfig.gitlab.base (e.g., http://10.200.11.32)
// URL encoding: file paths are URI-encoded for the GitLab API.
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitLabService = void 0;
exports.createGitLabService = createGitLabService;
const client_1 = require("../http/client");
const loader_1 = require("../config/loader");
const logger_1 = require("../lib/logger");
// =====================================================================
// GitLab Service Class
// =====================================================================
class GitLabService {
    baseUrl;
    token;
    projectId;
    sourceBranch;
    qaBranch;
    ciPoll;
    ciTimeout;
    constructor(config) {
        const cfg = config || (0, loader_1.loadConfig)();
        this.baseUrl = cfg.gitlab.base;
        this.token = cfg.gitlab.token;
        this.projectId = cfg.gitlab.projectId;
        this.sourceBranch = cfg.branches.source;
        this.qaBranch = cfg.branches.qa;
        const ext = (0, loader_1.loadExtendedConfig)();
        this.ciPoll = ext.ciPoll;
        this.ciTimeout = ext.ciTimeout;
    }
    /** Build standard GitLab API headers */
    headers() {
        return {
            'PRIVATE-TOKEN': this.token,
            'Content-Type': 'application/json',
        };
    }
    /** Build project-scoped API URL */
    url(path) {
        return `${this.baseUrl}/api/v4/projects/${this.projectId}${path}`;
    }
    // ── File Operations ───────────────────────────────────────────────
    /**
     * Get a file from the repository.
     * GET /projects/{id}/repository/files/{path}
     *
     * Returns decoded file content as a string, or null if not found.
     *
     * @param filePath - File path relative to repo root
     * @param ref - Branch or commit ref (defaults to QA branch)
     */
    async getFile(filePath, ref) {
        const branch = ref || this.qaBranch;
        const encodedPath = encodeURIComponent(filePath);
        const r = await (0, client_1.req)(this.url(`/repository/files/${encodedPath}?ref=${branch}`), { headers: this.headers() });
        if (r.status !== 200)
            return null;
        return Buffer.from(r.data.content, 'base64').toString('utf8');
    }
    /**
     * Get the raw GitLabFile metadata (without decoding content).
     * Useful when you need the commit ID or SHA.
     */
    async getFileRaw(filePath, ref) {
        const branch = ref || this.qaBranch;
        const encodedPath = encodeURIComponent(filePath);
        const r = await (0, client_1.req)(this.url(`/repository/files/${encodedPath}?ref=${branch}`), { headers: this.headers() });
        if (r.status !== 200)
            return null;
        return r.data;
    }
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
    async getTree(dir = '', ref, recursive = false) {
        const branch = ref || this.sourceBranch;
        const MAX_TREE_ITEMS = 10_000;
        const baseParams = `path=${encodeURIComponent(dir)}&ref=${branch}&per_page=100` +
            (recursive ? '&recursive=true' : '');
        let all = [];
        let page = 1;
        while (true) {
            const r = await (0, client_1.req)(this.url(`/repository/tree?${baseParams}&page=${page}`), { headers: this.headers() });
            if (r.status !== 200) {
                (0, logger_1.logWarn)(`getTree(): Page ${page} returned status ${r.status} -- ` +
                    `tree may be incomplete (${all.length} items so far)`);
                break;
            }
            if (!Array.isArray(r.data) || r.data.length === 0)
                break;
            all = all.concat(r.data);
            if (all.length >= MAX_TREE_ITEMS) {
                (0, logger_1.logWarn)(`getTree(): Hit ${MAX_TREE_ITEMS} item cap -- results may be truncated`);
                break;
            }
            const nextPage = parseInt(r.headers['x-next-page'] || '', 10);
            if (!nextPage || nextPage <= page)
                break;
            page = nextPage;
        }
        return all;
    }
    /**
     * Search code in the repository.
     * GET /projects/{id}/search?scope=blobs
     *
     * @param query - Search query string
     * @param ref - Branch or commit ref (defaults to QA branch)
     */
    async searchCode(query, ref) {
        const branch = ref || this.qaBranch;
        const r = await (0, client_1.req)(this.url(`/search?scope=blobs&search=${encodeURIComponent(query)}&ref=${branch}&per_page=20`), { headers: this.headers() });
        return r.status === 200 ? r.data : [];
    }
    // ── Branch Operations ─────────────────────────────────────────────
    /**
     * Get a branch by name.
     * GET /projects/{id}/repository/branches/{name}
     *
     * Returns null if the branch does not exist.
     */
    async getBranch(name) {
        const r = await (0, client_1.req)(this.url(`/repository/branches/${encodeURIComponent(name)}`), { headers: this.headers() });
        if (r.status === 404)
            return null;
        if (r.status !== 200) {
            throw new Error(`GL getBranch: ${r.status} ${JSON.stringify(r.data)}`);
        }
        return r.data;
    }
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
    async createBranch(name, ref) {
        const r = await (0, client_1.req)(this.url('/repository/branches'), {
            method: 'POST',
            headers: this.headers(),
            body: { branch: name, ref },
        });
        if (r.status === 201)
            return r.data;
        if (r.status === 400) {
            // Branch may already exist -- verify it
            const existing = await this.getBranch(name);
            if (existing) {
                (0, logger_1.logInfo)(`Branch "${name}" already exists -- reusing`);
                return existing;
            }
            throw new Error(`GL createBranch: ${r.status} ${JSON.stringify(r.data)} -- branch not found after 400`);
        }
        throw new Error(`GL createBranch: ${r.status} ${JSON.stringify(r.data)}`);
    }
    /**
     * Delete a branch.
     * DELETE /projects/{id}/repository/branches/{name}
     *
     * Returns true if deleted, false if already gone (404).
     */
    async deleteBranch(name) {
        const r = await (0, client_1.req)(this.url(`/repository/branches/${encodeURIComponent(name)}`), { method: 'DELETE', headers: this.headers() });
        if (r.status !== 204 && r.status !== 404) {
            throw new Error(`GL deleteBranch: ${r.status} ${JSON.stringify(r.data)}`);
        }
        return r.status === 204;
    }
    // ── Commit Operations ─────────────────────────────────────────────
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
    async commit(branch, message, actions, authorName, authorEmail) {
        const body = {
            branch,
            commit_message: message,
            actions,
        };
        if (authorName)
            body.author_name = authorName;
        if (authorEmail)
            body.author_email = authorEmail;
        const r = await (0, client_1.req)(this.url('/repository/commits'), {
            method: 'POST',
            headers: this.headers(),
            body,
        });
        if (r.status !== 201) {
            const errMsg = typeof r.data === 'object'
                ? (r.data.message || JSON.stringify(r.data))
                : String(r.data);
            const err = new Error(`GL commit: ${r.status} ${errMsg}`);
            err.statusCode = r.status;
            err.responseData = r.data;
            throw err;
        }
        return r.data;
    }
    /**
     * Get diffs for a specific commit.
     * GET /projects/{id}/repository/commits/{sha}/diff
     */
    async getCommitDiffs(sha) {
        const r = await (0, client_1.req)(this.url(`/repository/commits/${sha}/diff`), { headers: this.headers() });
        if (r.status !== 200) {
            throw new Error(`GL getCommitDiffs: ${r.status}`);
        }
        return r.data;
    }
    /**
     * Compare two branches or commits.
     * GET /projects/{id}/repository/compare
     *
     * @param from - Source branch/commit
     * @param to - Target branch/commit
     */
    async compareBranches(from, to) {
        const r = await (0, client_1.req)(this.url(`/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`), { headers: this.headers() });
        if (r.status !== 200) {
            throw new Error(`GL compareBranches: ${r.status}`);
        }
        return r.data;
    }
    // ── Merge Request Operations ──────────────────────────────────────
    /**
     * Create a merge request.
     * POST /projects/{id}/merge_requests
     *
     * Handles MR-already-exists (409/400) by finding and returning the
     * existing MR (idempotent create).
     */
    async createMR(opts) {
        const { sourceBranch, targetBranch, title, description, removeSourceBranch, assigneeId } = opts;
        const body = {
            source_branch: sourceBranch,
            target_branch: targetBranch,
            title,
            description: description || '',
            remove_source_branch: removeSourceBranch || false,
        };
        if (assigneeId)
            body.assignee_id = assigneeId;
        // E12: Verify both branches exist before creating MR
        for (const branchName of [sourceBranch, targetBranch]) {
            try {
                const branchCheck = await (0, client_1.req)(this.url(`/repository/branches/${encodeURIComponent(branchName)}`), { headers: this.headers() });
                if (branchCheck.status === 404) {
                    throw new Error(`Branch "${branchName}" does not exist -- cannot create MR (${sourceBranch} -> ${targetBranch})`);
                }
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.includes('does not exist'))
                    throw e;
                (0, logger_1.logWarn)(`Could not verify branch "${branchName}" existence: ${msg} -- proceeding anyway`);
            }
        }
        const r = await (0, client_1.req)(this.url('/merge_requests'), {
            method: 'POST',
            headers: this.headers(),
            body,
        });
        // E11: MR already exists -- idempotent create
        if (r.status === 409 ||
            (r.status === 400 && r.data && typeof r.data === 'object' &&
                JSON.stringify(r.data).toLowerCase().includes('already exists'))) {
            (0, logger_1.logWarn)(`MR already exists for ${sourceBranch} -> ${targetBranch} -- searching for existing MR`);
            try {
                // Search for open MR
                const search = await (0, client_1.req)(this.url(`/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}` +
                    `&target_branch=${encodeURIComponent(targetBranch)}&state=opened&per_page=1`), { headers: this.headers() });
                if (search.status === 200 && Array.isArray(search.data) && search.data.length > 0) {
                    (0, logger_1.logOk)(`Found existing MR !${search.data[0].iid}`);
                    return search.data[0];
                }
                // Search for merged MR
                const merged = await (0, client_1.req)(this.url(`/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}` +
                    `&target_branch=${encodeURIComponent(targetBranch)}&state=merged&per_page=1`), { headers: this.headers() });
                if (merged.status === 200 && Array.isArray(merged.data) && merged.data.length > 0) {
                    (0, logger_1.logOk)(`Found already-merged MR !${merged.data[0].iid}`);
                    return merged.data[0];
                }
            }
            catch (searchErr) {
                const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
                (0, logger_1.logWarn)(`Could not search for existing MR: ${msg}`);
            }
            throw new Error(`GL createMR: ${r.status} ${JSON.stringify(r.data)}`);
        }
        if (r.status !== 201) {
            throw new Error(`GL createMR: ${r.status} ${JSON.stringify(r.data)}`);
        }
        return r.data;
    }
    /**
     * Get a merge request by IID.
     * GET /projects/{id}/merge_requests/{iid}
     */
    async getMR(iid) {
        const r = await (0, client_1.req)(this.url(`/merge_requests/${iid}`), { headers: this.headers() });
        if (r.status !== 200) {
            throw new Error(`GL getMR: ${r.status}`);
        }
        return r.data;
    }
    /**
     * Merge a merge request.
     * PUT /projects/{id}/merge_requests/{iid}/merge
     *
     * Retries up to 10 times if the merge status is "checking",
     * and handles already-merged and unmergeable states.
     */
    async mergeMR(iid) {
        const MAX_MERGE_CHECK_RETRIES = 10;
        for (let attempt = 0; attempt < MAX_MERGE_CHECK_RETRIES; attempt++) {
            const mrCheck = await this.getMR(iid);
            if (mrCheck.state === 'merged') {
                (0, logger_1.logOk)(`MR !${iid} already merged externally`);
                return mrCheck;
            }
            const mergeStatus = mrCheck.merge_status || mrCheck.detailed_merge_status || '';
            if (mergeStatus === 'can_be_merged' ||
                mergeStatus === 'ci_must_pass' ||
                mergeStatus === 'mergeable') {
                break;
            }
            if (mergeStatus === 'cannot_be_merged') {
                throw new Error(`MR !${iid} cannot be merged -- merge conflicts or unresolved discussions. Status: ${mergeStatus}`);
            }
            if (mergeStatus === 'checking') {
                (0, logger_1.logInfo)(`MR !${iid} merge status is "checking" -- waiting 10s ` +
                    `(attempt ${attempt + 1}/${MAX_MERGE_CHECK_RETRIES})`);
                await (0, client_1.sleep)(10_000);
                continue;
            }
            if (mrCheck.work_in_progress || mrCheck.draft) {
                throw new Error(`MR !${iid} is a draft/WIP -- cannot merge`);
            }
            (0, logger_1.logWarn)(`MR !${iid} merge_status="${mergeStatus}" -- proceeding with merge attempt`);
            break;
        }
        const r = await (0, client_1.req)(this.url(`/merge_requests/${iid}/merge`), {
            method: 'PUT',
            headers: this.headers(),
            body: { should_remove_source_branch: false },
        });
        if (r.status !== 200) {
            throw new Error(`GL mergeMR: ${r.status} ${JSON.stringify(r.data)}`);
        }
        return r.data;
    }
    /**
     * Get merge request approvals.
     * GET /projects/{id}/merge_requests/{iid}/approvals
     *
     * Returns a default "not approved" object if the API call fails.
     */
    async getMRApprovals(iid) {
        const r = await (0, client_1.req)(this.url(`/merge_requests/${iid}/approvals`), { headers: this.headers() });
        if (r.status !== 200) {
            return { approved: false, approved_by: [], approvals_required: 0, approvals_left: 0 };
        }
        return r.data;
    }
    /**
     * Get merge request notes (comments).
     * GET /projects/{id}/merge_requests/{iid}/notes
     *
     * Paginates automatically up to 500 notes.
     *
     * @param iid - Merge request IID
     * @param since - Optional ISO date string; only return notes created after this time
     */
    async getMRNotes(iid, since) {
        let allNotes = [];
        let page = 1;
        const perPage = 100;
        while (true) {
            const r = await (0, client_1.req)(this.url(`/merge_requests/${iid}/notes?sort=desc&per_page=${perPage}&page=${page}`), { headers: this.headers() });
            if (r.status !== 200)
                break;
            const notes = r.data || [];
            if (notes.length === 0)
                break;
            allNotes = allNotes.concat(notes);
            const nextPage = parseInt(r.headers['x-next-page'] || '', 10);
            if (!nextPage || nextPage <= page)
                break;
            page = nextPage;
            if (allNotes.length >= 500)
                break;
        }
        if (since) {
            const sinceDate = new Date(since);
            return allNotes.filter((n) => new Date(n.created_at) > sinceDate);
        }
        return allNotes;
    }
    /**
     * Add a note (comment) to a merge request.
     * POST /projects/{id}/merge_requests/{iid}/notes
     */
    async addMRNote(iid, body) {
        const r = await (0, client_1.req)(this.url(`/merge_requests/${iid}/notes`), {
            method: 'POST',
            headers: this.headers(),
            body: { body },
        });
        if (r.status !== 201) {
            throw new Error(`GL addMRNote: ${r.status}`);
        }
    }
    // ── Pipeline Operations ───────────────────────────────────────────
    /**
     * Trigger a pipeline on a ref (branch or tag).
     * POST /projects/{id}/pipeline
     */
    async triggerPipeline(ref) {
        const r = await (0, client_1.req)(this.url('/pipeline'), {
            method: 'POST',
            headers: this.headers(),
            body: { ref },
        });
        if (r.status !== 201) {
            throw new Error(`GL triggerPipeline: ${r.status} ${JSON.stringify(r.data)}`);
        }
        return r.data;
    }
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
    async waitPipeline(ref) {
        (0, logger_1.logWarn)(`Waiting for CI pipeline on ${ref}...`);
        const t0 = Date.now();
        let noPipelinePolls = 0;
        while (Date.now() - t0 < this.ciTimeout) {
            const r = await (0, client_1.req)(this.url(`/pipelines?ref=${ref}&per_page=1&order_by=id&sort=desc`), { headers: this.headers() });
            const pipelines = r.status === 200 ? r.data : [];
            if (pipelines.length) {
                noPipelinePolls = 0;
                const p = pipelines[0];
                if (p.status === 'success') {
                    (0, logger_1.logOk)(`Pipeline #${p.id} passed`);
                    return p;
                }
                if (p.status === 'skipped') {
                    (0, logger_1.logOk)(`Pipeline #${p.id} skipped -- treating as success`);
                    return p;
                }
                if (p.status === 'failed') {
                    throw new Error(`Pipeline #${p.id} failed -- ${p.web_url}`);
                }
                if (p.status === 'canceled') {
                    throw new Error(`Pipeline #${p.id} canceled -- ${p.web_url}`);
                }
                const elapsedMin = Math.floor((Date.now() - t0) / 60_000);
                (0, logger_1.logInfo)(`Pipeline #${p.id}: ${p.status} (${elapsedMin}m elapsed)`);
            }
            else {
                noPipelinePolls++;
                const elapsedMin = Math.floor((Date.now() - t0) / 60_000);
                (0, logger_1.logWarn)(`No pipelines found for ${ref} (poll ${noPipelinePolls}/3, ${elapsedMin}m elapsed)`);
                if (noPipelinePolls >= 3) {
                    throw new Error(`No pipelines found for ref "${ref}" after ${noPipelinePolls} polls. ` +
                        `CI may not be configured for this branch.`);
                }
            }
            await (0, client_1.sleep)(this.ciPoll);
        }
        // Timeout -- gather final state for error message
        let lastPipelineInfo = '';
        try {
            const r = await (0, client_1.req)(this.url(`/pipelines?ref=${ref}&per_page=1&order_by=id&sort=desc`), { headers: this.headers() });
            if (r.status === 200 && Array.isArray(r.data) && r.data.length > 0) {
                const p = r.data[0];
                const pUrl = p.web_url;
                const timeoutMin = this.ciTimeout / 60_000;
                if (p.status === 'pending') {
                    lastPipelineInfo = `Pipeline #${p.id} is PENDING -- may be waiting for a runner. URL: ${pUrl}`;
                }
                else if (p.status === 'running') {
                    lastPipelineInfo = `Pipeline #${p.id} is still RUNNING (exceeded ${timeoutMin}min timeout). URL: ${pUrl}`;
                }
                else if (p.status === 'manual') {
                    lastPipelineInfo = `Pipeline #${p.id} requires MANUAL action. URL: ${pUrl}`;
                }
                else {
                    lastPipelineInfo = `Pipeline #${p.id} status: ${p.status}. URL: ${pUrl}`;
                }
                (0, logger_1.logErr)(lastPipelineInfo);
            }
        }
        catch {
            // Ignore -- best effort for error reporting
        }
        const timeoutMin = this.ciTimeout / 60_000;
        throw new Error(`Pipeline timeout on ${ref} after ${timeoutMin}min. ${lastPipelineInfo}`);
    }
}
exports.GitLabService = GitLabService;
// =====================================================================
// Factory + default instance
// =====================================================================
/** Create a new GitLabService instance with optional config override. */
function createGitLabService(config) {
    return new GitLabService(config);
}
//# sourceMappingURL=gitlab.js.map