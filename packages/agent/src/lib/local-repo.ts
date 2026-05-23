/**
 * local-repo.ts -- Local git clone management + worktree support
 *
 * Converted from lib/local-repo.js (zero functional changes).
 */

import fs from "fs";
import path from "path";

const { cfg, GIT_CLONE_DEPTH } = require('./config') as {
  cfg: {
    gitlab: { cloneUrl: string };
    branch: { ts: string };
    [key: string]: any;
  };
  GIT_CLONE_DEPTH: number;
};
const { logOk, logErr, logInfo, logWarn, logDebug } = require('./logging') as {
  logOk: (msg: string) => void;
  logErr: (msg: string) => void;
  logInfo: (msg: string) => void;
  logWarn: (msg: string) => void;
  logDebug: (msg: string) => void;
};
const { isBinaryFile, isBinaryContent } = require('./utils') as {
  isBinaryFile: (filePath: string) => boolean;
  isBinaryContent: (content: string) => boolean;
};

const REPO_CACHE_DIR: string = path.join(__dirname, "..", ".repo-cache");

interface TreeEntry {
  path: string;
  type: 'tree' | 'blob';
}

interface ChangeEntry {
  action: 'create' | 'update' | 'delete';
  file_path: string;
  content: string;
}

async function ensureLocalRepo(): Promise<string | null> {
  const { execSync } = require("child_process");

  const cloneUrl = cfg.gitlab.cloneUrl;
  if (!cloneUrl) {
    logWarn("No GITLAB_CLONE_URL set — using GitLab API for reads");
    return null;
  }

  const branch = cfg.branch.ts;
  logInfo(`Repo: ${cloneUrl} | Branch: ${branch} | Cache: ${REPO_CACHE_DIR}`);

  // W13: Check if .repo-cache exists but is corrupted
  if (fs.existsSync(REPO_CACHE_DIR)) {
    const gitDir = path.join(REPO_CACHE_DIR, ".git");
    const gitHead = path.join(REPO_CACHE_DIR, ".git", "HEAD");
    if (!fs.existsSync(gitDir) || !fs.existsSync(gitHead)) {
      logWarn("Cache dir exists but git repo is corrupted (missing .git/HEAD) — removing and re-cloning…");
      fs.rmSync(REPO_CACHE_DIR, { recursive: true, force: true });
    } else {
      try {
        const headContent = fs.readFileSync(gitHead, "utf8").trim();
        if (!headContent || (!headContent.startsWith("ref:") && !/^[0-9a-f]{40}$/.test(headContent))) {
          logWarn("Git HEAD file is corrupted — removing and re-cloning…");
          fs.rmSync(REPO_CACHE_DIR, { recursive: true, force: true });
        }
      } catch (e: any) {
        logWarn(`Cannot read .git/HEAD: ${e.message} — removing and re-cloning…`);
        fs.rmSync(REPO_CACHE_DIR, { recursive: true, force: true });
      }
    }
  }

  // G7: Git index lock cleanup
  const gitIndexLock = path.join(REPO_CACHE_DIR, ".git", "index.lock");
  if (fs.existsSync(gitIndexLock)) {
    logWarn("Removing stale .git/index.lock file…");
    try { fs.unlinkSync(gitIndexLock); } catch (e: any) { logWarn(`Could not remove index.lock: ${e.message}`); }
  }

  // T1.6: Use execFileSync (array args) to prevent command injection via branch/cloneUrl
  const { execFileSync } = require("child_process");

  try {
    if (!fs.existsSync(REPO_CACHE_DIR)) {
      logInfo(`Cloning (branch: ${branch}, depth: ${GIT_CLONE_DEPTH}) — first run, may take 1-5 min…`);
      execFileSync("git", [
        "clone", "--config", "core.hooksPath=/dev/null",
        `--depth=${GIT_CLONE_DEPTH}`, "--single-branch", "--branch", branch,
        cloneUrl, REPO_CACHE_DIR,
      ], { stdio: "pipe", timeout: 600_000 });
      logOk(`Cloned to ${REPO_CACHE_DIR}`);
    } else {
      logInfo("Updating local repo cache…");
      execFileSync("git", ["-C", REPO_CACHE_DIR, "remote", "set-url", "origin", cloneUrl],
        { stdio: "pipe", timeout: 10_000 });
      logInfo(`  checkout ${branch}…`);
      execFileSync("git", ["-C", REPO_CACHE_DIR, "checkout", "-f", branch],
        { stdio: "pipe", timeout: 30_000 });
      logInfo(`  fetch origin/${branch} (depth: ${GIT_CLONE_DEPTH})…`);
      execFileSync("git", ["-C", REPO_CACHE_DIR, "fetch", "origin", branch, `--depth=${GIT_CLONE_DEPTH}`],
        { stdio: "pipe", timeout: 120_000 });
      // Skip hard reset if active worktrees exist — they share the git objects
      const activeWt = getActiveWorktrees();
      if (activeWt.length > 0) {
        logInfo(`  Skipping reset --hard (${activeWt.length} active worktree(s): ${activeWt.join(", ")})`);
      } else {
        execFileSync("git", ["-C", REPO_CACHE_DIR, "reset", "--hard", `origin/${branch}`],
          { stdio: "pipe", timeout: 30_000 });
      }
      logOk("Local repo cache updated (latest enterprise-ts)");
    }
    return REPO_CACHE_DIR;
  } catch (e: any) {
    const detail = e.stderr ? e.stderr.toString().substring(0, 300) : e.message;
    logErr(`Local clone/pull failed: ${detail}`);
    logWarn("Falling back to GitLab API for reads");
    return null;
  }
}

function localGetTree(clonePath: string, dir: string = "", recursive: boolean = true): TreeEntry[] {
  const base = dir ? path.join(clonePath, dir) : clonePath;
  const results: TreeEntry[] = [];
  const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".cache", "coverage"]);

  function walk(currentPath: string, relativeTo: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(currentPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const relPath = relativeTo ? path.join(relativeTo, entry.name) : entry.name;
      if (entry.isDirectory()) {
        results.push({ path: relPath, type: "tree" });
        if (recursive) walk(path.join(currentPath, entry.name), relPath);
      } else {
        results.push({ path: relPath, type: "blob" });
      }
    }
  }

  walk(base, dir);
  return results;
}

function localGetFile(clonePath: string, filePath: string): string | null {
  try {
    const resolved = path.resolve(clonePath, filePath);
    if (!resolved.startsWith(path.resolve(clonePath))) return null;

    // C3: Refuse to read symlink targets — committing the resolved
    // content would let an agent exfiltrate internal files (e.g. a
    // foo.ts -> .env link). G6 only caught escapes outside the repo;
    // an in-repo target (e.g. .env, .api-token) passed through.
    try {
      const lst = fs.lstatSync(resolved);
      if (lst.isSymbolicLink()) { logWarn(`Symlink skipped (not committed): ${filePath}`); return null; }
    } catch { /* file doesn't exist yet — allow */ }

    // G6: Symlink escape guard (still useful if lstat missed and realpath
    // escapes). Compare BOTH sides through realpath so OS-level symlinks
    // in the clone-path itself (e.g. macOS `/var` -> `/private/var`)
    // don't falsely trip the guard for legitimate in-repo files.
    try {
      const real = fs.realpathSync(resolved);
      const realClone = (() => { try { return fs.realpathSync(clonePath); } catch { return path.resolve(clonePath); } })();
      if (!real.startsWith(realClone)) { logWarn(`G6: Symlink escape blocked: ${filePath}`); return null; }
    } catch { /* file doesn't exist yet — allow */ }

    // D7: Binary file guard
    if (isBinaryFile(filePath)) {
      try {
        const stat = fs.statSync(resolved);
        return `[Binary file: ${path.basename(filePath)}, ${stat.size} bytes]`;
      } catch { return null; }
    }

    const content = fs.readFileSync(resolved, "utf8");
    if (isBinaryContent(content)) {
      try {
        const stat = fs.statSync(resolved);
        return `[Binary file: ${path.basename(filePath)}, ${stat.size} bytes]`;
      } catch {
        return `[Binary file: ${path.basename(filePath)}]`;
      }
    }
    return content;
  } catch {
    return null;
  }
}

function localResetRepo(clonePath: string): void {
  const { execFileSync } = require("child_process");
  logInfo(`Resetting local repo to clean state…`);
  // Use "checkout -f ." instead of "checkout -f <branch>" — works in both worktree and main clone contexts
  execFileSync("git", ["-C", clonePath, "checkout", "-f", "."], { stdio: "pipe", timeout: 30_000 });
  // T2.22: Exclude important untracked files from clean
  execFileSync("git", ["-C", clonePath, "clean", "-fd", "-e", ".env", "-e", ".env.*", "-e", ".api-token", "-e", ".state-secret", "-e", ".debug"], { stdio: "pipe", timeout: 30_000 });
  logOk("Local repo reset to clean state");
}

function localGetChanges(clonePath: string): ChangeEntry[] {
  const { execFileSync } = require("child_process");
  // Strip only the trailing newline — `.trim()` would eat the leading
  // space of the first line, which `git status --porcelain` uses to
  // encode the worktree column (e.g. " M path" for unstaged-modified).
  // Losing that space offsets the downstream `substring(3)` path parse.
  const output: string = execFileSync("git", ["-C", clonePath, "status", "--porcelain"], { encoding: "utf8", timeout: 15_000 }).replace(/\n+$/, "");
  if (!output) return [];

  let diffOutput = "";
  try {
    diffOutput = execFileSync("git", ["-C", clonePath, "diff", "--name-status", "HEAD"], { encoding: "utf8", timeout: 15_000 }).trim();
  } catch { /* no HEAD yet or other issue */ }

  const changes: ChangeEntry[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const status = line.substring(0, 2).trim();
    let filePath = line.substring(3).trim();
    if (!filePath) continue;

    // G8: Strip quotes from filenames
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }

    // D6: Handle renames
    if (status.startsWith("R") && filePath.includes(" -> ")) {
      const parts = filePath.split(" -> ");
      let oldPath = parts[0].trim();
      let newPath = parts[1].trim();
      if (oldPath.startsWith('"') && oldPath.endsWith('"')) oldPath = oldPath.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      if (newPath.startsWith('"') && newPath.endsWith('"')) newPath = newPath.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      changes.push({ action: "delete", file_path: oldPath, content: "" });
      const content = localGetFile(clonePath, newPath);
      if (content !== null) {
        changes.push({ action: "create", file_path: newPath, content });
      }
      continue;
    }

    // C2: Detect unmerged (merge-conflict) states before mapping to an
    // action. Without this, codes like UU/AA/DD silently fall through to
    // "update" and the file content (with `<<<<<<<` markers) ships in the
    // GitLab commit.
    const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
    if (UNMERGED.has(status)) {
      throw new Error(`Merge conflict detected in ${filePath} (git status: ${status}). Resolve conflicts before committing.`);
    }

    let action: 'create' | 'update' | 'delete';
    if (status === "D") {
      action = "delete";
    } else if (status === "??" || status === "A") {
      action = "create";
    } else {
      action = "update";
    }

    if (action === "delete") {
      changes.push({ action, file_path: filePath, content: "" });
    } else {
      let content = localGetFile(clonePath, filePath);
      if (content !== null) {
        // GQ3: Strip BOM
        if (typeof content === "string" && content.length > 0 && content.charCodeAt(0) === 0xFEFF) {
          content = content.substring(1);
          logDebug(`GQ3: Stripped BOM from ${filePath}`);
        }
        if (typeof content === "string" && content.includes("\0")) {
          logWarn(`GQ3: Skipping binary file (null bytes): ${filePath}`);
          continue;
        }
        changes.push({ action, file_path: filePath, content });
      }
    }
  }

  // D6: Also parse git diff --name-status for renames missed by porcelain
  if (diffOutput) {
    for (const line of diffOutput.split("\n")) {
      const m = line.match(/^R\d*\t(.+?)\t(.+)$/);
      if (m) {
        let oldPath = m[1].trim();
        let newPath = m[2].trim();
        if (oldPath.startsWith('"') && oldPath.endsWith('"')) oldPath = oldPath.slice(1, -1);
        if (newPath.startsWith('"') && newPath.endsWith('"')) newPath = newPath.slice(1, -1);
        if (!changes.some((c) => c.file_path === oldPath && c.action === "delete")) {
          changes.push({ action: "delete", file_path: oldPath, content: "" });
        }
        if (!changes.some((c) => c.file_path === newPath)) {
          const content = localGetFile(clonePath, newPath);
          if (content !== null) {
            changes.push({ action: "create", file_path: newPath, content });
          }
        }
      }
    }
  }

  return changes;
}

function localGetOriginal(clonePath: string, filePath: string): string | null {
  const { execFileSync } = require("child_process");
  try {
    return execFileSync("git", ["-C", clonePath, "show", `HEAD:${filePath}`], { encoding: "utf8", timeout: 10_000 });
  } catch {
    return null;
  }
}

// ── Multi-ticket worktree support ──────────────────────────────────

const WORKTREES_DIR: string = path.join(REPO_CACHE_DIR, ".worktrees");
const MIN_DISK_MB = 1024; // 1GB minimum free disk space

/**
 * Create a detached-HEAD git worktree for a ticket.
 */
function createWorktree(ticket: string): string {
  const { execFileSync } = require("child_process");

  if (!ticket) throw new Error("createWorktree: ticket is required");

  const wtPath = path.join(WORKTREES_DIR, ticket);

  // Disk space check
  try {
    const stats = (fs as any).statfsSync ? (fs as any).statfsSync(REPO_CACHE_DIR) : null;
    if (stats) {
      const freeMB = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
      if (freeMB < MIN_DISK_MB) {
        throw new Error(`Insufficient disk space for worktree (need ${MIN_DISK_MB}MB, have ${freeMB}MB)`);
      }
    }
  } catch (e: any) {
    if (e.message.includes("Insufficient disk")) throw e;
    // statfsSync may not exist on all Node versions — skip check
  }

  // If worktree already exists, reset it
  if (fs.existsSync(wtPath)) {
    logInfo(`Worktree for ${ticket} already exists — resetting…`);
    try {
      execFileSync("git", ["-C", wtPath, "checkout", "-f", "."], { stdio: "pipe", timeout: 30_000 });
      execFileSync("git", ["-C", wtPath, "clean", "-fd", "-e", ".env", "-e", ".env.*", "-e", ".api-token", "-e", ".state-secret", "-e", ".debug"], { stdio: "pipe", timeout: 30_000 });
      logOk(`Worktree for ${ticket} reset`);
      return wtPath;
    } catch (e: any) {
      logWarn(`Failed to reset existing worktree: ${e.message} — removing and recreating…`);
      removeWorktree(ticket);
    }
  }

  // Ensure worktrees parent dir exists
  if (!fs.existsSync(WORKTREES_DIR)) {
    fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  }

  // Get latest enterprise-ts commit SHA
  const sha: string = execFileSync("git", ["-C", REPO_CACHE_DIR, "rev-parse", `origin/${cfg.branch.ts}`],
    { encoding: "utf8", timeout: 10_000 }).trim();

  logInfo(`Creating worktree for ${ticket} at ${sha.substring(0, 8)}…`);
  execFileSync("git", ["-C", REPO_CACHE_DIR, "worktree", "add", "--detach", wtPath, sha],
    { stdio: "pipe", timeout: 60_000 });

  logOk(`Worktree created: ${wtPath}`);
  return wtPath;
}

/**
 * Remove a ticket's git worktree.
 */
function removeWorktree(ticket: string): void {
  const { execFileSync } = require("child_process");
  if (!ticket) return;

  const wtPath = path.join(WORKTREES_DIR, ticket);
  if (!fs.existsSync(wtPath)) return;

  logInfo(`Removing worktree for ${ticket}…`);
  try {
    execFileSync("git", ["-C", REPO_CACHE_DIR, "worktree", "remove", wtPath, "--force"],
      { stdio: "pipe", timeout: 30_000 });
  } catch (e: any) {
    logWarn(`git worktree remove failed: ${e.message} — falling back to rm + prune`);
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    try {
      execFileSync("git", ["-C", REPO_CACHE_DIR, "worktree", "prune"],
        { stdio: "pipe", timeout: 10_000 });
    } catch {}
  }
  logOk(`Worktree for ${ticket} removed`);
}

/**
 * Clean up orphaned worktrees whose owning agent process is no longer alive.
 */
function cleanOrphanedWorktrees(): void {
  const { execFileSync } = require("child_process");

  if (!fs.existsSync(WORKTREES_DIR)) return;

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(WORKTREES_DIR, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;

    // M1: Sub-worktrees follow the naming `<ticket>.dev-<idx>`. Owning
    // ticket is the prefix before `.dev-`. Reap if the OWNING ticket's
    // agent process is dead.
    const subMatch = name.match(/^(.+)\.dev-(\d+)$/);
    const owningTicket = subMatch ? subMatch[1] : name;
    const subIdx = subMatch ? parseInt(subMatch[2], 10) : null;

    const lockPath = path.join(__dirname, "..", `state-${owningTicket}.lock`);

    // Check if owning agent process is alive
    let alive = false;
    if (fs.existsSync(lockPath)) {
      try {
        const pid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
        if (pid > 0) {
          process.kill(pid, 0); // Signal 0 = check existence
          alive = true;
        }
      } catch {
        // Process doesn't exist or can't be signaled
      }
    }

    if (!alive) {
      if (subIdx !== null) {
        logInfo(`Cleaning orphaned sub-worktree: ${name}`);
        try { removeSubWorktree(owningTicket, subIdx); } catch {}
      } else {
        logInfo(`Cleaning orphaned worktree: ${owningTicket}`);
        removeWorktree(owningTicket);
      }
    }
  }

  // Prune any stale git worktree references
  try {
    execFileSync("git", ["-C", REPO_CACHE_DIR, "worktree", "prune"],
      { stdio: "pipe", timeout: 10_000 });
  } catch {}
}

// ── M1: Per-agent sub-worktrees ──────────────────────────────────────
//
// For parallel Dev Agents within a single ticket, each agent gets its
// own sub-worktree so they can't collide on the filesystem. After all
// agents finish, mergeSubWorktrees applies each agent's changes back
// into the ticket's canonical worktree.
//
// Naming: <WORKTREES_DIR>/<ticket>.dev-<index>/ (e.g. AUT-8648.dev-0).
// The dot keeps them distinguishable from the canonical ticket
// worktree directory and matches the existing orphan-cleanup walk.

function _subWorktreeName(ticket: string, idx: number): string {
  return `${ticket}.dev-${idx}`;
}

function _subWorktreePath(ticket: string, idx: number): string {
  return path.join(WORKTREES_DIR, _subWorktreeName(ticket, idx));
}

/**
 * Create a sub-worktree branched from the ticket's CURRENT worktree HEAD
 * (so each Dev Agent starts from the same base, including any in-progress
 * work from earlier stages). Returns the absolute path or throws.
 */
function createSubWorktree(ticket: string, idx: number): string {
  const { execFileSync } = require("child_process");
  if (!ticket) throw new Error("createSubWorktree: ticket is required");
  if (!Number.isInteger(idx) || idx < 0) throw new Error("createSubWorktree: idx must be a non-negative integer");

  const wtPath = _subWorktreePath(ticket, idx);
  const parentTicketPath = path.join(WORKTREES_DIR, ticket);

  // Determine the base SHA: prefer the ticket's current worktree HEAD,
  // fall back to origin/<base-branch> if the ticket worktree doesn't
  // exist yet (e.g. spawned without the server's createWorktree path).
  let baseSha: string;
  try {
    if (fs.existsSync(parentTicketPath)) {
      baseSha = execFileSync("git", ["-C", parentTicketPath, "rev-parse", "HEAD"],
        { encoding: "utf8", timeout: 10_000 }).toString().trim();
    } else {
      baseSha = execFileSync("git", ["-C", REPO_CACHE_DIR, "rev-parse", `origin/${cfg.branch.ts}`],
        { encoding: "utf8", timeout: 10_000 }).toString().trim();
    }
  } catch (e: any) {
    throw new Error(`createSubWorktree: failed to resolve base SHA: ${e.message}`);
  }

  // If a previous sub-worktree exists at this path (e.g. crash recovery),
  // remove it before recreating so we start from a clean base.
  if (fs.existsSync(wtPath)) {
    try { removeSubWorktree(ticket, idx); } catch {}
  }

  if (!fs.existsSync(WORKTREES_DIR)) {
    fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  }

  logInfo(`Creating sub-worktree ${_subWorktreeName(ticket, idx)} at ${baseSha.substring(0, 8)}…`);
  execFileSync("git", ["-C", REPO_CACHE_DIR, "worktree", "add", "--detach", wtPath, baseSha],
    { stdio: "pipe", timeout: 60_000 });

  // Mirror any in-progress changes from the ticket's canonical worktree
  // into the sub-worktree so the agent sees the same starting state.
  // Without this, a Dev Agent in iteration 2 of a retry would lose all
  // changes from iteration 1's other groups that were merged back.
  if (fs.existsSync(parentTicketPath) && parentTicketPath !== wtPath) {
    try {
      const changes = localGetChanges(parentTicketPath);
      for (const c of changes) {
        const dst = path.join(wtPath, c.file_path);
        if (c.action === "delete") {
          try { if (fs.existsSync(dst)) fs.rmSync(dst, { force: true }); } catch {}
          continue;
        }
        if (typeof c.content === "string") {
          try {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.writeFileSync(dst, c.content);
          } catch (e: any) {
            logWarn(`createSubWorktree: failed to mirror ${c.file_path}: ${e.message.substring(0, 120)}`);
          }
        }
      }
    } catch (e: any) {
      logWarn(`createSubWorktree: mirror step failed: ${e.message.substring(0, 200)}`);
    }
  }

  logOk(`Sub-worktree created: ${wtPath}`);
  return wtPath;
}

/**
 * Remove one sub-worktree.
 */
function removeSubWorktree(ticket: string, idx: number): void {
  const { execFileSync } = require("child_process");
  const wtPath = _subWorktreePath(ticket, idx);
  if (!fs.existsSync(wtPath)) return;

  try {
    execFileSync("git", ["-C", REPO_CACHE_DIR, "worktree", "remove", wtPath, "--force"],
      { stdio: "pipe", timeout: 30_000 });
  } catch (e: any) {
    logWarn(`Sub-worktree remove failed: ${e.message.substring(0, 120)} — falling back to rm + prune`);
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    try {
      execFileSync("git", ["-C", REPO_CACHE_DIR, "worktree", "prune"], { stdio: "pipe", timeout: 10_000 });
    } catch {}
  }
}

/**
 * Remove all sub-worktrees for a ticket (idx >= 0).
 */
function removeAllSubWorktrees(ticket: string): void {
  if (!fs.existsSync(WORKTREES_DIR)) return;
  const prefix = `${ticket}.dev-`;
  try {
    for (const entry of fs.readdirSync(WORKTREES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(prefix)) continue;
      const idx = parseInt(entry.name.slice(prefix.length), 10);
      if (Number.isInteger(idx)) {
        try { removeSubWorktree(ticket, idx); } catch (e: any) {
          logWarn(`removeAllSubWorktrees: ${entry.name} failed: ${e.message.substring(0, 100)}`);
        }
      }
    }
  } catch (e: any) {
    logWarn(`removeAllSubWorktrees: enumerate failed: ${e.message.substring(0, 100)}`);
  }
}

interface SubWorktreeMergeResult {
  applied: number;            // files copied/deleted into canonical
  conflicts: Array<{ file: string; agents: number[] }>;
  skippedForbidden: string[]; // .env/.api-token/etc. carve-outs
}

/**
 * Merge sub-worktrees back into the canonical ticket worktree.
 *
 * Strategy: for each sub-worktree, iterate its `localGetChanges`. Track
 * which file each change came from; if two agents touched the same file,
 * first-agent-wins and the conflict is reported. Forbidden files (.env-
 * class) are never copied — they shouldn't appear here (F3 blocks them
 * earlier), but defense in depth keeps the canonical worktree's preserved
 * secrets intact.
 */
function mergeSubWorktrees(ticket: string, agentIndices: number[], canonicalPath: string): SubWorktreeMergeResult {
  const FORBIDDEN = [
    /(^|\/)\.env(\..+)?$/,
    /(^|\/)\.api-token$/,
    /(^|\/)\.state-secret$/,
    /(^|\/)\.npmrc$/,
  ];
  const result: SubWorktreeMergeResult = { applied: 0, conflicts: [], skippedForbidden: [] };
  const fileOwner = new Map<string, number>(); // file_path → first agent idx that wrote it

  for (const idx of agentIndices) {
    const sub = _subWorktreePath(ticket, idx);
    if (!fs.existsSync(sub)) continue;
    let changes: ChangeEntry[];
    try { changes = localGetChanges(sub); } catch (e: any) {
      logWarn(`mergeSubWorktrees: localGetChanges(${sub}) failed: ${e.message.substring(0, 120)}`);
      continue;
    }

    for (const c of changes) {
      if (FORBIDDEN.some((re) => re.test(c.file_path))) {
        result.skippedForbidden.push(c.file_path);
        continue;
      }

      const prior = fileOwner.get(c.file_path);
      if (prior !== undefined) {
        // Same file modified by two agents → first wins. Track conflict.
        const existing = result.conflicts.find((x) => x.file === c.file_path);
        if (existing) {
          if (!existing.agents.includes(idx)) existing.agents.push(idx);
        } else {
          result.conflicts.push({ file: c.file_path, agents: [prior, idx] });
        }
        continue;
      }
      fileOwner.set(c.file_path, idx);

      const dst = path.join(canonicalPath, c.file_path);
      try {
        if (c.action === "delete") {
          if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        } else {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          if (typeof c.content === "string") {
            fs.writeFileSync(dst, c.content);
          } else {
            // Binary content placeholder — copy raw bytes from src
            const src = path.join(sub, c.file_path);
            if (fs.existsSync(src)) {
              fs.copyFileSync(src, dst);
            }
          }
        }
        result.applied++;
      } catch (e: any) {
        logWarn(`mergeSubWorktrees: failed to apply ${c.file_path}: ${e.message.substring(0, 120)}`);
      }
    }
  }

  return result;
}

/**
 * Check if there are any active worktrees.
 */
function getActiveWorktrees(): string[] {
  if (!fs.existsSync(WORKTREES_DIR)) return [];
  try {
    return fs.readdirSync(WORKTREES_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return []; }
}

module.exports = {
  REPO_CACHE_DIR,
  WORKTREES_DIR,
  ensureLocalRepo,
  localGetTree,
  localGetFile,
  localResetRepo,
  localGetChanges,
  localGetOriginal,
  createWorktree,
  removeWorktree,
  cleanOrphanedWorktrees,
  getActiveWorktrees,
  // M1: per-agent sub-worktree support
  createSubWorktree,
  removeSubWorktree,
  removeAllSubWorktrees,
  mergeSubWorktrees,
};
