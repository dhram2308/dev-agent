// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- OAuth HTTP Route Handler
//
// Handles all /api/oauth/* and /oauth/* routes for the OAuth
// authorization code flow:
//
//   POST /api/oauth/:provider/start      — Initiate OAuth flow
//   GET  /oauth/:provider/callback       — Handle provider redirect
//   POST /api/oauth/:provider/disconnect  — Revoke + delete tokens
//   GET  /api/oauth/status               — List all provider statuses
//
// Follows the same patterns as the main routes.ts handler:
//   - Auth via x-api-token header or ?token= query param
//   - POST body parsing via stream-to-string + JSON.parse
//   - Native http module (no Express)
//
// Returns true if the route was handled, false if not an OAuth
// route (so the main router can fall through to other handlers).
// ═══════════════════════════════════════════════════════════════

import type { IncomingMessage, ServerResponse } from 'http';
import { startOAuthFlow, handleOAuthCallback, disconnectProvider } from './engine';
import { getProvider } from './provider';
import { getCredentialStore } from '../credentials';
import { broadcast, addLog } from '../server/sse';

// ── Register all provider adapters on first import ──────────────
import './providers/index';

// ── Late-bound agent-process handlers for auth resume ───────────
// Injected via setOAuthAgentHandlers() from http-server.ts to avoid
// circular dependency (oauth/routes -> agent-process -> sse -> ...).
interface OAuthAgentHandlers {
  getAuthWaitingTickets: () => Record<string, { provider: string }>;
  startAgent: (ticket: string) => { ok: boolean; error?: string };
  clearAuthTimeout: (ticket: string) => void;
}

let _agentHandlers: OAuthAgentHandlers | null = null;

/**
 * Inject agent-process handlers for the OAuth resume path.
 * Called once by http-server.ts during startup.
 */
export function setOAuthAgentHandlers(handlers: OAuthAgentHandlers): void {
  _agentHandlers = handlers;
}

/**
 * After a successful OAuth callback, check if any ticket was paused
 * waiting for re-authorization of this provider. If so, clear the
 * auth timeout and respawn the agent automatically.
 *
 * This runs asynchronously (fire-and-forget) so it does not delay
 * the callback HTML response to the user's browser.
 */
function resumeAuthWaitingTickets(provider: string): void {
  if (!_agentHandlers) return;

  try {
    const waiting = _agentHandlers.getAuthWaitingTickets();
    for (const [ticket, meta] of Object.entries(waiting)) {
      if (meta.provider === provider) {
        addLog(
          `[OAuth] Provider ${provider} reconnected. Resuming agent for ${ticket}...`,
          'system',
          ticket,
        );
        // clearAuthTimeout is called inside startAgent, but we call it
        // explicitly here as well for the case where startAgent fails.
        _agentHandlers.clearAuthTimeout(ticket);
        const result = _agentHandlers.startAgent(ticket);
        if (result.ok) {
          addLog(
            `[OAuth] Agent for ${ticket} respawned after ${provider} re-authorization.`,
            'system',
            ticket,
          );
          broadcast('authResumed', { provider, ticket });
        } else {
          addLog(
            `[OAuth] Failed to respawn agent for ${ticket} after ${provider} re-auth: ${result.error}`,
            'system',
            ticket,
          );
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[OAuth] Error during auth-resume check: ${msg}`);
  }
}

// ── Lazy import for Figma TLS pre-warm ──────────────────────────
// Avoid top-level import to keep the module lightweight when Figma
// is not configured.
let _prewarmFigmaTls: (() => void) | null = null;

function getFigmaPrewarm(): () => void {
  if (!_prewarmFigmaTls) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const figmaModule = require('./providers/figma');
      _prewarmFigmaTls = figmaModule.prewarmFigmaTls || (() => {});
    } catch {
      _prewarmFigmaTls = () => {};
    }
  }
  return _prewarmFigmaTls!;
}

// ── Feature gate ────────────────────────────────────────────────

const ENABLE_OAUTH = process.env.ENABLE_OAUTH !== 'false';

// ── Allowed provider names (prevent path traversal / injection) ─

const PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;

function isValidProviderName(name: string): boolean {
  return PROVIDER_NAME_RE.test(name);
}

// ── Body parsing (matches routes.ts pattern) ────────────────────

const MAX_BODY_SIZE = 65_536; // 64KB — OAuth bodies are small.

function parseBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk: Buffer | string) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        request.destroy();
        reject(new Error('Payload too large'));
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}') as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ── JSON Response Helpers ───────────────────────────────────────

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  const body = Buffer.from(html, 'utf-8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ── Callback HTML Pages ─────────────────────────────────────────

function successHtml(provider: string): string {
  const displayName = provider.charAt(0).toUpperCase() + provider.slice(1);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connected — MI Dev Agent</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0;
      background: #0f172a; color: #e2e8f0;
    }
    .card {
      text-align: center; padding: 3rem 2rem;
      background: #1e293b; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
      max-width: 400px;
    }
    .check {
      font-size: 4rem; margin-bottom: 1rem;
      color: #22c55e;
    }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #94a3b8; font-size: 0.875rem; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h1>Connected to ${displayName}!</h1>
    <p>This window will close automatically&hellip;</p>
  </div>
  <script>setTimeout(function() { window.close(); }, 2000);</script>
</body>
</html>`;
}

function errorHtml(provider: string, errorMessage: string): string {
  const displayName = provider.charAt(0).toUpperCase() + provider.slice(1);
  // Escape HTML entities in error message to prevent XSS.
  const safeError = errorMessage
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connection Failed — MI Dev Agent</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0;
      background: #0f172a; color: #e2e8f0;
    }
    .card {
      text-align: center; padding: 3rem 2rem;
      background: #1e293b; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
      max-width: 400px;
    }
    .xmark {
      font-size: 4rem; margin-bottom: 1rem;
      color: #ef4444;
    }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    .error { color: #fca5a5; font-size: 0.875rem; margin: 0 0 1.5rem; }
    button {
      background: #3b82f6; color: white; border: none;
      padding: 0.625rem 1.5rem; border-radius: 6px;
      font-size: 0.875rem; cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <div class="xmark">&#10007;</div>
    <h1>Failed to connect to ${displayName}</h1>
    <p class="error">${safeError}</p>
    <button onclick="retry()">Try again</button>
  </div>
  <script>
    function retry() {
      try {
        if (window.opener) {
          window.opener.postMessage('oauth-retry', '*');
        }
      } catch (e) { /* cross-origin — ignore */ }
      window.close();
    }
  </script>
</body>
</html>`;
}

// ── URL Path Parsing ────────────────────────────────────────────

/**
 * Extract the provider name from a URL pathname.
 *
 * Patterns:
 *   /api/oauth/:provider/start       → provider
 *   /api/oauth/:provider/disconnect   → provider
 *   /oauth/:provider/callback         → provider
 *   /api/oauth/status                 → null (no provider)
 */
function extractProvider(pathname: string): string | null {
  // /api/oauth/:provider/start or /api/oauth/:provider/disconnect
  const apiMatch = pathname.match(/^\/api\/oauth\/([^/]+)\/(start|disconnect)$/);
  if (apiMatch) return apiMatch[1];

  // /oauth/:provider/callback
  const callbackMatch = pathname.match(/^\/oauth\/([^/]+)\/callback$/);
  if (callbackMatch) return callbackMatch[1];

  return null;
}

// ── Build Redirect URI ──────────────────────────────────────────

/**
 * Construct the OAuth callback redirect URI from the incoming request.
 *
 * Uses the Host header (or X-Forwarded-Host) + the provider name.
 * Falls back to localhost:3000 if no Host header is present.
 */
function buildRedirectUri(request: IncomingMessage, provider: string): string {
  const forwardedHost = request.headers['x-forwarded-host'] as string | undefined;
  const host = forwardedHost || request.headers['host'] || 'localhost:3000';
  const forwardedProto = request.headers['x-forwarded-proto'] as string | undefined;
  const protocol = forwardedProto || (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  return `${protocol}://${host}/oauth/${provider}/callback`;
}

// ═══════════════════════════════════════════════════════════════
// Main Route Handler
// ═══════════════════════════════════════════════════════════════

/**
 * Handle OAuth-related HTTP routes.
 *
 * @param url       - Parsed URL object.
 * @param request   - Incoming HTTP request.
 * @param res       - Server response.
 * @param apiToken  - The API token for auth validation.
 * @returns `true` if the route was handled, `false` if not an OAuth route.
 */
export async function handleOAuthRoute(
  url: URL,
  request: IncomingMessage,
  res: ServerResponse,
  apiToken: string,
): Promise<boolean> {
  const { pathname } = url;

  // ── GET /api/oauth/status ───────────────────────────────────
  if (pathname === '/api/oauth/status' && request.method === 'GET') {
    // Auth required.
    const token = request.headers['x-api-token'] || url.searchParams.get('token');
    if (token !== apiToken) {
      sendJson(res, 403, { error: 'Forbidden: invalid or missing API token' });
      return true;
    }

    if (!ENABLE_OAUTH) {
      sendJson(res, 404, { error: 'OAuth is disabled' });
      return true;
    }

    try {
      const store = await getCredentialStore();
      const statuses = await store.list();
      sendJson(res, 200, { providers: statuses });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: `Failed to list credentials: ${msg}` });
    }
    return true;
  }

  // ── POST /api/oauth/:provider/start ─────────────────────────
  if (pathname.match(/^\/api\/oauth\/[^/]+\/start$/) && request.method === 'POST') {
    // Auth required.
    const token = request.headers['x-api-token'] || url.searchParams.get('token');
    if (token !== apiToken) {
      sendJson(res, 403, { error: 'Forbidden: invalid or missing API token' });
      return true;
    }

    if (!ENABLE_OAUTH) {
      sendJson(res, 404, { error: 'OAuth is disabled' });
      return true;
    }

    const provider = extractProvider(pathname);
    if (!provider || !isValidProviderName(provider)) {
      sendJson(res, 400, { error: 'Invalid provider name' });
      return true;
    }

    const adapter = getProvider(provider);
    if (!adapter) {
      sendJson(res, 404, { error: `Unknown OAuth provider: ${provider}` });
      return true;
    }

    if (!adapter.clientId) {
      sendJson(res, 400, {
        error: `OAuth client ID is not configured for ${provider}. Set the appropriate OAUTH_${provider.toUpperCase()}_CLIENT_ID environment variable.`,
      });
      return true;
    }

    try {
      // Parse optional body for custom scopes or redirect URI override.
      let body: Record<string, unknown> = {};
      try {
        body = await parseBody(request);
      } catch {
        // Empty body is fine for start — defaults are used.
      }

      const redirectUri = typeof body.redirectUri === 'string'
        ? body.redirectUri
        : buildRedirectUri(request, provider);

      // Pre-warm Figma TLS connection to reduce latency.
      if (provider === 'figma') {
        getFigmaPrewarm()();
      }

      const result = await startOAuthFlow(provider, redirectUri);
      sendJson(res, 200, { authorizeUrl: result.authorizeUrl, state: result.state });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: `Failed to start OAuth flow: ${msg}` });
    }
    return true;
  }

  // ── GET /oauth/:provider/callback ───────────────────────────
  // NO auth required — this is a browser redirect from the provider.
  // Must ALWAYS work even if ENABLE_OAUTH is false (in-flight flow).
  if (pathname.match(/^\/oauth\/[^/]+\/callback$/) && request.method === 'GET') {
    const provider = extractProvider(pathname);
    if (!provider || !isValidProviderName(provider)) {
      sendHtml(res, 400, errorHtml('Unknown', 'Invalid provider name in callback URL.'));
      return true;
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    // Provider returned an error (user denied, etc.).
    if (error) {
      const errMsg = errorDescription || error;
      broadcast('connectorError', { provider, error: errMsg });
      sendHtml(res, 200, errorHtml(provider, errMsg));
      return true;
    }

    if (!code || !state) {
      const errMsg = 'Missing authorization code or state parameter.';
      broadcast('connectorError', { provider, error: errMsg });
      sendHtml(res, 400, errorHtml(provider, errMsg));
      return true;
    }

    const redirectUri = buildRedirectUri(request, provider);

    try {
      const result = await handleOAuthCallback(code, state, redirectUri);

      if (result.success) {
        broadcast('connectorConnected', {
          provider: result.provider,
          scopes: result.tokenSet?.scopes,
          metadata: result.tokenSet?.metadata,
        });

        // [OAuth Resume] Check if any paused pipeline was waiting for this
        // provider and auto-respawn it now that tokens are available.
        resumeAuthWaitingTickets(result.provider);

        sendHtml(res, 200, successHtml(result.provider));
      } else {
        const errMsg = result.error || 'Unknown error during token exchange.';
        broadcast('connectorError', { provider: result.provider, error: errMsg });
        sendHtml(res, 200, errorHtml(result.provider, errMsg));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcast('connectorError', { provider, error: msg });
      sendHtml(res, 500, errorHtml(provider, msg));
    }
    return true;
  }

  // ── POST /api/oauth/:provider/disconnect ────────────────────
  if (pathname.match(/^\/api\/oauth\/[^/]+\/disconnect$/) && request.method === 'POST') {
    // Auth required.
    const token = request.headers['x-api-token'] || url.searchParams.get('token');
    if (token !== apiToken) {
      sendJson(res, 403, { error: 'Forbidden: invalid or missing API token' });
      return true;
    }

    if (!ENABLE_OAUTH) {
      sendJson(res, 404, { error: 'OAuth is disabled' });
      return true;
    }

    const provider = extractProvider(pathname);
    if (!provider || !isValidProviderName(provider)) {
      sendJson(res, 400, { error: 'Invalid provider name' });
      return true;
    }

    try {
      await disconnectProvider(provider);
      broadcast('connectorDisconnected', { provider });
      sendJson(res, 200, { ok: true, provider });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: `Failed to disconnect ${provider}: ${msg}` });
    }
    return true;
  }

  // ── Not an OAuth route ──────────────────────────────────────
  return false;
}
