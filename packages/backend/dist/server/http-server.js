"use strict";
// =====================================================================
// MI Dev Agent -- HTTP Server (TypeScript port)
// =====================================================================
// Web UI server for the AI Dev Agent.
//
// Features:
//   - HTTP server on configurable port (default 3000)
//   - Security middleware integration (optional, try-catch load)
//   - Graceful shutdown with registered hooks
//   - SSE client management via registerClient
//   - API_TOKEN generation for auth (crypto.randomBytes)
//   - Clean orphaned locks on startup
//   - Serve React build from packages/frontend/dist/ for non-API routes
//   - Worktree cleanup on shutdown
//
// Ported from: server.js
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
exports.BIND_HOST = exports.PORT = exports.API_TOKEN = void 0;
exports.startServer = startServer;
exports.getServer = getServer;
exports.getApiToken = getApiToken;
exports.getRenderedHTML = getRenderedHTML;
exports.getPort = getPort;
exports.getBindHost = getBindHost;
const http = __importStar(require("http"));
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const graceful_shutdown_1 = require("../lib/graceful-shutdown");
const sse_1 = require("./sse");
const routes_1 = require("./routes");
const state_manager_1 = require("../state/state-manager");
let securityMiddleware = null;
try {
    securityMiddleware = require('../../lib/security').securityMiddleware || null;
}
catch {
    try {
        securityMiddleware = require('../../../../lib/security').securityMiddleware || null;
    }
    catch {
        securityMiddleware = null;
    }
}
let agentProcess = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    agentProcess = require('./agent-process');
}
catch {
    // Fall back to legacy CommonJS module (server/agent-process.js)
    try {
        agentProcess = require('../../../../server/agent-process');
    }
    catch {
        agentProcess = null;
    }
}
let localRepo = null;
try {
    localRepo = require('../../lib/local-repo');
}
catch {
    try {
        localRepo = require('../../../../lib/local-repo');
    }
    catch {
        localRepo = null;
    }
}
// ── Configuration ────────────────────────────────────────────────
/** M6: Auth token for POST endpoints */
const API_TOKEN = crypto.randomBytes(24).toString('hex');
exports.API_TOKEN = API_TOKEN;
/** Server port */
const PORT = parseInt(process.env.PORT || '3000', 10) || 3000;
exports.PORT = PORT;
/** Server bind host */
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
exports.BIND_HOST = BIND_HOST;
/** Base directory for the project */
const BASE_DIR = path.join(__dirname, '..', '..', '..', '..');
// ── HTML Generation ──────────────────────────────────────────────
/**
 * Generate HTML with injected API token.
 * Tries to read from frontend dist, falls back to a minimal placeholder.
 */
function getHTML(apiToken) {
    const frontendIndex = path.join(__dirname, '..', '..', '..', 'frontend', 'dist', 'index.html');
    try {
        if (fs.existsSync(frontendIndex)) {
            let html = fs.readFileSync(frontendIndex, 'utf8');
            // Inject API token into the HTML
            html = html.replace('</head>', `<script>window.__API_TOKEN__="${apiToken}";</script></head>`);
            return html;
        }
    }
    catch { /* fallback below */ }
    // Minimal fallback HTML
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MI Dev Agent</title>
  <script>window.__API_TOKEN__="${apiToken}";</script>
</head>
<body>
  <div id="root">
    <p>Frontend not built. Run <code>npm run build</code> in packages/frontend/</p>
  </div>
</body>
</html>`;
}
// ── Server instance ──────────────────────────────────────────────
/** Pre-render HTML with injected token */
const HTML = getHTML(API_TOKEN);
/** The HTTP server instance */
let server;
// ── Startup ─────────────────────────────────────────────────────
/**
 * Start the HTTP server.
 *
 * Sets up:
 *   1. Clean orphaned locks from previous crashes
 *   2. Graceful shutdown handlers
 *   3. HTTP server with security middleware and route handling
 *   4. SSE client management registration
 *   5. Shutdown hooks for server close and worktree cleanup
 *   6. Error handling for EADDRINUSE
 *
 * @returns The HTTP server instance
 */
function startServer() {
    // F10: Clean orphaned agent locks on startup
    if (agentProcess) {
        agentProcess.cleanOrphanedLocks();
        agentProcess.cleanOrphanedWorktreesOnStartup();
    }
    // [Graceful Shutdown] Install signal handlers for server context
    (0, graceful_shutdown_1.installShutdownHandlers)();
    // [Pipeline Dashboard] Auto-cleanup stale state files on startup
    try {
        const result = (0, state_manager_1.cleanupStaleStates)();
        if (result.archived.length > 0 || result.deleted.length > 0) {
            console.log(`[Startup] Cleanup: archived ${result.archived.length} state(s), deleted ${result.deleted.length} archive file(s)`);
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[Startup] State cleanup failed (non-fatal): ${msg}`);
    }
    // Wire agent process handlers into routes
    if (agentProcess) {
        (0, routes_1.setAgentProcessHandlers)({
            startAgent: agentProcess.startAgent,
            stopAgent: agentProcess.stopAgent,
            checkProcessHealth: agentProcess.checkProcessHealth,
            getAgentProcs: agentProcess.getAgentProcs,
            STAGE_DATA_MAP: agentProcess.STAGE_DATA_MAP,
        });
        // Wire agent procs getter into SSE for status broadcasts
        (0, sse_1.setAgentProcsGetter)(agentProcess.getAgentProcs);
    }
    // ── Create HTTP Server ─────────────────────────────────────────
    server = http.createServer(async (request, res) => {
        let url;
        try {
            url = new URL(request.url || '/', `http://${request.headers.host}`);
        }
        catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Malformed URL' }));
            return;
        }
        // [Security] Unified security middleware -- headers, CORS, rate limiting, auth
        if (securityMiddleware) {
            const sec = securityMiddleware(url, request, res, API_TOKEN);
            if (!sec.proceed)
                return; // Response already sent (CORS, rate limit, auth error)
        }
        await (0, routes_1.handleRequest)(url, request, res, API_TOKEN, HTML);
    });
    // [Graceful Shutdown] Register server and SSE clients for cleanup
    (0, graceful_shutdown_1.registerHttpServer)(server);
    (0, graceful_shutdown_1.registerSseClientGetter)(sse_1.getSseClients);
    // [Graceful Shutdown] Register shutdown hook to log server closure
    (0, graceful_shutdown_1.onShutdown)('http-server-close', async () => {
        console.log('[Shutdown] HTTP server closing...');
    });
    // [Graceful Shutdown] Worktree cleanup -- remove all worktrees on shutdown
    (0, graceful_shutdown_1.onShutdown)('worktree-cleanup', async () => {
        if (!localRepo)
            return;
        const activeWt = localRepo.getActiveWorktrees();
        if (activeWt.length > 0) {
            console.log(`[Shutdown] Cleaning up ${activeWt.length} worktree(s)...`);
            for (const ticket of activeWt) {
                try {
                    localRepo.removeWorktree(ticket);
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    console.warn(`[Shutdown] Worktree cleanup failed for ${ticket}: ${msg}`);
                }
            }
            // Prune dangling worktree references
            try {
                const { execFileSync } = require('child_process');
                const REPO_CACHE_DIR = path.join(BASE_DIR, '.repo-cache');
                execFileSync('git', ['-C', REPO_CACHE_DIR, 'worktree', 'prune'], {
                    stdio: 'pipe',
                    timeout: 10_000,
                });
            }
            catch { /* swallow */ }
        }
    });
    // ── Error handling ─────────────────────────────────────────────
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} already in use. Set PORT env var or kill existing process.`);
            process.exit(1);
        }
        throw err;
    });
    // ── Listen ─────────────────────────────────────────────────────
    server.listen(PORT, BIND_HOST, () => {
        console.log(`\n  AI Dev Agent UI -> http://${BIND_HOST}:${PORT}\n`);
        console.log(`  API Token: ${API_TOKEN.substring(0, 8)}...\n`);
    });
    return server;
}
// ── Exports ─────────────────────────────────────────────────────
/**
 * Get the HTTP server instance (available after startServer() is called).
 */
function getServer() {
    return server;
}
/**
 * Get the API token (for testing or embedding in HTML).
 */
function getApiToken() {
    return API_TOKEN;
}
/**
 * Get the pre-rendered HTML string.
 */
function getRenderedHTML() {
    return HTML;
}
/**
 * Get the configured port.
 */
function getPort() {
    return PORT;
}
/**
 * Get the configured bind host.
 */
function getBindHost() {
    return BIND_HOST;
}
// ── Auto-start when run directly ────────────────────────────────
if (require.main === module) {
    startServer();
}
//# sourceMappingURL=http-server.js.map