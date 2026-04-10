"use strict";

const fs = require("fs");
const path = require("path");
const { cfg, GIT_CLONE_DEPTH } = require("./config");
const { logOk, logErr, logInfo, logWarn, logDebug } = require("./logging");
const { isBinaryFile, isBinaryContent } = require("./utils");

const REPO_CACHE_DIR = path.join(__dirname, "..", ".repo-cache");

async function ensureLocalRepo() {
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
      } catch (e) {
        logWarn(`Cannot read .git/HEAD: ${e.message} — removing and re-cloning…`);
        fs.rmSync(REPO_CACHE_DIR, { recursive: true, force: true });
      }
    }
  }

  // G7: Git index lock cleanup
  const gitIndexLock = path.join(REPO_CACHE_DIR, ".git", "index.lock");
  if (fs.existsSync(gitIndexLock)) {
    logWarn("Removing stale .git/index.lock file…");
    try { fs.unlinkSync(gitIndexLock); } catch (e) { logWarn(`Could not remove index.lock: ${e.message}`); }
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
  } catch (e) {
    const detail = e.stderr ? e.stderr.toString().substring(0, 300) : e.message;
    logErr(`Local clone/pull failed: ${detail}`);
    logWarn("Falling back to GitLab API for reads");
    return null;
  }
}

function localGetTree(clonePath, dir = "", recursive = true) {
  const base = dir ? path.join(clonePath, dir) : clonePath;
  const results = [];
  const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".cache", "coverage"]);

  function walk(currentPath, relativeTo) {
    let entries;
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

function localGetFile(clonePath, filePath) {
  try {
    const resolved = path.resolve(clonePath, filePath);
    if (!resolved.startsWith(path.resolve(clonePath))) return null;

    // G6: Symlink escape guard
    try {
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(path.resolve(clonePath))) { logWarn(`G6: Symlink escape blocked: ${filePath}`); return null; }
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

function localResetRepo(clonePath) {
  const { execFileSync } = require("child_process");
  logInfo(`Resetting local repo to clean state…`);
  // Use "checkout -f ." instead of "checkout -f <branch>" — works in both worktree and main clone contexts
  execFileSync("git", ["-C", clonePath, "checkout", "-f", "."], { stdio: "pipe", timeout: 30_000 });
  // T2.22: Exclude important untracked files from clean
  execFileSync("git", ["-C", clonePath, "clean", "-fd", "-e", ".env", "-e", ".env.*", "-e", ".api-token", "-e", ".state-secret", "-e", ".debug"], { stdio: "pipe", timeout: 30_000 });
  logOk("Local repo reset to clean state");
}

function localGetChanges(clonePath) {
  const { execFileSync } = require("child_process");
  const output = execFileSync("git", ["-C", clonePath, "status", "--porcelain"], { encoding: "utf8", timeout: 15_000 }).trim();
  if (!output) return [];

  let diffOutput = "";
  try {
    diffOutput = execFileSync("git", ["-C", clonePath, "diff", "--name-status", "HEAD"], { encoding: "utf8", timeout: 15_000 }).trim();
  } catch { /* no HEAD yet or other issue */ }

  const changes = [];
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

    let action;
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

function localGetOriginal(clonePath, filePath) {
  const { execFileSync } = require("child_process");
  try {
    return execFileSync("git", ["-C", clonePath, "show", `HEAD:${filePath}`], { encoding: "utf8", timeout: 10_000 });
  } catch {
    return null;
  }
}

// ── Multi-ticket worktree support ──────────────────────────────────

const WORKTREES_DIR = path.join(REPO_CACHE_DIR, ".worktrees");
const MIN_DISK_MB = 1024; // 1GB minimum free disk space

/**
 * Create a detached-HEAD git worktree for a ticket.
 * If the worktree already exists, reset it instead of creating new.
 * @param {string} ticket - Ticket ID (e.g., "AUT-8203")
 * @returns {string} Path to the worktree directory
 */
function createWorktree(ticket) {
  const { execFileSync } = require("child_process");
  const os = require("os");

  if (!ticket) throw new Error("createWorktree: ticket is required");

  const wtPath = path.join(WORKTREES_DIR, ticket);

  // Disk space check
  try {
    const stats = fs.statfsSync ? fs.statfsSync(REPO_CACHE_DIR) : null;
    if (stats) {
      const freeMB = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
      if (freeMB < MIN_DISK_MB) {
        throw new Error(`Insufficient disk space for worktree (need ${MIN_DISK_MB}MB, have ${freeMB}MB)`);
      }
    }
  } catch (e) {
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
    } catch (e) {
      logWarn(`Failed to reset existing worktree: ${e.message} — removing and recreating…`);
      removeWorktree(ticket);
    }
  }

  // Ensure worktrees parent dir exists
  if (!fs.existsSync(WORKTREES_DIR)) {
    fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  }

  // Get latest enterprise-ts commit SHA
  const sha = execFileSync("git", ["-C", REPO_CACHE_DIR, "rev-parse", `origin/${cfg.branch.ts}`],
    { encoding: "utf8", timeout: 10_000 }).trim();

  logInfo(`Creating worktree for ${ticket} at ${sha.substring(0, 8)}…`);
  execFileSync("git", ["-C", REPO_CACHE_DIR, "worktree", "add", "--detach", wtPath, sha],
    { stdio: "pipe", timeout: 60_000 });

  logOk(`Worktree created: ${wtPath}`);
  return wtPath;
}

/**
 * Remove a ticket's git worktree.
 * Falls back to rm -rf + git worktree prune on failure.
 * @param {string} ticket - Ticket ID
 */
function removeWorktree(ticket) {
  const { execFileSync } = require("child_process");
  if (!ticket) return;

  const wtPath = path.join(WORKTREES_DIR, ticket);
  if (!fs.existsSync(wtPath)) return;

  logInfo(`Removing worktree for ${ticket}…`);
  try {
    execFileSync("git", ["-C", REPO_CACHE_DIR, "worktree", "remove", wtPath, "--force"],
      { stdio: "pipe", timeout: 30_000 });
  } catch (e) {
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
 * Called at server startup.
 */
function cleanOrphanedWorktrees() {
  const { execFileSync } = require("child_process");

  if (!fs.existsSync(WORKTREES_DIR)) return;

  let entries;
  try { entries = fs.readdirSync(WORKTREES_DIR, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ticket = entry.name;
    const lockPath = path.join(__dirname, "..", `state-${ticket}.lock`);

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
      logInfo(`Cleaning orphaned worktree: ${ticket}`);
      removeWorktree(ticket);
    }
  }

  // Prune any stale git worktree references
  try {
    execFileSync("git", ["-C", REPO_CACHE_DIR, "worktree", "prune"],
      { stdio: "pipe", timeout: 10_000 });
  } catch {}
}

/**
 * Check if there are any active worktrees.
 * @returns {string[]} List of ticket IDs with active worktrees
 */
function getActiveWorktrees() {
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
};
