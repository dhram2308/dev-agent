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

import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Server, IncomingMessage, ServerResponse } from 'http';

import {
  registerHttpServer,
  registerSseClientGetter,
  installShutdownHandlers,
  onShutdown,
} from '../lib/graceful-shutdown';

import { getSseClients, setAgentProcsGetter, broadcastStateChange } from './sse';
import { handleRequest, setAgentProcessHandlers } from './routes';
import { cleanupStaleStates, readForDisplay } from '../state/state-manager';

// ── Resilience modules (safe require) ────────────────────────────

// Security: unified middleware (optional -- may not exist yet in all envs)
interface SecurityMiddlewareResult {
  proceed: boolean;
}

type SecurityMiddlewareFn = (
  url: URL,
  request: IncomingMessage,
  res: ServerResponse,
  apiToken: string,
) => SecurityMiddlewareResult;

let securityMiddleware: SecurityMiddlewareFn | null = null;
try {
  securityMiddleware = require('../../lib/security').securityMiddleware || null;
} catch {
  securityMiddleware = null;
}

// Agent process management
interface AgentChildProcess {
  exitCode: number | null;
  kill: (signal: string) => void;
}

interface AgentProcessModule {
  cleanOrphanedLocks: () => void;
  cleanOrphanedWorktreesOnStartup: () => void;
  startAgent: (ticket: string) => { ok: boolean; error?: string };
  stopAgent: (ticket: string | null) => { ok: boolean; error?: string };
  checkProcessHealth: (ticket: string) => { alive: boolean; reason?: string; exitCode?: number; pid?: number };
  getAgentProcs: () => Record<string, AgentChildProcess>;
  getAuthWaitingTickets?: () => Record<string, { provider: string }>;
  clearAuthTimeout?: (ticket: string) => void;
  STAGE_DATA_MAP: Record<string, string[]>;
  /**
   * Inject the host's SSE module so child-process stdout/stderr broadcasts
   * are routed to the backend's connected UI clients instead of the agent
   * package's orphan sse instance.
   */
  setSseModule?: (mod: unknown) => void;
  /**
   * Inject the backend's TokenManager so spawned agents receive fresh OAuth
   * access tokens in their environment. Called once at startup. See design.md
   * Decision 10 in the `oauth-connectors` change.
   */
  setTokenManager?: (tm: {
    getAccessTokenSync: (provider: string) => string | null;
    refresh: (provider: string) => Promise<unknown>;
  }) => void;
}

let agentProcess: AgentProcessModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  agentProcess = require('./agent-process');
} catch {
  try {
    // Fall back to compiled agent package (packages/agent/dist/server/agent-process.js)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    agentProcess = require('../../../agent/dist/server/agent-process');
  } catch {
    agentProcess = null;
  }
}

// Bug fix: inject the backend's SSE module into the agent-process wrapper
// so the child agent's addLog/broadcast/clearTicketLogs calls reach the UI.
// Without this, agent-process falls back to its own packages/agent/dist/server/sse.js
// instance which has zero connected clients.
if (agentProcess && typeof agentProcess.setSseModule === 'function') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    agentProcess.setSseModule(require('./sse'));
  } catch (e) {
    console.warn('[http-server] Failed to inject SSE module into agent-process:', (e as Error).message);
  }
}

// Local repo management (for worktree cleanup on shutdown)
interface LocalRepoModule {
  WORKTREES_DIR: string;
  removeWorktree: (ticket: string) => void;
  getActiveWorktrees: () => string[];
}

let localRepo: LocalRepoModule | null = null;
try {
  localRepo = require('../../lib/local-repo');
} catch {
  localRepo = null;
}

// ── Configuration ────────────────────────────────────────────────

/** M6: Auth token for POST endpoints — accept from env for dev-mode token sharing */
const API_TOKEN: string = process.env.API_TOKEN || crypto.randomBytes(24).toString('hex');

/** Server port */
const PORT: number = parseInt(process.env.PORT || '3000', 10) || 3000;

/** Server bind host -- loopback-only by default for OAuth redirect compliance.
 *  Set HTTP_BIND_HOST=0.0.0.0 when running behind a reverse-proxy. */
const BIND_HOST: string = process.env.HTTP_BIND_HOST || '127.0.0.1';

/** Base directory for the project */
const BASE_DIR: string = path.join(__dirname, '..', '..', '..', '..');

// ── HTML Generation ──────────────────────────────────────────────

/**
 * Generate HTML with injected API token.
 * Tries to read from frontend dist, falls back to a minimal placeholder.
 */
function getHTML(apiToken: string): string {
  const frontendIndex = path.join(__dirname, '..', '..', '..', 'frontend', 'dist', 'index.html');
  try {
    if (fs.existsSync(frontendIndex)) {
      let html = fs.readFileSync(frontendIndex, 'utf8');
      // Inject API token into the HTML
      html = html.replace(
        '</head>',
        `<script>window.__API_TOKEN__="${apiToken}";</script></head>`,
      );
      return html;
    }
  } catch { /* fallback below */ }

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
const HTML: string = getHTML(API_TOKEN);

/** The HTTP server instance */
let server: Server;

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
export function startServer(): Server {
  // F10: Clean orphaned agent locks on startup
  if (agentProcess) {
    agentProcess.cleanOrphanedLocks();
    agentProcess.cleanOrphanedWorktreesOnStartup();
  }

  // [Graceful Shutdown] Install signal handlers for server context
  installShutdownHandlers();

  // [Pipeline Dashboard] Auto-cleanup stale state files on startup
  try {
    const result = cleanupStaleStates();
    if (result.archived.length > 0 || result.deleted.length > 0) {
      console.log(`[Startup] Cleanup: archived ${result.archived.length} state(s), deleted ${result.deleted.length} archive file(s)`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[Startup] State cleanup failed (non-fatal): ${msg}`);
  }

  // Wire agent process handlers into routes
  if (agentProcess) {
    setAgentProcessHandlers({
      startAgent: agentProcess.startAgent,
      stopAgent: agentProcess.stopAgent,
      checkProcessHealth: agentProcess.checkProcessHealth,
      getAgentProcs: agentProcess.getAgentProcs,
      STAGE_DATA_MAP: agentProcess.STAGE_DATA_MAP,
    });

    // Wire agent procs getter into SSE for status broadcasts
    setAgentProcsGetter(agentProcess.getAgentProcs);

    // [OAuth Resume] Wire agent-process auth-waiting functions into OAuth routes
    // so the OAuth callback can auto-resume paused pipelines after re-auth.
    if (agentProcess.getAuthWaitingTickets && agentProcess.clearAuthTimeout) {
      try {
        const { setOAuthAgentHandlers } = require('../oauth/routes') as {
          setOAuthAgentHandlers: (handlers: {
            getAuthWaitingTickets: () => Record<string, { provider: string }>;
            startAgent: (ticket: string) => { ok: boolean; error?: string };
            clearAuthTimeout: (ticket: string) => void;
          }) => void;
        };
        setOAuthAgentHandlers({
          getAuthWaitingTickets: agentProcess.getAuthWaitingTickets,
          startAgent: agentProcess.startAgent,
          clearAuthTimeout: agentProcess.clearAuthTimeout,
        });
      } catch (e) {
        console.warn('[http-server] Failed to wire OAuth resume handlers:', (e as Error).message);
      }
    }

    // [OAuth] Wire TokenManager into agent-process so spawned agents receive
    // fresh OAuth access tokens in their environment. See design.md Decision 10
    // in the `oauth-connectors` change. Without this wire, GOOGLE_OAUTH_ACCESS_TOKEN
    // / FIGMA_OAUTH_ACCESS_TOKEN / GITLAB_OAUTH_ACCESS_TOKEN never reach the child
    // and connectors fall back to PAT/service-account paths.
    const oauthEnabled = process.env.ENABLE_OAUTH !== 'false';
    if (oauthEnabled) {
      if (typeof agentProcess.setTokenManager === 'function') {
        try {
          const tokenManager = require('../oauth/token-manager') as {
            getAccessTokenSync: (provider: string) => string | null;
            refresh: (provider: string) => Promise<unknown>;
            initFromStore: () => Promise<void>;
          };
          agentProcess.setTokenManager({
            getAccessTokenSync: tokenManager.getAccessTokenSync,
            refresh: tokenManager.refresh,
          });
          // Warm the in-memory token cache (and recover any interrupted refreshes
          // via WAL — initFromStore calls recoverWAL internally). Fire-and-forget:
          // user-initiated agent spawns happen many ms after server boot, by which
          // time the cache is populated. If init fails the wire still works — calls
          // just return null and connectors fall back to non-OAuth paths.
          tokenManager.initFromStore().catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('[http-server] OAuth token-manager initFromStore failed (non-fatal):', msg);
          });
        } catch (e) {
          console.warn('[http-server] Failed to wire TokenManager into agent-process:', (e as Error).message);
        }
      } else {
        console.warn(
          '[http-server] OAuth enabled but loaded agent-process module does not expose setTokenManager — ' +
          'spawned agents will not receive OAuth tokens. Connectors will fall back to PAT / service-account paths. ' +
          'Rebuild the agent package or set ENABLE_OAUTH=false to silence this warning.',
        );
      }
    }
  }

  // ── Create HTTP Server ─────────────────────────────────────────
  server = http.createServer(async (request: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(request.url || '/', `http://${request.headers.host}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Malformed URL' }));
      return;
    }

    // [Security] Unified security middleware -- headers, CORS, rate limiting, auth
    if (securityMiddleware) {
      const sec = securityMiddleware(url, request, res, API_TOKEN);
      if (!sec.proceed) return; // Response already sent (CORS, rate limit, auth error)
    }

    await handleRequest(url, request, res, API_TOKEN, HTML);
  });

  // [Graceful Shutdown] Register server and SSE clients for cleanup
  registerHttpServer(server);
  registerSseClientGetter(getSseClients as unknown as () => Array<{ end: () => void }>);

  // [Graceful Shutdown] Register shutdown hook to log server closure
  onShutdown('http-server-close', async () => {
    console.log('[Shutdown] HTTP server closing...');
  });

  // [Graceful Shutdown] Worktree cleanup -- remove all worktrees on shutdown
  onShutdown('worktree-cleanup', async () => {
    if (!localRepo) return;
    const activeWt = localRepo.getActiveWorktrees();
    if (activeWt.length > 0) {
      console.log(`[Shutdown] Cleaning up ${activeWt.length} worktree(s)...`);
      for (const ticket of activeWt) {
        try {
          localRepo.removeWorktree(ticket);
        } catch (e: unknown) {
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
      } catch { /* swallow */ }
    }
  });

  // ── Error handling ─────────────────────────────────────────────
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} already in use. Set PORT env var or kill existing process.`);
      process.exit(1);
    }
    throw err;
  });

  // [Config Hot-Reload] Start config watcher for SSE broadcasts
  try {
    const { startConfigWatcher } = require('./config-watcher') as {
      startConfigWatcher: () => void;
    };
    startConfigWatcher();
  } catch (e) {
    console.warn('[http-server] Config watcher not available:', (e as Error).message);
  }

  // ── State Poll: broadcast state changes via SSE ─────────────────
  // Every 5 seconds, read active pipeline states and emit SSE `state`
  // events when the stage OR data._seq changes. This ensures the
  // frontend receives sub-stage checkpoint updates (e.g. _dev_complete,
  // _reviewed) within long-running stages like generate_code.
  const _stageCache: Record<string, string> = {};
  const _seqCache: Record<string, number> = {};
  if (agentProcess) {
    const statePollTimer = setInterval(() => {
      try {
        const procs = agentProcess!.getAgentProcs();
        for (const ticket of Object.keys(procs)) {
          const state = readForDisplay(ticket);
          if (!state) continue;
          const stateData = (state.data ?? {}) as Record<string, unknown>;
          const seq = (state as any)._seq as number | undefined;
          const stageChanged = state.stage !== _stageCache[ticket];
          const seqChanged = seq !== undefined && seq !== _seqCache[ticket];
          if (stageChanged || seqChanged) {
            _stageCache[ticket] = state.stage;
            if (seq !== undefined) _seqCache[ticket] = seq;
            broadcastStateChange(ticket, state.stage, stateData, seq);
          }
        }
      } catch {
        // Non-fatal: state files may not exist yet
      }
    }, 5_000);
    statePollTimer.unref();

    // Clean cache when agent processes are removed
    onShutdown('state-poll-cleanup', async () => {
      clearInterval(statePollTimer);
    });
  }

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
export function getServer(): Server | undefined {
  return server;
}

/**
 * Get the API token (for testing or embedding in HTML).
 */
export function getApiToken(): string {
  return API_TOKEN;
}

/**
 * Get the pre-rendered HTML string.
 */
export function getRenderedHTML(): string {
  return HTML;
}

/**
 * Get the configured port.
 */
export function getPort(): number {
  return PORT;
}

/**
 * Get the configured bind host.
 */
export function getBindHost(): string {
  return BIND_HOST;
}

// Re-export for convenience
export { API_TOKEN, PORT, BIND_HOST };

// ── Auto-start when run directly ────────────────────────────────
if (require.main === module) {
  startServer();
}
