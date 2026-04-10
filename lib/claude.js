"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { cfg, TICKET, SAVE_DEBUG_OUTPUT } = require("./config");
const { logOk, logInfo, logWarn, logDebug } = require("./logging");
const { validatePromptSize, truncateWithIndicator } = require("./utils");
const { getCurrentState, save } = require("./state");
const { gl } = require("./gitlab");
const { localGetTree, localGetFile } = require("./local-repo");

const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT, 10) || 180_000;

// ── Single Claude CLI invocation (no retry logic) ─────────────────
async function _callClaudeOnce(prompt, timeoutMs, opts = {}) {
  prompt = validatePromptSize(prompt, opts.agentName || "Claude");

  return new Promise((resolve, reject) => {
    const maxTurns = String(opts.maxTurns || 4);
    const args = ["-p", "--output-format", "text", "--max-turns", maxTurns];
    const model = process.env.CLAUDE_MODEL;
    if (model) args.push("--model", model);
    if (opts.allowedTools) {
      args.push("--allowedTools", opts.allowedTools.join(","));
    }

    // Fix 2b: Whitelist env vars
    const ALLOWED_ENV = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
      "NODE_PATH", "NODE_OPTIONS", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
      "ANTHROPIC_API_KEY", "CLAUDE_MODEL", "npm_config_prefix"];
    const cleanEnv = {};
    for (const k of ALLOWED_ENV) {
      if (process.env[k]) cleanEnv[k] = process.env[k];
    }

    const spawnOpts = { stdio: ["pipe", "pipe", "pipe"], env: cleanEnv, detached: true };
    if (opts.cwd) spawnOpts.cwd = opts.cwd;

    const agentName = opts.agentName || "Claude";
    const proc = spawn("claude", args, spawnOpts);
    // T1.7: Track Claude subprocess for graceful-shutdown cleanup (do NOT unref)
    const { trackChildProcess } = require("./graceful-shutdown");
    trackChildProcess(proc, `Claude [${agentName}]`);

    let stdout = "";
    let stderr = "";
    let done = false;
    let killTimer = null;
    const claudeStart = Date.now();

    const _currentState = getCurrentState();
    if (_currentState) { _currentState.data._claude_pid = proc.pid; try { save(_currentState); } catch {} }

    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - claudeStart) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      logInfo(`[${agentName}] Working… ${timeStr} elapsed`);
      const cs = getCurrentState();
      if (cs) {
        cs.data._lastActivity = new Date().toISOString();
        try { save(cs); } catch {}
      }
    }, 30_000);

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        clearInterval(heartbeat);
        try { process.kill(-proc.pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch {} }
        killTimer = setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} } }, 10_000);
        reject(new Error(`Claude CLI timed out after ${timeoutMs / 1000}s`));
      }
    }, timeoutMs);

    const MAX_STDOUT = 2_000_000;
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_STDOUT && !done) {
        done = true; clearTimeout(timer); clearInterval(heartbeat);
        try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
        reject(new Error(`Claude output too large (>${MAX_STDOUT} bytes) — killed`));
      }
    });
    // T2.21: Cap stderr to 1MB to prevent unbounded memory growth
    const MAX_STDERR = 1_000_000;
    proc.stderr.on("data", (d) => {
      if (stderr.length < MAX_STDERR) {
        stderr += d.toString().substring(0, MAX_STDERR - stderr.length);
      }
    });

    proc.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (killTimer) clearTimeout(killTimer);
      const cs = getCurrentState();
      if (cs) { cs.data._claude_pid = null; }

      if (SAVE_DEBUG_OUTPUT) {
        try {
          const debugDir = path.join(__dirname, "..", ".debug", TICKET);
          fs.mkdirSync(debugDir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const debugFile = path.join(debugDir, `${agentName.replace(/\s+/g, "-")}-${ts}.txt`);
          const debugContent = `=== PROMPT (${prompt.length} chars) ===\n${prompt.substring(0, 50000)}\n\n=== STDOUT (${stdout.length} chars) ===\n${stdout}\n\n=== STDERR ===\n${stderr}\n\n=== EXIT CODE: ${code} ===\n`;
          fs.writeFileSync(debugFile, debugContent);
          logDebug(`O3: Debug output saved to ${debugFile}`);
        } catch (debugErr) {
          logDebug(`O3: Could not save debug output: ${debugErr.message}`);
        }
      }

      if (code !== 0) {
        const errDetail = stderr.trim() || stdout.substring(0, 500).trim() || "(no output)";
        reject(new Error(`Claude CLI error (${code}): ${errDetail}`));
      } else {
        if (stderr.trim()) {
          logInfo(`[${agentName}] stderr (${stderr.length} chars): ${stderr.slice(-500)}`);
        }
        resolve(stdout.trim());
      }
    });

    proc.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (killTimer) clearTimeout(killTimer);
      const cs = getCurrentState();
      if (cs) { cs.data._claude_pid = null; }
      reject(new Error(`Failed to start claude CLI: ${e.message}. Is Claude Code installed?`));
    });

    proc.stdin.on("error", () => {});
    try {
      const ok = proc.stdin.write(prompt);
      if (!ok) {
        proc.stdin.once("drain", () => { try { proc.stdin.end(); } catch {} });
      } else {
        proc.stdin.end();
      }
    } catch {}
  });
}

// ── Public wrapper: logging + retry-on-timeout ────────────────────
async function callClaude(prompt, timeoutMs = CLAUDE_TIMEOUT, opts = {}) {
  const agentName = opts.agentName || "Claude";
  const maxTurns = opts.maxTurns || 4;
  const retryEnabled = opts.retry !== false;
  const callStart = Date.now();

  // Layer 4: Prompt size logging
  const promptChars = prompt.length;
  const estimatedTokens = Math.round(promptChars / 4);
  logInfo(`[${agentName}] Prompt: ${promptChars} chars (~${estimatedTokens} tokens) | Timeout: ${timeoutMs / 1000}s | MaxTurns: ${maxTurns}`);
  if (promptChars > 100_000) {
    logWarn(`[${agentName}] Prompt exceeds 100K chars (${promptChars}) — consider reducing context`);
  }

  try {
    const result = await _callClaudeOnce(prompt, timeoutMs, opts);
    const elapsedSec = ((Date.now() - callStart) / 1000).toFixed(1);
    logOk(`[${agentName}] Complete in ${elapsedSec}s`);
    return result;
  } catch (err) {
    const isTimeout = err.message && err.message.includes("timed out after");

    if (isTimeout && retryEnabled) {
      const retryTimeout = Math.round(timeoutMs * 1.5);
      const retryMaxTurns = Math.max(2, Math.floor(maxTurns / 2));
      logWarn(`[${agentName}] Timeout — retrying with ${retryTimeout / 1000}s timeout, ${retryMaxTurns} maxTurns (degraded)`);

      const retryResult = await _callClaudeOnce(prompt, retryTimeout, { ...opts, maxTurns: retryMaxTurns });
      const elapsedSec = ((Date.now() - callStart) / 1000).toFixed(1);
      logOk(`[${agentName}] Complete in ${elapsedSec}s (after retry)`);
      return retryResult;
    }

    throw err;
  }
}

// ── Fetch repo tree + key files for Claude context ────────────────
async function fetchRepoContext(ticket, summary, description, ac, feedback, state) {
  let tree;
  if (cfg.localRepo) {
    logInfo("Fetching repository structure from local clone…");
    tree = localGetTree(cfg.localRepo);
  } else {
    logInfo("Fetching repository structure from enterprise-ts (GitLab API)…");
    tree = await gl.getTree("", cfg.branch.ts, true);
  }
  const SRC_EXT = /\.(tsx?|jsx?|css|scss|less|json)$/i;
  const SKIP = /node_modules|\.next|dist\/|build\/|\.git\/|__pycache__|\.cache|\.husky|coverage|\.nyc|\.storybook|public\/static|assets\/(images|fonts|icons)|\.svg$|\.png$|\.jpg$|\.ico$|\.woff|\.ttf|\.map$|package-lock|yarn\.lock|\.eslint|\.prettier|\.spec\.|\.test\.|__tests__|__mocks__/i;
  const srcTree = tree.filter((e) => e.type === "blob" && SRC_EXT.test(e.path) && !SKIP.test(e.path));
  const treeStr = srcTree
    .slice(0, 200)
    .map((e) => `📄 ${e.path}`)
    .join("\n");
  logInfo(`Repo: ${tree.length} total → ${srcTree.length} source files`);

  let filesToRead = [];
  const plan = (state && state.data && state.data.explore_plan) || "";
  if (plan) {
    const pathMatches = plan.match(/(?:src|lib|app|pages|components|hooks|utils|services|constants|types|styles)\/[\w\-./]+\.\w+/g) || [];
    filesToRead = [...new Set(pathMatches)];
    logInfo(`Extracted ${filesToRead.length} file(s) from plan`);
  }

  if (filesToRead.length === 0) {
    logInfo("Identifying relevant files…");
    const fileListResp = await callClaude(
      `Repository (${srcTree.length} source files):\n${treeStr}\n\n` +
      `Ticket: ${ticket} — ${summary}\n${description}\nAC: ${ac}\n` +
      `${feedback ? `Feedback: ${feedback}\n` : ""}` +
      `Return ONLY a JSON array of file paths to read for this ticket. Max 20 files:\n["path/file.js"]`,
    );
    try {
      filesToRead = JSON.parse(fileListResp.match(/\[[\s\S]*?\]/)?.[0] || "[]");
    } catch {
      filesToRead = [];
    }
  }

  if (filesToRead.length === 0 && srcTree.length > 0) {
    logWarn("No relevant files identified — falling back to first 50 source files");
    filesToRead = srcTree.slice(0, 50).map((e) => e.path);
  }

  // GQ6: Always include config files
  const CONFIG_FILES = ["tsconfig.json", "vite.config.ts", "vite.config.js"];
  const CONFIG_PATTERNS = [/^\.eslintrc/, /^\.prettierrc/, /^tsconfig\./];
  const allTreePaths = tree.map((e) => e.path);
  for (const cf of CONFIG_FILES) {
    if (allTreePaths.includes(cf) && !filesToRead.includes(cf)) {
      filesToRead.push(cf);
    }
  }
  for (const pat of CONFIG_PATTERNS) {
    for (const tp of allTreePaths) {
      if (pat.test(path.basename(tp)) && !filesToRead.includes(tp)) {
        filesToRead.push(tp);
      }
    }
  }

  const fileCap = cfg.localRepo ? 40 : 25;
  const source = cfg.localRepo ? "local clone" : "GitLab";
  logInfo(`Reading ${Math.min(filesToRead.length, fileCap)} file(s) from ${source}…`);
  const fileContents = {};
  for (const fp of filesToRead.slice(0, fileCap)) {
    const content = cfg.localRepo
      ? localGetFile(cfg.localRepo, fp)
      : await gl.getFile(fp, cfg.branch.ts);
    if (content) {
      fileContents[fp] = content;
      logOk(`  ${fp}`);
    }
  }

  const readCount = Object.keys(fileContents).length;
  if (readCount === 0) {
    logWarn(`No files could be read from ${source} — code gen may produce poor results`);
  } else {
    logOk(`Read ${readCount} file(s) from ${source}`);
  }

  const MAX_PROMPT_SIZE = 120_000;
  let fileContext = "";
  for (const [p, c] of Object.entries(fileContents)) {
    const entry = `── ${p} ──\n${truncateWithIndicator(c, 6000)}\n\n`;
    if (fileContext.length + entry.length > MAX_PROMPT_SIZE) {
      logWarn(`File context capped at ${MAX_PROMPT_SIZE} chars (skipping remaining files)`);
      break;
    }
    fileContext += entry;
  }

  return { treeStr, fileContext };
}

module.exports = { callClaude, fetchRepoContext, CLAUDE_TIMEOUT };
