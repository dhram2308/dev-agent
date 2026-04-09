"use strict";

const fs = require("fs");
const path = require("path");
const { EVIDENCE_MAX_SIZE, TEST_ARTIFACTS_DIR, TICKET } = require("../../lib/config");
const { logInfo, logOk, logWarn } = require("../../lib/logging");

/**
 * Collect all evidence from a Playwright page after navigating to a route.
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {string} route - The route that was navigated to
 * @param {string} acceptanceCriteria - AC text for DOM checks
 * @returns {Promise<object>} Evidence object
 */
async function collectEvidence(page, route, acceptanceCriteria) {
  logInfo(`  Evidence: Collecting for ${route}…`);

  const [accessibilityTree, visibleText, domChecks, consoleErrors, navigation] = await Promise.allSettled([
    captureAccessibilityTree(page),
    captureVisibleText(page),
    runDOMChecks(page, acceptanceCriteria),
    Promise.resolve([]), // Console errors collected externally via listener
    captureNavigationTimeline(page, route),
  ]);

  const evidence = {
    route,
    timestamp: new Date().toISOString(),
    accessibilityTree: accessibilityTree.status === "fulfilled" ? accessibilityTree.value : null,
    visibleText: visibleText.status === "fulfilled" ? visibleText.value : "",
    domChecks: domChecks.status === "fulfilled" ? domChecks.value : [],
    networkSummary: null, // Set externally by network listener
    consoleErrors: [], // Set externally by console listener
    navigation: navigation.status === "fulfilled" ? navigation.value : null,
    screenshotPath: null,
  };

  logOk(`  Evidence: Collected for ${route}`);
  return evidence;
}

/**
 * Capture structured accessibility tree from the page.
 */
async function captureAccessibilityTree(page) {
  try {
    const tree = await page.accessibility.snapshot();
    if (!tree) {
      logWarn("  Accessibility tree: null — using raw HTML fallback");
      const html = await page.evaluate(() => document.body.innerHTML.substring(0, 5000));
      return { fallback: true, html };
    }

    // Prune to fit within EVIDENCE_MAX_SIZE
    const pruned = pruneAccessibilityTree(tree);
    const serialized = JSON.stringify(pruned);

    if (serialized.length > EVIDENCE_MAX_SIZE) {
      // Focus on role: "main" subtree only
      const mainChild = findMainContent(pruned);
      if (mainChild) return mainChild;
    }

    return pruned;
  } catch (e) {
    logWarn(`  Accessibility tree failed: ${e.message.substring(0, 100)}`);
    try {
      const html = await page.evaluate(() => document.body.innerHTML.substring(0, 5000));
      return { fallback: true, html };
    } catch {
      return null;
    }
  }
}

/**
 * Prune accessibility tree by removing generic/noise nodes.
 */
function pruneAccessibilityTree(node, depth = 0) {
  if (!node) return null;
  if (depth > 5) return { role: node.role, name: node.name ? node.name.substring(0, 100) : undefined };

  const pruned = { role: node.role };
  if (node.name) pruned.name = node.name.substring(0, 200);
  if (node.value) pruned.value = String(node.value).substring(0, 100);

  if (node.children && node.children.length > 0) {
    pruned.children = node.children
      .filter((c) => c.role !== "generic" && c.role !== "none")
      .map((c) => pruneAccessibilityTree(c, depth + 1))
      .filter(Boolean);
    if (pruned.children.length === 0) delete pruned.children;
  }

  return pruned;
}

/**
 * Find the main content subtree in an accessibility tree.
 */
function findMainContent(node) {
  if (!node) return null;
  if (node.role === "main") return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findMainContent(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Capture visible text content from the page.
 */
async function captureVisibleText(page) {
  try {
    let text = await page.textContent("body");
    if (!text) return "";
    // Normalize whitespace
    text = text.replace(/\s+/g, " ").trim();
    // Truncate to 5KB
    if (text.length > 5120) text = text.substring(0, 5120) + "…[truncated]";
    return text;
  } catch {
    return "";
  }
}

/**
 * Run targeted DOM checks based on acceptance criteria keywords.
 */
async function runDOMChecks(page, acceptanceCriteria) {
  const checks = [];
  const ac = (acceptanceCriteria || "").toLowerCase();

  // Map AC keywords to DOM selectors
  const selectorMap = [
    { keywords: ["table", "list", "grid"], selectors: ["table", ".ant-table", '[role="grid"]'] },
    { keywords: ["form", "input"], selectors: ["form", ".ant-form", "input"] },
    { keywords: ["modal", "dialog", "popup"], selectors: [".ant-modal", '[role="dialog"]'] },
    { keywords: ["dropdown", "select"], selectors: [".ant-select", "select"] },
    { keywords: ["tab", "tabs"], selectors: [".ant-tabs", '[role="tablist"]'] },
    { keywords: ["chart", "graph"], selectors: ["canvas", ".recharts-wrapper", "svg"] },
    { keywords: ["button"], selectors: ["button", ".ant-btn"] },
  ];

  for (const { keywords, selectors } of selectorMap) {
    const matches = keywords.some((kw) => ac.includes(kw));
    if (!matches) continue;

    for (const selector of selectors) {
      try {
        const count = await page.locator(selector).count();
        if (count > 0) {
          let text = "";
          try {
            text = await page.locator(selector).first().textContent({ timeout: 2000 });
            if (text) text = text.substring(0, 200).trim();
          } catch { /* text extraction optional */ }
          checks.push({ selector, found: true, count, text });
          break; // Found one match for this keyword group
        }
      } catch { /* selector not found */ }
    }

    // If none found for this keyword group
    if (!checks.some((c) => selectors.includes(c.selector))) {
      checks.push({ selector: selectors[0], found: false });
    }
  }

  // Always check for error boundary
  try {
    const errorBoundary = await page.locator(".error-boundary, [class*='error-boundary']").count();
    checks.push({ selector: ".error-boundary", found: errorBoundary > 0 });
  } catch { /* ignore */ }

  return checks;
}

/**
 * Set up network activity capture on a page.
 * Call BEFORE navigation. Returns a collector object.
 *
 * @param {import('playwright').Page} page
 * @returns {object} Network collector with .summary() method
 */
function setupNetworkCapture(page) {
  const MAX_ENTRIES = 500; // Cap to prevent unbounded memory growth
  const requests = [];
  const responses = [];
  const failures = [];

  page.on("request", (req) => {
    if (requests.length < MAX_ENTRIES) {
      requests.push({ url: req.url(), method: req.method(), timestamp: Date.now() });
    }
  });

  page.on("response", (res) => {
    if (responses.length < MAX_ENTRIES) {
      responses.push({ url: res.url(), status: res.status(), timestamp: Date.now() });
    }
  });

  page.on("requestfailed", (req) => {
    if (failures.length < MAX_ENTRIES) {
      failures.push({
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText || "unknown",
        timestamp: Date.now(),
      });
    }
  });

  return {
    summary() {
      const apiRequests = requests.filter((r) => r.url.includes("/api/"));
      const apiResponses = responses.filter((r) => r.url.includes("/api/"));
      const failedApi = apiResponses.filter((r) => r.status >= 400);
      const authFailures = apiResponses.filter((r) => r.status === 401 || r.status === 403);

      return {
        total: requests.length,
        succeeded: responses.filter((r) => r.status < 400).length,
        failed: failedApi.length + failures.length,
        failedUrls: [
          ...failedApi.slice(0, 10).map((r) => `${r.url.split("?")[0]} → ${r.status}`),
          ...failures.slice(0, 5).map((r) => `${r.method} ${r.url.split("?")[0]} → ${r.failure}`),
        ],
        apiCallsMade: apiRequests.slice(0, 20).map((r) => `${r.method} ${r.url.split("?")[0].replace(/.*\/api\//, "/api/")}`),
        authFailures: authFailures.length,
        networkHealthy: apiRequests.length === 0 || (failedApi.length / Math.max(apiRequests.length, 1)) < 0.5,
      };
    },
    reset() {
      requests.length = 0;
      responses.length = 0;
      failures.length = 0;
    },
  };
}

/**
 * Set up console error capture on a page.
 * Call BEFORE navigation. Returns a collector object.
 *
 * @param {import('playwright').Page} page
 * @returns {object} Console collector with .errors() method
 */
function setupConsoleCapture(page) {
  const MAX_ENTRIES = 200; // Cap to prevent unbounded memory growth
  const entries = [];

  page.on("console", (msg) => {
    if (entries.length >= MAX_ENTRIES) return;
    const type = msg.type();
    if (type === "error" || type === "warning") {
      entries.push({
        type,
        text: msg.text().substring(0, 500),
        url: msg.location()?.url || "",
        timestamp: Date.now(),
      });
    }
  });

  page.on("pageerror", (err) => {
    if (entries.length >= MAX_ENTRIES) return;
    entries.push({
      type: "pageerror",
      text: err.message.substring(0, 500),
      stack: err.stack ? err.stack.substring(0, 500) : "",
      timestamp: Date.now(),
    });
  });

  return {
    errors() {
      // Classify severity
      const classified = entries.map((e) => {
        let severity;
        if (e.type === "pageerror") {
          severity = "HIGH";
        } else if (e.type === "error" && (e.text.includes("Uncaught") || e.text.includes("unhandled"))) {
          severity = "HIGH";
        } else if (e.type === "error") {
          severity = "MEDIUM";
        } else if (e.text.includes("Warning: Each child") || e.text.includes("componentWill")) {
          severity = "LOW";
        } else if (e.url && (e.url.includes("clarity.ms") || e.url.includes("atlassian.net"))) {
          severity = "IGNORE";
        } else if (e.text.includes("WebSocket")) {
          severity = "IGNORE";
        } else if (e.text.includes("ERR_CERT")) {
          severity = "IGNORE";
        } else {
          severity = "LOW";
        }
        return { ...e, severity };
      });

      // Filter out IGNORE, deduplicate by message text
      const seen = new Map();
      for (const e of classified) {
        if (e.severity === "IGNORE") continue;
        if (seen.has(e.text)) {
          seen.get(e.text).count++;
        } else {
          seen.set(e.text, { ...e, count: 1 });
        }
      }

      // Sort by severity, limit to 20
      const severityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return Array.from(seen.values())
        .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
        .slice(0, 20);
    },
    reset() {
      entries.length = 0;
    },
  };
}

/**
 * Capture navigation timeline.
 */
async function captureNavigationTimeline(page, expectedRoute) {
  const currentUrl = page.url();
  let pathname;
  try {
    pathname = new URL(currentUrl).pathname;
  } catch {
    pathname = currentUrl;
  }

  const redirects = [];
  const authRedirect = pathname === "/login" || pathname === "/signin";

  return {
    finalUrl: pathname,
    expectedRoute,
    redirects,
    authRedirect,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Capture a full-page screenshot to disk.
 */
async function captureScreenshot(page, route, ticket) {
  try {
    const artifactsDir = path.join(process.cwd(), TEST_ARTIFACTS_DIR, ticket, "screenshots");
    if (!fs.existsSync(artifactsDir)) {
      fs.mkdirSync(artifactsDir, { recursive: true });
    }

    const slug = route.replace(/\//g, "_").replace(/^_/, "") || "root";
    const screenshotPath = path.join(artifactsDir, `${slug}.png`);

    await page.screenshot({ fullPage: true, path: screenshotPath });
    logOk(`  Screenshot: ${screenshotPath}`);
    return screenshotPath;
  } catch (e) {
    logWarn(`  Screenshot failed: ${e.message.substring(0, 100)}`);
    return null;
  }
}

/**
 * Aggregate evidence from multiple route results into a single object for the Gap Analysis Agent.
 *
 * @param {Array<object>} routeResults - Evidence per route
 * @returns {object} Aggregated evidence
 */
function aggregateEvidence(routeResults) {
  const overallHealth = {
    allRoutesLoaded: routeResults.every((r) => r.navigation && !r.navigation.authRedirect),
    authFailures: routeResults.filter((r) => r.navigation?.authRedirect).length,
    highSeverityErrors: routeResults.reduce((acc, r) =>
      acc + (r.consoleErrors || []).filter((e) => e.severity === "HIGH").length, 0),
    networkHealthy: routeResults.every((r) => !r.networkSummary || r.networkSummary.networkHealthy),
  };

  return { routes: routeResults, overallHealth };
}

module.exports = {
  collectEvidence,
  captureAccessibilityTree,
  captureVisibleText,
  runDOMChecks,
  setupNetworkCapture,
  setupConsoleCapture,
  captureNavigationTimeline,
  captureScreenshot,
  aggregateEvidence,
};
