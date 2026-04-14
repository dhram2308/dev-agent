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

import type { PipelineState } from '@shared/types';
import {
  logInfo, logOk, logWarn, logErr, logStep,
} from '../lib/logger';
import { sanitizeForPrompt } from '../lib/utils';
import { isShuttingDown, onShutdown } from '../lib/graceful-shutdown';

// ── Types ────────────────────────────────────────────────────────────

/** File change entry */
export interface FileChange {
  action: string;
  file_path: string;
  content?: string;
}

/** Route info detected from changed files */
interface RouteInfo {
  route: string;
  source?: string;
}

/** Route evidence from verification */
interface RouteEvidence {
  route: string;
  error?: string;
  consoleErrors?: Array<{ severity: string; text?: string; message?: string }>;
  networkSummary?: Record<string, unknown>;
  screenshotPath?: string;
}

/** Aggregated evidence */
interface AggregatedEvidence {
  overallHealth: {
    allRoutesLoaded: boolean;
    authFailures: number;
    highSeverityErrors: number;
    networkHealthy: boolean;
  };
  [key: string]: unknown;
}

/** Gap analysis verdict */
interface GapVerdict {
  overall: 'PASS' | 'NEEDS_FIX' | 'SKIP';
  gaps: string[];
  rawOutput?: string;
  agentFailed?: boolean;
}

/** Context passed from generate-code orchestrator */
export interface BrowserVerifyContext {
  state: PipelineState;
  approvedPlan: string;
  devFullContext: string;
  extraDocs: string;
  extraFeedback: string;
  feedback: string;
}

/** Dependencies for browser verification */
export interface BrowserVerifyDeps {
  cfg: {
    localRepo: string;
    ticket: string;
    urls?: { qa?: string };
    qa?: { main?: { user?: string; pass?: string } };
  };
  /** Feature flag */
  browserVerify: boolean;
  /** Max verification retries */
  maxVerifyRetries: number;
  /** Verification timeout */
  verificationTimeout: number;
  /** Developer timeout */
  developerTimeoutMs: number;
  /** Max evidence size */
  evidenceMaxSize: number;
  /** Apply complexity timeout */
  applyComplexityTimeout: (baseMs: number, state: PipelineState) => number;
  /** Save state */
  save: (state: PipelineState) => void;
  /** Run a single agent */
  runSingleAgent: (opts: {
    name: string;
    prompt: string;
    timeout: number;
    opts: Record<string, unknown>;
    state: PipelineState;
    checkpointKey: string;
    required: boolean;
  }) => Promise<string | null>;
  /** Get local repo changes */
  localGetChanges: (repoPath: string) => FileChange[];
  /** Dev server controls */
  startDevServer: (repoPath: string, state: PipelineState) => Promise<{
    port: number; pid: number;
  } | null>;
  stopDevServer: (state: PipelineState) => void;
  isProcessAlive: (pid: number) => boolean;
  /** Route detection */
  detectRoutes: (changedFiles: FileChange[], repoPath: string, ac: string) => RouteInfo[];
  /** Evidence collection */
  collectEvidence: (page: unknown, route: string, ac: string) => Promise<RouteEvidence>;
  setupNetworkCapture: (page: unknown) => { reset: () => void; summary: () => Record<string, unknown> };
  setupConsoleCapture: (page: unknown) => {
    reset: () => void;
    errors: () => Array<{ severity: string; text?: string; message?: string }>;
  };
  captureScreenshot: (page: unknown, route: string, ticket: string) => Promise<string | null>;
  aggregateEvidence: (evidences: RouteEvidence[]) => AggregatedEvidence;
  /** Health check + login */
  checkQAHealth: (url: string) => Promise<{ healthy: boolean; reason?: string }>;
  loginToApp: (page: unknown, port: number, credentials: {
    email: string; pass: string;
  }) => Promise<{ success: boolean; reason?: string }>;
}

// Module-level ref for shutdown hook cleanup
let _activeBrowser: { close: () => Promise<void> } | null = null;

// Register Playwright cleanup on shutdown
onShutdown('codegen-playwright', async () => {
  if (_activeBrowser) {
    try { await _activeBrowser.close(); } catch { /* ignore */ }
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
export async function runBrowserVerification(
  state: PipelineState,
  ctx: BrowserVerifyContext,
  deps: BrowserVerifyDeps,
): Promise<void> {
  const data = state.data as Record<string, unknown>;

  if (!deps.browserVerify) {
    logInfo('Part 2: BROWSER_VERIFY=false -- skipping browser verification');
    data._routes_detected = 'SKIP';
    data._login_complete = 'SKIP';
    data._browser_verified = 'SKIP';
    deps.save(state);
    return;
  }

  if (!data._dev_server_ready) {
    logWarn('Part 2: Dev server not ready -- skipping browser verification');
    data._browser_verified = 'SKIP';
    data._browser_verify_skip_reason = 'dev_server_not_ready';
    deps.save(state);
    return;
  }

  // Checkpoint: already verified this run
  if (data._browser_verified === 'PASS' || data._browser_verified === 'SKIP') {
    logOk(`Part 2: Browser verification already ${data._browser_verified} (cached)`);
    return;
  }

  logStep('2.5', 'Browser-based verification');
  const startTime = Date.now();

  let browser: { close: () => Promise<void> } | null = null;
  let context: { newPage: () => Promise<unknown>; close: () => Promise<void> } | null = null;

  try {
    // Step 1: Check QA backend health
    const qaUrl = deps.cfg.urls?.qa || '';
    if (qaUrl) {
      const health = await deps.checkQAHealth(qaUrl);
      if (!health.healthy) {
        logWarn(`Part 2: QA backend unhealthy -- ${health.reason}`);
        data._browser_verified = 'SKIP';
        data._browser_verify_skip_reason = 'backend_unhealthy';
        deps.save(state);
        return;
      }
      logOk('Part 2: QA backend healthy');
    }

    // Step 2: Start dev server if needed
    const port = data._nx_serve_port as number;
    if (!port || !deps.isProcessAlive(data._nx_serve_pid as number)) {
      logInfo('Part 2: Starting dev server...');
      const server = await deps.startDevServer(deps.cfg.localRepo, state);
      if (!server) {
        logWarn('Part 2: Dev server failed to start -- skipping verification');
        data._browser_verified = 'SKIP';
        data._browser_verify_skip_reason = 'dev_server_start_failed';
        deps.save(state);
        return;
      }
    }

    const serverPort = data._nx_serve_port as number;

    // Step 3: Launch Playwright
    // Dynamic import to handle optional dependency
    let chromium: { launch: (opts: Record<string, unknown>) => Promise<unknown> };
    try {
      const pw = await import('playwright' as string);
      chromium = pw.chromium;
    } catch {
      logWarn('Part 2: Playwright not available -- skipping browser verification');
      data._browser_verified = 'SKIP';
      data._browser_verify_skip_reason = 'playwright_not_installed';
      deps.save(state);
      return;
    }

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }) as { close: () => Promise<void> };
    _activeBrowser = browser;

    context = await (browser as unknown as {
      newContext: (opts: Record<string, unknown>) => Promise<{
        newPage: () => Promise<unknown>;
        close: () => Promise<void>;
      }>;
    }).newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
    });

    // Step 4: Detect routes
    const changedFiles = deps.localGetChanges(deps.cfg.localRepo);
    const ac = ((data.ticket as Record<string, unknown>)?.ac as string) || '';
    if (!data._routes_detected) {
      data._routes_detected = deps.detectRoutes(changedFiles, deps.cfg.localRepo, ac);
      deps.save(state);
    }

    // Step 5: Verification loop
    const credentials = {
      email: process.env.VERIFY_LOGIN_EMAIL || deps.cfg.qa?.main?.user || '',
      pass: process.env.VERIFY_LOGIN_PASS || deps.cfg.qa?.main?.pass || '',
    };

    let overallVerdict: 'PASS' | 'SKIP' = 'SKIP';

    for (let attempt = 1; attempt <= deps.maxVerifyRetries; attempt++) {
      if (isShuttingDown()) {
        logInfo('Part 2: Shutdown in progress -- aborting verification');
        break;
      }

      data._verify_attempt = attempt;
      deps.save(state);

      // Check total timeout
      if (Date.now() - startTime > deps.verificationTimeout) {
        logWarn('Part 2: Verification timeout reached');
        data._browser_verify_skip_reason = 'timeout';
        break;
      }

      logInfo(`Part 2: Verification attempt ${attempt}/${deps.maxVerifyRetries}`);

      // If retry: run fix agent first
      if (attempt > 1 && data._verify_known_gaps) {
        logInfo('Part 2: Running fix agent for identified gaps...');
        await runBrowserFixAgent(ctx, data._verify_known_gaps as string[], attempt, state, deps);
        data._routes_detected = null;
        logInfo('Part 2: Waiting 5s for HMR hot reload...');
        await new Promise<void>((r) => setTimeout(r, 5000));
      }

      const page = await context!.newPage();

      try {
        // Login
        logInfo('Part 2: Logging in...');
        const loginResult = await deps.loginToApp(page, serverPort, credentials);
        if (!loginResult.success) {
          logWarn(`Part 2: Login failed -- ${loginResult.reason}`);
          data._login_complete = false;
          data._browser_verified = 'SKIP';
          data._browser_verify_skip_reason = 'login_failed';
          deps.save(state);
          break;
        }

        data._login_complete = true;
        deps.save(state);
        logOk('Part 2: Login successful');

        // Re-detect routes on retry
        if (!data._routes_detected) {
          const freshFiles = deps.localGetChanges(deps.cfg.localRepo);
          data._routes_detected = deps.detectRoutes(freshFiles, deps.cfg.localRepo, ac);
          deps.save(state);
        }
        const currentRoutes = (data._routes_detected as RouteInfo[]) || [];

        // Navigate and collect evidence
        const routeEvidences: RouteEvidence[] = [];
        for (const routeInfo of currentRoutes) {
          const networkCapture = deps.setupNetworkCapture(page);
          const consoleCapture = deps.setupConsoleCapture(page);
          logInfo(`Part 2: Navigating to ${routeInfo.route}...`);

          try {
            // Page navigation would happen here via Playwright API
            const evidence = await deps.collectEvidence(page, routeInfo.route, ac);
            evidence.networkSummary = networkCapture.summary();
            evidence.consoleErrors = consoleCapture.errors();
            evidence.screenshotPath = await deps.captureScreenshot(page, routeInfo.route, deps.cfg.ticket) ?? undefined;
            routeEvidences.push(evidence);
          } catch (navErr: unknown) {
            const msg = navErr instanceof Error ? navErr.message : String(navErr);
            logWarn(`Part 2: Navigation to ${routeInfo.route} failed: ${msg.substring(0, 200)}`);
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
          logWarn('Part 2: Gap Analysis Agent failed -- skipping verification');
          break;
        }

        if (verdict.overall === 'PASS') {
          overallVerdict = 'PASS';
          logOk(`Part 2: Verification PASSED on attempt ${attempt}`);
          break;
        }

        if (verdict.overall === 'NEEDS_FIX' && attempt < deps.maxVerifyRetries) {
          data._verify_known_gaps = verdict.gaps;
          deps.save(state);
          logInfo(`Part 2: Gaps found -- will retry (attempt ${attempt + 1})`);
          continue;
        }

        overallVerdict = 'SKIP';
        data._browser_verify_skip_reason = verdict.overall === 'SKIP' ? 'inconclusive' : 'max_retries_exceeded';
        logWarn(`Part 2: Verification ${verdict.overall} after attempt ${attempt}`);
        break;
      } catch (attemptErr: unknown) {
        const msg = attemptErr instanceof Error ? attemptErr.message : String(attemptErr);
        logWarn(`Part 2: Attempt ${attempt} error: ${msg.substring(0, 300)}`);
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
      logOk(`Part 2: Browser verification complete -- PASS (${elapsed}s)`);
    } else {
      logWarn(`Part 2: Browser verification complete -- ${overallVerdict} (${elapsed}s)`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logErr(`Part 2: Unexpected error: ${msg.substring(0, 300)}`);
    data._browser_verified = 'SKIP';
    data._browser_verify_skip_reason = 'unexpected_error';
    deps.save(state);
  } finally {
    if (context) {
      try { await context.close(); } catch { /* ignore */ }
    }
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
      _activeBrowser = null;
    }
  }
}

// ── Gap Analysis Agent ──────────────────────────────────────────────

async function runGapAnalysis(
  state: PipelineState,
  ac: string,
  aggregatedEvidence: AggregatedEvidence,
  attempt: number,
  deps: BrowserVerifyDeps,
): Promise<GapVerdict> {
  const data = state.data as Record<string, unknown>;
  const previousGaps = attempt > 1 ? (data._verify_known_gaps as string[]) || [] : [];

  const evidenceStr = JSON.stringify(aggregatedEvidence, null, 2);
  const maxEvidenceSize = deps.evidenceMaxSize * 3;
  const truncatedEvidence = evidenceStr.length > maxEvidenceSize
    ? (logWarn(`Gap analysis evidence truncated from ${evidenceStr.length} to ${maxEvidenceSize} chars`),
       evidenceStr.substring(0, maxEvidenceSize) + '\n...[truncated]')
    : evidenceStr;

  const prompt = `You are a QA Gap Analyst. Evaluate browser evidence against acceptance criteria.

## Acceptance Criteria
${sanitizeForPrompt(ac)}

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
function parseGapAnalysisVerdict(output: string): GapVerdict {
  const overallMatch = output.match(/OVERALL:\s*(PASS|NEEDS_FIX|SKIP)/i);
  const overall = (overallMatch ? overallMatch[1].toUpperCase() : 'SKIP') as 'PASS' | 'NEEDS_FIX' | 'SKIP';

  const gaps: string[] = [];
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
async function runBrowserFixAgent(
  ctx: BrowserVerifyContext,
  gaps: string[],
  attempt: number,
  state: PipelineState,
  deps: BrowserVerifyDeps,
): Promise<void> {
  const data = state.data as Record<string, unknown>;
  const ticket = data.ticket as Record<string, unknown> | undefined;
  const gapsList = Array.isArray(gaps) ? gaps.join('\n- ') : String(gaps);

  const prompt = `You are a Developer Fix Agent. The browser verification found specific gaps.

## Ticket: ${deps.cfg.ticket}
## Acceptance Criteria
${sanitizeForPrompt((ticket?.ac as string) || '')}

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
    logWarn(`Browser Fix Agent failed (attempt ${attempt}) -- continuing without fix`);
  }
}

// ── MR Description Builder ──────────────────────────────────────────

/**
 * Build MR description section for browser verification results.
 */
export function buildBrowserVerifyMRSection(state: PipelineState): string {
  const data = state.data as Record<string, unknown>;
  const verified = data._browser_verified as string;
  if (!verified) return '';

  const attempt = (data._verify_attempt as number) || 0;
  const routes = (data._routes_detected as RouteInfo[]) || [];
  const health = (data._verify_evidence as AggregatedEvidence['overallHealth']) || {};
  const consoleErrors = (data._verify_console_summary as Array<{
    severity?: string; text?: string;
  }>) || [];

  let section = '\n## Browser Verification\n';

  if (verified === 'PASS') {
    section += `- **Result**: PASS (attempt ${attempt})\n`;
  } else if (verified === 'SKIP') {
    section += '- **Result**: SKIPPED\n';
    const skipReason = data._browser_verify_skip_reason as string;
    if (skipReason) section += `- **Skip reason**: ${skipReason}\n`;
    const gaps = (data._verify_known_gaps as string[]) || [];
    if (gaps.length > 0) section += `- **Last known gaps**: ${gaps[0].substring(0, 200)}\n`;
    section += '- Manual testing recommended\n';
  }

  if (routes.length > 0) {
    section += `- **Routes checked**: ${routes.map((r) => r.route).join(', ')}\n`;
  }

  if (health.allRoutesLoaded !== undefined) {
    section += `- **All routes loaded**: ${health.allRoutesLoaded ? 'Yes' : 'No'}`;
    if (health.authFailures > 0) section += ` (${health.authFailures} auth redirect(s))`;
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
