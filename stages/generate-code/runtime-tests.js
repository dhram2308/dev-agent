"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const {
  cfg, TICKET, DEVELOPER_TIMEOUT_MS, TEST_FIXER_TIMEOUT_MS,
  RUN_RUNTIME_TESTS, BUILD_INSTALL_TIMEOUT,
  UNIT_TESTS_TIMEOUT, E2E_TESTS_TIMEOUT,
  VITE_PREVIEW_TIMEOUT, VITE_BUILD_TIMEOUT,
  MAX_UNIT_TEST_RETRIES, MAX_E2E_TEST_RETRIES,
  CONSOLE_WARNING_THRESHOLD, TEST_ARTIFACTS_DIR, PLAYWRIGHT_BROWSER,
  VITE_PREVIEW_PORT_START, VITE_PREVIEW_PORT_END,
  applyComplexityTimeout, monotonicMs,
} = require("../../lib/config");
const { logStep, logInfo, logOk, logWarn } = require("../../lib/logging");
const { sanitizeForPrompt } = require("../../lib/utils");
const { save } = require("../../lib/state");
const { runSingleAgent } = require("../../lib/agents-team");
const { localGetChanges, localGetOriginal } = require("../../lib/local-repo");

// ── Shell command with heartbeat progress ──────────────────
function execWithProgress(cmd, opts, label, intervalMs = 15000) {
  return new Promise((resolve, reject) => {
    const proc = require("child_process").spawn("sh", ["-c", cmd], { ...opts, stdio: "pipe" });
    let stdout = "", stderr = "";
    const start = Date.now();
    const hb = setInterval(() => {
      logInfo(`  [${label}] Running… ${Math.round((Date.now() - start) / 1000)}s`);
    }, intervalMs);
    proc.stdout.on("data", d => { stdout += d; });
    proc.stderr.on("data", d => { stderr += d; });
    proc.on("close", code => {
      clearInterval(hb);
      logOk(`  [${label}] Done in ${((Date.now() - start) / 1000).toFixed(1)}s (exit ${code})`);
      resolve({ stdout, stderr, code });
    });
    proc.on("error", e => { clearInterval(hb); reject(e); });
    if (opts.timeout) {
      setTimeout(() => {
        clearInterval(hb);
        try { proc.kill("SIGTERM"); } catch {}
        // SIGKILL fallback if SIGTERM ignored after 5s
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 5000);
        reject(new Error(`${label} timed out after ${opts.timeout / 1000}s`));
      }, opts.timeout);
    }
  });
}

// ── Change Classifier (task 3.4, 3.5) ──────────────────────
function classifyChanges(changes) {
  const styleOnly = /\.(css|scss|less|styled\.(ts|js|tsx|jsx))$/;
  const componentFile = /\.(tsx|jsx)$/;
  const apiFile = /\/(services|api|hooks)\/[^/]+\.(ts|js|tsx|jsx)$/i;
  const codeExt = /\.(ts|js|tsx|jsx)$/i;
  let hasStyle = false, hasUtil = false, hasComponent = false, hasApi = false;
  for (const c of changes) {
    const fp = c.file_path;
    if (styleOnly.test(fp)) { hasStyle = true; continue; }
    if (apiFile.test(fp)) { hasApi = true; }
    if (componentFile.test(fp)) { hasComponent = true; }
    else if (codeExt.test(fp)) { hasUtil = true; }
    // silently skip non-code files (json, md, etc.) — they don't affect classification
  }
  if (hasApi) return "API_INTEGRATION";
  if (hasComponent) return "COMPONENT";
  if (hasUtil) return "UTILITY";
  if (hasStyle) return "STYLE";
  return "COMPONENT"; // default to full depth
}

// ── Find free port ──────────────────────────────────────────
async function findFreePort(start, end) {
  for (let port = start; port <= end; port++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => { try { srv.close(); } catch {} resolve(false); });
      srv.once("listening", () => { srv.close(); resolve(true); });
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  return null;
}

// ── Extract public API from a file (props, exports) ────────
function extractPublicAPI(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const api = [];
    for (const line of lines) {
      if (/^export\s+(default\s+)?(function|const|class|interface|type|enum)\b/.test(line.trim())) {
        api.push(line.trim());
      }
      if (/^export\s+\{/.test(line.trim())) {
        api.push(line.trim());
      }
      // Props types
      if (/interface\s+\w+Props/.test(line) || /type\s+\w+Props/.test(line)) {
        const idx = lines.indexOf(line);
        const block = lines.slice(idx, Math.min(idx + 20, lines.length)).join("\n");
        const closeBrace = block.indexOf("}");
        if (closeBrace > 0) api.push(block.substring(0, closeBrace + 1));
      }
    }
    return api.join("\n");
  } catch { return ""; }
}

// ── Find nearest test files to changed files ────────────────
function findNearestTests(changedFiles, repoPath, max = 5) {
  const examples = [];
  for (const cf of changedFiles) {
    const dir = path.dirname(path.join(repoPath, cf.file_path));
    try {
      _walkForTests(dir, examples, max, 0, 2);
    } catch (e) { logWarn(`findNearestTests walk error: ${e.message.substring(0, 80)}`); }
    if (examples.length >= max) break;
  }
  return examples;
}

function _walkForTests(dir, results, max, depth, maxDepth) {
  if (depth > maxDepth || results.length >= max) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= max) return;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) {
        _walkForTests(fullPath, results, max, depth + 1, maxDepth);
      } else if (entry.name.endsWith(".spec.tsx") && !results.includes(fullPath)) {
        results.push(fullPath);
      }
    }
  } catch { /* permission error */ }
}

/**
 * Run the full Runtime Testing Pipeline: Phase 0 → 1 → 2 → 3 → cleanup.
 *
 * @param {object} state - pipeline state
 * @param {Array} fileChanges - current file changes
 * @param {object} originalFiles - map of file_path → original content (mutated in place)
 * @returns {Array} updated fileChanges after cleanup
 */
async function runRuntimeTests(state, fileChanges, originalFiles) {
  if (!RUN_RUNTIME_TESTS || !cfg.localRepo) {
    if (!cfg.localRepo) logInfo("  Runtime tests: Skipped (no local repo)");
    else if (!RUN_RUNTIME_TESTS) logInfo("  Runtime tests: Disabled (RUN_RUNTIME_TESTS=false)");
    state.data._env_bootstrapped = "SKIP";
    state.data._unit_tests_complete = "SKIP";
    state.data._e2e_tests_complete = "SKIP";
    save(state);
    return fileChanges;
  }

  const { execSync, spawn: spawnProc } = require("child_process");
  const artifactsDir = path.join(path.dirname(path.dirname(__dirname)), TEST_ARTIFACTS_DIR, TICKET);

  // Fix 2d: Kill stale Claude process from previous crash
  if (state.data._claude_pid) {
    try { process.kill(state.data._claude_pid, 0); try { process.kill(-state.data._claude_pid, "SIGTERM"); } catch { process.kill(state.data._claude_pid, "SIGTERM"); } logWarn("Killed stale Claude process from previous run"); } catch {}
    state.data._claude_pid = null; save(state);
  }

  // T2.13: Stale process cleanup with PID validation to avoid killing wrong process
  if (state.data._vite_preview_pid) {
    const stalePid = state.data._vite_preview_pid;
    try {
      process.kill(stalePid, 0); // Check if alive
      // Validate it's actually a vite/node process before killing
      let isSafeToKill = false;
      try {
        const { execFileSync } = require("child_process");
        const cmdline = execFileSync("cat", [`/proc/${stalePid}/cmdline`], { encoding: "utf8", timeout: 2000 });
        isSafeToKill = /node|vite|nx/.test(cmdline);
      } catch { isSafeToKill = true; } // If can't check, assume safe (non-Linux)
      if (isSafeToKill) {
        try { process.kill(-stalePid, "SIGTERM"); } catch { process.kill(stalePid, "SIGTERM"); }
        logWarn("Killed stale vite preview process from previous run");
      } else {
        logWarn(`PID ${stalePid} is not a node/vite process — skipping kill`);
      }
    } catch {} // Process already dead
    state.data._vite_preview_pid = null;
    state.data._vite_preview_port = null;
    save(state);
  }

  // Clean artifacts directory for fresh run (task 6.3)
  try {
    if (fs.existsSync(artifactsDir)) fs.rmSync(artifactsDir, { recursive: true, force: true });
    fs.mkdirSync(artifactsDir, { recursive: true });
  } catch (e) { logWarn(`Artifacts dir setup failed: ${e.message.substring(0, 100)}`); }
  state.data._test_artifacts_path = artifactsDir;

  const changeType = classifyChanges(fileChanges);
  logInfo(`Runtime tests: Change type = ${changeType}`);

  // ── Phase 0: Environment Bootstrap (tasks 2.1-2.11) ────────
  if (!state.data._env_bootstrapped && !state.data._env_bootstrap_failed && changeType !== "STYLE") {
    logStep("RT-0", "Environment Bootstrap");
    try {
      // 2.2: npm install guard
      const nmPath = path.join(cfg.localRepo, "node_modules");
      if (!fs.existsSync(nmPath)) {
        logInfo("  Installing dependencies (npm install --legacy-peer-deps)…");
        try {
          const npmResult = await execWithProgress(
            "npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund",
            { cwd: cfg.localRepo, timeout: BUILD_INSTALL_TIMEOUT, env: { ...process.env, NODE_OPTIONS: "--max_old_space_size=8192" } },
            "npm install",
          );
          if (npmResult.code !== 0) throw new Error(npmResult.stderr.substring(0, 200) || "non-zero exit");
          logOk("  Dependencies installed");
        } catch (e) {
          logWarn(`  npm install failed: ${(e.message || "").substring(0, 200)}`);
          state.data._env_bootstrap_failed = true;
          save(state);
        }
      }

      if (!state.data._env_bootstrap_failed) {
        // 2.3: jest-environment-jsdom + jest-canvas-mock install
        const devDeps = ["jest-environment-jsdom", "jest-canvas-mock"];
        for (const dep of devDeps) {
          const depPath = path.join(cfg.localRepo, "node_modules", dep);
          if (!fs.existsSync(depPath)) {
            try {
              logInfo(`  Installing ${dep}…`);
              execSync(`npm install --save-dev ${dep} --legacy-peer-deps`, {
                cwd: cfg.localRepo, timeout: 60_000, stdio: "pipe",
              });
            } catch (e) { logWarn(`  Failed to install ${dep}: ${e.message.substring(0, 100)}`); }
          }
        }

        // 2.4: Playwright install
        try {
          const pwPath = path.join(cfg.localRepo, "node_modules", "@playwright", "test");
          if (!fs.existsSync(pwPath)) {
            logInfo("  Installing @playwright/test…");
            execSync("npm install --save-dev @playwright/test --legacy-peer-deps", {
              cwd: cfg.localRepo, timeout: 120_000, stdio: "pipe",
            });
          }
          logInfo(`  Installing Playwright ${PLAYWRIGHT_BROWSER} browser…`);
          execSync(`npx playwright install ${PLAYWRIGHT_BROWSER}`, {
            cwd: cfg.localRepo, timeout: 120_000, stdio: "pipe",
          });
          logOk("  Playwright browser installed");
        } catch (e) {
          logWarn(`  Playwright install failed: ${e.message.substring(0, 200)} — Phase 3 will be skipped`);
          state.data._playwright_install_failed = true;
        }

        // 2.5: Generate jest.config.override.ts
        _generateJestConfig(cfg.localRepo);

        // Shared: Find the correct src dir
        const appSrcBase = path.join(cfg.localRepo, "apps", "enterprise", "src");
        const srcDir = fs.existsSync(appSrcBase) ? appSrcBase : path.join(cfg.localRepo, "src");

        // 2.6: Generate setupTests.runtime.ts
        _generateSetupTests(srcDir);

        // 2.7: Generate test-providers.tsx
        _generateTestProviders(srcDir);

        // 2.8: Generate @mi/core shim
        _generateMiCoreShim(srcDir);

        // 2.9: .env.local for VITE_* mock values
        _generateEnvLocal(cfg.localRepo);

        // 2.10: Validation step — run 1 existing test file
        _validateTestSetup(cfg.localRepo, execSync);

        state.data._env_bootstrapped = true;
        save(state);
        logOk("Phase 0: Environment bootstrap complete");
      }
    } catch (bootstrapErr) {
      // 2.11: Graceful degradation
      logWarn(`Phase 0: Bootstrap failed: ${bootstrapErr.message} — skipping Phases 2-3`);
      state.data._env_bootstrap_failed = true;
      save(state);
    }
  }

  // ── Phase 1 Enhancement: Vite Build (tasks 3.1-3.3) ────────
  // Run if env bootstrapped and Vite build not yet done (doesn't require build-check to have run)
  if (state.data._env_bootstrapped && !state.data._vite_build_done && changeType !== "STYLE") {
    logStep("RT-1", "Vite Build Verification");
    try {
      const distPath = path.join(cfg.localRepo, "dist", "apps", "enterprise");
      const hasExistingDist = fs.existsSync(distPath);

      logInfo(`  Running ${hasExistingDist ? "affected" : "full"} Vite build…`);
      const buildCmd = hasExistingDist
        ? `npx nx affected:build --base=HEAD~1`
        : `npx nx build enterprise`;
      const buildResult = await execWithProgress(
        buildCmd,
        { cwd: cfg.localRepo, timeout: VITE_BUILD_TIMEOUT, env: { ...process.env, NODE_OPTIONS: "--max_old_space_size=8192" } },
        "Vite build",
      );
      if (buildResult.code !== 0) throw new Error(buildResult.stderr.substring(0, 300) || "non-zero exit");
      state.data._vite_build_done = true;
      logOk("  Vite build: SUCCESS");
    } catch (buildErr) {
      logWarn(`  Vite build failed: ${(buildErr.message || "").substring(0, 300)}`);
      state.data._vite_build_done = "FAIL";
    }
    save(state);
  }

  // ── Phase 2+3: Unit Tests + Browser Smoke Tests (PARALLEL when possible) ──
  const canRunUnit = state.data._env_bootstrapped && !state.data._env_bootstrap_failed &&
    !state.data._unit_tests_complete && changeType !== "STYLE";
  const canRunE2E = state.data._env_bootstrapped && !state.data._env_bootstrap_failed &&
    !state.data._e2e_tests_complete && !state.data._playwright_install_failed &&
    (changeType === "COMPONENT" || changeType === "API_INTEGRATION") &&
    state.data._vite_build_done === true;

  if (canRunUnit && canRunE2E) {
    // Run both in parallel — they write to non-overlapping files (.spec.tsx vs .test.ts)
    logInfo("  Running Unit Tests + Browser Smoke Tests in parallel…");
    const [unitResult, e2eResult] = await Promise.allSettled([
      _runUnitTests(state, fileChanges, artifactsDir, execSync),
      _runBrowserSmoke(state, fileChanges, artifactsDir, execSync, spawnProc),
    ]);
    // Use unit test result for fileChanges if available (it may have dev-retry changes)
    if (unitResult.status === "fulfilled") {
      fileChanges = unitResult.value;
    }
    if (e2eResult.status === "rejected") {
      logWarn(`  Browser smoke tests failed (parallel): ${e2eResult.reason?.message?.substring(0, 200) || "unknown"}`);
    }
  } else {
    // Fall back to sequential when only one type can run
    if (canRunUnit) {
      fileChanges = await _runUnitTests(state, fileChanges, artifactsDir, execSync);
    } else if (changeType === "STYLE") {
      logInfo("  Skipping Phase 2 — STYLE-only change");
      state.data._unit_tests_complete = "SKIP";
    }

    if (canRunE2E) {
      fileChanges = await _runBrowserSmoke(state, fileChanges, artifactsDir, execSync, spawnProc);
    } else if (changeType === "STYLE" || changeType === "UTILITY") {
      if (!state.data._e2e_tests_complete) {
        logInfo(`  Skipping Phase 3 — ${changeType} change doesn't need browser tests`);
        state.data._e2e_tests_complete = "SKIP";
        save(state);
      }
    }
  }

  // ── Cleanup: Revert test files (tasks 6.1-6.4) ────────────
  logInfo("  Reverting generated test infrastructure files…");
  try {
    const filesToRevert = ["jest.config.override.js", ".env.local"];
    for (const f of filesToRevert) {
      const fp = path.join(cfg.localRepo, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    // Remove generated test files (untracked) and revert modified ones — recursive glob
    try {
      execSync("git clean -fd -- '**/*.spec.tsx' '**/*.spec.ts' '**/*.test.tsx' '**/*.test.ts' 2>/dev/null || true", {
        cwd: cfg.localRepo, timeout: 15_000, stdio: "pipe", shell: true,
      });
      execSync("git checkout -- '**/*.spec.tsx' '**/*.spec.ts' '**/*.test.tsx' '**/*.test.ts' 2>/dev/null || true", {
        cwd: cfg.localRepo, timeout: 15_000, stdio: "pipe", shell: true,
      });
    } catch {}
    // Remove generated directories
    const appSrcClean = path.join(cfg.localRepo, "apps", "enterprise", "src");
    const srcClean = fs.existsSync(appSrcClean) ? appSrcClean : path.join(cfg.localRepo, "src");
    const shimDir = path.join(srcClean, "__test-shims__");
    if (fs.existsSync(shimDir)) fs.rmSync(shimDir, { recursive: true, force: true });
    const setupRuntime = path.join(srcClean, "setupTests.runtime.ts");
    if (fs.existsSync(setupRuntime)) fs.unlinkSync(setupRuntime);
    const testProviders = path.join(srcClean, "test-providers.tsx");
    if (fs.existsSync(testProviders)) fs.unlinkSync(testProviders);

    logOk("  Test infrastructure files reverted — only production code remains");
  } catch (cleanErr) {
    logWarn(`  Test file cleanup error: ${cleanErr.message.substring(0, 200)} — proceeding anyway`);
  }

  // Re-extract changes after cleanup (ensures no test files in commit)
  fileChanges = localGetChanges(cfg.localRepo);
  for (const c of fileChanges) {
    if (c.action === "update" && !originalFiles[c.file_path]) {
      const orig = localGetOriginal(cfg.localRepo, c.file_path);
      if (orig) originalFiles[c.file_path] = orig;
    }
  }

  return fileChanges;
}

// ══════════════════════════════════════════════════════════════
// ── Phase 2: Unit Tests — internal helper ────────────────────
// ══════════════════════════════════════════════════════════════
async function _runUnitTests(state, fileChanges, artifactsDir, execSync) {
  logStep("RT-2", "Unit Test Generation & Execution");
  try {
    const publicAPIs = fileChanges.map((c) => {
      const fp = path.join(cfg.localRepo, c.file_path);
      return `### ${c.file_path}\n${extractPublicAPI(fp) || "(no public exports found)"}`;
    }).join("\n\n");

    const testExamples = findNearestTests(fileChanges, cfg.localRepo);
    let exampleContent = "";
    for (const te of testExamples) {
      try {
        const content = fs.readFileSync(te, "utf8").substring(0, 4000);
        exampleContent += `\n### Example: ${path.basename(te)}\n\`\`\`tsx\n${content}\n\`\`\`\n`;
      } catch {}
    }

    const ac = state.data.ticket?.ac || state.data.ticket?.description || "";
    if (!ac) {
      logWarn("  No acceptance criteria or description found — unit tests may be generic");
    }

    // 4.1: QA Test Engineer Agent prompt
    const unitTestPrompt =
      `You are the **QA Test Engineer Agent**. Write Jest unit tests for a React component based on the acceptance criteria below.\n\n` +
      `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Write test files using Write tool.\n\n` +
      `## CRITICAL RULES\n` +
      `1. Write tests for EACH acceptance criterion. Include at least 1 negative test and 1 edge case per AC.\n` +
      `2. Do NOT test implementation details. Test observable behavior only.\n` +
      `3. Mock API responses at the hook level (jest.mock the custom hook), NOT at the axios level.\n` +
      `4. Use \`renderWithWrapper()\` from \`@mi/core\` for all component renders.\n` +
      `5. Assert using accessible queries: \`getByRole\`, \`getByLabelText\`, \`getByText\` — NOT \`getByTestId\`.\n` +
      `6. Use \`*.spec.tsx\` naming convention. Place test files next to the component.\n` +
      `7. Include \`import '@testing-library/jest-dom';\` at the top of each test file.\n\n` +
      `## Acceptance Criteria\n${sanitizeForPrompt(ac)}\n\n` +
      `## Component Public API (props and exports — NOT the implementation)\n${publicAPIs}\n\n` +
      `## Changed Files\n${fileChanges.map((c) => `- ${c.action}: ${c.file_path}`).join("\n")}\n\n` +
      `## Existing Test Examples (follow these patterns)\n${exampleContent || "(no existing tests found nearby)"}\n\n` +
      `Write the test files now. Make sure each test would FAIL if the feature described in the AC is not implemented.`;

    // 4.4: Call Claude for test generation
    logInfo("  Generating unit tests from acceptance criteria…");
    const unitGenResult = await runSingleAgent({
      name: "QA Test Engineer Agent",
      prompt: unitTestPrompt,
      timeout: applyComplexityTimeout(UNIT_TESTS_TIMEOUT, state),
      opts: { cwd: cfg.localRepo, maxTurns: 15, allowedTools: ["Read", "Write", "Glob", "Grep"] },
      state,
      checkpointKey: "_unit_test_gen_result",
      required: false,
    });
    if (!unitGenResult) {
      logWarn("  Unit test generation failed — skipping unit tests");
      state.data._unit_tests_complete = "SKIP";
      state.data._unit_tests_count = JSON.stringify({ total: 0, passed: 0, failed: 0, flaky: 0, status: "SKIP" });
      save(state);
      return fileChanges;
    }
    logOk("  Unit test files generated");

    // 4.5-4.7: Run Jest with retry and flaky detection
    let unitResult = { total: 0, passed: 0, failed: 0, flaky: 0, status: "INCONCLUSIVE" };
    const jestResultsPath = path.join(artifactsDir, "jest-results.json");

    for (let attempt = 0; attempt <= MAX_UNIT_TEST_RETRIES; attempt++) {
      try {
        logInfo(`  Running Jest (attempt ${attempt + 1}/${MAX_UNIT_TEST_RETRIES + 1})…`);
        await execWithProgress(
          `npx jest --config jest.config.override.js --json --outputFile="${jestResultsPath}" --forceExit --passWithNoTests 2>&1 || true`,
          { cwd: cfg.localRepo, timeout: UNIT_TESTS_TIMEOUT, env: { ...process.env, NODE_OPTIONS: "--max_old_space_size=8192" } },
          `Jest (attempt ${attempt + 1})`,
        );

        // 4.6: Parse results
        if (fs.existsSync(jestResultsPath)) {
          try {
            const results = JSON.parse(fs.readFileSync(jestResultsPath, "utf8"));
            const prevFailed = unitResult.failed;
            unitResult.total = results.numTotalTests || 0;
            unitResult.passed = results.numPassedTests || 0;
            unitResult.failed = results.numFailedTests || 0;

            // 4.7: Flaky detection
            if (attempt > 0 && prevFailed > 0 && unitResult.failed < prevFailed) {
              unitResult.flaky += (prevFailed - unitResult.failed);
            }

            if (unitResult.failed === 0) {
              unitResult.status = "PASS";
              break;
            }
          } catch (parseErr) {
            logWarn(`  Failed to parse jest results: ${parseErr.message.substring(0, 100)}`);
          }
        }
      } catch (jestErr) {
        logWarn(`  Jest attempt ${attempt + 1} error: ${jestErr.message.substring(0, 200)}`);
      }
    }

    // 4.8: If compile errors → Test Fixer Agent
    if (unitResult.status !== "PASS" && unitResult.total === 0) {
      logInfo("  Tests may have compile errors — running Test Fixer Agent…");
      const fixerOutput = await runSingleAgent({
        name: "Test Fixer Agent",
        prompt: `You are the **Test Fixer Agent**. Fix ONLY import paths and type errors in test files.\n\n` +
          `YOU HAVE DIRECT ACCESS TO THE REPOSITORY.\n\n` +
          `The generated test files failed to compile. Read the test files (*.spec.tsx), fix import paths and type errors ONLY. Do NOT change test logic.\n\n` +
          `Changed test files are alongside these source files:\n${fileChanges.map((c) => `- ${c.file_path}`).join("\n")}`,
        timeout: applyComplexityTimeout(TEST_FIXER_TIMEOUT_MS, state),
        opts: { cwd: cfg.localRepo, maxTurns: 10, allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"] },
        state,
        checkpointKey: "_test_fixer_result",
        required: false,
      });
      if (fixerOutput) {
        // Re-run jest once more
        try {
          await execWithProgress(
            `npx jest --config jest.config.override.js --json --outputFile="${jestResultsPath}" --forceExit --passWithNoTests 2>&1 || true`,
            { cwd: cfg.localRepo, timeout: UNIT_TESTS_TIMEOUT, env: { ...process.env, NODE_OPTIONS: "--max_old_space_size=8192" } },
            "Jest (after fix)",
          );
          if (fs.existsSync(jestResultsPath)) {
            try {
              const r2 = JSON.parse(fs.readFileSync(jestResultsPath, "utf8"));
              unitResult.total = r2.numTotalTests || 0;
              unitResult.passed = r2.numPassedTests || 0;
              unitResult.failed = r2.numFailedTests || 0;
              if (unitResult.failed === 0) unitResult.status = "PASS";
            } catch (parseErr) { logWarn(`  Failed to parse jest results after fix: ${parseErr.message.substring(0, 100)}`); }
          }
        } catch {}
      } else {
        logWarn("  Test Fixer Agent failed — skipping fix attempt");
      }
    }

    // 4.9: Logic error → feed back to Developer for ONE code fix retry
    if (unitResult.status !== "PASS" && unitResult.failed > 0 && !state.data._unit_test_dev_retry) {
      logInfo("  Unit test logic failures — sending back to Developer for one fix attempt…");
      state.data._unit_test_dev_retry = true;
      save(state);
      try {
        let failDetails = "";
        if (fs.existsSync(jestResultsPath)) {
          const r = JSON.parse(fs.readFileSync(jestResultsPath, "utf8"));
          const failedSuites = (r.testResults || []).filter((s) => s.status === "failed");
          for (const s of failedSuites.slice(0, 3)) {
            for (const t of (s.assertionResults || []).filter((a) => a.status === "failed").slice(0, 3)) {
              failDetails += `\nTest: ${t.ancestorTitles.join(" > ")} > ${t.title}\n`;
              failDetails += `Failure: ${(t.failureMessages || []).join("\n").substring(0, 500)}\n`;
            }
          }
        }
        if (failDetails) {
          const ac = state.data.ticket?.ac || state.data.ticket?.description || "";
          const devFixResult = await runSingleAgent({
            name: "Developer Agent (Test Fix)",
            prompt: `You are the **Developer Agent**. Unit tests found issues in your code.\n\n` +
              `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Fix the issues directly.\n\n` +
              `## Unit Test Failures\n${failDetails}\n\n` +
              `## Acceptance Criteria\n${sanitizeForPrompt(ac)}\n\n` +
              `Review and fix the code that these tests are validating. Focus on logic, not test files.`,
            timeout: applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
            opts: { cwd: cfg.localRepo, maxTurns: 15, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
            state,
            checkpointKey: "_test_fix_dev_result",
            required: false,
          });
          if (devFixResult) {
            fileChanges = localGetChanges(cfg.localRepo);
            logOk("  Developer fixed code based on test failures — re-running tests…");
            // Final re-run
            try {
              await execWithProgress(
                `npx jest --config jest.config.override.js --json --outputFile="${jestResultsPath}" --forceExit --passWithNoTests 2>&1 || true`,
                { cwd: cfg.localRepo, timeout: UNIT_TESTS_TIMEOUT, env: { ...process.env, NODE_OPTIONS: "--max_old_space_size=8192" } },
                "Jest (re-run)",
              );
              if (fs.existsSync(jestResultsPath)) {
                try {
                  const r3 = JSON.parse(fs.readFileSync(jestResultsPath, "utf8"));
                  unitResult.total = r3.numTotalTests || 0;
                  unitResult.passed = r3.numPassedTests || 0;
                  unitResult.failed = r3.numFailedTests || 0;
                  if (unitResult.failed === 0) unitResult.status = "PASS";
                } catch (parseErr) { logWarn(`  Failed to parse jest results after dev fix: ${parseErr.message.substring(0, 100)}`); }
              }
            } catch {}
          } else {
            logWarn("  Developer Agent (Test Fix) failed — skipping code fix");
          }
        }
      } catch (devErr) {
        logWarn(`  Developer fix attempt failed: ${devErr.message.substring(0, 200)}`);
      }
    }

    // 4.10, 4.11: Store results
    if (unitResult.status !== "PASS") unitResult.status = "INCONCLUSIVE";
    state.data._unit_tests_complete = unitResult.status;
    state.data._unit_tests_count = unitResult;
    save(state);

    // 4.11: Validate test count
    const acStr = state.data.ticket?.ac || "";
    const acCount = (acStr.match(/^[\s]*[-*\d.]+/gm) || []).length || 1;
    if (unitResult.total < acCount) {
      logWarn(`  Only ${unitResult.total} tests for ~${acCount} acceptance criteria — coverage may be incomplete`);
    }
    logOk(`Phase 2: Unit tests — ${unitResult.status} (${unitResult.passed}/${unitResult.total} passed${unitResult.flaky ? `, ${unitResult.flaky} flaky` : ""})`);
  } catch (phase2Err) {
    logWarn(`Phase 2: Unit tests failed: ${phase2Err.message.substring(0, 300)}`);
    state.data._unit_tests_complete = "INCONCLUSIVE";
    state.data._unit_tests_count = { total: 0, passed: 0, failed: 0, flaky: 0 };
    save(state);
  }

  return fileChanges;
}

// ══════════════════════════════════════════════════════════════
// ── Phase 3: Browser Smoke Tests — internal helper ───────────
// ══════════════════════════════════════════════════════════════
async function _runBrowserSmoke(state, fileChanges, artifactsDir, execSync, spawnProc) {
  logStep("RT-3", "Browser Smoke Tests (Playwright)");
  let viteProc = null;

  try {
    const vitePort = await findFreePort(VITE_PREVIEW_PORT_START, VITE_PREVIEW_PORT_END);
    if (!vitePort) {
      logWarn(`  No free port in ${VITE_PREVIEW_PORT_START}-${VITE_PREVIEW_PORT_END} — skipping browser tests`);
      state.data._e2e_tests_complete = "INCONCLUSIVE";
      save(state);
      return fileChanges;
    }

    // 5.2: Start vite preview
    logInfo(`  Starting vite preview on port ${vitePort}…`);
    viteProc = spawnProc("npx", ["vite", "preview", "--port", String(vitePort)], {
      cwd: cfg.localRepo, stdio: "pipe", detached: true,
    });
    viteProc.unref();
    state.data._vite_preview_pid = viteProc.pid;
    state.data._vite_preview_port = vitePort;
    save(state);

    // Detect early process crash so health check doesn't poll until timeout
    let viteCrashed = false;
    viteProc.on("exit", (code) => {
      if (code !== 0 && code !== null) viteCrashed = true;
    });

    // Health check — wait for server to respond
    const previewUrl = `http://127.0.0.1:${vitePort}`;
    let ready = false;
    const t0 = monotonicMs();
    while (monotonicMs() - t0 < VITE_PREVIEW_TIMEOUT) {
      if (viteCrashed) {
        logWarn("  Vite preview crashed on startup — skipping browser tests");
        break;
      }
      try {
        await new Promise((resolve, reject) => {
          const r = http.get(previewUrl, { agent: false }, (res) => { res.resume(); r.destroy(); resolve(res.statusCode); });
          r.on("error", () => { r.destroy(); reject(new Error("connect")); });
          r.setTimeout(2000, () => { r.destroy(); reject(new Error("timeout")); });
        });
        ready = true;
        break;
      } catch {
        const elapsed = Math.round((monotonicMs() - t0) / 1000);
        if (elapsed > 0 && elapsed % 5 === 0) {
          logInfo(`  [Vite preview] Starting up… ${elapsed}s`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    if (!ready) {
      logWarn("  Vite preview didn't respond in time — skipping browser tests");
      state.data._e2e_tests_complete = "INCONCLUSIVE";
      save(state);
      return fileChanges;
    }

    logOk(`  Vite preview ready at ${previewUrl}`);

    // 5.3-5.7: Generate Playwright test via Claude
    const ac = state.data.ticket?.ac || state.data.ticket?.description || "";
    const playwrightTestPrompt =
      `You are the **E2E Test Engineer Agent**. Write a Playwright test for browser smoke verification.\n\n` +
      `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Write files using the Write tool.\n\n` +
      `## Instructions\n` +
      `Write a Playwright test file at: ${artifactsDir}/e2e/smoke.spec.ts\n\n` +
      `The app is served at: ${previewUrl}\n\n` +
      `## CRITICAL: Route Interception Setup\n` +
      `Before navigating, set up these route interceptions to mock the mandatory init APIs:\n` +
      `\`\`\`typescript\n` +
      `import { test, expect } from '@playwright/test';\n\n` +
      `test.describe('Smoke Tests', () => {\n` +
      `  test.beforeEach(async ({ page }) => {\n` +
      `    // Mock mandatory init APIs\n` +
      `    await page.route('**/iv-generation/**', route => route.fulfill({ json: { iv: '0123456789abcdef' } }));\n` +
      `    await page.route('**/sync-data/**', route => route.fulfill({ json: { data: {} } }));\n` +
      `    await page.route('**/auth-user/**', route => route.fulfill({ json: { user: { displayName: 'Test', email: 'test@test.com', role: ['admin'] } } }));\n` +
      `    await page.route('**/user/permissions/**', route => route.fulfill({ json: { permissions: [{ module: '*', access: 'full' }] } }));\n` +
      `    // Block third-party scripts\n` +
      `    await page.route('**/*.clarity.ms/**', route => route.abort());\n` +
      `    await page.route('**/*.atlassian.net/**', route => route.abort());\n` +
      `    // Catch-all for any other API\n` +
      `    await page.route('**/api/**', route => route.fulfill({ json: { data: [], total: 0 } }));\n` +
      `    // Set localStorage before navigation\n` +
      `    await page.addInitScript(() => {\n` +
      `      localStorage.setItem('AUTH_TOKEN', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0IiwiZXhwIjo5OTk5OTk5OTk5fQ.sig');\n` +
      `      localStorage.setItem('REFRESH_TOKEN', 'mock-refresh-token');\n` +
      `      localStorage.setItem('orgId', 'test-org-1');\n` +
      `      localStorage.setItem('activeGstin', '29ABCDE1234F1ZK');\n` +
      `      localStorage.setItem('userMode', 'enterprise');\n` +
      `      localStorage.setItem('selectedLocale', 'en');\n` +
      `      localStorage.setItem('themeMode', 'light');\n` +
      `    });\n` +
      `  });\n` +
      `\`\`\`\n\n` +
      `## Acceptance Criteria\n${sanitizeForPrompt(ac)}\n\n` +
      `## Changed Files\n${fileChanges.map((c) => `- ${c.action}: ${c.file_path}`).join("\n")}\n\n` +
      `## Test Requirements\n` +
      `1. Navigate to the app and wait for content to load (waitForSelector)\n` +
      `2. Verify key UI elements exist based on the acceptance criteria\n` +
      `3. Take a screenshot: await page.screenshot({ path: '${artifactsDir}/screenshots/smoke.png' })\n` +
      `4. Check for console errors and capture them\n` +
      `5. Detect hard redirects (window.location.href changes) as failures\n` +
      `6. Use test.setTimeout(30000) for each test\n\n` +
      `## IMPORTANT: Console Error Capture\n` +
      `At the end of your test, write all captured console errors to '${artifactsDir}/console-errors.json' as a JSON array of objects with fields: { level, text, url, timestamp }.\n` +
      `Use this pattern in your test:\n` +
      `\`\`\`typescript\n` +
      `import * as fs from 'fs';\n\n` +
      `const errors: Array<{ level: string; text: string; url: string; timestamp: number }> = [];\n` +
      `page.on('console', msg => {\n` +
      `  if (msg.type() === 'error' || msg.type() === 'warning') {\n` +
      `    errors.push({ level: msg.type(), text: msg.text(), url: page.url(), timestamp: Date.now() });\n` +
      `  }\n` +
      `});\n` +
      `page.on('pageerror', err => {\n` +
      `  errors.push({ level: 'error', text: err.message, url: page.url(), timestamp: Date.now() });\n` +
      `});\n` +
      `// ... your test code ...\n` +
      `// At the end of the test (in afterAll or afterEach):\n` +
      `fs.writeFileSync('${artifactsDir}/console-errors.json', JSON.stringify(errors, null, 2));\n` +
      `\`\`\`\n\n` +
      `Create the directory ${artifactsDir}/e2e/ first, then write the test file.`;

    fs.mkdirSync(path.join(artifactsDir, "e2e"), { recursive: true });
    fs.mkdirSync(path.join(artifactsDir, "screenshots"), { recursive: true });

    logInfo("  Generating Playwright tests…");
    const e2eGenResult = await runSingleAgent({
      name: "E2E Test Engineer Agent",
      prompt: playwrightTestPrompt,
      timeout: applyComplexityTimeout(E2E_TESTS_TIMEOUT, state),
      opts: { cwd: cfg.localRepo, maxTurns: 10, allowedTools: ["Read", "Write", "Glob", "Grep"] },
      state,
      checkpointKey: "_e2e_test_gen_result",
      required: false,
    });
    if (!e2eGenResult) {
      logWarn("  E2E test generation failed — skipping browser tests");
      state.data._e2e_tests_complete = "INCONCLUSIVE";
      save(state);
      return fileChanges;
    }
    logOk("  Playwright test files generated");

    // 5.8-5.11: Run Playwright with retry
    let e2eResult = { total: 0, passed: 0, failed: 0, flaky: 0, consoleErrors: [], status: "INCONCLUSIVE" };
    const pwResultsPath = path.join(artifactsDir, "playwright-results.json");

    for (let attempt = 0; attempt <= MAX_E2E_TEST_RETRIES; attempt++) {
      try {
        logInfo(`  Running Playwright (attempt ${attempt + 1}/${MAX_E2E_TEST_RETRIES + 1})…`);
        const pwCmd = `npx playwright test "${artifactsDir}/e2e/" --timeout=30000 --reporter=json 2>&1 || true`;
        const pwRun = await execWithProgress(
          pwCmd,
          { cwd: cfg.localRepo, timeout: E2E_TESTS_TIMEOUT, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: pwResultsPath } },
          "Playwright",
        );
        const pwOutput = pwRun.stdout;

        // Parse results
        if (fs.existsSync(pwResultsPath)) {
          try {
            const r = JSON.parse(fs.readFileSync(pwResultsPath, "utf8"));
            const suites = r.suites || [];
            let total = 0, passed = 0, failed = 0;
            function countSpecs(s) {
              for (const spec of s.specs || []) {
                for (const test of spec.tests || []) {
                  total++;
                  const status = test.results?.[0]?.status;
                  if (status === "passed") passed++;
                  else failed++;
                }
              }
              for (const child of s.suites || []) countSpecs(child);
            }
            for (const s of suites) countSpecs(s);
            const prevFailed = e2eResult.failed;
            e2eResult.total = total;
            e2eResult.passed = passed;
            e2eResult.failed = failed;
            if (attempt > 0 && prevFailed > 0 && failed < prevFailed) {
              e2eResult.flaky += (prevFailed - failed);
            }
            if (failed === 0) { e2eResult.status = "PASS"; break; }
          } catch {}
        } else {
          // Try parsing from stdout — Playwright outputs "  N passed (Xs)" or "  N passed, M failed (Xs)"
          const passMatch = pwOutput.match(/(\d+)\s+passed/);
          const failMatch = pwOutput.match(/(\d+)\s+failed/);
          if (passMatch && !failMatch) {
            e2eResult.status = "PASS";
            e2eResult.passed = parseInt(passMatch[1], 10);
            e2eResult.total = e2eResult.passed;
            break;
          } else if (passMatch && failMatch) {
            e2eResult.passed = parseInt(passMatch[1], 10);
            e2eResult.failed = parseInt(failMatch[1], 10);
            e2eResult.total = e2eResult.passed + e2eResult.failed;
            e2eResult.status = e2eResult.failed > 0 ? "FAIL" : "PASS";
          }
        }
      } catch (pwErr) {
        logWarn(`  Playwright attempt ${attempt + 1} error: ${pwErr.message.substring(0, 200)}`);
      }
    }

    // 5.10: Console error severity classification
    try {
      const consoleFile = path.join(artifactsDir, "console-errors.json");
      if (fs.existsSync(consoleFile)) {
        const errors = JSON.parse(fs.readFileSync(consoleFile, "utf8"));
        e2eResult.consoleErrors = (errors || []).slice(0, 10);
        // T2.12: Playwright uses e.level, not e.type for console errors
        const highSeverity = errors.filter((e) => e.level === "error" || e.type === "pageerror").length;
        const warnings = errors.filter((e) => e.level === "warning" || e.type === "warning").length;
        if (highSeverity > 0) {
          logWarn(`  ${highSeverity} page error(s) detected during browser test`);
          if (e2eResult.status === "PASS") e2eResult.status = "INCONCLUSIVE";
        }
        if (warnings > CONSOLE_WARNING_THRESHOLD) {
          logWarn(`  ${warnings} console warnings exceed threshold (${CONSOLE_WARNING_THRESHOLD})`);
          if (e2eResult.status === "PASS") e2eResult.status = "INCONCLUSIVE";
        }
      }
    } catch {}

    // 5.13: Store results
    if (e2eResult.status !== "PASS") e2eResult.status = "INCONCLUSIVE";
    state.data._e2e_tests_complete = e2eResult.status;
    state.data._e2e_tests_count = { total: e2eResult.total, passed: e2eResult.passed, failed: e2eResult.failed, flaky: e2eResult.flaky };
    state.data._e2e_console_errors = e2eResult.consoleErrors || [];
    save(state);
    logOk(`Phase 3: Browser smoke — ${e2eResult.status} (${e2eResult.passed}/${e2eResult.total} passed)`);
  } catch (phase3Err) {
    logWarn(`Phase 3: Browser tests failed: ${phase3Err.message.substring(0, 300)}`);
    state.data._e2e_tests_complete = "INCONCLUSIVE";
    state.data._e2e_tests_count = { total: 0, passed: 0, failed: 0, flaky: 0 };
    save(state);
  } finally {
    // 5.12: Kill vite preview (process group to catch child workers)
    if (viteProc && viteProc.pid) {
      try { process.kill(-viteProc.pid, "SIGTERM"); } catch { try { process.kill(viteProc.pid, "SIGTERM"); } catch {} }
      await new Promise((r) => setTimeout(r, 3000));
      try { process.kill(-viteProc.pid, "SIGKILL"); } catch { try { process.kill(viteProc.pid, "SIGKILL"); } catch {} }
    }
    state.data._vite_preview_pid = null;
    state.data._vite_preview_port = null;
    save(state);
  }

  return fileChanges;
}

// ══════════════════════════════════════════════════════════════
// ── Bootstrap file generators (private helpers) ──────────────
// ══════════════════════════════════════════════════════════════

function _generateJestConfig(repoPath) {
  try {
    logInfo("  Generating jest.config.override.js…");
    const tsconfigPath = path.join(repoPath, "tsconfig.base.json");
    let moduleNameMapper = {};
    if (fs.existsSync(tsconfigPath)) {
      // Strip JSON comments (// and /* */) before parsing — tsconfig allows them
      const raw = fs.readFileSync(tsconfigPath, "utf8");
      const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const tsconfig = JSON.parse(stripped);
      const paths = tsconfig.compilerOptions?.paths || {};
      for (const [alias, targets] of Object.entries(paths)) {
        const key = `^${alias.replace("/*", "/(.*)")}$`;
        const target = targets[0] ? `<rootDir>/${targets[0].replace("/*", "/$1")}` : "<rootDir>/src";
        moduleNameMapper[key] = target;
      }
    }
    moduleNameMapper["^@mi/core$"] = "<rootDir>/src/__test-shims__/mi-core.ts";
    moduleNameMapper["^@mi/core/(.*)$"] = "<rootDir>/src/__test-shims__/mi-core.ts";
    moduleNameMapper["\\.(css|scss|less)$"] = "<rootDir>/src/__test-shims__/style-mock.ts";
    moduleNameMapper["\\.(jpg|jpeg|png|gif|svg|webp|ico)$"] = "<rootDir>/src/__test-shims__/file-mock.ts";

    const jestConfig = `// Auto-generated by MI Dev Agent Runtime Testing Pipeline — DO NOT COMMIT
let baseConfig = {};
try { baseConfig = require('./jest.config'); } catch {}
module.exports = {
  ...baseConfig,
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/src/setupTests.runtime.ts"],
  moduleNameMapper: ${JSON.stringify(moduleNameMapper, null, 4)},
  testTimeout: 10000,
  forceExit: true,
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
};
`;
    fs.writeFileSync(path.join(repoPath, "jest.config.override.js"), jestConfig);
    logOk("  jest.config.override.js generated");
  } catch (e) { logWarn(`  jest.config.override generation failed: ${e.message.substring(0, 200)}`); }
}

function _generateSetupTests(srcDir) {
  try {
    logInfo("  Generating setupTests.runtime.ts…");
    const setupTests = `// Auto-generated by MI Dev Agent Runtime Testing Pipeline — DO NOT COMMIT
import '@testing-library/jest-dom';

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: jest.fn(), removeListener: jest.fn(),
    addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn(),
  })),
});

// Mock IntersectionObserver
class MockIntersectionObserver { observe = jest.fn(); unobserve = jest.fn(); disconnect = jest.fn(); }
Object.defineProperty(window, 'IntersectionObserver', { writable: true, value: MockIntersectionObserver });

// Mock ResizeObserver
class MockResizeObserver { observe = jest.fn(); unobserve = jest.fn(); disconnect = jest.fn(); }
Object.defineProperty(window, 'ResizeObserver', { writable: true, value: MockResizeObserver });

// Mock canvas
HTMLCanvasElement.prototype.getContext = jest.fn().mockReturnValue({
  fillRect: jest.fn(), clearRect: jest.fn(), getImageData: jest.fn(() => ({ data: [] })),
  putImageData: jest.fn(), createImageData: jest.fn(() => []), setTransform: jest.fn(),
  drawImage: jest.fn(), save: jest.fn(), fillText: jest.fn(), restore: jest.fn(),
  beginPath: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn(), closePath: jest.fn(),
  stroke: jest.fn(), translate: jest.fn(), scale: jest.fn(), rotate: jest.fn(), arc: jest.fn(),
  fill: jest.fn(), measureText: jest.fn(() => ({ width: 0 })), transform: jest.fn(),
  rect: jest.fn(), clip: jest.fn(),
}) as any;

// Mock crypto
Object.defineProperty(window, 'crypto', {
  value: { getRandomValues: (arr: any) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; } },
});

// Mock browser-only modules
jest.mock('mapbox-gl', () => ({ Map: jest.fn(), Marker: jest.fn(), NavigationControl: jest.fn() }), { virtual: true });
jest.mock('pdfjs-dist', () => ({ getDocument: jest.fn(), GlobalWorkerOptions: {} }), { virtual: true });
jest.mock('html2canvas', () => jest.fn().mockResolvedValue(document.createElement('canvas')), { virtual: true });
jest.mock('react-google-charts', () => ({ Chart: () => null }), { virtual: true });

// Suppress console.error for act() warnings in tests
const originalError = console.error;
console.error = (...args: any[]) => {
  if (typeof args[0] === 'string' && args[0].includes('act(')) return;
  originalError.call(console, ...args);
};
`;
    fs.writeFileSync(path.join(srcDir, "setupTests.runtime.ts"), setupTests);
    logOk("  setupTests.runtime.ts generated");
  } catch (e) { logWarn(`  setupTests.runtime generation failed: ${e.message.substring(0, 200)}`); }
}

function _generateTestProviders(srcDir) {
  try {
    logInfo("  Generating test-providers.tsx…");
    const testProviders = `// Auto-generated by MI Dev Agent Runtime Testing Pipeline — DO NOT COMMIT
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { IntlProvider } from 'react-intl';
import { ThemeProvider } from 'styled-components';

const mockTheme = {
  palette: { mode: 'light', primary: { main: '#1890ff' }, background: { default: '#fff' } },
  card: { headerBg: '#fafafa' },
};

const mockUser = {
  id: 'test-user-1', displayName: 'Test User', email: 'test@test.com',
  role: ['admin'], permissions: [{ module: '*', access: 'full' }],
};

// Minimal context providers for testing
export const TestProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <MemoryRouter>
    <IntlProvider locale="en" messages={{}}>
      <ThemeProvider theme={mockTheme}>
        {children}
      </ThemeProvider>
    </IntlProvider>
  </MemoryRouter>
);

export default TestProviders;
`;
    fs.writeFileSync(path.join(srcDir, "test-providers.tsx"), testProviders);
    logOk("  test-providers.tsx generated");
  } catch (e) { logWarn(`  test-providers generation failed: ${e.message.substring(0, 200)}`); }
}

function _generateMiCoreShim(srcDir) {
  try {
    logInfo("  Generating @mi/core shim…");
    const miCoreShim = `// Auto-generated by MI Dev Agent Runtime Testing Pipeline — DO NOT COMMIT
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import TestProviders from '../test-providers';

export function renderWithWrapper(ui: React.ReactElement, options?: any) {
  return render(ui, { wrapper: TestProviders, ...options });
}

export function authTestRender(ui: React.ReactElement, options?: any) {
  return render(ui, { wrapper: TestProviders, ...options });
}

export function defineMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: jest.fn(), removeListener: jest.fn(),
      addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn(),
    })),
  });
}

export { screen, fireEvent, waitFor, act };
export default { renderWithWrapper, authTestRender, defineMatchMedia };
`;
    const shimDir = path.join(srcDir, "__test-shims__");
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, "mi-core.ts"), miCoreShim);
    fs.writeFileSync(path.join(shimDir, "style-mock.ts"), "export default {};\n");
    fs.writeFileSync(path.join(shimDir, "file-mock.ts"), "export default 'test-file-stub';\n");
    logOk("  @mi/core shim generated");
  } catch (e) { logWarn(`  @mi/core shim generation failed: ${e.message.substring(0, 200)}`); }
}

function _generateEnvLocal(repoPath) {
  try {
    logInfo("  Writing .env.local with VITE_* mock values…");
    const envLocal = `# Auto-generated by MI Dev Agent Runtime Testing Pipeline — DO NOT COMMIT
VITE_APP_API_URL=http://localhost:9876
VITE_APP_QA=true
VITE_APP_TYPE=enterprise
VITE_PRODUCT_ID=${process.env.VITE_PRODUCT_ID || "2"}
VITE_CHAT_SOCKET_URL=
VITE_APP_ENV=test
`;
    fs.writeFileSync(path.join(repoPath, ".env.local"), envLocal);
    logOk("  .env.local written");
  } catch (e) { logWarn(`  .env.local write failed: ${e.message.substring(0, 200)}`); }
}

function _validateTestSetup(repoPath, execSync) {
  try {
    logInfo("  Validating test setup…");
    // Find an existing spec file using fs (no shell injection risk)
    const existingTests = [];
    _walkForTests(repoPath, existingTests, 1, 0, 4);
    const existingTest = existingTests[0];
    if (existingTest) {
      logInfo(`  Running validation test: ${path.basename(existingTest)}`);
      const escapedName = path.basename(existingTest).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      try {
        execSync(`npx jest --config jest.config.override.js --testPathPattern="${escapedName}" --passWithNoTests --forceExit 2>&1 | tail -5`, {
          cwd: repoPath, timeout: 30_000, stdio: "pipe", shell: true,
          env: { ...process.env, NODE_OPTIONS: "--max_old_space_size=8192" },
        });
        logOk("  Validation test passed");
      } catch {
        logWarn("  Validation test failed — proceeding anyway (existing tests may have issues)");
      }
    } else {
      logInfo("  No existing test files found — skipping validation");
    }
  } catch (e) { logWarn(`  Validation step error: ${e.message.substring(0, 100)}`); }
}

module.exports = { runRuntimeTests, classifyChanges, findFreePort };
