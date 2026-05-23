"use strict";

import type { PipelineState } from '@mi/shared';

const {
  cfg, TICKET, BROWSER_VERIFY, MAX_VERIFY_RETRIES, VERIFICATION_TIMEOUT,
  DEVELOPER_TIMEOUT_MS, EVIDENCE_MAX_SIZE, applyComplexityTimeout,
} = require("../../lib/config");
const { logInfo, logOk, logWarn, logErr, logStep } = require("../../lib/logging");
const { sanitizeForPrompt } = require("../../lib/utils");
const { save } = require("../../lib/state");
const { runSingleAgent } = require("../../lib/agents-team");
const { isShuttingDown, onShutdown } = require("../../lib/graceful-shutdown");
const { localGetChanges } = require("../../lib/local-repo");
const { _validateDevChanges } = require("./developer");

// Module-level ref for shutdown hook cleanup
let _activeBrowser: any = null;

// Register Playwright cleanup on shutdown
onShutdown("codegen-playwright", async () => {
  if (_activeBrowser) {
    try { await _activeBrowser.close(); } catch {}
    _activeBrowser = null;
  }
});

const { startDevServer, stopDevServer, isProcessAlive } = require("./dev-server");
const { checkQAHealth, loginToApp } = require("./login-helper");
const { detectRoutes } = require("./route-detector");
const {
  collectEvidence, setupNetworkCapture, setupConsoleCapture,
  captureScreenshot, aggregateEvidence,
} = require("./evidence-collector");

/**
 * Part 2: Browser-based verification of generated code.
 *
 * Launches Playwright, logs into the running dev server, navigates to feature routes,
 * collects evidence (accessibility tree, text, DOM, network, console), and runs
 * Gap Analysis Agent to evaluate against acceptance criteria.
 */
async function runBrowserVerification(state: PipelineState, ctx: any): Promise<void> {
  if (!BROWSER_VERIFY) {
    logInfo("Part 2: BROWSER_VERIFY=false -- skipping browser verification");
    (state.data as any)._routes_detected = "SKIP";
    (state.data as any)._login_complete = "SKIP";
    (state.data as any)._browser_verified = "SKIP";
    save(state);
    return;
  }

  if (!(state.data as any)._dev_server_ready) {
    logWarn("Part 2: Dev server not ready -- skipping browser verification");
    (state.data as any)._browser_verified = "SKIP";
    (state.data as any)._browser_verify_skip_reason = "dev_server_not_ready";
    save(state);
    return;
  }

  // M14: Honor the flag set by env-setup. If Playwright install failed,
  // there's no point launching chromium — it'd throw at runtime. Skip
  // cleanly with a clear reason.
  if ((state.data as any)._browser_verify_available === false) {
    logWarn("Part 2: Browser verify unavailable (Playwright install failed) -- skipping");
    (state.data as any)._browser_verified = "SKIP";
    (state.data as any)._browser_verify_skip_reason = "playwright_unavailable";
    save(state);
    return;
  }

  // Checkpoint: already verified this run
  if ((state.data as any)._browser_verified === "PASS" || (state.data as any)._browser_verified === "SKIP") {
    logOk(`Part 2: Browser verification already ${(state.data as any)._browser_verified} (cached)`);
    return;
  }

  logStep("2.5", "Browser-based verification");
  const startTime = Date.now();

  let browser: any = null;
  let context: any = null;
  try {
    // Step 1: Check QA backend health
    const qaUrl = cfg.urls.qa;
    const health = await checkQAHealth(qaUrl);
    if (!health.healthy) {
      logWarn(`Part 2: QA backend unhealthy -- ${health.reason}`);
      (state.data as any)._browser_verified = "SKIP";
      (state.data as any)._browser_verify_skip_reason = "backend_unhealthy";
      save(state);
      return;
    }
    logOk("Part 2: QA backend healthy");

    // Step 2: Start dev server if needed
    const port = (state.data as any)._nx_serve_port;
    if (!port || !isProcessAlive((state.data as any)._nx_serve_pid)) {
      logInfo("Part 2: Starting dev server...");
      const server = await startDevServer(cfg.localRepo, state);
      if (!server) {
        logWarn("Part 2: Dev server failed to start -- skipping verification");
        (state.data as any)._browser_verified = "SKIP";
        (state.data as any)._browser_verify_skip_reason = "dev_server_start_failed";
        save(state);
        return;
      }
    }

    const serverPort = (state.data as any)._nx_serve_port;

    // Step 3: Launch Playwright
    const { chromium } = require("playwright");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    _activeBrowser = browser;

    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
    });

    // Step 4: Detect routes (initial; re-detected on retry after fix agent)
    const changedFiles = localGetChanges(cfg.localRepo);
    const ac = (state.data as any).ticket?.ac || "";
    if (!(state.data as any)._routes_detected) {
      (state.data as any)._routes_detected = detectRoutes(changedFiles, cfg.localRepo, ac);
      save(state);
    }

    // Step 5: Verification loop
    const credentials = {
      email: process.env.VERIFY_LOGIN_EMAIL || cfg.qa.main.user,
      pass: process.env.VERIFY_LOGIN_PASS || cfg.qa.main.pass,
    };

    let overallVerdict = "SKIP";
    const maxRetries = MAX_VERIFY_RETRIES;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (isShuttingDown()) {
        logInfo("Part 2: Shutdown in progress -- aborting verification");
        break;
      }

      (state.data as any)._verify_attempt = attempt;
      save(state);

      // Check total timeout
      if (Date.now() - startTime > VERIFICATION_TIMEOUT) {
        logWarn("Part 2: Verification timeout reached");
        (state.data as any)._browser_verify_skip_reason = "timeout";
        break;
      }

      // H8: Health-check the dev server before each attempt. The server may
      // have crashed during the previous attempt (HMR error, OOM, port
      // collision). Without this check, we'd keep navigating to a dead URL
      // and waste retries collecting empty evidence.
      const devPid = (state.data as any)._nx_serve_pid;
      if (!devPid || !isProcessAlive(devPid)) {
        logWarn(`Part 2: Dev server (pid ${devPid}) is not alive — attempting restart before attempt ${attempt}`);
        const restarted = await startDevServer(cfg.localRepo, state);
        if (!restarted) {
          logErr("Part 2: Dev server restart failed — aborting verification");
          (state.data as any)._browser_verify_skip_reason = "dev_server_crashed";
          (state.data as any)._browser_verified = "SKIP";
          save(state);
          break;
        }
        logOk("Part 2: Dev server restarted");
      }

      logInfo(`Part 2: Verification attempt ${attempt}/${maxRetries}`);

      // If retry: run fix agent first
      if (attempt > 1 && (state.data as any)._verify_known_gaps) {
        logInfo("Part 2: Running fix agent for identified gaps...");
        const fixOk = await runBrowserFixAgent(ctx, (state.data as any)._verify_known_gaps, attempt, state);
        // M6: abort the loop after 2 consecutive fix-agent failures. The
        // outer MAX_VERIFY_RETRIES cap still applies — this just prevents
        // burning the remaining attempts on a fixer that's clearly stuck.
        const consecutive = (((state.data as any)._verify_fix_failures as number) || 0);
        if (fixOk) {
          (state.data as any)._verify_fix_failures = 0;
        } else {
          (state.data as any)._verify_fix_failures = consecutive + 1;
          if (consecutive + 1 >= 2) {
            logWarn(`Part 2: Browser Fix Agent failed ${consecutive + 1} consecutive times — giving up on automated fixes`);
            (state.data as any)._browser_verify_skip_reason = "fix_agent_unstuck";
            (state.data as any)._browser_verified = "SKIP";
            save(state);
            break;
          }
        }
        save(state);
        // Invalidate stale route cache -- fix agent may have changed routing
        (state.data as any)._routes_detected = null;
        // M15: Poll the dev server until it responds (Vite re-bundles after
        // the fixer's writes) instead of a flat 5s sleep. Caps at 15s so a
        // hung server doesn't stall the loop. Falls back to the original
        // sleep if the polling helper isn't available.
        try {
          const http = require("http");
          const start = Date.now();
          const maxWaitMs = 15_000;
          let ready = false;
          while (Date.now() - start < maxWaitMs) {
            ready = await new Promise<boolean>((resolve) => {
              const req = http.get(`http://localhost:${serverPort}/`, { timeout: 1500 }, (res: any) => {
                res.resume();
                resolve(res.statusCode != null && res.statusCode < 500);
              });
              req.on("error", () => resolve(false));
              req.on("timeout", () => { req.destroy(); resolve(false); });
            });
            if (ready) break;
            await new Promise((r) => setTimeout(r, 500));
          }
          if (ready) {
            logOk(`Part 2: Dev server responsive after fixer (${Date.now() - start}ms)`);
          } else {
            logWarn(`Part 2: Dev server still not responsive after ${maxWaitMs}ms — proceeding anyway`);
          }
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
        }
      }

      // Login (or re-login on retry)
      const page = await context.newPage();

      try {
        // Set up capture before navigation
        const networkCapture = setupNetworkCapture(page);
        const consoleCapture = setupConsoleCapture(page);

        logInfo("Part 2: Logging in...");
        const loginResult = await loginToApp(page, serverPort, credentials);

        if (!loginResult.success) {
          logWarn(`Part 2: Login failed -- ${loginResult.reason}`);
          (state.data as any)._login_complete = false;
          (state.data as any)._browser_verified = "SKIP";
          (state.data as any)._browser_verify_skip_reason = "login_failed";
          save(state);
          await page.close();
          break;
        }

        (state.data as any)._login_complete = true;
        save(state);
        logOk("Part 2: Login successful");

        // Re-detect routes on retry (fix agent may have changed files)
        if (!(state.data as any)._routes_detected) {
          const freshFiles = localGetChanges(cfg.localRepo);
          (state.data as any)._routes_detected = detectRoutes(freshFiles, cfg.localRepo, ac);
          save(state);
        }
        const currentRoutes = (state.data as any)._routes_detected || [];

        // Navigate to each route and collect evidence
        const routeEvidences: any[] = [];
        for (const routeInfo of currentRoutes) {
          // Reset captures per-route to prevent cross-route contamination
          networkCapture.reset();
          consoleCapture.reset();
          logInfo(`Part 2: Navigating to ${routeInfo.route}...`);

          try {
            await page.goto(`https://localhost:${serverPort}${routeInfo.route}`, {
              waitUntil: "networkidle",
              timeout: 30_000,
            });

            // Check for auth redirect
            let currentPath: string;
            try { currentPath = new URL(page.url()).pathname; } catch { currentPath = page.url(); }
            if (currentPath === "/login" || currentPath === "/signin") {
              logWarn(`Part 2: Auth redirect detected on ${routeInfo.route} -- re-logging in`);
              const reLogin = await loginToApp(page, serverPort, credentials);
              if (!reLogin.success) {
                logWarn("Part 2: Re-login failed -- skipping remaining routes");
                break;
              }
              // Re-navigate
              await page.goto(`https://localhost:${serverPort}${routeInfo.route}`, {
                waitUntil: "networkidle",
                timeout: 30_000,
              });
            }
          } catch (navErr: any) {
            logWarn(`Part 2: Navigation to ${routeInfo.route} failed: ${navErr.message.substring(0, 200)}`);
            routeEvidences.push({
              route: routeInfo.route,
              error: navErr.message.substring(0, 300),
              consoleErrors: consoleCapture.errors(),
              networkSummary: networkCapture.summary(),
            });
            continue;
          }

          // Collect evidence
          const evidence = await collectEvidence(page, routeInfo.route, ac);
          evidence.networkSummary = networkCapture.summary();
          evidence.consoleErrors = consoleCapture.errors();

          // Screenshot (disk only)
          evidence.screenshotPath = await captureScreenshot(page, routeInfo.route, TICKET);

          routeEvidences.push(evidence);
        }

        // Aggregate and run gap analysis
        const aggregated = aggregateEvidence(routeEvidences);

        // Save evidence to state for MR description and Web UI
        const consoleErrorsAll = routeEvidences
          .flatMap((r: any) => r.consoleErrors || [])
          .filter((e: any) => e.severity === "HIGH" || e.severity === "MEDIUM");
        (state.data as any)._verify_evidence = aggregated.overallHealth;
        (state.data as any)._verify_console_summary = consoleErrorsAll.slice(0, 20);
        save(state);

        const verdict = await runGapAnalysis(state, ac, aggregated, attempt);

        if (verdict.agentFailed) {
          (state.data as any)._browser_verify_skip_reason = "agent_failure";
          overallVerdict = "SKIP";
          logWarn("Part 2: Gap Analysis Agent failed -- skipping verification");
          await page.close();
          break;
        }

        if (verdict.overall === "PASS") {
          overallVerdict = "PASS";
          logOk(`Part 2: Verification PASSED on attempt ${attempt}`);
          await page.close();
          break;
        }

        if (verdict.overall === "NEEDS_FIX" && attempt < maxRetries) {
          (state.data as any)._verify_known_gaps = verdict.gaps;
          save(state);
          logInfo(`Part 2: Gaps found -- will retry (attempt ${attempt + 1})`);
          await page.close();
          continue;
        }

        // SKIP or final attempt
        overallVerdict = "SKIP";
        (state.data as any)._browser_verify_skip_reason = verdict.overall === "SKIP" ? "inconclusive" : "max_retries_exceeded";
        logWarn(`Part 2: Verification ${verdict.overall} after attempt ${attempt}`);
        await page.close();
        break;
      } catch (attemptErr: any) {
        logWarn(`Part 2: Attempt ${attempt} error: ${attemptErr.message.substring(0, 300)}`);
        try { await page.close(); } catch { /* already closed */ }
        if (attempt >= maxRetries) {
          (state.data as any)._browser_verify_skip_reason = "attempt_error: " + attemptErr.message.substring(0, 200);
          break;
        }
      }
    }

    (state.data as any)._browser_verified = overallVerdict;
    save(state);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (overallVerdict === "PASS") {
      logOk(`Part 2: Browser verification complete -- PASS (${elapsed}s)`);
    } else {
      logWarn(`Part 2: Browser verification complete -- ${overallVerdict} (${elapsed}s)`);
    }
  } catch (e: any) {
    logErr(`Part 2: Unexpected error: ${e.message.substring(0, 300)}`);
    (state.data as any)._browser_verified = "SKIP";
    (state.data as any)._browser_verify_skip_reason = "unexpected_error";
    save(state);
  } finally {
    // L6: Explicit cleanup of Playwright tracing/video before closing. If
    // tracing/video weren't enabled, these calls throw — caught and
    // ignored. Without this, debug-mode runs (which DO enable tracing)
    // could leave .zip/.webm/HAR artifacts in the Playwright temp dir.
    if (context) {
      try { await context.tracing?.stop?.({ path: undefined }); } catch { /* tracing not enabled */ }
      try { await context.close(); } catch { /* ignore */ }
    }
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
      _activeBrowser = null;
    }
    // Note: Dev server stays running for potential next ticket
  }
}

/**
 * Run the Gap Analysis Agent to evaluate evidence against acceptance criteria.
 */
async function runGapAnalysis(state: PipelineState, ac: string, aggregatedEvidence: any, attempt: number): Promise<any> {
  const previousGaps = attempt > 1 ? ((state.data as any)._verify_known_gaps || []) : [];

  // Truncate evidence for prompt size
  const evidenceStr = JSON.stringify(aggregatedEvidence, null, 2);
  const maxEvidenceSize = EVIDENCE_MAX_SIZE * 3;
  const truncatedEvidence = evidenceStr.length > maxEvidenceSize
    ? (logWarn(`Gap analysis evidence truncated from ${evidenceStr.length} to ${maxEvidenceSize} chars`),
       evidenceStr.substring(0, maxEvidenceSize) + "\n...[truncated]")
    : evidenceStr;

  const prompt = `You are a QA Gap Analyst. Evaluate browser evidence against acceptance criteria.

## Acceptance Criteria
${sanitizeForPrompt(ac)}

## Browser Evidence (attempt ${attempt}/${MAX_VERIFY_RETRIES})
${truncatedEvidence}

${previousGaps.length > 0 ? `## Known Gaps from Previous Attempt\n${previousGaps.join("\n")}\n` : ""}

## Instructions
For each acceptance criterion, evaluate the evidence:
- PASS: Evidence confirms the AC is met (element exists in accessibility tree, text matches, etc.)
- PARTIAL: Element exists but content/behavior is uncertain
- FAIL: Element clearly missing, wrong content, or error preventing verification

Output format (EXACTLY):
AC 1: [criterion text] -> PASS | PARTIAL | FAIL
  Evidence: [what you found]
  Gap: [if not PASS, what's missing]

AC 2: ...

OVERALL: PASS | NEEDS_FIX | SKIP
FIX_INSTRUCTIONS: [if NEEDS_FIX, specific code changes needed]

Rules:
- PASS overall if all ACs are PASS or PARTIAL with minor issues
- NEEDS_FIX if specific, fixable code issues identified
- SKIP if unable to verify (backend errors, wrong route, etc.)
- After ${MAX_VERIFY_RETRIES} attempts, prefer SKIP over NEEDS_FIX`;

  const output = await runSingleAgent({
    name: "Gap Analysis Agent",
    prompt,
    timeout: applyComplexityTimeout(120_000, state),
    opts: { maxTurns: 3, allowedTools: [] },
    state,
    checkpointKey: `_gap_analysis_attempt_${attempt}`,
    required: false,
  });

  if (!output) {
    return { overall: "SKIP", gaps: [], verdicts: [], agentFailed: true };
  }

  return parseGapAnalysisVerdict(output);
}

/**
 * Parse the Gap Analysis Agent output into structured verdict.
 */
function parseGapAnalysisVerdict(output: string): any {
  // M7: Normalize unicode arrows + smart quotes the model sometimes emits
  // (→, ⟶, ⇒), then run the regex. Without this, `AC 1: foo → FAIL` was
  // silently dropped because the regex only accepted the ASCII `->`.
  const normalized = (output || "")
    .replace(/[→⟶⇒]/g, "->")
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'");

  const overallMatch = normalized.match(/OVERALL:\s*(PASS|NEEDS_FIX|SKIP)/i);
  const overall = overallMatch ? overallMatch[1].toUpperCase() : "SKIP";

  const gaps: string[] = [];
  const fixMatch = normalized.match(/FIX_INSTRUCTIONS:\s*(.+?)(?=\n\n|$)/is);
  if (fixMatch && overall === "NEEDS_FIX") {
    gaps.push(fixMatch[1].trim());
  }

  // T2.4 + M7: Accept "->", "→", "=>", capture inline gap descriptions, and
  // make the trailing-line `Gap:` optional so a single-line verdict still
  // contributes to `gaps`.
  const acPattern = /AC\s*\d+:.*?->\s*(FAIL|PARTIAL).*?(?:\n\s*Gap:\s*(.+?))?(?=\n(?:AC\s*\d+:|OVERALL:|$))/gis;
  let match: RegExpExecArray | null;
  while ((match = acPattern.exec(normalized)) !== null) {
    if (match[2]) gaps.push(match[2].trim());
  }

  // M7: If overall is NEEDS_FIX but we couldn't extract any structured
  // gap, log the unparsed output so an operator can diagnose the format
  // drift.
  if (overall === "NEEDS_FIX" && gaps.length === 0) {
    logWarn(`parseGapAnalysisVerdict: NEEDS_FIX with no gaps parsed — output may have format drift: ${normalized.substring(0, 400)}`);
  }

  return { overall, gaps, rawOutput: output };
}

/**
 * Run the Developer Fix Agent to address specific browser-identified gaps.
 */
// M6: returns true on success, false on fix-agent failure so the caller can
// short-circuit after consecutive failures instead of re-running a known-bad
// fixer forever.
async function runBrowserFixAgent(ctx: any, gaps: any, attempt: number, state: PipelineState): Promise<boolean> {
  const gapsList = Array.isArray(gaps) ? gaps.join("\n- ") : String(gaps);

  const prompt = `You are a Developer Fix Agent. The browser verification found specific gaps in the generated code.

## Ticket: ${TICKET}
## Acceptance Criteria
${sanitizeForPrompt((state.data as any).ticket?.ac || "")}

## Browser-Identified Gaps (attempt ${attempt})
- ${gapsList}

## Instructions
1. Read the relevant files to understand the current code
2. Fix ONLY the specific gaps identified above
3. Do NOT rewrite files unnecessarily -- make minimal targeted changes
4. The dev server has HMR -- changes will hot-reload automatically

Focus on fixing rendering issues, missing elements, or incorrect behavior that the browser verification detected.`;

  const fixResult = await runSingleAgent({
    name: "Browser Fix Agent",
    prompt,
    timeout: applyComplexityTimeout(DEVELOPER_TIMEOUT_MS, state),
    opts: { cwd: cfg.localRepo, maxTurns: 15, allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"] },
    state,
    checkpointKey: `_gap_fix_attempt_${attempt}`,
    required: false,
  });
  if (!fixResult) {
    logWarn(`Browser Fix Agent failed (attempt ${attempt}) -- continuing without fix`);
    return false;
  }
  // H2: Validate browser-fix output (GQ7 unresolved imports + F3 forbidden
  // paths). A fix agent making HMR-targeted tweaks can still write to
  // forbidden files or introduce a broken import.
  try {
    _validateDevChanges(state);
  } catch (validationErr: any) {
    logWarn(`Browser Fix Agent output rejected by validation: ${validationErr.message.substring(0, 200)}`);
    throw validationErr;
  }
  return true;
}

/**
 * Build MR description section for browser verification results.
 */
function buildBrowserVerifyMRSection(state: PipelineState): string {
  const verified = (state.data as any)._browser_verified;
  if (!verified) return "";

  const attempt = (state.data as any)._verify_attempt || 0;
  const routes = (state.data as any)._routes_detected || [];
  const health = (state.data as any)._verify_evidence || {};
  const consoleErrors = (state.data as any)._verify_console_summary || [];

  let section = "\n## Browser Verification\n";

  if (verified === "PASS") {
    section += `- **Result**: PASS (attempt ${attempt})\n`;
  } else if (verified === "SKIP") {
    section += `- **Result**: SKIPPED\n`;
    const skipReason = (state.data as any)._browser_verify_skip_reason;
    if (skipReason) {
      section += `- **Skip reason**: ${skipReason}\n`;
    }
    const gaps = (state.data as any)._verify_known_gaps || [];
    if (gaps.length > 0) {
      section += `- **Last known gaps**: ${gaps[0].substring(0, 200)}\n`;
    }
    section += `- Manual testing recommended\n`;
  }

  if (routes.length > 0) {
    section += `- **Routes checked**: ${routes.map((r: any) => r.route).join(", ")}\n`;
  }

  // Overall health from evidence
  if (health.allRoutesLoaded !== undefined) {
    section += `- **All routes loaded**: ${health.allRoutesLoaded ? "Yes" : "No"}`;
    if (health.authFailures > 0) section += ` (${health.authFailures} auth redirect(s))`;
    section += "\n";
    if (health.highSeverityErrors > 0) {
      section += `- **High severity JS errors**: ${health.highSeverityErrors}\n`;
    }
    section += `- **Network healthy**: ${health.networkHealthy ? "Yes" : "No"}\n`;
  }

  if (consoleErrors.length > 0) {
    section += `- **Console errors**: ${consoleErrors.length}\n`;
    for (const err of consoleErrors.slice(0, 5)) {
      const severity = err.severity ? `[${err.severity}] ` : "";
      section += `  - ${severity}${err.text ? err.text.substring(0, 100) : "unknown"}\n`;
    }
  }

  if (attempt > 1) {
    section += `- Passed on attempt ${attempt} after ${attempt - 1} fix(es)\n`;
  }

  return section;
}

export { runBrowserVerification, buildBrowserVerifyMRSection };
