// =====================================================================
// MI Dev Agent -- HTTP Route Handlers (TypeScript port)
// =====================================================================
// All API routes for the MI Dev Agent server.
//
// Features:
//   - Input validation via Zod-style sanitizers (safeTicket, safeGate, safeStage)
//   - Auth token check on all /api/ routes except /api/health
//   - Rate limiting integration (in-memory per-IP)
//   - POST body parsing with size limits and prototype pollution guard
//   - Static file serving for non-API routes (React build or HTML)
//
// Ported from: server/routes.js
// =====================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { StageName, PipelineState } from '@shared/types';
import { STAGES } from '@shared/constants';
import {
  addLog,
  broadcast,
  getLogBuffer,
  registerClient,
  getSSEStats,
} from './sse';
import {
  getState,
  updateAsync,
  saveReviewComments,
  getReviewComments,
  patchUIWithGateAsync,
} from '../state/state-io';
import {
  getCachedPipelineList,
  invalidatePipelineCache,
  deletePipeline,
  readStateFromDisk,
  getStateFilePath,
  stateSecret,
  wrapEnvelope,
  atomicWriteSync,
  type PipelineSummary,
} from '../state/state-manager';

// ── Late-bound imports (avoid circular deps at load time) ────────

// Agent process management: startAgent, stopAgent, etc.
// These are registered via setAgentProcessHandlers() from http-server.ts
interface AgentProcessHandlers {
  startAgent: (ticket: string) => { ok: boolean; error?: string };
  stopAgent: (ticket: string | null) => { ok: boolean; error?: string };
  checkProcessHealth: (ticket: string) => { alive: boolean; reason?: string; exitCode?: number; pid?: number };
  getAgentProcs: () => Record<string, AgentChildProcess>;
  STAGE_DATA_MAP: Record<string, string[]>;
}

interface AgentChildProcess {
  exitCode: number | null;
  kill: (signal: string) => void;
}

let _agentHandlers: AgentProcessHandlers | null = null;

/**
 * Register agent process handlers. Called by http-server.ts on startup.
 */
export function setAgentProcessHandlers(handlers: AgentProcessHandlers): void {
  _agentHandlers = handlers;
}

// ── Resilience modules (safe require -- each may not exist yet) ──

// Security: input sanitization + safe body parsing
let validateTicketSec: ((t: string) => string | null) | null = null;
let validateGateSec: ((g: string) => string | null) | null = null;
let validateStageSec: ((s: string) => string | null) | null = null;
let parseBodySafe: ((req: IncomingMessage, maxSize: number) => Promise<Record<string, unknown>>) | null = null;
let sanitizeSec: ((body: Record<string, unknown>, schema: unknown) => Record<string, unknown>) | null = null;
let ENDPOINT_SCHEMAS: Record<string, unknown> | null = null;
let ENDPOINT_SIZE_LIMITS: Record<string, number> | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const security = require('../../lib/security');
  validateTicketSec = security.validateTicket || null;
  validateGateSec = security.validateGate || null;
  validateStageSec = security.validateStage || null;
  parseBodySafe = security.parseBodySafe || null;
  sanitizeSec = security.sanitize || null;
  ENDPOINT_SCHEMAS = security.ENDPOINT_SCHEMAS || null;
  ENDPOINT_SIZE_LIMITS = security.ENDPOINT_SIZE_LIMITS || null;
} catch {
  // Security module not available -- fallbacks used
}

// Health monitor: service health for enhanced /api/health
let getServiceHealth: (() => Record<string, unknown>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  getServiceHealth = require('../../lib/health-monitor').getServiceHealth || null;
} catch { getServiceHealth = null; }

// Notification audit: for /api/notification-audit endpoint
let getAuditLog: (() => unknown[]) | null = null;
let getAuditSummary: (() => unknown) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const audit = require('../../lib/notification-audit');
  getAuditLog = audit.getAuditLog || null;
  getAuditSummary = audit.getAuditSummary || null;
} catch { getAuditLog = null; getAuditSummary = null; }

// Escalation: for /api/escalations endpoint
let getEscalationLog: (() => unknown[]) | null = null;
let getActiveEscalations: (() => unknown[]) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const esc = require('../../lib/escalation');
  getEscalationLog = esc.getEscalationLog || null;
  getActiveEscalations = esc.getActiveEscalations || null;
} catch { getEscalationLog = null; getActiveEscalations = null; }

// Slack health: for enhanced health endpoint
let getSlackHealth: (() => Record<string, unknown>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  getSlackHealth = require('../../lib/slack').getSlackHealth || null;
} catch { getSlackHealth = null; }

// Config schema: for /api/config endpoints (source: packages/agent/dist/lib/config-schema.js)
let CONFIG_SCHEMA: Record<string, {
  env: string; type: string; default?: unknown; required?: boolean;
  sensitive?: boolean; group?: string; description?: string;
  hotReload?: boolean; allowed?: unknown;
}> = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  CONFIG_SCHEMA = require('../../../agent/dist/lib/config-schema').CONFIG_SCHEMA || {};
} catch { CONFIG_SCHEMA = {}; }

// Notification config: for /api/notification-config endpoints
let loadNotificationConfig: () => Record<string, unknown> = () => ({});
let saveNotificationConfig: (config: Record<string, unknown>) => void = () => { /* noop */ };
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nc = require('../../../agent/dist/lib/notification-config');
  if (nc.loadNotificationConfig) loadNotificationConfig = nc.loadNotificationConfig;
  if (nc.saveNotificationConfig) saveNotificationConfig = nc.saveNotificationConfig;
} catch { /* keep noop fallbacks */ }

// ── Configuration ───────────────────────────────────────────────

const BASE_DIR = path.join(__dirname, '..', '..', '..', '..');

/** O7: Stage skip requires env var opt-in */
const ALLOW_STAGE_SKIP = process.env.ALLOW_STAGE_SKIP === 'true';

// ── OAuth routes (optional -- may not exist in all envs) ────────

let handleOAuthRoute: ((url: URL, request: IncomingMessage, res: ServerResponse, apiToken: string) => Promise<boolean>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  handleOAuthRoute = require('../oauth/routes').handleOAuthRoute || null;
} catch { handleOAuthRoute = null; }

// ── Rate Limiting (in-memory per-IP) ────────────────────────────

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 300;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count <= RATE_LIMIT_MAX;
}

// Clean up stale rate limit entries every 2 minutes
const rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetTime) rateLimitMap.delete(ip);
  }
}, 120_000);
rateLimitCleanupInterval.unref();

// ── Input Validation / Sanitizers ───────────────────────────────

/**
 * F12: Path traversal guard -- validate ticket params.
 * Uses security module's validateTicket when available, falls back to basic regex.
 */
export function safeTicket(t: string | null | undefined): string | null {
  if (validateTicketSec && t) return validateTicketSec(t);
  const s = (t || '').trim();
  if (!/^[A-Za-z]+-\d+$/.test(s)) return null;
  return s;
}

/**
 * Gate parameter sanitization -- whitelist valid gate names.
 */
export function safeGate(g: string | null | undefined): string | null {
  if (validateGateSec && g) return validateGateSec(g);
  const s = (g || '').trim();
  const valid = new Set([
    'explore_plan', 'gate_code_review', 'deploy_qa',
    'gate_preprod_approval', 'gate_dual_approval',
  ]);
  return valid.has(s) ? s : null;
}

/**
 * Stage parameter sanitization -- whitelist valid stage names.
 */
export function safeStage(s: string | null | undefined): StageName | null {
  if (validateStageSec && s) return validateStageSec(s) as StageName | null;
  const st = (s || '').trim();
  if (!_agentHandlers) return null;
  return _agentHandlers.STAGE_DATA_MAP[st] !== undefined ? st as StageName : null;
}

// ── POST Body Parsing ───────────────────────────────────────────

/**
 * Parse POST body helper -- delegates to security module's parseBodySafe when available.
 * parseBodySafe adds: prototype pollution guard via safeJsonParse, proper chunk buffering.
 */
function parseBody(request: IncomingMessage, maxSize: number = 1_048_576): Promise<Record<string, unknown>> {
  if (parseBodySafe) return parseBodySafe(request, maxSize);

  // Fallback: basic parser (for envs where security module isn't loaded)
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (c: Buffer | string) => {
      body += c;
      if (body.length > maxSize) {
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

/**
 * Sanitize parsed body against endpoint schema -- returns sanitized object or throws.
 */
function sanitizeBody(pathname: string, body: Record<string, unknown>): Record<string, unknown> {
  if (!sanitizeSec || !ENDPOINT_SCHEMAS || !ENDPOINT_SCHEMAS[pathname]) return body;
  return sanitizeSec(body, ENDPOINT_SCHEMAS[pathname]);
}

/**
 * Get per-endpoint body size limit.
 */
function getBodySizeLimit(pathname: string): number {
  if (!ENDPOINT_SIZE_LIMITS) return 1_048_576;
  return ENDPOINT_SIZE_LIMITS[pathname] || (ENDPOINT_SIZE_LIMITS as Record<string, number>).default || 1_048_576;
}

// ── Static file serving ─────────────────────────────────────────

/** MIME types for static file serving */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/** Frontend build directory */
const FRONTEND_DIST = path.join(__dirname, '..', '..', '..', 'frontend', 'dist');

/**
 * Try to serve a static file from the frontend dist directory.
 * Returns true if file was served, false otherwise.
 */
function tryServeStaticFile(url: URL, res: ServerResponse, apiToken?: string): boolean {
  // Only serve for non-API paths
  if (url.pathname.startsWith('/api/')) return false;

  const relPath = url.pathname === '/' ? '/index.html' : url.pathname;

  // Prevent directory traversal
  const normalizedPath = path.normalize(relPath);
  if (normalizedPath.includes('..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }

  const filePath = path.join(FRONTEND_DIST, normalizedPath);

  // Verify the resolved path is within FRONTEND_DIST
  if (!filePath.startsWith(FRONTEND_DIST)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }

  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return false;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    let content: Buffer | string = fs.readFileSync(filePath);

    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };

    // Cache static assets (except HTML)
    if (ext !== '.html') {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers['Pragma'] = 'no-cache';
      // Inject API token into HTML for frontend auth
      if (apiToken) {
        content = content.toString('utf8').replace(
          '</head>',
          `<script>window.__API_TOKEN__="${apiToken}";</script></head>`,
        );
      }
    }

    res.writeHead(200, headers);
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// ── Main Route Handler ──────────────────────────────────────────

/**
 * Handle all API routes for the server.
 *
 * @param url - Parsed URL object
 * @param request - HTTP incoming message
 * @param res - HTTP server response
 * @param apiToken - The API token for auth
 * @param html - Pre-rendered HTML string (fallback for SPA)
 * @returns true if the route was handled
 */
export async function handleRequest(
  url: URL,
  request: IncomingMessage,
  res: ServerResponse,
  apiToken: string,
  html?: string,
): Promise<boolean> {

  // OAuth routes: handle before auth check (callback has no auth)
  if (handleOAuthRoute && (url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/api/oauth/'))) {
    const handled = await handleOAuthRoute(url, request, res, apiToken);
    if (handled) return true;
  }

  // S12: Rate limiting for API routes
  if (url.pathname.startsWith('/api/')) {
    const clientIp = request.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Rate limit exceeded. Max 60 requests per minute.' }));
      return true;
    }
  }

  // T1.8: Auth token check on ALL /api/ requests (GET and POST)
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
    const token = request.headers['x-api-token'] || url.searchParams.get('token');
    if (token !== apiToken) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: invalid or missing API token' }));
      return true;
    }
  }

  // -- POST /api/start -- Smart Start with resume/fresh mode --
  if (url.pathname === '/api/start' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/start'));
      const { ticket, mode } = sanitizeBody('/api/start', raw) as {
        ticket?: string; mode?: 'resume' | 'fresh';
      };
      if (!ticket || !ticket.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Ticket ID is required. Provide a Jira ticket key (e.g. AUT-1234).' }));
        return true;
      }
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Invalid ticket format: "${ticket}". Expected format: PROJECT-NUMBER (e.g. AUT-1234).` }));
        return true;
      }
      if (!_agentHandlers) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Agent system is not available. The server may still be initializing — try again in a few seconds, or check server logs for startup errors.' }));
        return true;
      }

      // Smart Start: Check existing state and handle resume/fresh mode
      const RESUME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
      const stateFilePath = getStateFilePath(t);
      const existingState = readStateFromDisk(stateFilePath, {
        allowUnverified: true,
        onWarn: () => {},
      });

      if (mode === 'fresh') {
        // Fresh start: delete existing state and start from scratch
        deletePipeline(t);
      } else if (existingState) {
        // Existing state found — check if resumable
        const d = (existingState.state.data || {}) as Record<string, unknown>;
        const lastActivity = (d._lastActivity as string)
          || (d.startedAt as string)
          || null;
        const ageMs = lastActivity ? Date.now() - new Date(lastActivity).getTime() : Infinity;
        const isExpired = ageMs > RESUME_WINDOW_MS;
        const isDone = existingState.state.stage === 'done';

        if (mode === 'resume' || !mode) {
          if (isExpired && mode === 'resume') {
            // Explicit resume on expired pipeline — error
            const daysAgo = Math.round(ageMs / (24 * 60 * 60 * 1000));
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              error: `Pipeline expired (last active ${daysAgo} days ago). Use mode=fresh to start over.`,
            }));
            return true;
          }
          if (isExpired && !mode) {
            // Default mode on expired — error with guidance
            const daysAgo = Math.round(ageMs / (24 * 60 * 60 * 1000));
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              error: `Pipeline expired (last active ${daysAgo} days ago). Use mode=fresh to start over.`,
              expired: true,
            }));
            return true;
          }
          if (!isDone && !isExpired) {
            // Resume: reset timer, increment resume count, record history
            const state = existingState.state;
            const data = (state.data || {}) as Record<string, unknown>;
            data.startedAt = new Date().toISOString();
            data._resumeCount = ((data._resumeCount as number) || 0) + 1;
            const history = (data._resumeHistory as Array<{ at: string; fromStage: string }>) || [];
            history.push({ at: new Date().toISOString(), fromStage: state.stage });
            data._resumeHistory = history;
            data._lastActivity = new Date().toISOString();

            // Write updated state back
            const secret = stateSecret();
            state._seq = (state._seq || existingState.seq || 0) + 1;
            const envelope = wrapEnvelope(state, secret);
            atomicWriteSync(stateFilePath, envelope);
          }
          // For done pipelines with no mode, fall through to start fresh
          if (isDone && !mode) {
            deletePipeline(t);
          }
        }
      }
      // mode === undefined and no state → start fresh (default behavior)

      invalidatePipelineCache();
      const result = _agentHandlers.startAgent(t);

      // Broadcast updated pipeline list
      const agentProcs = _agentHandlers.getAgentProcs();
      const pipelines = getCachedPipelineList(agentProcs);
      broadcast('pipelines', pipelines);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- POST /api/stop --
  if (url.pathname === '/api/stop' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/stop'));
      const parsed = sanitizeBody('/api/stop', raw) as { ticket?: string };
      const t = parsed.ticket ? safeTicket(parsed.ticket) : null;
      // t can be null for legacy "stop any" behavior, but if ticket provided it must be valid
      if (parsed.ticket && !t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid ticket format' }));
        return true;
      }
      if (!_agentHandlers) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Agent system is not available. The server may still be initializing — try again in a few seconds, or check server logs for startup errors.' }));
        return true;
      }
      const stopResult = _agentHandlers.stopAgent(t);
      // Broadcast updated pipeline list after stop
      invalidatePipelineCache();
      const agentProcs = _agentHandlers.getAgentProcs();
      broadcast('pipelines', getCachedPipelineList(agentProcs));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stopResult));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- GET /api/state --
  if (url.pathname === '/api/state') {
    const ticket = safeTicket(url.searchParams.get('ticket'));
    if (!ticket) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Invalid ticket format"}');
      return true;
    }

    const state = await getState(ticket);
    const agentProcs = _agentHandlers?.getAgentProcs() || {};
    const health = _agentHandlers?.checkProcessHealth(ticket) || { alive: false, reason: 'no_handlers' };

    if (!health.alive && agentProcs[ticket]) {
      addLog(`Agent for ${ticket} detected as unhealthy (${health.reason}), cleaning up`, 'system', ticket);
      delete agentProcs[ticket];
    }

    const completedGates = (state?.data?._completedGates as string[] | undefined) || null;
    let stuck = false;
    let stuckMinutes = 0;
    const lastActivity = state?.data?._lastActivity as string | undefined;
    if (lastActivity && agentProcs[ticket]) {
      const stuckDuration = Date.now() - new Date(lastActivity).getTime();
      stuckMinutes = Math.floor(stuckDuration / 60000);
      if (stuckDuration > 10 * 60 * 1000) stuck = true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      running: !!agentProcs[ticket],
      state,
      logCount: getLogBuffer().length,
      health,
      stuck,
      stuckMinutes,
      _completedGates: completedGates,
      activeAgents: Object.keys(agentProcs),
    }));
    return true;
  }

  // -- GET /api/logs (SSE) -- Robust connection with auth, replay, backpressure --
  if (url.pathname === '/api/logs') {
    // registerClient handles: auth, limits, LRU eviction, headers,
    // replay from Last-Event-ID, keepalive, backpressure, cleanup
    registerClient(res, request, url, apiToken);
    return true;
  }

  // -- GET /api/sse-stats -- SSE diagnostics --
  if (url.pathname === '/api/sse-stats' && request.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getSSEStats()));
    return true;
  }

  // -- POST /api/reset --
  if (url.pathname === '/api/reset' && request.method === 'POST') {
    try {
      const rawBody = await parseBody(request, getBodySizeLimit('/api/reset'));
      const { ticket } = sanitizeBody('/api/reset', rawBody) as { ticket?: string };
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Valid ticket ID required' }));
        return true;
      }
      const f = path.join(BASE_DIR, `state-${t}.json`);
      const agentProcs = _agentHandlers?.getAgentProcs() || {};
      const runningProc = agentProcs[t] as AgentChildProcess | undefined;
      if (runningProc && runningProc.exitCode === null) {
        runningProc.kill('SIGTERM');
        setTimeout(() => {
          try {
            const procs = _agentHandlers?.getAgentProcs() || {};
            const p = procs[t] as AgentChildProcess | undefined;
            if (p && p.exitCode === null) p.kill('SIGKILL');
          } catch { /* swallow */ }
        }, 5000);
      }
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch { /* swallow */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- GET /api/review --
  if (url.pathname === '/api/review') {
    const ticket = safeTicket(url.searchParams.get('ticket'));
    if (!ticket) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Invalid ticket format"}');
      return true;
    }
    const state = await getState(ticket);
    if (!state) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ gate: null }));
      return true;
    }
    const d = (state.data || {}) as Record<string, unknown>;
    const result: Record<string, unknown> = { gate: null };

    if (state.stage === 'explore_plan' && d.explore_plan_posted) {
      result.gate = 'explore_plan';
      result.plan = d.explore_plan || '';
      result.agents = d.explore_agents || {};
      result.openspec = d.explore_openspec || null;
    } else if (state.stage === 'gate_code_review' && d.code_mr_iid) {
      result.gate = 'gate_code_review';
      result.changes = ((d.codeChanges as Record<string, unknown>)?.changes) || [];
      result.summary = ((d.codeChanges as Record<string, unknown>)?.summary) || '';
      result.test_notes = ((d.codeChanges as Record<string, unknown>)?.test_notes) || '';
      result.original_files = d.original_files || {};
      result.mr_url = d.code_mr_url || '';
      result.unit_tests = d._unit_tests_complete || null;
      result.unit_tests_count = d._unit_tests_count || null;
      result.e2e_tests = d._e2e_tests_complete || null;
      result.e2e_tests_count = d._e2e_tests_count || null;
      result.e2e_console_errors = d._e2e_console_errors || null;
    } else if (state.stage === 'deploy_qa' && d.deploy_qa_posted) {
      result.gate = 'deploy_qa';
      result.changes = ((d.codeChanges as Record<string, unknown>)?.changes) || [];
      result.summary = ((d.codeChanges as Record<string, unknown>)?.summary) || '';
      result.test_notes = ((d.codeChanges as Record<string, unknown>)?.test_notes) || '';
      result.original_files = d.original_files || {};
      result.mr_url = d.code_mr_url || '';
    } else if (state.stage === 'gate_preprod_approval' && d.gate2a_posted) {
      result.gate = 'gate_preprod_approval';
      result.qa_test = d.qa_test || [];
      result.mr_url = d.code_mr_url || '';
    } else if (state.stage === 'gate_dual_approval' && d.gate2b_posted) {
      result.gate = 'gate_dual_approval';
      result.preprod_mr_url = d.preprod_mr_url || '';
      result.summary = ((d.codeChanges as Record<string, unknown>)?.summary) || '';
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // -- POST /api/approve --
  // Uses patchUIWithGateAsync for atomic locked write with HMAC
  if (url.pathname === '/api/approve' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/approve'));
      const { ticket, gate } = sanitizeBody('/api/approve', raw) as { ticket?: string; gate?: string };
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid ticket"}');
        return true;
      }
      const g = safeGate(gate);
      if (!g) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid gate parameter"}');
        return true;
      }
      await patchUIWithGateAsync(t, g, {
        '_ui_approved': true,
        '_ui_rejected': null,
        '_ui_feedback': null,
        '_ui_refine': null,
        '_ui_refine_instructions': null,
      });
      broadcast('review', { gate: g, action: 'approved', ticket: t });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('no state file') ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- POST /api/reject --
  // Uses patchUIWithGateAsync for atomic locked write with HMAC
  if (url.pathname === '/api/reject' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/reject'));
      const { ticket, gate, feedback } = sanitizeBody('/api/reject', raw) as {
        ticket?: string; gate?: string; feedback?: string;
      };
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid ticket"}');
        return true;
      }
      const g = safeGate(gate);
      if (!g) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid gate parameter"}');
        return true;
      }
      await patchUIWithGateAsync(t, g, {
        '_ui_rejected': true,
        '_ui_feedback': feedback || '',
        '_ui_approved': null,
        '_ui_refine': null,
        '_ui_refine_instructions': null,
      });
      broadcast('review', { gate: g, action: 'rejected', feedback, ticket: t });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('no state file') ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- POST /api/refine --
  // Uses patchUIWithGateAsync for atomic locked write with HMAC
  if (url.pathname === '/api/refine' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/refine'));
      const { ticket, gate, instructions } = sanitizeBody('/api/refine', raw) as {
        ticket?: string; gate?: string; instructions?: string;
      };
      if (!instructions || typeof instructions !== 'string' || instructions.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Refine instructions are required' }));
        return true;
      }
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid ticket"}');
        return true;
      }
      const g = safeGate(gate);
      if (!g) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid gate parameter"}');
        return true;
      }
      await patchUIWithGateAsync(t, g, {
        '_ui_refine': true,
        '_ui_refine_instructions': instructions.trim(),
        '_ui_approved': null,
        '_ui_rejected': null,
        '_ui_feedback': null,
      });
      broadcast('review', { gate: g, action: 'refine', instructions: instructions.trim(), ticket: t });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('no state file') ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- GET /api/error --
  if (url.pathname === '/api/error') {
    const ticket = safeTicket(url.searchParams.get('ticket'));
    if (!ticket) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Invalid ticket"}');
      return true;
    }
    const state = await getState(ticket);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (state?.data as Record<string, unknown>)?._lastError || null }));
    return true;
  }

  // -- POST /api/comments --
  // Accepts two shapes:
  //   1. Full blob:   { ticket, comments: Record<string, unknown> }
  //   2. Single add:  { ticket, file, line, body, parentId? }   (the new UI sends this)
  if (url.pathname === '/api/comments' && request.method === 'POST') {
    try {
      const rawComments = await parseBody(request, getBodySizeLimit('/api/comments'));
      const parsed = sanitizeBody('/api/comments', rawComments) as {
        ticket?: string;
        comments?: Record<string, unknown>;
        file?: string;
        line?: number;
        body?: string;
        parentId?: string;
      };
      const t = safeTicket(parsed.ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid ticket"}');
        return true;
      }

      let ok: boolean;
      if (parsed.comments && typeof parsed.comments === 'object') {
        // Shape 1: full blob replaces the persisted comments.
        ok = await saveReviewComments(t, parsed.comments);
      } else if (
        typeof parsed.file === 'string' &&
        typeof parsed.line === 'number' &&
        typeof parsed.body === 'string' &&
        parsed.body.length > 0
      ) {
        // Shape 2: append a single comment into the existing blob.
        const existing = await getReviewComments(t);
        const key = `${parsed.file}:${parsed.line}`;
        const list = Array.isArray(existing[key]) ? (existing[key] as unknown[]) : [];
        const entry = {
          id: `srv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file: parsed.file,
          line: parsed.line,
          body: parsed.body,
          author: 'reviewer',
          timestamp: Date.now(),
          parentId: parsed.parentId,
        };
        const next: Record<string, unknown> = { ...existing, [key]: [...list, entry] };
        ok = await saveReviewComments(t, next);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid payload: expected {comments} or {file,line,body}"}');
        return true;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- GET /api/comments --
  if (url.pathname === '/api/comments' && request.method === 'GET') {
    const ticket = safeTicket(url.searchParams.get('ticket'));
    if (!ticket) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Invalid ticket"}');
      return true;
    }
    const comments = await getReviewComments(ticket);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ comments }));
    return true;
  }

  // -- POST /api/skip-stage --
  // Uses updateAsync for atomic locked read-modify-write with HMAC
  if (url.pathname === '/api/skip-stage' && request.method === 'POST') {
    if (!ALLOW_STAGE_SKIP) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Stage skip disabled. Set ALLOW_STAGE_SKIP=true to enable.' }));
      return true;
    }
    try {
      const rawSkip = await parseBody(request, getBodySizeLimit('/api/skip-stage'));
      const { ticket, confirm } = sanitizeBody('/api/skip-stage', rawSkip) as {
        ticket?: string; confirm?: boolean;
      };
      if (!confirm) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Confirmation required: send confirm=true' }));
        return true;
      }
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid ticket"}');
        return true;
      }
      const updated = await updateAsync(t, async (state) => {
        state.data = state.data || {} as PipelineState['data'];
        (state.data as Record<string, unknown>)._force_advance = true;
        return state;
      });
      addLog(`[O7] Stage skip requested for ${t} (current stage: ${updated.stage})`, 'system', t);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stage: updated.stage }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('no state file') ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- POST /api/reset-stage --
  // Uses updateAsync for atomic locked read-modify-write with HMAC
  if (url.pathname === '/api/reset-stage' && request.method === 'POST') {
    try {
      const rawReset = await parseBody(request, getBodySizeLimit('/api/reset-stage'));
      const { ticket, stage } = sanitizeBody('/api/reset-stage', rawReset) as {
        ticket?: string; stage?: string;
      };
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid ticket"}');
        return true;
      }
      const s = safeStage(stage);
      if (!s) {
        const validStages = _agentHandlers
          ? Object.keys(_agentHandlers.STAGE_DATA_MAP).join(', ')
          : 'unknown';
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Invalid stage. Valid: ${validStages}` }));
        return true;
      }
      const fieldsToClear = _agentHandlers?.STAGE_DATA_MAP[s] || [];
      await updateAsync(t, async (state) => {
        state.data = state.data || {} as PipelineState['data'];
        const data = state.data as Record<string, unknown>;
        for (const field of fieldsToClear) {
          delete data[field];
        }
        state.stage = s;
        return state;
      });
      addLog(`[O8] Stage reset to '${s}' for ${t}, cleared ${fieldsToClear.length} fields`, 'system', t);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stage: s, clearedFields: fieldsToClear }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('no state file') ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- GET /api/logs-file --
  if (url.pathname === '/api/logs-file' && request.method === 'GET') {
    const ticket = safeTicket(url.searchParams.get('ticket'));
    if (!ticket) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Invalid ticket format"}');
      return true;
    }
    const tail = Math.min(Math.max(parseInt(url.searchParams.get('tail') || '50', 10) || 50, 1), 500);
    const logPath = path.join(BASE_DIR, `agent-${ticket}.log`);
    try {
      if (!fs.existsSync(logPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lines: [], total: 0 }));
        return true;
      }
      const content = await fs.promises.readFile(logPath, 'utf8');
      const allLines = content.split('\n').filter(Boolean);
      const total = allLines.length;
      const lines = allLines.slice(-tail);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines, total }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read log file: ' + msg }));
    }
    return true;
  }

  // -- POST /api/inject-context --
  // Uses updateAsync for atomic locked read-modify-write with HMAC
  if (url.pathname === '/api/inject-context' && request.method === 'POST') {
    try {
      const rawCtx = await parseBody(request, getBodySizeLimit('/api/inject-context'));
      const { ticket, context } = sanitizeBody('/api/inject-context', rawCtx) as {
        ticket?: string; context?: string;
      };
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid ticket format"}');
        return true;
      }
      if (!context || typeof context !== 'string' || context.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Context text is required' }));
        return true;
      }
      if (context.length > 10000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Context too long (max 10000 chars)' }));
        return true;
      }
      await updateAsync(t, async (state) => {
        state.data = state.data || {} as PipelineState['data'];
        (state.data as Record<string, unknown>)._injectedContext = {
          text: context.trim(),
          timestamp: new Date().toISOString(),
        };
        return state;
      });
      addLog(`[O9] Context injected for ${t} (${context.trim().length} chars)`, 'system', t);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('no state file') ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- GET /api/health -- Enhanced with service health, Slack, escalations --
  if (url.pathname === '/api/health' && request.method === 'GET') {
    const rawTicket = url.searchParams.get('ticket');
    const t = rawTicket ? safeTicket(rawTicket) : null;
    let currentStageVal: string | null = null;
    let lastActivityVal: string | null = null;
    let pipelineHealth: unknown = null;
    if (t) {
      const state = await getState(t);
      if (state) {
        currentStageVal = state.stage || null;
        lastActivityVal = (state.data as Record<string, unknown>)?._lastActivity as string || null;
        pipelineHealth = (state.data as Record<string, unknown>)?._health || null;
      }
    }
    const agentProcs = _agentHandlers?.getAgentProcs() || {};
    const healthData: Record<string, unknown> = {
      pid: process.pid,
      uptime: process.uptime(),
      lastActivity: lastActivityVal,
      currentStage: currentStageVal,
      memoryUsage: process.memoryUsage(),
      tickets: Object.keys(agentProcs),
    };

    // [Health Monitor] Include service health (Jira, GitLab, Slack, Claude)
    if (getServiceHealth) {
      healthData.services = getServiceHealth();
    }

    // [Slack] Include Slack integration health
    if (getSlackHealth) {
      healthData.slack = getSlackHealth();
    }

    // [Escalation] Include active escalations
    if (getActiveEscalations) {
      healthData.escalations = getActiveEscalations();
    }

    // [Health Monitor] Include pipeline-level health from state
    if (pipelineHealth) {
      healthData.pipeline = pipelineHealth;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthData));
    return true;
  }

  // -- GET /api/test-artifacts --
  if (url.pathname === '/api/test-artifacts' && request.method === 'GET') {
    const ticket = safeTicket(url.searchParams.get('ticket'));
    if (!ticket) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Invalid ticket format"}');
      return true;
    }
    const artifactsDir = path.join(BASE_DIR, '.test-artifacts', ticket);
    const files: Array<{ name: string; type: string; files?: string[] }> = [];
    try {
      if (fs.existsSync(artifactsDir)) {
        const entries = fs.readdirSync(artifactsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            files.push({ name: entry.name, type: 'file' });
          } else if (entry.isDirectory()) {
            try {
              const subEntries = fs.readdirSync(path.join(artifactsDir, entry.name));
              files.push({ name: entry.name, type: 'directory', files: subEntries });
            } catch {
              files.push({ name: entry.name, type: 'directory', files: [] });
            }
          }
        }
      }
    } catch { /* swallow */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ticket, files }));
    return true;
  }

  // -- GET /api/notification-audit -- Notification audit trail --
  if (url.pathname === '/api/notification-audit' && request.method === 'GET') {
    if (getAuditLog && getAuditSummary) {
      const response = {
        summary: getAuditSummary(),
        log: getAuditLog(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary: null, log: [], message: 'Notification audit module not loaded' }));
    }
    return true;
  }

  // -- GET /api/pipelines -- Pipeline dashboard list --
  if (url.pathname === '/api/pipelines' && request.method === 'GET') {
    const agentProcs = _agentHandlers?.getAgentProcs() || {};
    const pipelines = getCachedPipelineList(agentProcs);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pipelines }));
    return true;
  }

  // -- DELETE /api/pipeline/:ticket -- Delete pipeline state + logs --
  if (url.pathname.startsWith('/api/pipeline/') && request.method === 'DELETE') {
    const rawTicket = url.pathname.replace('/api/pipeline/', '');
    const ticket = safeTicket(rawTicket);
    if (!ticket) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid ticket format' }));
      return true;
    }
    deletePipeline(ticket);
    // Broadcast updated pipeline list
    const agentProcs = _agentHandlers?.getAgentProcs() || {};
    const pipelines = getCachedPipelineList(agentProcs);
    broadcast('pipelines', pipelines);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // -- GET /api/escalations -- Active escalations and history --
  if (url.pathname === '/api/escalations' && request.method === 'GET') {
    const response = {
      active: getActiveEscalations ? getActiveEscalations() : [],
      log: getEscalationLog ? getEscalationLog() : [],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return true;
  }

  // -- GET /api/tickets -- Overview of all active tickets --
  if (url.pathname === '/api/tickets' && request.method === 'GET') {
    const GATE_STAGES = new Set<string>([
      'gate_code_review', 'gate_preprod_approval',
      'gate_dual_approval', 'explore_plan',
    ]);
    const agentProcs = _agentHandlers?.getAgentProcs() || {};
    const tickets: Array<Record<string, unknown>> = [];

    // Iterate all running agent tickets
    for (const ticket of Object.keys(agentProcs)) {
      const state = await getState(ticket);
      const stage = state?.stage || 'unknown';
      const stageIndex = (STAGES as readonly string[]).indexOf(stage);
      const progress = stageIndex >= 0 ? parseFloat((stageIndex / STAGES.length).toFixed(2)) : 0;
      const d = (state?.data || {}) as Record<string, unknown>;
      const activeAgents = (d._active_agents as string[]) || [];
      const startedAt = (d._startedAt as string) || null;
      let needsApproval = GATE_STAGES.has(stage);
      // explore_plan only needs approval when plan is posted
      if (stage === 'explore_plan' && state?.data && !d.explore_plan_posted) {
        needsApproval = false;
      }

      tickets.push({
        ticket, stage, running: true, activeAgents,
        startedAt, needsApproval, progress,
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tickets }));
    return true;
  }

  // -- GET /api/review-comments -- (alias for /api/comments GET)
  if (url.pathname === '/api/review-comments' && request.method === 'GET') {
    const ticket = safeTicket(url.searchParams.get('ticket'));
    if (!ticket) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Invalid ticket"}');
      return true;
    }
    const comments = await getReviewComments(ticket);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ comments }));
    return true;
  }

  // -- POST /api/review-comments -- (alias for /api/comments POST)
  if (url.pathname === '/api/review-comments' && request.method === 'POST') {
    try {
      const rawComments = await parseBody(request, getBodySizeLimit('/api/review-comments'));
      const { ticket, comments } = sanitizeBody('/api/review-comments', rawComments) as {
        ticket?: string; comments?: Record<string, unknown>;
      };
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid ticket"}');
        return true;
      }
      const ok = await saveReviewComments(t, comments || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- POST /api/review-decision -- code review approve/reject
  if (url.pathname === '/api/review-decision' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/review-decision'));
      const { ticket, decision, feedback } = sanitizeBody('/api/review-decision', raw) as {
        ticket?: string; decision?: string; feedback?: string;
      };
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid ticket"}');
        return true;
      }
      if (decision !== 'approve' && decision !== 'reject') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid decision. Must be "approve" or "reject".' }));
        return true;
      }
      if (decision === 'approve') {
        await patchUIWithGateAsync(t, 'gate_code_review', {
          '_ui_approved': true,
          '_ui_rejected': null,
          '_ui_feedback': null,
        });
        broadcast('review', { gate: 'gate_code_review', action: 'approved', ticket: t });
      } else {
        await patchUIWithGateAsync(t, 'gate_code_review', {
          '_ui_rejected': true,
          '_ui_feedback': feedback || '',
          '_ui_approved': null,
        });
        broadcast('review', { gate: 'gate_code_review', action: 'rejected', feedback, ticket: t });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('no state file') ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // ── GET /api/config — Return all config vars with values (secrets masked) ──
  if (url.pathname === '/api/config' && request.method === 'GET') {
    const items: unknown[] = [];
    for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
      const rawValue = process.env[schema.env];
      let value = rawValue !== undefined
        ? rawValue
        : (schema.default !== undefined ? String(schema.default) : '');
      if (schema.sensitive && rawValue) {
        value = rawValue.length > 4 ? '****' + rawValue.slice(-4) : '****';
      }
      items.push({
        key,
        env: schema.env,
        type: schema.type,
        value,
        default: schema.default !== undefined ? String(schema.default) : '',
        required: !!schema.required,
        sensitive: !!schema.sensitive,
        group: schema.group || '',
        description: schema.description || '',
        hotReload: !!schema.hotReload,
        allowed: schema.allowed || null,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, items }));
    return true;
  }

  // ── POST /api/config/save — Save env var changes to .env file atomically ──
  if (url.pathname === '/api/config/save' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/config/save'));
      const { values } = sanitizeBody('/api/config/save', raw) as { values?: Record<string, string> };
      if (!values || typeof values !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'values object is required' }));
        return true;
      }
      const envPath = path.join(BASE_DIR, '.env');
      let envContent = '';
      try { envContent = fs.readFileSync(envPath, 'utf8'); } catch { /* no .env yet */ }
      const lines = envContent.split('\n');
      const existingKeys = new Set<string>();
      const updatedLines: string[] = [];
      for (const line of lines) {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
        if (match) {
          const envKey = match[1];
          existingKeys.add(envKey);
          if (envKey in values && !values[envKey].startsWith('****')) {
            updatedLines.push(`${envKey}=${values[envKey]}`);
            process.env[envKey] = values[envKey];
          } else {
            updatedLines.push(line);
          }
        } else {
          updatedLines.push(line);
        }
      }
      for (const [envKey, envVal] of Object.entries(values)) {
        if (envVal.startsWith('****')) continue;
        if (!existingKeys.has(envKey)) {
          updatedLines.push(`${envKey}=${envVal}`);
          process.env[envKey] = envVal;
        }
      }
      const tmpPath = envPath + '.' + Date.now() + '.tmp';
      fs.writeFileSync(tmpPath, updatedLines.join('\n'), 'utf8');
      fs.renameSync(tmpPath, envPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        saved: Object.keys(values).filter((k) => !values[k].startsWith('****')).length,
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // ── POST /api/config/test — Test service connectivity ──
  if (url.pathname === '/api/config/test' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/config/test'));
      const { service } = sanitizeBody('/api/config/test', raw) as { service?: string };
      const allowed = [
        'jira', 'gitlab', 'slack',
        'gdrive', 'figma', 'postman',
        'claude', 'anthropic', 'browser',
      ];
      if (!service || !allowed.includes(service)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `service must be one of: ${allowed.join(', ')}` }));
        return true;
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const https = require('https');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const http = require('http');
      type TestResult = { ok: boolean; message?: string; error?: string };
      let result: TestResult = { ok: false, error: 'not implemented' };

      if (service === 'jira') {
        const jiraBase = (process.env.JIRA_BASE_URL || 'https://mastersindia-sols.atlassian.net').replace(/\/+$/, '');
        const jiraEmail = process.env.JIRA_EMAIL;
        const jiraToken = process.env.JIRA_TOKEN;
        if (!jiraEmail || !jiraToken) {
          result = { ok: false, error: 'JIRA_EMAIL and JIRA_TOKEN must be set' };
        } else {
          const testUrl = new URL(jiraBase + '/rest/api/3/myself');
          const proto = testUrl.protocol === 'https:' ? https : http;
          const authHeader = 'Basic ' + Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
          result = await new Promise<TestResult>((resolve) => {
            const req = proto.get(testUrl.href, {
              headers: { Authorization: authHeader, Accept: 'application/json' },
              timeout: 10000,
            }, (resp: { statusCode: number; on: (ev: string, cb: (data?: unknown) => void) => void }) => {
              let body = '';
              resp.on('data', (c: unknown) => { body += c; });
              resp.on('end', () => {
                if (resp.statusCode >= 200 && resp.statusCode < 300) {
                  try {
                    const j = JSON.parse(body);
                    resolve({ ok: true, message: `Connected as ${j.displayName || j.emailAddress || 'OK'}` });
                  } catch {
                    resolve({ ok: true, message: 'Connected (status ' + resp.statusCode + ')' });
                  }
                } else {
                  resolve({ ok: false, error: `HTTP ${resp.statusCode}: ${body.slice(0, 200)}` });
                }
              });
            });
            req.on('error', (e: Error) => resolve({ ok: false, error: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Connection timed out' }); });
          });
        }
      } else if (service === 'gitlab') {
        const gitlabUrl = (process.env.GITLAB_URL || 'http://10.200.11.32').replace(/\/+$/, '');
        const gitlabToken = process.env.GITLAB_TOKEN;
        const gitlabProjectId = process.env.GITLAB_PROJECT_ID;
        if (!gitlabToken || !gitlabProjectId) {
          result = { ok: false, error: 'GITLAB_TOKEN and GITLAB_PROJECT_ID must be set' };
        } else {
          const testUrl = new URL(`${gitlabUrl}/api/v4/projects/${gitlabProjectId}`);
          const proto = testUrl.protocol === 'https:' ? https : http;
          result = await new Promise<TestResult>((resolve) => {
            const req = proto.get(testUrl.href, {
              headers: { 'PRIVATE-TOKEN': gitlabToken, Accept: 'application/json' },
              timeout: 10000,
            }, (resp: { statusCode: number; on: (ev: string, cb: (data?: unknown) => void) => void }) => {
              let body = '';
              resp.on('data', (c: unknown) => { body += c; });
              resp.on('end', () => {
                if (resp.statusCode >= 200 && resp.statusCode < 300) {
                  try {
                    const j = JSON.parse(body);
                    resolve({ ok: true, message: `Connected to project: ${j.name_with_namespace || j.name || 'OK'}` });
                  } catch {
                    resolve({ ok: true, message: 'Connected (status ' + resp.statusCode + ')' });
                  }
                } else {
                  resolve({ ok: false, error: `HTTP ${resp.statusCode}: ${body.slice(0, 200)}` });
                }
              });
            });
            req.on('error', (e: Error) => resolve({ ok: false, error: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Connection timed out' }); });
          });
        }
      } else if (service === 'slack') {
        const webhookUrl = process.env.SLACK_WEBHOOK;
        if (!webhookUrl) {
          result = { ok: false, error: 'SLACK_WEBHOOK must be set' };
        } else {
          const payload = JSON.stringify({ text: '[MI Dev Agent] Connectivity test — this message confirms Slack integration is working.' });
          const testUrl = new URL(webhookUrl);
          const proto = testUrl.protocol === 'https:' ? https : http;
          result = await new Promise<TestResult>((resolve) => {
            const req = proto.request(testUrl.href, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
              timeout: 10000,
            }, (resp: { statusCode: number; on: (ev: string, cb: (data?: unknown) => void) => void }) => {
              let body = '';
              resp.on('data', (c: unknown) => { body += c; });
              resp.on('end', () => {
                if (resp.statusCode >= 200 && resp.statusCode < 300) {
                  resolve({ ok: true, message: 'Slack webhook responded OK — test message sent' });
                } else if (resp.statusCode === 302 || resp.statusCode === 301) {
                  resolve({ ok: false, error: 'Webhook returned redirect — the URL is likely expired or revoked. Generate a new webhook in Slack.' });
                } else {
                  resolve({ ok: false, error: `HTTP ${resp.statusCode}: ${body.slice(0, 200)}` });
                }
              });
            });
            req.on('error', (e: Error) => resolve({ ok: false, error: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Connection timed out' }); });
            req.write(payload);
            req.end();
          });
        }
      } else if (service === 'claude') {
        // Claude CLI is a local binary -- no network call. Report OK if the
        // model override or an API fallback is configured.
        const model = process.env.CLAUDE_MODEL;
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (model) {
          result = { ok: true, message: `Claude model configured: ${model}` };
        } else if (apiKey) {
          result = { ok: true, message: 'Claude CLI + Anthropic API fallback configured' };
        } else {
          result = { ok: false, error: 'Neither CLAUDE_MODEL nor ANTHROPIC_API_KEY is set' };
        }
      } else if (service === 'anthropic') {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          result = { ok: false, error: 'ANTHROPIC_API_KEY must be set' };
        } else {
          result = { ok: true, message: 'Anthropic API key configured (not validated against API to avoid charges)' };
        }
      } else if (service === 'browser') {
        const browser = process.env.PLAYWRIGHT_BROWSER || 'chromium';
        const validBrowsers = ['chromium', 'firefox', 'webkit'];
        if (!validBrowsers.includes(browser)) {
          result = { ok: false, error: `PLAYWRIGHT_BROWSER must be one of: ${validBrowsers.join(', ')}` };
        } else {
          result = { ok: true, message: `Playwright configured: ${browser}` };
        }
      } else {
        // gdrive / figma / postman — load agent lib via relative require
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const lib = require(`../../../agent/dist/lib/${service}`);
          result = await lib.testConnection();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          result = { ok: false, error: `${service} connector unavailable: ${msg}` };
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // ── GET /api/notification-config — Return current notification config ──
  if (url.pathname === '/api/notification-config' && request.method === 'GET') {
    const config = loadNotificationConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, config }));
    return true;
  }

  // ── POST /api/notification-config — Save notification config ──
  if (url.pathname === '/api/notification-config' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/notification-config'));
      const { config } = sanitizeBody('/api/notification-config', raw) as { config?: Record<string, unknown> };
      if (!config || typeof config !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'config object is required' }));
        return true;
      }
      saveNotificationConfig(config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // D14: Unknown API routes return 404
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return true;
  }

  // ── Static file serving (React build) ──
  if (tryServeStaticFile(url, res, apiToken)) {
    return true;
  }

  // ── Fallback: Serve SPA HTML ──
  if (html) {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.end(html);
  } else {
    // Try to serve index.html from frontend dist
    const indexPath = path.join(FRONTEND_DIST, 'index.html');
    try {
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
        });
        res.end(content);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  }
  return true;
}
