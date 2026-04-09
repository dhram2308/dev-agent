"use strict";

const fs = require("fs");
const path = require("path");
const { logInfo, logOk, logWarn } = require("../../lib/logging");

// Known module-to-route mappings (from 17 route files in the enterprise app)
const MODULE_ROUTE_MAP = {
  "gst-return": "/gst-return",
  "reports": "/reports",
  "dashboard": "/dashboard",
  "configuration": "/config",
  "config": "/config",
  "import": "/import",
  "reconcile": "/reconcile",
  "ims": "/ims",
  "auth": "/login",
  "profile": "/profile",
  "tds": "/tds",
  "e-invoice": "/e-invoice",
  "e-way-bill": "/e-way-bill",
  "einvoice": "/e-invoice",
  "ewaybill": "/e-way-bill",
};

// Route files to search for import chain analysis
const ROUTE_FILE_PATTERNS = [
  "**/routes.tsx",
  "**/*Routes.tsx",
  "**/AppRoutes.tsx",
];

/**
 * Detect which routes to verify based on changed file paths.
 * Uses a 5-tier algorithm with decreasing confidence.
 *
 * @param {Array<{file_path: string, action: string}>} changedFiles - Changed files from localGetChanges()
 * @param {string} clonePath - Path to .repo-cache
 * @param {string} [acceptanceCriteria=""] - AC text for Tier 3 extraction
 * @returns {Array<{route: string, confidence: number, source: string, tier: number}>}
 */
function detectRoutes(changedFiles, clonePath, acceptanceCriteria = "") {
  logInfo(`Route detection: Analyzing ${changedFiles.length} changed files…`);
  const results = [];
  const seenRoutes = new Set();

  // Filter to relevant source files only
  const sourceFiles = changedFiles
    .filter((f) => f.action !== "delete")
    .filter((f) => /\.(tsx?|jsx?)$/.test(f.file_path))
    .map((f) => f.file_path);

  // Tier 1: Direct file path → route mapping
  for (const filePath of sourceFiles) {
    const route = mapFilePathToRoute(filePath);
    if (route && !seenRoutes.has(route)) {
      seenRoutes.add(route);
      results.push({ route, confidence: 0.95, source: "file-path", tier: 1 });
    }
  }

  // Tier 2: Import chain analysis (only if Tier 1 found nothing)
  if (results.length === 0) {
    for (const filePath of sourceFiles) {
      const routes = traceComponentToRoute(filePath, clonePath);
      for (const route of routes) {
        if (!seenRoutes.has(route)) {
          seenRoutes.add(route);
          results.push({ route, confidence: 0.80, source: "import-chain", tier: 2 });
        }
      }
    }
  }

  // Tier 3: AC text extraction
  if (results.length === 0 && acceptanceCriteria) {
    const acRoutes = extractRoutesFromAC(acceptanceCriteria);
    for (const { route, confidence } of acRoutes) {
      if (!seenRoutes.has(route)) {
        seenRoutes.add(route);
        results.push({ route, confidence, source: "ac-text", tier: 3 });
      }
    }
  }

  // Tier 4: Module name grep
  if (results.length === 0) {
    for (const filePath of sourceFiles) {
      const routes = grepRoutesForModule(filePath, clonePath);
      for (const route of routes) {
        if (!seenRoutes.has(route)) {
          seenRoutes.add(route);
          results.push({ route, confidence: 0.50, source: "grep-match", tier: 4 });
        }
      }
    }
  }

  // Tier 5: Fallback to /dashboard
  if (results.length === 0) {
    logWarn("Route detection: No specific route detected — falling back to /dashboard");
    results.push({ route: "/dashboard", confidence: 0.30, source: "fallback", tier: 5 });
  }

  // Validate and deduplicate
  const validated = validateDetectedRoutes(results);

  logOk(`Route detection: ${validated.length} route(s) detected`);
  for (const r of validated) {
    logInfo(`  ${r.route} (confidence: ${(r.confidence * 100).toFixed(0)}%, source: ${r.source})`);
  }

  return validated;
}

/**
 * Tier 1: Map file path to route using known module-to-route table.
 */
function mapFilePathToRoute(filePath) {
  // Pattern: libs/entp/src/lib/{module}/{feature}/...
  const entpMatch = filePath.match(/libs\/entp\/src\/lib\/([^/]+)(?:\/([^/]+))?/);
  if (entpMatch) {
    const moduleName = entpMatch[1].toLowerCase();
    const featureName = entpMatch[2] ? entpMatch[2].toLowerCase() : null;
    const baseRoute = MODULE_ROUTE_MAP[moduleName];
    if (baseRoute) {
      if (featureName && featureName !== "index.tsx" && !featureName.includes(".")) {
        return `${baseRoute}/${toKebabCase(featureName)}`;
      }
      return baseRoute;
    }
  }

  // Pattern: apps/enterprise/src/.../{module}/...
  const appMatch = filePath.match(/apps\/enterprise\/src\/.*?\/([^/]+)\//);
  if (appMatch) {
    const moduleName = appMatch[1].toLowerCase();
    const baseRoute = MODULE_ROUTE_MAP[moduleName];
    if (baseRoute) return baseRoute;
  }

  // Shared/utility files — no direct route mapping
  if (filePath.includes("libs/shared/") || filePath.includes("libs/helpers/") || filePath.includes("libs/services/")) {
    return null;
  }

  return null;
}

/**
 * Tier 2: Trace a component to its route by searching route files.
 */
function traceComponentToRoute(filePath, clonePath) {
  const routes = [];
  const fileName = path.basename(filePath, path.extname(filePath));
  if (!fileName || fileName === "index") return routes;

  // Find route files
  const routeFiles = findRouteFiles(clonePath);

  for (const routeFile of routeFiles) {
    try {
      const content = fs.readFileSync(routeFile, "utf8");

      // Look for: <Route path="/..." element={<ComponentName ...
      const routePattern = new RegExp(`path=["']([^"']+)["'][^>]*?(?:element|component).*?${fileName}`, "gi");
      let match;
      while ((match = routePattern.exec(content)) !== null) {
        routes.push(match[1]);
      }

      // Look for: lazy(() => import('...path containing fileName...'))
      if (content.includes(fileName)) {
        const lazyPattern = new RegExp(`path:\\s*["']([^"']+)["']`, "gi");
        let lazyMatch;
        while ((lazyMatch = lazyPattern.exec(content)) !== null) {
          // Only include if this route file section references our component
          const contextStart = Math.max(0, lazyMatch.index - 500);
          const contextEnd = Math.min(content.length, lazyMatch.index + 500);
          const context = content.substring(contextStart, contextEnd);
          if (context.includes(fileName)) {
            routes.push(lazyMatch[1]);
          }
        }
      }
    } catch (e) { logWarn(`Route detection: Failed reading route file: ${e.message.substring(0, 100)}`); }
  }

  return routes;
}

/**
 * Tier 3: Extract routes from acceptance criteria text.
 */
function extractRoutesFromAC(ac) {
  const routes = [];

  // Explicit URLs: "/path/to/page"
  const urlPattern = /["'](\/[a-z0-9-/]+)["']/gi;
  let match;
  while ((match = urlPattern.exec(ac)) !== null) {
    routes.push({ route: match[1], confidence: 0.90 });
  }

  // "Navigate to X > Y" pattern (length-limited to prevent ReDoS)
  const navPattern = /navigate\s+to\s+([^>\n]{1,100}?)(?:\s*>\s*([^>\n]{1,100}?))?(?:\s*>|\.|\n)/gi;
  while ((match = navPattern.exec(ac)) !== null) {
    const module = match[1].trim().toLowerCase();
    const feature = match[2] ? match[2].trim().toLowerCase() : null;
    const baseRoute = findRouteForModuleName(module);
    if (baseRoute) {
      const route = feature ? `${baseRoute}/${toKebabCase(feature)}` : baseRoute;
      routes.push({ route, confidence: 0.70 });
    }
  }

  // Module name mentions
  for (const [moduleName, route] of Object.entries(MODULE_ROUTE_MAP)) {
    if (moduleName === "auth" || moduleName === "config") continue; // Too generic
    const pattern = new RegExp(`\\b${moduleName.replace(/-/g, "[- ]?")}\\b`, "i");
    if (pattern.test(ac)) {
      routes.push({ route, confidence: 0.60 });
    }
  }

  return routes;
}

/**
 * Tier 4: Grep route files for module name from file path.
 */
function grepRoutesForModule(filePath, clonePath) {
  const routes = [];
  const parts = filePath.split("/");

  // Extract module-like directory names
  const candidates = parts.filter((p) => !["src", "lib", "libs", "entp", "apps", "enterprise", "index.tsx", "index.ts"].includes(p));

  const routeFiles = findRouteFiles(clonePath);
  for (const routeFile of routeFiles) {
    try {
      const content = fs.readFileSync(routeFile, "utf8");
      for (const candidate of candidates) {
        if (candidate.includes(".")) continue; // Skip filenames
        if (content.toLowerCase().includes(candidate.toLowerCase())) {
          // Extract nearby path= values
          const pathPattern = /path=["']([^"']+)["']/gi;
          let match;
          while ((match = pathPattern.exec(content)) !== null) {
            if (match[1].toLowerCase().includes(candidate.toLowerCase())) {
              routes.push(match[1]);
            }
          }
        }
      }
    } catch (e) { logWarn(`Route detection: Grep failed for route file: ${e.message.substring(0, 100)}`); }
  }

  return routes;
}

/**
 * Validate and clean up detected routes.
 */
function validateDetectedRoutes(routes) {
  // Discard auth routes
  const filtered = routes.filter((r) => {
    const p = r.route.toLowerCase();
    if (p === "/login" || p === "/signup" || p === "/reset-password" || p === "/otp-verify") {
      return false;
    }
    return true;
  });

  // Deduplicate by normalized path
  const seen = new Map();
  for (const r of filtered) {
    const normalized = r.route.replace(/\/+$/, "").toLowerCase();
    if (!seen.has(normalized) || seen.get(normalized).confidence < r.confidence) {
      seen.set(normalized, r);
    }
  }

  // Sort by confidence, limit to 5
  return Array.from(seen.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}

// ── Helpers ──────────────────────────────────────────────────────────

function findRouteFiles(clonePath) {
  const results = [];
  const searchDirs = [
    path.join(clonePath, "libs", "entp", "src"),
    path.join(clonePath, "apps", "enterprise", "src"),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    walkForRouteFiles(dir, results);
  }
  return results;
}

function walkForRouteFiles(dir, results, depth = 0) {
  if (depth > 10) return; // Prevent excessive recursion in deep trees
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkForRouteFiles(fullPath, results, depth + 1);
      } else if (/[Rr]outes?\.(tsx?|jsx?)$/.test(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch (e) { logWarn(`Route detection: walkForRouteFiles error: ${e.message.substring(0, 80)}`); }
}

function findRouteForModuleName(name) {
  const lower = name.toLowerCase().replace(/\s+/g, "-");
  return MODULE_ROUTE_MAP[lower] || null;
}

function toKebabCase(str) {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

module.exports = { detectRoutes, mapFilePathToRoute, MODULE_ROUTE_MAP };
