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

// Playground process management: startPlaygroundRun, stopPlaygroundRun, etc.
// Registered via setPlaygroundProcessHandlers() from http-server.ts, same
// late-binding rationale as AgentProcessHandlers above.
interface PlaygroundProcessHandlers {
  startPlaygroundRun: (opts: { runId: string; stage: string; ticket?: string | null; customInstruction?: string }) => { ok: boolean; error?: string };
  stopPlaygroundRun: (runId: string) => { ok: boolean; error?: string };
  getPlaygroundProcs: () => Record<string, AgentChildProcess>;
  PLAYGROUND_WIRED_STAGES: Set<string>;
}

let _playgroundHandlers: PlaygroundProcessHandlers | null = null;

/**
 * Register Playground process handlers. Called by http-server.ts on startup.
 */
export function setPlaygroundProcessHandlers(handlers: PlaygroundProcessHandlers): void {
  _playgroundHandlers = handlers;
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

/**
 * Playground stage whitelist -- deliberately narrower than the full
 * pipeline's STAGES list and enforced server-side (not just hidden in the
 * UI). Only stages with no irreversible external side effect once
 * simulated are exposed; deploy/gate/dual-approval stages stay out until
 * the safe stages are proven out.
 */
const PLAYGROUND_ALLOWED_STAGES = new Set<string>(['fetch_ticket', 'explore_plan', 'generate_code']);

// Project root -- packages/agent/src/server/playground-process.ts persists run
// metadata to <root>/.state/playground/<runId>.json; read it back from here.
const PLAYGROUND_STATE_DIR = path.join(__dirname, '..', '..', '..', '..', '.state', 'playground');

interface PlaygroundRunRecord {
  runId: string;
  stage: string;
  ticket: string | null;
  customInstruction?: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  resultSummary?: string | null;
}

function readPlaygroundRun(runId: string): PlaygroundRunRecord | null {
  try {
    const filePath = path.join(PLAYGROUND_STATE_DIR, `${runId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PlaygroundRunRecord;
  } catch {
    return null;
  }
}

function listPlaygroundRuns(): PlaygroundRunRecord[] {
  try {
    if (!fs.existsSync(PLAYGROUND_STATE_DIR)) return [];
    const files = fs.readdirSync(PLAYGROUND_STATE_DIR).filter((f) => f.endsWith('.json'));
    const runs = files
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(PLAYGROUND_STATE_DIR, f), 'utf8')) as PlaygroundRunRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is PlaygroundRunRecord => r !== null);
    runs.sort((a, b) => b.startedAt - a.startedAt);
    return runs;
  } catch {
    return [];
  }
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

  // OAuth + connector-credential routes: handle before auth check
  // (OAuth callback has no auth; PAT save/remove apply x-api-token internally).
  if (
    handleOAuthRoute &&
    (
      url.pathname.startsWith('/oauth/') ||
      url.pathname.startsWith('/api/oauth/') ||
      url.pathname.startsWith('/api/connectors/')
    )
  ) {
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

  // T1.8: Auth token check on /api/ requests.
  // Read-only endpoints that return no secrets are public (GET config, health, state, pipelines).
  const PUBLIC_GET_PATHS = ['/api/health', '/api/config', '/api/state', '/api/pipelines', '/api/notification-config'];
  const isPublicGet = request.method === 'GET' && PUBLIC_GET_PATHS.includes(url.pathname);
  if (url.pathname.startsWith('/api/') && !isPublicGet) {
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
      const { ticket, mode, modelOverride } = sanitizeBody('/api/start', raw) as {
        ticket?: string; mode?: 'resume' | 'fresh'; modelOverride?: string;
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

            // Per-ticket model override (stuck-stage "Switch Model & Retry") --
            // scoped to this ticket only, applied to its next spawn's env by
            // agent-process.ts. Never touches the global CLAUDE_MODEL setting.
            if (modelOverride && modelOverride.trim()) {
              data._modelOverride = modelOverride.trim();
            }

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

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      running: !!agentProcs[ticket],
      state,
      logCount: getLogBuffer().length,
      health,
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

  // -- GET /api/changes --
  // Durable diff-data surface for the Write Code stage card.
  // Picks the best available source (live/state/git/none) so the UI can
  // render the same DiffViewer across running, post-run, cached-resume,
  // and past-gate contexts without stage-gated branches.
  if (url.pathname === '/api/changes') {
    const ticket = safeTicket(url.searchParams.get('ticket'));
    if (!ticket) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Invalid ticket format"}');
      return true;
    }
    const now = Date.now();
    const state = await getState(ticket);
    if (!state) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ source: 'none', changes: [], summary: '', original_files: {}, ts: now, reason: 'no_state' }));
      return true;
    }

    try {
      const d = (state.data || {}) as Record<string, unknown>;
      const { cfg } = require('@mi/agent/lib/config') as { cfg: { localRepo: string | null } };

      const liveActive = state.stage === 'generate_code' && !!d._active_team;
      const codeChanges = d.codeChanges as { changes?: unknown[]; summary?: string } | undefined;
      const hasStateChanges = Array.isArray(codeChanges?.changes) && (codeChanges!.changes as unknown[]).length > 0;

      if (liveActive && cfg.localRepo) {
        const { buildLiveSnapshot } = require('@mi/agent/lib/agents-team') as {
          buildLiveSnapshot: (cwd: string, ticket: string, team: string, activeAgents: string[]) => {
            changes: unknown[]; original_files: Record<string, string>;
          };
        };
        const rawAgents = (d._active_agents as unknown) || [];
        const activeAgents: string[] = Array.isArray(rawAgents)
          ? rawAgents.map((a: unknown) => (typeof a === 'string' ? a : (a as { name?: string })?.name)).filter((n): n is string => typeof n === 'string')
          : [];
        const teamName = (d._active_team as string) || 'Developer Team';
        const snap = buildLiveSnapshot(cfg.localRepo, ticket, teamName, activeAgents);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          source: 'live',
          changes: snap.changes,
          summary: codeChanges?.summary || '',
          original_files: snap.original_files,
          ts: now,
        }));
        return true;
      }

      if (hasStateChanges) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          source: 'state',
          changes: codeChanges!.changes,
          summary: codeChanges!.summary || '',
          original_files: d.original_files || {},
          ts: now,
        }));
        return true;
      }

      if (cfg.localRepo) {
        const { localGetChanges, localGetOriginal } = require('@mi/agent/lib/local-repo') as {
          localGetChanges: (cwd: string) => Array<{ action: string; file_path: string; content: string }>;
          localGetOriginal: (cwd: string, filePath: string) => string | null;
        };
        const SENSITIVE = /^(\.env(\..*)?|\.api-token|\.state-secret|\.debug)$/;
        const raw = localGetChanges(cfg.localRepo);
        const filtered = raw.filter((c) => !SENSITIVE.test(c.file_path));
        if (filtered.length > 0) {
          const originals: Record<string, string> = {};
          for (const c of filtered) {
            if (c.action !== 'update') continue;
            const orig = localGetOriginal(cfg.localRepo, c.file_path);
            if (orig !== null) originals[c.file_path] = orig;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            source: 'git',
            changes: filtered,
            summary: '',
            original_files: originals,
            ts: now,
          }));
          return true;
        }
      }

      const reason = cfg.localRepo ? 'no_changes_yet' : 'no_local_repo';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ source: 'none', changes: [], summary: '', original_files: {}, ts: now, reason }));
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e)).substring(0, 500);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ source: 'none', changes: [], summary: '', original_files: {}, ts: now, reason: 'error', error: msg }));
    }
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

  // -- POST /api/answer-questions --
  // Accepts user answers to Architect-raised clarifying questions.
  // Appends to state.data._qa_answers and removes answered entries from
  // state.data._pending_questions, then broadcasts so the UI re-enables
  // Approve and hides answered rows. Ported from the legacy agent server
  // (packages/agent/src/server/routes.ts) — handler was missing from the
  // backend dispatcher and returned 404 in production.
  if (url.pathname === '/api/answer-questions' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/answer-questions'));
      const ticketIn = raw.ticket;
      const answersIn = raw.answers;
      const t = typeof ticketIn === 'string' ? safeTicket(ticketIn) : null;
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid ticket format' }));
        return true;
      }
      if (!Array.isArray(answersIn) || answersIn.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: "'answers' must be a non-empty array" }));
        return true;
      }
      for (const a of answersIn) {
        if (!a || typeof a !== 'object'
            || typeof (a as { id?: unknown }).id !== 'string'
            || typeof (a as { choice?: unknown }).choice !== 'number') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Each answer must be {id: string, choice: number}' }));
          return true;
        }
      }
      const via: 'user' | 'ai-default' = (raw.via === 'ai-default') ? 'ai-default' : 'user';

      let remaining = 0;
      let validationError: { code: number; message: string } | null = null;

      await updateAsync(t, async (state) => {
        const data = (state.data ?? {}) as Record<string, unknown>;
        const pending = Array.isArray(data._pending_questions) ? (data._pending_questions as Array<{ id: string; options?: string[] }>) : [];
        const answers = Array.isArray(data._qa_answers) ? (data._qa_answers as Array<unknown>) : [];

        for (const a of answersIn) {
          const ans = a as { id: string; choice: number };
          const q = pending.find((p) => p.id === ans.id);
          if (!q) { validationError = { code: 400, message: `Unknown question id: ${ans.id}` }; return state; }
          if (!Array.isArray(q.options) || ans.choice < 0 || ans.choice >= q.options.length) {
            validationError = {
              code: 400,
              message: `Choice out of range for '${ans.id}': got ${ans.choice}, have ${q.options?.length ?? 0} options`,
            };
            return state;
          }
        }

        const now = Date.now();
        const answeredIds = new Set<string>();
        for (const a of answersIn) {
          const ans = a as { id: string; choice: number };
          const q = pending.find((p) => p.id === ans.id)!;
          answers.push({ id: ans.id, choice: ans.choice, optionText: q.options![ans.choice], via, ts: now });
          answeredIds.add(ans.id);
        }

        data._qa_answers = answers;
        data._pending_questions = pending.filter((p) => !answeredIds.has(p.id));
        remaining = (data._pending_questions as Array<unknown>).length;
        // Reassign via cast since PipelineData is loosely structured at this level.
        (state as { data: unknown }).data = data;
        return state;
      });

      if (validationError) {
        const err = validationError as { code: number; message: string };
        res.writeHead(err.code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
        return true;
      }

      const updated = await getState(t);
      if (updated) {
        broadcast('state', { ticket: t, stage: updated.stage, data: updated.data });
      }

      addLog(`[qa] ${answersIn.length} answer(s) applied for ${t} (remaining pending: ${remaining})`, 'system', t);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, remaining }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('no state file') ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
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

  // ── Local dev server management ─────────────────────────────────
  // Starts `npx nx serve enterprise --port 4200` in the agent's .repo-cache
  // after optionally checking out the ticket's feature branch, so the
  // Playground shows exactly the code developed for that ticket.

  // Shared in-module state (one server per backend process)
  const _lss = (globalThis as Record<string, unknown>);
  if (!_lss.__localServer) {
    _lss.__localServer = { pid: null, port: null, ready: false, startedAt: null, logs: [] as string[], stopping: false, ticket: null as string | null, branch: null as string | null };
  }
  const _ls = _lss.__localServer as { pid: number | null; port: number | null; ready: boolean; startedAt: number | null; logs: string[]; stopping: boolean; ticket: string | null; branch: string | null };

  // The agent always clones to this fixed path regardless of process context
  const REPO_CACHE = path.resolve(__dirname, '..', '..', '..', 'agent', 'dist', '.repo-cache');

  // POST /api/local-server/start
  if (url.pathname === '/api/local-server/start' && request.method === 'POST') {
    try {
      const rawBody = await parseBody(request, 65_536);
      const reqTicket = (rawBody.ticket as string | undefined)?.trim().toUpperCase() || null;

      // Kill any previous server first (user wants a fresh start)
      _ls.stopping = true;
      if (_ls.pid) {
        try { process.kill(_ls.pid, 'SIGTERM'); } catch { /* already dead */ }
        await new Promise((r) => setTimeout(r, 500));
        try { process.kill(_ls.pid, 'SIGKILL'); } catch { /* */ }
        _ls.pid = null; _ls.ready = false;
      }

      // Force-free port 4200 — kill whatever is using it
      try {
        const { execSync } = require('child_process') as typeof import('child_process');
        const pids = execSync('lsof -ti:4200 2>/dev/null || true').toString().trim();
        if (pids) {
          pids.split('\n').forEach((p: string) => { try { process.kill(Number(p), 'SIGKILL'); } catch { /* */ } });
          await new Promise((r) => setTimeout(r, 800));
        }
      } catch { /* lsof not available or no process */ }

      // Verify repo-cache exists
      if (!fs.existsSync(REPO_CACHE)) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Repo cache not found at ${REPO_CACHE}. Run a pipeline first to clone the repository.` }));
        return true;
      }

      const { execSync, spawn } = require('child_process') as typeof import('child_process');
      const appendLog = (line: string): void => { _ls.logs.push(line); if (_ls.logs.length > 150) _ls.logs = _ls.logs.slice(-150); };

      _ls.logs = [];
      _ls.stopping = false;
      _ls.ticket = reqTicket;
      _ls.branch = null;

      // Determine which branch to checkout
      let targetBranch: string | null = null;
      if (reqTicket) {
        try {
          // Read the pipeline state to get the feature branch for this ticket
          const stateFile = path.join(BASE_DIR, `state-${reqTicket}.json`);
          if (fs.existsSync(stateFile)) {
            const stateJson = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
            const stateData = ((stateJson.state as Record<string, unknown>)?.data || stateJson.data || {}) as Record<string, unknown>;
            targetBranch = (stateData.code_branch as string | undefined) ?? null;
          }
        } catch { /* state unreadable */ }
      }

      // Checkout the ticket's branch in repo-cache
      if (targetBranch) {
        appendLog(`[git] Fetching branch ${targetBranch}…`);
        try {
          execSync(`git -C "${REPO_CACHE}" fetch origin "${targetBranch}" --depth=5 2>&1`, { timeout: 60_000 });
          appendLog(`[git] Checking out ${targetBranch}…`);
          execSync(`git -C "${REPO_CACHE}" checkout -f "${targetBranch}" 2>&1`, { timeout: 30_000 });
          _ls.branch = targetBranch;
          appendLog(`[git] ✓ On branch ${targetBranch}`);
        } catch (ge: unknown) {
          appendLog(`[git] ⚠ Could not checkout ${targetBranch}: ${(ge as Error).message?.slice(0, 120)} — using current branch`);
          try { _ls.branch = execSync(`git -C "${REPO_CACHE}" branch --show-current`).toString().trim(); } catch { _ls.branch = 'unknown'; }
        }
      } else {
        try { _ls.branch = execSync(`git -C "${REPO_CACHE}" branch --show-current`).toString().trim(); } catch { _ls.branch = 'current'; }
        appendLog(`[git] Using current branch: ${_ls.branch}`);
      }

      // Write env file if provided in the request body
      const envContent = typeof rawBody.envContent === 'string' ? rawBody.envContent : null;
      if (envContent !== null) {
        try {
          const envFile = path.join(REPO_CACHE, 'apps', 'enterprise', '.env');
          const tmp = envFile + '.tmp';
          fs.writeFileSync(tmp, envContent, 'utf8');
          fs.renameSync(tmp, envFile);
          appendLog('[env] ✓ apps/enterprise/.env written');
        } catch (ee: unknown) {
          appendLog(`[env] ⚠ Could not write .env: ${(ee as Error).message?.slice(0, 80)}`);
        }
      }

      // Install missing packages before starting the dev server.
      // Uses --prefer-offline so cached packages install instantly.
      // Only needed when package.json changed since last install.
      appendLog('[npm] Checking dependencies…');
      try {
        const pkgJson = path.join(REPO_CACHE, 'package.json');
        const nmMeta  = path.join(REPO_CACHE, 'node_modules', '.package-lock.json');
        const pkgMtime = fs.existsSync(pkgJson) ? fs.statSync(pkgJson).mtimeMs : 0;
        const nmMtime  = fs.existsSync(nmMeta)  ? fs.statSync(nmMeta).mtimeMs  : 0;
        if (pkgMtime > nmMtime) {
          appendLog('[npm] package.json changed — running npm install…');
          execSync('npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps', {
            cwd: REPO_CACHE,
            timeout: 300_000,
            stdio: 'pipe',
          });
          appendLog('[npm] ✓ Dependencies installed');
        } else {
          appendLog('[npm] ✓ Dependencies up to date');
        }
      } catch (ne: unknown) {
        appendLog(`[npm] ⚠ Install warning: ${(ne as Error).message?.slice(0, 120)}`);
      }

      const port = 4200;
      appendLog(`[local-server] Starting nx serve enterprise on port ${port}…`);

      const proc = spawn('npx', ['nx', 'serve', 'enterprise', '--port', String(port), '--host', '0.0.0.0'], {
        cwd: REPO_CACHE,
        stdio: 'pipe',
        detached: true,
        env: { ...process.env, NODE_OPTIONS: '--max_old_space_size=4096', FORCE_COLOR: '0', BROWSER: 'none' },
      });
      proc.unref();

      _ls.pid = proc.pid ?? null;
      _ls.port = port;
      _ls.ready = false;
      _ls.startedAt = Date.now();

      const streamText = (stream: NodeJS.ReadableStream, tag: string): void => {
        let buf = '';
        stream.on('data', (c: Buffer) => {
          buf += c.toString();
          const parts = buf.split('\n');
          buf = parts.pop() ?? '';
          for (const line of parts) {
            const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim(); // strip ANSI
            if (clean) appendLog(`[${tag}] ${clean}`);
          }
        });
      };
      streamText(proc.stdout as NodeJS.ReadableStream, 'nx');
      streamText(proc.stderr as NodeJS.ReadableStream, 'nx');

      proc.on('exit', (code: number | null) => {
        if (!_ls.stopping) appendLog(`[local-server] Process exited (code ${code})`);
        _ls.pid = null; _ls.ready = false;
      });

      // Background health-check: poll http://localhost:4200 until it responds
      const startedAt = Date.now();
      const pollTimer = setInterval(async () => {
        if (!_ls.pid || _ls.ready || _ls.stopping) { clearInterval(pollTimer); return; }
        if (Date.now() - startedAt > 180_000) { appendLog('[local-server] Timeout (3 min)'); clearInterval(pollTimer); return; }
        try {
          // App may use HTTP or HTTPS (mkcert) — try both
          const httpsM = require('https') as typeof import('https');
          const httpM = require('http') as typeof import('http');
          const tryUrl = async (mod: typeof import('http') | typeof import('https'), urlStr: string): Promise<boolean> =>
            new Promise((resolve) => {
              const r = (mod as typeof import('https')).get(urlStr, { rejectUnauthorized: false, timeout: 4000 } as Parameters<typeof import('https').get>[1],
                (resp: { statusCode: number; resume: () => void }) => { resp.resume(); resolve((resp.statusCode ?? 0) < 500); });
              r.on('error', () => resolve(false));
              r.on('timeout', () => { r.destroy(); resolve(false); });
            });
          const ok = await tryUrl(httpsM, `https://localhost:${port}/`) || await tryUrl(httpM, `http://localhost:${port}/`);
          if (ok) {
            _ls.ready = true;
            appendLog(`[local-server] ✓ Ready → https://localhost:${port}`);
            clearInterval(pollTimer);
          }
        } catch { /* keep polling */ }
      }, 4000);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port, ticket: reqTicket, branch: _ls.branch }));
    } catch (e: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
    return true;
  }

  // GET /api/local-server/status
  if (url.pathname === '/api/local-server/status' && request.method === 'GET') {
    let alive = false;
    if (_ls.pid) { try { process.kill(_ls.pid, 0); alive = true; } catch { _ls.pid = null; _ls.ready = false; } }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running: alive, port: _ls.port, ready: _ls.ready, startedAt: _ls.startedAt, ticket: _ls.ticket, branch: _ls.branch, logs: _ls.logs.slice(-40) }));
    return true;
  }

  // GET /api/local-server/env — read apps/enterprise/.env from repo-cache
  if (url.pathname === '/api/local-server/env' && request.method === 'GET') {
    const envFile = path.join(REPO_CACHE, 'apps', 'enterprise', '.env');
    try {
      const content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, content, path: 'apps/enterprise/.env' }));
    } catch (e: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
    return true;
  }

  // POST /api/local-server/env — write apps/enterprise/.env in repo-cache
  if (url.pathname === '/api/local-server/env' && request.method === 'POST') {
    try {
      const body = await parseBody(request, 65_536);
      const content = typeof body.content === 'string' ? body.content : '';
      const envFile = path.join(REPO_CACHE, 'apps', 'enterprise', '.env');
      const dir = path.dirname(envFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Atomic write: tmp → rename
      const tmp = envFile + '.tmp';
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, envFile);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: 'apps/enterprise/.env', bytes: content.length }));
    } catch (e: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
    return true;
  }

  // POST /api/local-server/stop
  if (url.pathname === '/api/local-server/stop' && request.method === 'POST') {
    _ls.stopping = true;
    // Kill tracked PID first
    if (_ls.pid) {
      try { process.kill(_ls.pid, 'SIGTERM'); } catch { /* already dead */ }
      try { process.kill(_ls.pid, 'SIGKILL'); } catch { /* */ }
      _ls.pid = null;
    }
    // Force-kill everything still on the port (NX spawns daemon + vite child processes)
    if (_ls.port) {
      try {
        const { execSync } = require('child_process') as typeof import('child_process');
        const pids = execSync(`lsof -ti:${_ls.port} 2>/dev/null || true`).toString().trim();
        if (pids) pids.split('\n').forEach((p: string) => { try { process.kill(Number(p), 'SIGKILL'); } catch { /* */ } });
      } catch { /* lsof unavailable */ }
    }
    _ls.ready = false;
    _ls.port = null;
    _ls.logs.push('[local-server] Stopped');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // -- POST /api/ask-task --
  // Answers a free-form user question about the current pipeline task.
  // Builds context from pipeline state and spawns `claude -p` (print mode)
  // so it uses the same CLI auth as the agent — no ANTHROPIC_API_KEY needed.
  if (url.pathname === '/api/ask-task' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, 32_768);
      const { ticket, question } = sanitizeBody('/api/ask-task', raw) as {
        ticket?: string; question?: string;
      };
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid ticket format' }));
        return true;
      }
      if (!question || typeof question !== 'string' || question.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Question is required' }));
        return true;
      }
      if (question.length > 2000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Question too long (max 2000 chars)' }));
        return true;
      }

      // Build context from current pipeline state
      const state = await getState(t);
      const contextParts: string[] = [`Ticket: ${t}`];
      if (state) {
        contextParts.push(`Current stage: ${state.stage}`);
        const d = (state.data || {}) as Record<string, unknown>;

        const ticketData = d.ticket as Record<string, unknown> | undefined;
        if (ticketData?.title) contextParts.push(`Title: ${ticketData.title}`);
        if (ticketData?.description) {
          const desc = String(ticketData.description).slice(0, 1500);
          contextParts.push(`Description:\n${desc}`);
        }
        if (ticketData?.summary) contextParts.push(`Ticket summary: ${String(ticketData.summary).slice(0, 1000)}`);

        const plan = d.explore_plan as string | undefined;
        if (plan) contextParts.push(`Exploration plan:\n${String(plan).slice(0, 1500)}`);

        const codeChanges = d.codeChanges as { summary?: string } | undefined;
        if (codeChanges?.summary) contextParts.push(`Code changes summary: ${codeChanges.summary}`);

        const lastError = d._lastError as string | undefined;
        if (lastError) contextParts.push(`Last error: ${lastError}`);
      }

      const prompt =
        `You are a helpful assistant for a developer using an AI pipeline tool. ` +
        `Answer the user's question about their pipeline task clearly and concisely. ` +
        `Base your answer on the context provided. If information is missing, say so.\n\n` +
        `## Pipeline task context\n\n${contextParts.join('\n\n')}\n\n` +
        `## User question\n\n${question.trim()}`;

      const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';

      const answer = await new Promise<string>((resolve, reject) => {
        const { execFile } = require('child_process') as typeof import('child_process');
        const args = ['-p', prompt, '--model', model, '--output-format', 'text'];
        const proc = execFile('claude', args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) { reject(new Error(stderr?.trim() || err.message)); return; }
          resolve(stdout.trim());
        });
        void proc;
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, answer }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- POST /api/playground/start --
  // Validates input, then either delegates to the real single-stage runner
  // (packages/agent/src/playground-runner.ts, via playground-process.ts —
  // once a stage is in PLAYGROUND_WIRED_STAGES) or falls back to a stub
  // that echoes the request back over the `playground:log` /
  // `playground:status` SSE events (for stages not yet wired for real
  // execution). This lets the picker show every allowed stage from day
  // one while real execution rolls out stage-by-stage.
  if (url.pathname === '/api/playground/start' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/playground/start'));
      const { stage, ticket, customInstruction } = sanitizeBody('/api/playground/start', raw) as {
        stage?: string; ticket?: string; customInstruction?: string;
      };
      if (!stage || !PLAYGROUND_ALLOWED_STAGES.has(stage)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid or disallowed stage' }));
        return true;
      }
      let t: string | null = null;
      if (ticket) {
        t = safeTicket(ticket);
        if (!t) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid ticket format' }));
          return true;
        }
      }
      const instruction = typeof customInstruction === 'string' ? customInstruction.trim() : '';
      if (instruction.length > 10000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Custom instruction too long (max 10000 chars)' }));
        return true;
      }
      const runId = `pg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      if (_playgroundHandlers && _playgroundHandlers.PLAYGROUND_WIRED_STAGES.has(stage)) {
        const startResult = _playgroundHandlers.startPlaygroundRun({ runId, stage, ticket: t, customInstruction: instruction });
        if (!startResult.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: startResult.error ?? 'Failed to start Playground run' }));
          return true;
        }
        addLog(`[Playground] Started real run ${runId} for stage ${stage}`, 'system');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, runId }));
        return true;
      }

      addLog(`[Playground] Stub run ${runId} for stage ${stage}`, 'system');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, runId }));
      // Broadcast after the response is sent: the client only creates its
      // local run entry once this POST resolves, so events broadcast
      // beforehand would arrive over SSE before that entry exists and get
      // silently dropped. The delay also stands in for real async stage
      // execution, which genuinely takes time.
      setTimeout(() => {
        broadcast('playground:status', { runId, status: 'running', stage, ticket: t });
        broadcast('playground:log', {
          runId,
          level: 'info',
          message: `[PLAYGROUND] Would run stage "${stage}"`
            + (t ? ` with context from ${t}` : '')
            + (instruction ? ` — custom instruction: "${instruction}"` : ' — using default instruction')
            + ' (not yet wired for real execution — stub echo)',
        });
        broadcast('playground:status', { runId, status: 'completed', stage, ticket: t });
      }, 300);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- POST /api/playground/stop --
  if (url.pathname === '/api/playground/stop' && request.method === 'POST') {
    try {
      const raw = await parseBody(request, getBodySizeLimit('/api/playground/stop'));
      const { runId } = sanitizeBody('/api/playground/stop', raw) as { runId?: string };
      if (!runId || typeof runId !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'runId is required' }));
        return true;
      }
      if (!_playgroundHandlers) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No Playground run in progress' }));
        return true;
      }
      const stopResult = _playgroundHandlers.stopPlaygroundRun(runId);
      res.writeHead(stopResult.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stopResult));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- GET /api/playground/runs -- Recent run metadata, optionally filtered --
  // Backs the "validated in Playground" lookup in GateApproval.tsx: given a
  // (ticket, stage) pair, find the most recent completed run.
  if (url.pathname === '/api/playground/runs' && request.method === 'GET') {
    try {
      const runs = listPlaygroundRuns();
      const ticketFilter = url.searchParams.get('ticket');
      const stageFilter = url.searchParams.get('stage');
      const filtered = runs.filter((r) =>
        (!ticketFilter || r.ticket === ticketFilter) && (!stageFilter || r.stage === stageFilter),
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, runs: filtered }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  // -- GET /api/playground/run/:runId -- Single run detail --
  if (url.pathname.startsWith('/api/playground/run/') && request.method === 'GET') {
    const runId = decodeURIComponent(url.pathname.slice('/api/playground/run/'.length));
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid runId format' }));
      return true;
    }
    const run = readPlaygroundRun(runId);
    if (!run) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Run not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, run }));
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
      const rawActive = (d._active_agents as unknown) || [];
      const activeAgents: string[] = Array.isArray(rawActive)
        ? rawActive.map((a: unknown) => (typeof a === 'string' ? a : (a as { name?: string })?.name)).filter((n): n is string => typeof n === 'string')
        : [];
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

  // ── GET /api/gdrive/check — Diagnose Google Drive token + file access ────
  if (url.pathname === '/api/gdrive/check' && request.method === 'GET') {
    try {
      const fileId = url.searchParams.get('fileId');
      let accessToken: string | null = null;
      let tokenEmail: string | null = null;
      let grantedScopes: string | null = null;
      let tokenError: string | null = null;

      // Get token via token-manager
      try {
        const tm = require('../oauth/token-manager') as {
          getAccessToken: (p: string) => Promise<string | null>;
          getMetadataSync: (p: string) => Record<string, unknown> | null;
        };
        accessToken = await tm.getAccessToken('google');
        const meta = tm.getMetadataSync('google');
        tokenEmail = meta?.email as string ?? null;
      } catch (e) {
        tokenError = (e as Error).message;
      }

      const result: Record<string, unknown> = {
        tokenPresent: !!accessToken,
        tokenEmail,
        tokenError,
      };

      if (accessToken) {
        // Check token scopes via Google tokeninfo
        const https = require('https') as typeof import('https');
        const tokenInfo = await new Promise<Record<string, unknown>>((resolve) => {
          https.get(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`, (res) => {
            let d = ''; res.on('data', (c: Buffer) => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
          }).on('error', (e: Error) => resolve({ error: e.message }));
        });
        grantedScopes = tokenInfo.scope as string ?? null;
        result.scopes = grantedScopes;
        result.hasDriveScope = (grantedScopes ?? '').includes('drive.readonly') || (grantedScopes ?? '').includes('drive');
        result.tokenExpiry = tokenInfo.expires_in;
        result.scopeError = tokenInfo.error ?? null;

        // Test file access if fileId provided
        if (fileId) {
          const fileCheck = await new Promise<{ status: number; body: string }>((resolve) => {
            https.get(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType&supportsAllDrives=true`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            }, (res) => {
              let d = ''; res.on('data', (c: Buffer) => d += c);
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
            }).on('error', (e: Error) => resolve({ status: 0, body: e.message }));
          });
          result.fileStatus = fileCheck.status;
          if (fileCheck.status === 200) {
            const fj = JSON.parse(fileCheck.body);
            result.fileName = fj.name;
            result.fileMimeType = fj.mimeType;
            result.fileAccessible = true;
          } else {
            result.fileAccessible = false;
            result.fileError = JSON.parse(fileCheck.body)?.error?.message ?? fileCheck.body.slice(0, 200);
          }
        }
      }

      // Full content fetch if ?fetch=true
      if (url.searchParams.get('fetch') === 'true' && fileId && accessToken) {
        try {
          process.env['GOOGLE_OAUTH_ACCESS_TOKEN'] = accessToken;
          if (tokenEmail) process.env['GOOGLE_OAUTH_ACCOUNT_EMAIL'] = tokenEmail;
          // dev-boot rewriter maps agent/dist → agent/src at runtime
          const gdrive = require('../../../agent/dist/lib/gdrive') as {
            fetchGoogleDoc: (id: string) => Promise<{ ok: boolean; title?: string; content?: string; error?: string }>;
          };
          const fr = await gdrive.fetchGoogleDoc(fileId);
          result.fetchOk = fr.ok;
          result.fetchTitle = fr.title ?? null;
          result.fetchError = fr.error ?? null;
          result.fetchContentLength = fr.content?.length ?? 0;
          result.fetchContentPreview = fr.content?.slice(0, 800) ?? null;
        } catch (fe: unknown) {
          result.fetchError = (fe as Error).message;
          result.fetchOk = false;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    } catch (e: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }));
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
      const rawService = (sanitizeBody('/api/config/test', raw) as { service?: string }).service;
      // Frontend uses connector IDs (e.g. 'google-drive') that don't always
      // match the backend's connector lib filename (e.g. 'gdrive'). Alias here
      // so both forms are accepted and downstream lookups (require lib path,
      // OAuth env-var staging) use the canonical name.
      const SERVICE_ALIASES: Record<string, string> = {
        'google-drive': 'gdrive',
        'claude-design': 'claude-design',
      };
      const service = rawService ? (SERVICE_ALIASES[rawService] ?? rawService) : undefined;
      const allowed = [
        'jira', 'gitlab', 'slack',
        'gdrive', 'figma', 'postman',
        'claude', 'anthropic', 'browser',
        'claude-design',
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
      } else if (service === 'claude-design') {
        const enabled = process.env.CLAUDE_DESIGN_ENABLED;
        if (!enabled || enabled === 'false') {
          result = { ok: false, error: 'CLAUDE_DESIGN_ENABLED is not set to true — enable it in Settings → Connectors → Claude Design' };
        } else {
          result = { ok: true, message: 'Claude Design connector active — will detect claude.ai URLs in Jira tickets' };
        }
      } else {
        // gdrive / figma / postman — load agent lib via relative require.
        // [oauth-connectors Decision 10 follow-up] The connector libs read
        // OAuth tokens from process.env, which works for spawned agent children
        // (env injected at spawn time via setTokenManager) but NOT for in-process
        // callers like this Test button — the backend process never has those
        // env vars set. Pull from token-manager and stage in process.env before
        // calling the lib, so the in-process Test path mirrors the spawn path.
        const OAUTH_ENV_MAP: Record<string, { provider: string; envKey: string }> = {
          gdrive: { provider: 'google', envKey: 'GOOGLE_OAUTH_ACCESS_TOKEN' },
          figma: { provider: 'figma', envKey: 'FIGMA_OAUTH_ACCESS_TOKEN' },
        };
        const oauthMap = OAUTH_ENV_MAP[service];
        if (oauthMap) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const tm = require('../oauth/token-manager') as {
              getAccessToken: (provider: string) => Promise<string | null>;
            };
            const token = await tm.getAccessToken(oauthMap.provider);
            if (token) {
              process.env[oauthMap.envKey] = token;
            } else {
              // Clear any stale env var left behind by a previous test run, so
              // a disconnect-then-test sequence reflects current state instead
              // of resurrecting the last good token.
              delete process.env[oauthMap.envKey];
            }
          } catch { /* token-manager unavailable — fall back to whatever env had */ }
        }
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
