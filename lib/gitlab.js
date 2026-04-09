"use strict";

const { cfg, CI_POLL, CI_TIMEOUT, TICKET } = require("./config");
const { req, sleep } = require("./http-client");
const { logOk, logErr, logInfo, logWarn } = require("./logging");
const { slack } = require("./slack");

// ── GitLab API ────────────────────────────────────────────────────

const gl = {
  h() { return { "PRIVATE-TOKEN": cfg.gitlab.token, "Content-Type": "application/json" }; },
  u(p) { return `${cfg.gitlab.base}/api/v4/projects/${cfg.gitlab.projectId}${p}`; },

  async getFile(filePath, ref = cfg.branch.qa) {
    const r = await req(this.u(`/repository/files/${encodeURIComponent(filePath)}?ref=${ref}`),
      { headers: this.h() });
    if (r.status !== 200) return null;
    return Buffer.from(r.data.content, "base64").toString("utf8");
  },

  async getTree(dir = "", ref = cfg.branch.ts, recursive = false) {
    const MAX_TREE_ITEMS = 10000;
    const base = `path=${encodeURIComponent(dir)}&ref=${ref}&per_page=100${recursive ? "&recursive=true" : ""}`;
    let all = [];
    let page = 1;
    while (true) {
      const r = await req(this.u(`/repository/tree?${base}&page=${page}`), { headers: this.h() });
      if (r.status !== 200) {
        logWarn(`getTree(): Page ${page} returned status ${r.status} — tree may be incomplete (${all.length} items so far)`);
        break;
      }
      if (!Array.isArray(r.data) || r.data.length === 0) break;
      all = all.concat(r.data);
      if (all.length >= MAX_TREE_ITEMS) {
        logWarn(`getTree(): Hit ${MAX_TREE_ITEMS} item cap — results may be truncated`);
        break;
      }
      const next = parseInt(r.headers && r.headers["x-next-page"], 10);
      if (!next || next <= page) break;
      page = next;
    }
    return all;
  },

  async searchCode(query, ref = cfg.branch.qa) {
    const r = await req(
      this.u(`/search?scope=blobs&search=${encodeURIComponent(query)}&ref=${ref}&per_page=20`),
      { headers: this.h() });
    return r.status === 200 ? r.data : [];
  },

  async createBranch(name, ref) {
    const r = await req(this.u("/repository/branches"), {
      method: "POST", headers: this.h(),
      body: { branch: name, ref },
    });
    if (r.status !== 201 && r.status !== 400)
      throw new Error(`GL createBranch: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  },

  async commit(branch, message, actions, authorName, authorEmail) {
    const body = { branch, commit_message: message, actions };
    if (authorName) body.author_name = authorName;
    if (authorEmail) body.author_email = authorEmail;
    const r = await req(this.u("/repository/commits"), {
      method: "POST", headers: this.h(),
      body,
    });
    if (r.status !== 201)
      throw new Error(`GL commit: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  },

  async createMR(source, target, title, desc, removeSource = false, assigneeId = null) {
    const body = { source_branch: source, target_branch: target,
            title, description: desc, remove_source_branch: removeSource };
    if (assigneeId) body.assignee_id = parseInt(assigneeId, 10);

    // E12: Source/target branch existence check before MR creation
    for (const branchName of [source, target]) {
      try {
        const branchCheck = await req(this.u(`/repository/branches/${encodeURIComponent(branchName)}`), { headers: this.h() });
        if (branchCheck.status === 404) {
          throw new Error(`Branch "${branchName}" does not exist — cannot create MR (${source} -> ${target})`);
        }
      } catch (e) {
        if (e.message.includes("does not exist")) throw e;
        logWarn(`Could not verify branch "${branchName}" existence: ${e.message} — proceeding anyway`);
      }
    }

    const r = await req(this.u("/merge_requests"), {
      method: "POST", headers: this.h(),
      body,
    });
    // E11: MR already exists — idempotent create
    if (r.status === 409 || (r.status === 400 && r.data && typeof r.data === "object" &&
        JSON.stringify(r.data).toLowerCase().includes("already exists"))) {
      logWarn(`MR already exists for ${source} -> ${target} — searching for existing MR`);
      try {
        const search = await req(
          this.u(`/merge_requests?source_branch=${encodeURIComponent(source)}&target_branch=${encodeURIComponent(target)}&state=opened&per_page=1`),
          { headers: this.h() },
        );
        if (search.status === 200 && Array.isArray(search.data) && search.data.length > 0) {
          logOk(`Found existing MR !${search.data[0].iid}`);
          return search.data[0];
        }
        const merged = await req(
          this.u(`/merge_requests?source_branch=${encodeURIComponent(source)}&target_branch=${encodeURIComponent(target)}&state=merged&per_page=1`),
          { headers: this.h() },
        );
        if (merged.status === 200 && Array.isArray(merged.data) && merged.data.length > 0) {
          logOk(`Found already-merged MR !${merged.data[0].iid}`);
          return merged.data[0];
        }
      } catch (searchErr) {
        logWarn(`Could not search for existing MR: ${searchErr.message}`);
      }
      throw new Error(`GL createMR: ${r.status} ${JSON.stringify(r.data)}`);
    }
    if (r.status !== 201)
      throw new Error(`GL createMR: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  },

  async getMR(iid) {
    const r = await req(this.u(`/merge_requests/${iid}`), { headers: this.h() });
    if (r.status !== 200) throw new Error(`GL getMR: ${r.status}`);
    return r.data;
  },

  async getMRApprovals(iid) {
    const r = await req(this.u(`/merge_requests/${iid}/approvals`), { headers: this.h() });
    if (r.status !== 200) return { approved: false, approved_by: [] };
    return r.data;
  },

  async getMRNotes(iid, since) {
    let allNotes = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const r = await req(
        this.u(`/merge_requests/${iid}/notes?sort=desc&per_page=${perPage}&page=${page}`),
        { headers: this.h() },
      );
      if (r.status !== 200) break;
      const notes = r.data || [];
      if (notes.length === 0) break;
      allNotes = allNotes.concat(notes);
      const nextPage = parseInt(r.headers && r.headers["x-next-page"], 10);
      if (!nextPage || nextPage <= page) break;
      page = nextPage;
      if (allNotes.length >= 500) break;
    }
    return since ? allNotes.filter((n) => new Date(n.created_at) > new Date(since)) : allNotes;
  },

  async mergeMR(iid) {
    const MAX_MERGE_CHECK_RETRIES = 10;
    for (let attempt = 0; attempt < MAX_MERGE_CHECK_RETRIES; attempt++) {
      const mrCheck = await this.getMR(iid);
      if (mrCheck.state === "merged") {
        logOk(`MR !${iid} already merged externally`);
        return mrCheck;
      }
      const mergeStatus = mrCheck.merge_status || mrCheck.detailed_merge_status || "";
      if (mergeStatus === "can_be_merged" || mergeStatus === "ci_must_pass" || mergeStatus === "mergeable") break;
      if (mergeStatus === "cannot_be_merged") {
        throw new Error(`MR !${iid} cannot be merged — merge conflicts or unresolved discussions. Status: ${mergeStatus}`);
      }
      if (mergeStatus === "checking") {
        logInfo(`MR !${iid} merge status is "checking" — waiting 10s (attempt ${attempt + 1}/${MAX_MERGE_CHECK_RETRIES})`);
        await sleep(10_000);
        continue;
      }
      if (mrCheck.work_in_progress || mrCheck.draft) {
        throw new Error(`MR !${iid} is a draft/WIP — cannot merge`);
      }
      logWarn(`MR !${iid} merge_status="${mergeStatus}" — proceeding with merge attempt`);
      break;
    }

    const r = await req(this.u(`/merge_requests/${iid}/merge`), {
      method: "PUT", headers: this.h(),
      body: { should_remove_source_branch: false },
    });
    if (r.status !== 200)
      throw new Error(`GL mergeMR: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  },

  async waitPipeline(ref) {
    logWarn(`Waiting for CI pipeline on ${ref}...`);
    const t0 = Date.now();
    let noPipelinePolls = 0;
    while (Date.now() - t0 < CI_TIMEOUT) {
      const r = await req(
        this.u(`/pipelines?ref=${ref}&per_page=1&order_by=id&sort=desc`),
        { headers: this.h() });
      const pipelines = r.status === 200 ? r.data : [];
      if (pipelines.length) {
        noPipelinePolls = 0;
        const p = pipelines[0];
        const pipelineUrl = `${cfg.gitlab.base}/${cfg.gitlab.projectId ? "" : ""}pipelines/${p.id}`;
        if (p.status === "success")  { logOk(`Pipeline #${p.id} passed`);  return p; }
        if (p.status === "skipped")  { logOk(`Pipeline #${p.id} skipped — treating as success`); return p; }
        if (p.status === "failed")   throw new Error(`Pipeline #${p.id} failed — ${p.web_url || pipelineUrl}`);
        if (p.status === "canceled") throw new Error(`Pipeline #${p.id} canceled — ${p.web_url || pipelineUrl}`);
        const elapsedMin = Math.floor((Date.now() - t0) / 60000);
        logInfo(`Pipeline #${p.id}: ${p.status} (${elapsedMin}m elapsed)`);
      } else {
        noPipelinePolls++;
        const elapsedMin = Math.floor((Date.now() - t0) / 60000);
        logWarn(`No pipelines found for ${ref} (poll ${noPipelinePolls}/3, ${elapsedMin}m elapsed)`);
        if (noPipelinePolls >= 3) {
          throw new Error(`No pipelines found for ref "${ref}" after ${noPipelinePolls} polls. CI may not be configured for this branch.`);
        }
      }
      await sleep(CI_POLL);
    }
    let lastPipelineInfo = "";
    try {
      const r = await req(
        this.u(`/pipelines?ref=${ref}&per_page=1&order_by=id&sort=desc`),
        { headers: this.h() });
      if (r.status === 200 && Array.isArray(r.data) && r.data.length > 0) {
        const p = r.data[0];
        const pUrl = p.web_url || `${cfg.gitlab.base}/pipelines/${p.id}`;
        if (p.status === "pending") {
          lastPipelineInfo = `Pipeline #${p.id} is PENDING — may be waiting for a runner. URL: ${pUrl}`;
        } else if (p.status === "running") {
          lastPipelineInfo = `Pipeline #${p.id} is still RUNNING (exceeded ${CI_TIMEOUT / 60000}min timeout). URL: ${pUrl}`;
        } else if (p.status === "manual") {
          lastPipelineInfo = `Pipeline #${p.id} requires MANUAL action. URL: ${pUrl}`;
        } else {
          lastPipelineInfo = `Pipeline #${p.id} status: ${p.status}. URL: ${pUrl}`;
        }
        logErr(lastPipelineInfo);
        await slack(`⏰ *Pipeline Timeout — ${TICKET}*\n${lastPipelineInfo}`, [cfg.slack.ownerId]);
      }
    } catch {}
    throw new Error(`Pipeline timeout on ${ref} after ${CI_TIMEOUT / 60000}min. ${lastPipelineInfo}`);
  },
};

module.exports = { gl };
