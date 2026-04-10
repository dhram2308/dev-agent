#!/usr/bin/env node

/* ================================================================
   server.js — Web UI for AI Dev Agent
   Run: node server.js
   Open: http://localhost:3000

   Resilience integrations:
   - Security middleware (lib/security.js) — headers, CORS
   - Graceful shutdown (lib/graceful-shutdown.js) — SIGTERM handler
   - Process redaction (lib/process-redactor.js) — agent output redaction
   ================================================================ */

"use strict";

const http = require("http");
const crypto = require("crypto");

const { cleanOrphanedLocks, cleanOrphanedWorktreesOnStartup } = require("./server/agent-process");
const { handleRequest } = require("./server/routes");
const { getHTML } = require("./server/html");

// ── Resilience modules ──────────────────────────────────────────
const {
  registerHttpServer,
  registerSseClientGetter,
  installShutdownHandlers,
  onShutdown,
} = require("./lib/graceful-shutdown");

const { getSseClients } = require("./server/sse");

// Security: unified middleware (optional — may not exist yet in all envs)
let securityMiddleware;
try {
  securityMiddleware = require("./lib/security").securityMiddleware;
} catch {
  securityMiddleware = null;
}

// ── M6: Auth token for POST endpoints ────────────────────────────
const API_TOKEN = crypto.randomBytes(24).toString("hex");

// Pre-render HTML with injected token
const HTML = getHTML(API_TOKEN);

const PORT = process.env.PORT || 3000;
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";

// F10: Clean orphaned agent locks on startup
cleanOrphanedLocks();
// Clean orphaned worktrees from previous crashes
cleanOrphanedWorktreesOnStartup();

// [Graceful Shutdown] Install signal handlers for server context
installShutdownHandlers();

// ── HTTP Server ───────────────────────────────────────────────────

const server = http.createServer(async (request, res) => {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host}`);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Malformed URL" }));
    return;
  }

  // [Security] Unified security middleware — headers, CORS, rate limiting, auth
  if (securityMiddleware) {
    const sec = securityMiddleware(url, request, res, API_TOKEN);
    if (!sec.proceed) return; // Response already sent (CORS, rate limit, auth error)
  }

  await handleRequest(url, request, res, API_TOKEN, HTML);
});

// [Graceful Shutdown] Register server and SSE clients for cleanup
registerHttpServer(server);
registerSseClientGetter(getSseClients);

// [Graceful Shutdown] Register shutdown hook to log server closure
onShutdown("http-server-close", async () => {
  console.log("[Shutdown] HTTP server closing...");
});

// [Graceful Shutdown] Worktree cleanup — remove all worktrees on shutdown
onShutdown("worktree-cleanup", async () => {
  const { WORKTREES_DIR, removeWorktree, getActiveWorktrees } = require("./lib/local-repo");
  const activeWt = getActiveWorktrees();
  if (activeWt.length > 0) {
    console.log(`[Shutdown] Cleaning up ${activeWt.length} worktree(s)…`);
    for (const ticket of activeWt) {
      try { removeWorktree(ticket); } catch (e) {
        console.warn(`[Shutdown] Worktree cleanup failed for ${ticket}: ${e.message}`);
      }
    }
    try {
      const { execFileSync } = require("child_process");
      const path = require("path");
      const REPO_CACHE_DIR = path.join(__dirname, ".repo-cache");
      execFileSync("git", ["-C", REPO_CACHE_DIR, "worktree", "prune"], { stdio: "pipe", timeout: 10_000 });
    } catch {}
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} already in use. Set PORT env var or kill existing process.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`\n  AI Dev Agent UI -> http://${BIND_HOST}:${PORT}\n`);
});
