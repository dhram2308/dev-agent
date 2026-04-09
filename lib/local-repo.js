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
      logInfo(`  fetch + reset to origin/${branch} (depth: ${GIT_CLONE_DEPTH})…`);
      execFileSync("git", ["-C", REPO_CACHE_DIR, "fetch", "origin", branch, `--depth=${GIT_CLONE_DEPTH}`],
        { stdio: "pipe", timeout: 120_000 });
      execFileSync("git", ["-C", REPO_CACHE_DIR, "reset", "--hard", `origin/${branch}`],
        { stdio: "pipe", timeout: 30_000 });
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
  const branch = cfg.branch.ts;
  logInfo(`Resetting local repo to clean ${branch} state…`);
  execFileSync("git", ["-C", clonePath, "checkout", "-f", branch], { stdio: "pipe", timeout: 30_000 });
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

module.exports = {
  REPO_CACHE_DIR,
  ensureLocalRepo,
  localGetTree,
  localGetFile,
  localResetRepo,
  localGetChanges,
  localGetOriginal,
};
