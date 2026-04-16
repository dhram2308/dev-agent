"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBrowserVerification = runBrowserVerification;
exports.buildBrowserVerifyMRSection = buildBrowserVerifyMRSection;
const { cfg, TICKET, BROWSER_VERIFY, MAX_VERIFY_RETRIES, VERIFICATION_TIMEOUT, DEVELOPER_TIMEOUT_MS, EVIDENCE_MAX_SIZE, applyComplexityTimeout, } = require("../../lib/config");
const { logInfo, logOk, logWarn, logErr, logStep } = require("../../lib/logging");
const { sanitizeForPrompt } = require("../../lib/utils");
const { save } = require("../../lib/state");
const { runSingleAgent } = require("../../lib/agents-team");
const { isShuttingDown, onShutdown } = require("../../lib/graceful-shutdown");
const { localGetChanges } = require("../../lib/local-repo");
// Module-level ref for shutdown hook cleanup
let _activeBrowser = null;
// Register Playwright cleanup on shutdown
onShutdown("codegen-playwright", async () => {
    if (_activeBrowser) {
        try {
            await _activeBrowser.close();
        }
        catch { }
        _activeBrowser = null;
    }
});
const { startDevServer, stopDevServer, isProcessAlive } = require("./dev-server");
const { checkQAHealth, loginToApp } = require("./login-helper");
const { detectRoutes } = require("./route-detector");
const { collectEvidence, setupNetworkCapture, setupConsoleCapture, captureScreenshot, aggregateEvidence, } = require("./evidence-collector");
/**
 * Part 2: Browser-based verification of generated code.
 *
 * Launches Playwright, logs into the running dev server, navigates to feature routes,
 * collects evidence (accessibility tree, text, DOM, network, console), and runs
 * Gap Analysis Agent to evaluate against acceptance criteria.
 */
async function runBrowserVerification(state, ctx) {
    if (!BROWSER_VERIFY) {
        logInfo("Part 2: BROWSER_VERIFY=false -- skipping browser verification");
        state.data._routes_detected = "SKIP";
        state.data._login_complete = "SKIP";
        state.data._browser_verified = "SKIP";
        save(state);
        return;
    }
    if (!state.data._dev_server_ready) {
        logWarn("Part 2: Dev server not ready -- skipping browser verification");
        state.data._browser_verified = "SKIP";
        state.data._browser_verify_skip_reason = "dev_server_not_ready";
        save(state);
        return;
    }
    // Checkpoint: already verified this run
    if (state.data._browser_verified === "PASS" || state.data._browser_verified === "SKIP") {
        logOk(`Part 2: Browser verification already ${state.data._browser_verified} (cached)`);
        return;
    }
    logStep("2.5", "Browser-based verification");
    const startTime = Date.now();
    let browser = null;
    let context = null;
    try {
        // Step 1: Check QA backend health
        const qaUrl = cfg.urls.qa;
        const health = await checkQAHealth(qaUrl);
        if (!health.healthy) {
            logWarn(`Part 2: QA backend unhealthy -- ${health.reason}`);
            state.data._browser_verified = "SKIP";
            state.data._browser_verify_skip_reason = "backend_unhealthy";
            save(state);
            return;
        }
        logOk("Part 2: QA backend healthy");
        // Step 2: Start dev server if needed
        const port = state.data._nx_serve_port;
        if (!port || !isProcessAlive(state.data._nx_serve_pid)) {
            logInfo("Part 2: Starting dev server...");
            const server = await startDevServer(cfg.localRepo, state);
            if (!server) {
                logWarn("Part 2: Dev server failed to start -- skipping verification");
                state.data._browser_verified = "SKIP";
                state.data._browser_verify_skip_reason = "dev_server_start_failed";
                save(state);
                return;
            }
        }
        const serverPort = state.data._nx_serve_port;
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
        const ac = state.data.ticket?.ac || "";
        if (!state.data._routes_detected) {
            state.data._routes_detected = detectRoutes(changedFiles, cfg.localRepo, ac);
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
            state.data._verify_attempt = attempt;
            save(state);
            // Check total timeout
            if (Date.now() - startTime > VERIFICATION_TIMEOUT) {
                logWarn("Part 2: Verification timeout reached");
                state.data._browser_verify_skip_reason = "timeout";
                break;
            }
            logInfo(`Part 2: Verification attempt ${attempt}/${maxRetries}`);
            // If retry: run fix agent first
            if (attempt > 1 && state.data._verify_known_gaps) {
                logInfo("Part 2: Running fix agent for identified gaps...");
                await runBrowserFixAgent(ctx, state.data._verify_known_gaps, attempt, state);
                // Invalidate stale route cache -- fix agent may have changed routing
                state.data._routes_detected = null;
                // Wait for HMR to apply
                logInfo("Part 2: Waiting 5s for HMR hot reload...");
                await new Promise((r) => setTimeout(r, 5000));
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
                    state.data._login_complete = false;
                    state.data._browser_verified = "SKIP";
                    state.data._browser_verify_skip_reason = "login_failed";
                    save(state);
                    await page.close();
                    break;
                }
                state.data._login_complete = true;
                save(state);
                logOk("Part 2: Login successful");
                // Re-detect routes on retry (fix agent may have changed files)
                if (!state.data._routes_detected) {
                    const freshFiles = localGetChanges(cfg.localRepo);
                    state.data._routes_detected = detectRoutes(freshFiles, cfg.localRepo, ac);
                    save(state);
                }
                const currentRoutes = state.data._routes_detected || [];
                // Navigate to each route and collect evidence
                const routeEvidences = [];
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
                        let currentPath;
                        try {
                            currentPath = new URL(page.url()).pathname;
                        }
                        catch {
                            currentPath = page.url();
                        }
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
                    }
                    catch (navErr) {
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
                    .flatMap((r) => r.consoleErrors || [])
                    .filter((e) => e.severity === "HIGH" || e.severity === "MEDIUM");
                state.data._verify_evidence = aggregated.overallHealth;
                state.data._verify_console_summary = consoleErrorsAll.slice(0, 20);
                save(state);
                const verdict = await runGapAnalysis(state, ac, aggregated, attempt);
                if (verdict.agentFailed) {
                    state.data._browser_verify_skip_reason = "agent_failure";
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
                    state.data._verify_known_gaps = verdict.gaps;
                    save(state);
                    logInfo(`Part 2: Gaps found -- will retry (attempt ${attempt + 1})`);
                    await page.close();
                    continue;
                }
                // SKIP or final attempt
                overallVerdict = "SKIP";
                state.data._browser_verify_skip_reason = verdict.overall === "SKIP" ? "inconclusive" : "max_retries_exceeded";
                logWarn(`Part 2: Verification ${verdict.overall} after attempt ${attempt}`);
                await page.close();
                break;
            }
            catch (attemptErr) {
                logWarn(`Part 2: Attempt ${attempt} error: ${attemptErr.message.substring(0, 300)}`);
                try {
                    await page.close();
                }
                catch { /* already closed */ }
                if (attempt >= maxRetries) {
                    state.data._browser_verify_skip_reason = "attempt_error: " + attemptErr.message.substring(0, 200);
                    break;
                }
            }
        }
        state.data._browser_verified = overallVerdict;
        save(state);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (overallVerdict === "PASS") {
            logOk(`Part 2: Browser verification complete -- PASS (${elapsed}s)`);
        }
        else {
            logWarn(`Part 2: Browser verification complete -- ${overallVerdict} (${elapsed}s)`);
        }
    }
    catch (e) {
        logErr(`Part 2: Unexpected error: ${e.message.substring(0, 300)}`);
        state.data._browser_verified = "SKIP";
        state.data._browser_verify_skip_reason = "unexpected_error";
        save(state);
    }
    finally {
        if (context) {
            try {
                await context.close();
            }
            catch { /* ignore */ }
        }
        if (browser) {
            try {
                await browser.close();
            }
            catch { /* ignore */ }
            _activeBrowser = null;
        }
        // Note: Dev server stays running for potential next ticket
    }
}
/**
 * Run the Gap Analysis Agent to evaluate evidence against acceptance criteria.
 */
async function runGapAnalysis(state, ac, aggregatedEvidence, attempt) {
    const previousGaps = attempt > 1 ? (state.data._verify_known_gaps || []) : [];
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
function parseGapAnalysisVerdict(output) {
    const overallMatch = output.match(/OVERALL:\s*(PASS|NEEDS_FIX|SKIP)/i);
    const overall = overallMatch ? overallMatch[1].toUpperCase() : "SKIP";
    const gaps = [];
    const fixMatch = output.match(/FIX_INSTRUCTIONS:\s*(.+?)(?=\n\n|$)/is);
    if (fixMatch && overall === "NEEDS_FIX") {
        gaps.push(fixMatch[1].trim());
    }
    // T2.4: Accept both -> and -> arrow styles, and capture inline gap descriptions
    const acPattern = /AC\s*\d+:.*?(?:->|->)\s*(FAIL|PARTIAL).*?\n\s*Gap:\s*(.+?)(?=\n(?:AC\s*\d+:|OVERALL:|$))/gis;
    let match;
    while ((match = acPattern.exec(output)) !== null) {
        gaps.push(match[2].trim());
    }
    return { overall, gaps, rawOutput: output };
}
/**
 * Run the Developer Fix Agent to address specific browser-identified gaps.
 */
async function runBrowserFixAgent(ctx, gaps, attempt, state) {
    const gapsList = Array.isArray(gaps) ? gaps.join("\n- ") : String(gaps);
    const prompt = `You are a Developer Fix Agent. The browser verification found specific gaps in the generated code.

## Ticket: ${TICKET}
## Acceptance Criteria
${sanitizeForPrompt(state.data.ticket?.ac || "")}

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
    }
}
/**
 * Build MR description section for browser verification results.
 */
function buildBrowserVerifyMRSection(state) {
    const verified = state.data._browser_verified;
    if (!verified)
        return "";
    const attempt = state.data._verify_attempt || 0;
    const routes = state.data._routes_detected || [];
    const health = state.data._verify_evidence || {};
    const consoleErrors = state.data._verify_console_summary || [];
    let section = "\n## Browser Verification\n";
    if (verified === "PASS") {
        section += `- **Result**: PASS (attempt ${attempt})\n`;
    }
    else if (verified === "SKIP") {
        section += `- **Result**: SKIPPED\n`;
        const skipReason = state.data._browser_verify_skip_reason;
        if (skipReason) {
            section += `- **Skip reason**: ${skipReason}\n`;
        }
        const gaps = state.data._verify_known_gaps || [];
        if (gaps.length > 0) {
            section += `- **Last known gaps**: ${gaps[0].substring(0, 200)}\n`;
        }
        section += `- Manual testing recommended\n`;
    }
    if (routes.length > 0) {
        section += `- **Routes checked**: ${routes.map((r) => r.route).join(", ")}\n`;
    }
    // Overall health from evidence
    if (health.allRoutesLoaded !== undefined) {
        section += `- **All routes loaded**: ${health.allRoutesLoaded ? "Yes" : "No"}`;
        if (health.authFailures > 0)
            section += ` (${health.authFailures} auth redirect(s))`;
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
//# sourceMappingURL=browser-verify.js.map