"use strict";

import type { PipelineState } from '@mi/shared';

const fs = require("fs");
const path = require("path");
const { cfg, DEVELOPER_TIMEOUT_MS, BUILD_INSTALL_TIMEOUT, BUILD_TSC_TIMEOUT, BUILD_ESLINT_TIMEOUT, BUILD_FIXER_MAX_TURNS, applyComplexityTimeout } = require("../../lib/config");
const { logInfo, logOk, logWarn } = require("../../lib/logging");
const { save } = require("../../lib/state");
const { runSingleAgent } = require("../../lib/agents-team");
const { localGetChanges, localGetOriginal } = require("../../lib/local-repo");
const { _validateDevChanges } = require("./developer");

// M3: Smarter context truncation for fixer prompts. Taking the first 3000
// chars can hide the root-cause error (e.g. the missing import that
// cascaded into 200 type errors). Instead, keep the first N error-lines
// and the last N — root cause + final summary.
function truncateErrorOutput(output: string, headLines = 80, tailLines = 40): string {
  const lines = (output || "").split(/\r?\n/);
  if (lines.length <= headLines + tailLines) return lines.join("\n");
  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(-tailLines).join("\n");
  const omitted = lines.length - headLines - tailLines;
  return `${head}\n\n[... ${omitted} lines omitted ...]\n\n${tail}`;
}

// H5: Hard cap on Build Fixer attempts. Previously a single boolean
// `_build_fix_attempted` prevented re-entry within one run, but if tsc kept
// emitting new errors after each fix the wrapper was bounded only by the
// per-stage timeout. We now count attempts persistently in state and refuse
// to spawn a new fixer once the cap is hit.
const BUILD_FIXER_ATTEMPT_CAP = 3;

/**
 * Q5: Build verification — tsc + eslint + Build Fixer Agent.
 */
async function runBuildCheck(state: PipelineState, fileChanges: any[], originalFiles: Record<string, string>): Promise<any[]> {
  logInfo("Q5: Running build verification (tsc + eslint)…");
  const { execSync } = require("child_process");
  const buildErrors: Array<{type: string; output: string}> = [];

  try {
    // 1. Ensure node_modules exists
    const nmPath = path.join(cfg.localRepo, "node_modules");
    if (!fs.existsSync(nmPath)) {
      logInfo("  Installing dependencies (npm install --ignore-scripts)…");
      try {
        execSync("npm install --ignore-scripts", { cwd: cfg.localRepo, timeout: BUILD_INSTALL_TIMEOUT, stdio: "pipe" });
        logOk("  Dependencies installed");
      } catch (e: any) {
        logWarn(`  npm install failed: ${(e.message || "").substring(0, 200)}`);
      }
    }

    // 2. Run tsc --noEmit
    try {
      logInfo("  Running TypeScript check…");
      execSync("npx tsc --noEmit --pretty 2>&1 | head -50", { cwd: cfg.localRepo, timeout: BUILD_TSC_TIMEOUT, stdio: "pipe", shell: true });
      logOk("  TypeScript: No errors");
      (state.data as any)._build_tsc = "PASS";
    } catch (tscErr: any) {
      // M3: head+tail truncation preserves root-cause errors that bare
      // `.substring(0, 3000)` could drop.
      const tscOutput = truncateErrorOutput((tscErr.stdout || tscErr.stderr || "").toString());
      logWarn(`  TypeScript errors found:\n${tscOutput.substring(0, 500)}`);
      buildErrors.push({ type: "typescript", output: tscOutput });
      (state.data as any)._build_tsc = "FAIL";
    }

    // 3. Run eslint on changed files
    const changedPaths = fileChanges.map((c: any) => c.file_path).filter((p: string) => /\.(tsx?|jsx?)$/.test(p));
    if (changedPaths.length > 0) {
      try {
        logInfo(`  Running ESLint on ${changedPaths.length} file(s)…`);
        const escapePath = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
        const eslintCmd = `npx eslint ${changedPaths.map(escapePath).join(" ")} --format json 2>&1`;
        execSync(eslintCmd, { cwd: cfg.localRepo, timeout: BUILD_ESLINT_TIMEOUT, stdio: "pipe", shell: true });
        logOk("  ESLint: No errors");
        (state.data as any)._build_eslint = "PASS";
      } catch (eslintErr: any) {
        const eslintOutput = truncateErrorOutput((eslintErr.stdout || eslintErr.stderr || "").toString());
        logWarn(`  ESLint errors found`);
        buildErrors.push({ type: "eslint", output: eslintOutput });
        (state.data as any)._build_eslint = "FAIL";
      }
    } else {
      (state.data as any)._build_eslint = "SKIP";
    }

    // If build errors → pass to Fixer Agent. H5: bounded by an attempt
    // counter so cascading errors can't loop forever.
    const buildFixAttempts = ((state.data as any)._build_fix_attempts as number | undefined) || 0;
    if (buildErrors.length > 0 && buildFixAttempts < BUILD_FIXER_ATTEMPT_CAP) {
      logInfo(`Q5: Build errors found — sending to Fixer Agent (attempt ${buildFixAttempts + 1}/${BUILD_FIXER_ATTEMPT_CAP})…`);
      (state.data as any)._build_fix_attempts = buildFixAttempts + 1;
      (state.data as any)._build_fix_attempted = true; // back-compat for any reader
      save(state);
      const buildIssues = buildErrors.map((e) => `## [BUILD-${e.type.toUpperCase()}]\n\`\`\`\n${e.output}\n\`\`\``).join("\n\n");
      const fixResult = await runSingleAgent({
        name: "Build Fixer Agent",
        prompt: `You are the **Build Fixer Agent**. Fix ALL build errors below.\n\n` +
          `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Read the flagged files and fix them directly using Write/Edit.\n\n` +
          `${buildIssues}\n\n` +
          `## Changed files:\n${fileChanges.map((c: any) => `- ${c.action}: ${c.file_path}`).join("\n")}\n\n` +
          `Read the erroring files, fix the build issues, and confirm what you changed.`,
        timeout: applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
        opts: { cwd: cfg.localRepo, maxTurns: BUILD_FIXER_MAX_TURNS, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
        state,
        checkpointKey: "_build_fix_result",
        required: false,
      });
      if (fixResult) {
        logOk("Build Fixer Agent complete — re-extracting changes");
        fileChanges = localGetChanges(cfg.localRepo);
        for (const c of fileChanges) {
          if (c.action === "update" && !originalFiles[c.file_path]) {
            const orig = localGetOriginal(cfg.localRepo, c.file_path);
            if (orig) originalFiles[c.file_path] = orig;
          }
        }
        // H2: validate the fixer's output — a Build Fixer can introduce
        // unresolved imports or write to forbidden paths just like any
        // other agent.
        _validateDevChanges(state);
      } else {
        logWarn("Build Fixer Agent failed — proceeding with build errors");
      }
    } else if (buildErrors.length > 0 && buildFixAttempts >= BUILD_FIXER_ATTEMPT_CAP) {
      logWarn(`Q5: Build errors persist after ${BUILD_FIXER_ATTEMPT_CAP} fixer attempts — giving up on automated fixes`);
    }
  } catch (buildErr: any) {
    logWarn(`Q5: Build verification error: ${buildErr.message}`);
  }
  (state.data as any)._build_checked = true;
  save(state);

  return fileChanges;
}

export { runBuildCheck };
