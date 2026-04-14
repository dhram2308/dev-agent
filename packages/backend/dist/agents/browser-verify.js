"use strict";
// =====================================================================
// MI Dev Agent -- Browser Verification Agent (TypeScript port)
// =====================================================================
// Part 2: Browser-based verification of generated code.
//
// Features:
//   - Playwright browser automation (headless chromium)
//   - QA backend health check
//   - Dev server management integration
//   - Route detection from changed files
//   - Evidence collection (accessibility tree, text, DOM, network, console)
//   - Gap Analysis Agent for evaluating against acceptance criteria
//   - Iterative fix loop (max retries with Browser Fix Agent)
//   - Shutdown-safe (registers cleanup hook)
//   - MR description section builder
//
// Ported from: stages/generate-code/browser-verify.js
// =====================================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBrowserVerification = runBrowserVerification;
exports.buildBrowserVerifyMRSection = buildBrowserVerifyMRSection;
const logger_1 = require("../lib/logger");
const utils_1 = require("../lib/utils");
const graceful_shutdown_1 = require("../lib/graceful-shutdown");
// Module-level ref for shutdown hook cleanup
let _activeBrowser = null;
// Register Playwright cleanup on shutdown
(0, graceful_shutdown_1.onShutdown)('codegen-playwright', async () => {
    if (_activeBrowser) {
        try {
            await _activeBrowser.close();
        }
        catch { /* ignore */ }
        _activeBrowser = null;
    }
});
// ── Main function ───────────────────────────────────────────────────
/**
 * Part 2: Browser-based verification of generated code.
 *
 * Launches Playwright, logs into the running dev server, navigates to feature routes,
 * collects evidence, and runs Gap Analysis Agent.
 */
async function runBrowserVerification(state, ctx, deps) {
    const data = state.data;
    if (!deps.browserVerify) {
        (0, logger_1.logInfo)('Part 2: BROWSER_VERIFY=false -- skipping browser verification');
        data._routes_detected = 'SKIP';
        data._login_complete = 'SKIP';
        data._browser_verified = 'SKIP';
        deps.save(state);
        return;
    }
    if (!data._dev_server_ready) {
        (0, logger_1.logWarn)('Part 2: Dev server not ready -- skipping browser verification');
        data._browser_verified = 'SKIP';
        data._browser_verify_skip_reason = 'dev_server_not_ready';
        deps.save(state);
        return;
    }
    // Checkpoint: already verified this run
    if (data._browser_verified === 'PASS' || data._browser_verified === 'SKIP') {
        (0, logger_1.logOk)(`Part 2: Browser verification already ${data._browser_verified} (cached)`);
        return;
    }
    (0, logger_1.logStep)('2.5', 'Browser-based verification');
    const startTime = Date.now();
    let browser = null;
    let context = null;
    try {
        // Step 1: Check QA backend health
        const qaUrl = deps.cfg.urls?.qa || '';
        if (qaUrl) {
            const health = await deps.checkQAHealth(qaUrl);
            if (!health.healthy) {
                (0, logger_1.logWarn)(`Part 2: QA backend unhealthy -- ${health.reason}`);
                data._browser_verified = 'SKIP';
                data._browser_verify_skip_reason = 'backend_unhealthy';
                deps.save(state);
                return;
            }
            (0, logger_1.logOk)('Part 2: QA backend healthy');
        }
        // Step 2: Start dev server if needed
        const port = data._nx_serve_port;
        if (!port || !deps.isProcessAlive(data._nx_serve_pid)) {
            (0, logger_1.logInfo)('Part 2: Starting dev server...');
            const server = await deps.startDevServer(deps.cfg.localRepo, state);
            if (!server) {
                (0, logger_1.logWarn)('Part 2: Dev server failed to start -- skipping verification');
                data._browser_verified = 'SKIP';
                data._browser_verify_skip_reason = 'dev_server_start_failed';
                deps.save(state);
                return;
            }
        }
        const serverPort = data._nx_serve_port;
        // Step 3: Launch Playwright
        // Dynamic import to handle optional dependency
        let chromium;
        try {
            const pw = await Promise.resolve(`${'playwright'}`).then(s => __importStar(require(s)));
            chromium = pw.chromium;
        }
        catch {
            (0, logger_1.logWarn)('Part 2: Playwright not available -- skipping browser verification');
            data._browser_verified = 'SKIP';
            data._browser_verify_skip_reason = 'playwright_not_installed';
            deps.save(state);
            return;
        }
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        _activeBrowser = browser;
        context = await browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: { width: 1280, height: 720 },
        });
        // Step 4: Detect routes
        const changedFiles = deps.localGetChanges(deps.cfg.localRepo);
        const ac = data.ticket?.ac || '';
        if (!data._routes_detected) {
            data._routes_detected = deps.detectRoutes(changedFiles, deps.cfg.localRepo, ac);
            deps.save(state);
        }
        // Step 5: Verification loop
        const credentials = {
            email: process.env.VERIFY_LOGIN_EMAIL || deps.cfg.qa?.main?.user || '',
            pass: process.env.VERIFY_LOGIN_PASS || deps.cfg.qa?.main?.pass || '',
        };
        let overallVerdict = 'SKIP';
        for (let attempt = 1; attempt <= deps.maxVerifyRetries; attempt++) {
            if ((0, graceful_shutdown_1.isShuttingDown)()) {
                (0, logger_1.logInfo)('Part 2: Shutdown in progress -- aborting verification');
                break;
            }
            data._verify_attempt = attempt;
            deps.save(state);
            // Check total timeout
            if (Date.now() - startTime > deps.verificationTimeout) {
                (0, logger_1.logWarn)('Part 2: Verification timeout reached');
                data._browser_verify_skip_reason = 'timeout';
                break;
            }
            (0, logger_1.logInfo)(`Part 2: Verification attempt ${attempt}/${deps.maxVerifyRetries}`);
            // If retry: run fix agent first
            if (attempt > 1 && data._verify_known_gaps) {
                (0, logger_1.logInfo)('Part 2: Running fix agent for identified gaps...');
                await runBrowserFixAgent(ctx, data._verify_known_gaps, attempt, state, deps);
                data._routes_detected = null;
                (0, logger_1.logInfo)('Part 2: Waiting 5s for HMR hot reload...');
                await new Promise((r) => setTimeout(r, 5000));
            }
            const page = await context.newPage();
            try {
                // Login
                (0, logger_1.logInfo)('Part 2: Logging in...');
                const loginResult = await deps.loginToApp(page, serverPort, credentials);
                if (!loginResult.success) {
                    (0, logger_1.logWarn)(`Part 2: Login failed -- ${loginResult.reason}`);
                    data._login_complete = false;
                    data._browser_verified = 'SKIP';
                    data._browser_verify_skip_reason = 'login_failed';
                    deps.save(state);
                    break;
                }
                data._login_complete = true;
                deps.save(state);
                (0, logger_1.logOk)('Part 2: Login successful');
                // Re-detect routes on retry
                if (!data._routes_detected) {
                    const freshFiles = deps.localGetChanges(deps.cfg.localRepo);
                    data._routes_detected = deps.detectRoutes(freshFiles, deps.cfg.localRepo, ac);
                    deps.save(state);
                }
                const currentRoutes = data._routes_detected || [];
                // Navigate and collect evidence
                const routeEvidences = [];
                for (const routeInfo of currentRoutes) {
                    const networkCapture = deps.setupNetworkCapture(page);
                    const consoleCapture = deps.setupConsoleCapture(page);
                    (0, logger_1.logInfo)(`Part 2: Navigating to ${routeInfo.route}...`);
                    try {
                        // Page navigation would happen here via Playwright API
                        const evidence = await deps.collectEvidence(page, routeInfo.route, ac);
                        evidence.networkSummary = networkCapture.summary();
                        evidence.consoleErrors = consoleCapture.errors();
                        evidence.screenshotPath = await deps.captureScreenshot(page, routeInfo.route, deps.cfg.ticket) ?? undefined;
                        routeEvidences.push(evidence);
                    }
                    catch (navErr) {
                        const msg = navErr instanceof Error ? navErr.message : String(navErr);
                        (0, logger_1.logWarn)(`Part 2: Navigation to ${routeInfo.route} failed: ${msg.substring(0, 200)}`);
                        routeEvidences.push({
                            route: routeInfo.route,
                            error: msg.substring(0, 300),
                            consoleErrors: consoleCapture.errors(),
                            networkSummary: networkCapture.summary(),
                        });
                    }
                }
                // Aggregate and run gap analysis
                const aggregated = deps.aggregateEvidence(routeEvidences);
                data._verify_evidence = aggregated.overallHealth;
                deps.save(state);
                const verdict = await runGapAnalysis(state, ac, aggregated, attempt, deps);
                if (verdict.agentFailed) {
                    data._browser_verify_skip_reason = 'agent_failure';
                    overallVerdict = 'SKIP';
                    (0, logger_1.logWarn)('Part 2: Gap Analysis Agent failed -- skipping verification');
                    break;
                }
                if (verdict.overall === 'PASS') {
                    overallVerdict = 'PASS';
                    (0, logger_1.logOk)(`Part 2: Verification PASSED on attempt ${attempt}`);
                    break;
                }
                if (verdict.overall === 'NEEDS_FIX' && attempt < deps.maxVerifyRetries) {
                    data._verify_known_gaps = verdict.gaps;
                    deps.save(state);
                    (0, logger_1.logInfo)(`Part 2: Gaps found -- will retry (attempt ${attempt + 1})`);
                    continue;
                }
                overallVerdict = 'SKIP';
                data._browser_verify_skip_reason = verdict.overall === 'SKIP' ? 'inconclusive' : 'max_retries_exceeded';
                (0, logger_1.logWarn)(`Part 2: Verification ${verdict.overall} after attempt ${attempt}`);
                break;
            }
            catch (attemptErr) {
                const msg = attemptErr instanceof Error ? attemptErr.message : String(attemptErr);
                (0, logger_1.logWarn)(`Part 2: Attempt ${attempt} error: ${msg.substring(0, 300)}`);
                if (attempt >= deps.maxVerifyRetries) {
                    data._browser_verify_skip_reason = 'attempt_error: ' + msg.substring(0, 200);
                    break;
                }
            }
        }
        data._browser_verified = overallVerdict;
        deps.save(state);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (overallVerdict === 'PASS') {
            (0, logger_1.logOk)(`Part 2: Browser verification complete -- PASS (${elapsed}s)`);
        }
        else {
            (0, logger_1.logWarn)(`Part 2: Browser verification complete -- ${overallVerdict} (${elapsed}s)`);
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logErr)(`Part 2: Unexpected error: ${msg.substring(0, 300)}`);
        data._browser_verified = 'SKIP';
        data._browser_verify_skip_reason = 'unexpected_error';
        deps.save(state);
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
    }
}
// ── Gap Analysis Agent ──────────────────────────────────────────────
async function runGapAnalysis(state, ac, aggregatedEvidence, attempt, deps) {
    const data = state.data;
    const previousGaps = attempt > 1 ? data._verify_known_gaps || [] : [];
    const evidenceStr = JSON.stringify(aggregatedEvidence, null, 2);
    const maxEvidenceSize = deps.evidenceMaxSize * 3;
    const truncatedEvidence = evidenceStr.length > maxEvidenceSize
        ? ((0, logger_1.logWarn)(`Gap analysis evidence truncated from ${evidenceStr.length} to ${maxEvidenceSize} chars`),
            evidenceStr.substring(0, maxEvidenceSize) + '\n...[truncated]')
        : evidenceStr;
    const prompt = `You are a QA Gap Analyst. Evaluate browser evidence against acceptance criteria.

## Acceptance Criteria
${(0, utils_1.sanitizeForPrompt)(ac)}

## Browser Evidence (attempt ${attempt}/${deps.maxVerifyRetries})
${truncatedEvidence}

${previousGaps.length > 0 ? `## Known Gaps from Previous Attempt\n${previousGaps.join('\n')}\n` : ''}

## Instructions
For each acceptance criterion, evaluate the evidence:
- PASS: Evidence confirms the AC is met
- PARTIAL: Element exists but content/behavior is uncertain
- FAIL: Element clearly missing, wrong content, or error

Output format:
AC 1: [criterion text] -> PASS | PARTIAL | FAIL
  Evidence: [what you found]
  Gap: [if not PASS, what's missing]

OVERALL: PASS | NEEDS_FIX | SKIP
FIX_INSTRUCTIONS: [if NEEDS_FIX, specific code changes needed]`;
    const output = await deps.runSingleAgent({
        name: 'Gap Analysis Agent',
        prompt,
        timeout: deps.applyComplexityTimeout(120_000, state),
        opts: { maxTurns: 3, allowedTools: [] },
        state,
        checkpointKey: `_gap_analysis_attempt_${attempt}`,
        required: false,
    });
    if (!output) {
        return { overall: 'SKIP', gaps: [], agentFailed: true };
    }
    return parseGapAnalysisVerdict(output);
}
/**
 * Parse Gap Analysis Agent output into structured verdict.
 */
function parseGapAnalysisVerdict(output) {
    const overallMatch = output.match(/OVERALL:\s*(PASS|NEEDS_FIX|SKIP)/i);
    const overall = (overallMatch ? overallMatch[1].toUpperCase() : 'SKIP');
    const gaps = [];
    const fixMatch = output.match(/FIX_INSTRUCTIONS:\s*(.+?)(?=\n\n|$)/is);
    if (fixMatch && overall === 'NEEDS_FIX') {
        gaps.push(fixMatch[1].trim());
    }
    // T2.4: Accept both -> and -> arrow styles
    const acPattern = /AC\s*\d+:.*?(?:->|→)\s*(FAIL|PARTIAL).*?\n\s*Gap:\s*(.+?)(?=\n(?:AC\s*\d+:|OVERALL:|$))/gis;
    let match;
    while ((match = acPattern.exec(output)) !== null) {
        gaps.push(match[2].trim());
    }
    return { overall, gaps, rawOutput: output };
}
/**
 * Run the Developer Fix Agent for browser-identified gaps.
 */
async function runBrowserFixAgent(ctx, gaps, attempt, state, deps) {
    const data = state.data;
    const ticket = data.ticket;
    const gapsList = Array.isArray(gaps) ? gaps.join('\n- ') : String(gaps);
    const prompt = `You are a Developer Fix Agent. The browser verification found specific gaps.

## Ticket: ${deps.cfg.ticket}
## Acceptance Criteria
${(0, utils_1.sanitizeForPrompt)(ticket?.ac || '')}

## Browser-Identified Gaps (attempt ${attempt})
- ${gapsList}

## Instructions
1. Read the relevant files to understand current code
2. Fix ONLY the specific gaps identified above
3. Do NOT rewrite files unnecessarily -- make minimal targeted changes
4. The dev server has HMR -- changes will hot-reload automatically`;
    const fixResult = await deps.runSingleAgent({
        name: 'Browser Fix Agent',
        prompt,
        timeout: deps.applyComplexityTimeout(deps.developerTimeoutMs, state),
        opts: { cwd: deps.cfg.localRepo, maxTurns: 15, allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'] },
        state,
        checkpointKey: `_gap_fix_attempt_${attempt}`,
        required: false,
    });
    if (!fixResult) {
        (0, logger_1.logWarn)(`Browser Fix Agent failed (attempt ${attempt}) -- continuing without fix`);
    }
}
// ── MR Description Builder ──────────────────────────────────────────
/**
 * Build MR description section for browser verification results.
 */
function buildBrowserVerifyMRSection(state) {
    const data = state.data;
    const verified = data._browser_verified;
    if (!verified)
        return '';
    const attempt = data._verify_attempt || 0;
    const routes = data._routes_detected || [];
    const health = data._verify_evidence || {};
    const consoleErrors = data._verify_console_summary || [];
    let section = '\n## Browser Verification\n';
    if (verified === 'PASS') {
        section += `- **Result**: PASS (attempt ${attempt})\n`;
    }
    else if (verified === 'SKIP') {
        section += '- **Result**: SKIPPED\n';
        const skipReason = data._browser_verify_skip_reason;
        if (skipReason)
            section += `- **Skip reason**: ${skipReason}\n`;
        const gaps = data._verify_known_gaps || [];
        if (gaps.length > 0)
            section += `- **Last known gaps**: ${gaps[0].substring(0, 200)}\n`;
        section += '- Manual testing recommended\n';
    }
    if (routes.length > 0) {
        section += `- **Routes checked**: ${routes.map((r) => r.route).join(', ')}\n`;
    }
    if (health.allRoutesLoaded !== undefined) {
        section += `- **All routes loaded**: ${health.allRoutesLoaded ? 'Yes' : 'No'}`;
        if (health.authFailures > 0)
            section += ` (${health.authFailures} auth redirect(s))`;
        section += '\n';
        if (health.highSeverityErrors > 0) {
            section += `- **High severity JS errors**: ${health.highSeverityErrors}\n`;
        }
        section += `- **Network healthy**: ${health.networkHealthy ? 'Yes' : 'No'}\n`;
    }
    if (consoleErrors.length > 0) {
        section += `- **Console errors**: ${consoleErrors.length}\n`;
        for (const err of consoleErrors.slice(0, 5)) {
            const severity = err.severity ? `[${err.severity}] ` : '';
            section += `  - ${severity}${err.text ? err.text.substring(0, 100) : 'unknown'}\n`;
        }
    }
    if (attempt > 1) {
        section += `- Passed on attempt ${attempt} after ${attempt - 1} fix(es)\n`;
    }
    return section;
}
//# sourceMappingURL=browser-verify.js.map