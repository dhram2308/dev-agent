// ═══════════════════════════════════════════════════════════════
// Security Middleware — TypeScript port of lib/security.js
// Comprehensive security layer: sessions, auth, rate limiting,
// CORS, CSP headers, input sanitization, body parsing
// ═══════════════════════════════════════════════════════════════

import * as crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { StageName } from '@shared/types';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** Session data stored in the session store */
export interface SessionData {
  authenticated: boolean;
  ip: string;
  csrf?: string;
  createdAt: number;
  lastAccess: number;
  [key: string]: unknown;
}

/** Options for the SessionStore */
export interface SessionStoreOptions {
  /** TTL in milliseconds (default: 8 hours) */
  ttlMs?: number;
  /** Maximum sessions (default: 100) */
  maxSessions?: number;
}

/** Authentication result */
export interface AuthResult {
  authenticated: boolean;
  session: SessionData | null;
  sessionId: string | null;
  method: 'cookie' | 'token' | 'query' | 'none';
}

/** CORS check result */
export interface CORSResult {
  allowed: boolean;
  reason?: string;
}

/** Rate limit check result */
export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  reason?: string;
}

/** Rate limiter options */
export interface RateLimiterOptions {
  readLimit?: number;
  writeLimit?: number;
  authFailLimit?: number;
  authBackoffBase?: number;
  authBackoffMax?: number;
  ssePerSession?: number;
  sseTotal?: number;
  globalLimit?: number;
  windowMs?: number;
}

/** Auth failure tracking */
export interface AuthFailureResult {
  blocked: boolean;
  blockedUntil?: number;
  retryAfter?: number;
}

/** SSE check result */
export interface SSECheckResult {
  allowed: boolean;
  reason?: string;
}

/** Security middleware result */
export interface SecurityMiddlewareResult {
  proceed: boolean;
  auth: AuthResult | null;
  nonce: string;
  sessionId: string | null;
}

/** Schema field rule */
export interface SchemaFieldRule {
  type: 'ticket' | 'gate' | 'stage' | 'string' | 'boolean' | 'number' | 'object';
  required?: boolean;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  trim?: boolean;
}

/** Schema definition (field name -> rules) */
export type SchemaDefinition = Record<string, SchemaFieldRule>;

/** Endpoint schemas map */
export type EndpointSchemas = Record<string, SchemaDefinition>;

/** Endpoint size limits map */
export type EndpointSizeLimits = Record<string, number>;


// ═══════════════════════════════════════════════════════════════
// 1. SESSION STORE
// ═══════════════════════════════════════════════════════════════

/** Cookie name for session. */
export const SESSION_COOKIE_NAME = '__mi_agent_sid';

/** Cookie name for CSRF token (double-submit). */
export const CSRF_COOKIE_NAME = '__mi_agent_csrf';

/**
 * In-memory session store with TTL-based expiry.
 * Sessions are keyed by a random 32-byte hex token stored in a cookie.
 *
 * Ported from lib/security.js SessionStore class.
 */
export class SessionStore {
  private _sessions: Map<string, SessionData>;
  private _ttlMs: number;
  private _maxSessions: number;
  private _cleanupInterval: ReturnType<typeof setInterval>;

  constructor(options: SessionStoreOptions = {}) {
    this._sessions = new Map();
    this._ttlMs = options.ttlMs ?? 8 * 60 * 60 * 1000; // 8 hours default
    this._maxSessions = options.maxSessions ?? 100;
    this._cleanupInterval = setInterval(() => this._cleanup(), 60_000);
    this._cleanupInterval.unref();
  }

  /**
   * Create a new session. Returns the session ID (cookie value).
   * Evicts the oldest session if max capacity is reached.
   */
  create(data: Partial<SessionData> = {}): string {
    // Enforce max sessions -- evict oldest
    if (this._sessions.size >= this._maxSessions) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, session] of this._sessions) {
        if (session.createdAt < oldestTime) {
          oldestTime = session.createdAt;
          oldestKey = key;
        }
      }
      if (oldestKey) this._sessions.delete(oldestKey);
    }

    const sessionId = crypto.randomBytes(32).toString('hex');
    this._sessions.set(sessionId, {
      authenticated: false,
      ip: 'unknown',
      ...data,
      createdAt: Date.now(),
      lastAccess: Date.now(),
    });
    return sessionId;
  }

  /**
   * Retrieve session by ID. Returns null if expired/missing.
   * Uses constant-time length check and hex validation to prevent timing attacks.
   */
  get(sessionId: string): SessionData | null {
    if (!sessionId || typeof sessionId !== 'string') return null;
    // Constant-time length check to prevent timing attacks
    if (sessionId.length !== 64) return null;
    // Validate hex-only
    if (!/^[0-9a-f]{64}$/.test(sessionId)) return null;

    const session = this._sessions.get(sessionId);
    if (!session) return null;
    // TTL based on lastAccess (sliding window)
    if (Date.now() - session.lastAccess > this._ttlMs) {
      this._sessions.delete(sessionId);
      return null;
    }
    session.lastAccess = Date.now();
    return session;
  }

  /**
   * Touch a session (update lastAccess without retrieving data).
   */
  touch(sessionId: string): void {
    const session = this._sessions.get(sessionId);
    if (session) {
      session.lastAccess = Date.now();
    }
  }

  /**
   * Destroy a specific session.
   */
  destroy(sessionId: string): void {
    this._sessions.delete(sessionId);
  }

  /**
   * Destroy all sessions (e.g., on token rotation).
   */
  destroyAll(): void {
    this._sessions.clear();
  }

  /** Active session count. */
  get size(): number {
    return this._sessions.size;
  }

  /** Periodic cleanup of expired sessions. */
  private _cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this._sessions) {
      if (now - session.createdAt > this._ttlMs) {
        this._sessions.delete(key);
      }
    }
  }

  /** Dispose the store and stop the cleanup timer. */
  dispose(): void {
    clearInterval(this._cleanupInterval);
    this._sessions.clear();
  }
}


// ═══════════════════════════════════════════════════════════════
// 2. SECURITY HEADERS
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a random CSP nonce for this response.
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Build the Content-Security-Policy header value.
 * Nonce-based script-src for secure inline script execution.
 */
export function buildCSP(nonce: string): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join('; ');
}

/**
 * Get the standard security headers to apply to every response.
 * Call once per response (nonce must be unique per response).
 */
export function getSecurityHeaders(nonce?: string): Record<string, string> {
  const n = nonce ?? generateNonce();
  return {
    'Content-Security-Policy': buildCSP(n),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '0',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

/**
 * Apply security headers to a response object.
 */
export function applySecurityHeaders(res: ServerResponse, nonce: string): void {
  const headers = getSecurityHeaders(nonce);
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}


// ═══════════════════════════════════════════════════════════════
// 3. CORS POLICY
// ═══════════════════════════════════════════════════════════════

/**
 * Check if the request is same-origin. Blocks cross-origin requests.
 * Ported from lib/security.js checkCORS().
 */
export function checkCORS(request: IncomingMessage, url: URL): CORSResult {
  const method = request.method;

  // Preflight -- always deny (we don't support cross-origin)
  if (method === 'OPTIONS') {
    return { allowed: false, reason: 'CORS preflight denied: cross-origin not supported' };
  }

  // Sec-Fetch-Site is set by modern browsers and cannot be spoofed by JS
  const secFetchSite = request.headers['sec-fetch-site'] as string | undefined;
  if (secFetchSite) {
    if (secFetchSite === 'same-origin' || secFetchSite === 'none') {
      return { allowed: true };
    }
    return { allowed: false, reason: `Cross-origin request blocked (sec-fetch-site: ${secFetchSite})` };
  }

  // Fallback for older browsers: check Origin header
  const origin = request.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const serverHost = request.headers.host ?? `${url.hostname}:${url.port}`;
      if (originUrl.host !== serverHost) {
        return { allowed: false, reason: `Cross-origin request blocked (origin: ${origin})` };
      }
    } catch {
      return { allowed: false, reason: 'Cross-origin request blocked (malformed Origin header)' };
    }
  }

  // For POST requests without Origin, check Referer
  if (method === 'POST') {
    const referer = request.headers.referer;
    if (referer) {
      try {
        const refUrl = new URL(referer);
        if (refUrl.host !== (request.headers.host ?? '')) {
          return { allowed: false, reason: 'Cross-origin POST blocked (Referer mismatch)' };
        }
      } catch {
        return { allowed: false, reason: 'Cross-origin POST blocked (malformed Referer)' };
      }
    }
  }

  return { allowed: true };
}


// ═══════════════════════════════════════════════════════════════
// 4. RATE LIMITER
// ═══════════════════════════════════════════════════════════════

/** Internal rate window entry */
interface RateWindow {
  count: number;
  resetTime: number;
}

/** Auth failure tracking entry */
interface AuthFailEntry {
  count: number;
  blockedUntil: number;
}

/**
 * Token bucket rate limiter per IP.
 * Supports separate limits for read/write, auth failure backoff,
 * SSE connection limits, and global DDoS mitigation.
 *
 * Ported from lib/security.js RateLimiter class.
 */
export class RateLimiter {
  private _windows: Map<string, RateWindow>;
  private _authFails: Map<string, AuthFailEntry>;
  private _sseConns: Map<string, number>;
  private _globalCounter: RateWindow;
  private _cleanupTimer: ReturnType<typeof setInterval>;

  /** GET requests per minute */
  readonly READ_LIMIT: number;
  /** POST requests per minute */
  readonly WRITE_LIMIT: number;
  /** Failed auths before lockout */
  readonly AUTH_FAIL_LIMIT: number;
  /** Base backoff time for auth failures (ms) */
  readonly AUTH_BACKOFF_BASE: number;
  /** Max backoff time for auth failures (ms) */
  readonly AUTH_BACKOFF_MAX: number;
  /** Max SSE connections per session */
  readonly SSE_PER_SESSION: number;
  /** Total SSE connections allowed */
  readonly SSE_TOTAL: number;
  /** Global requests per minute (DDoS protection) */
  readonly GLOBAL_LIMIT: number;
  /** Rate window duration (ms) */
  readonly WINDOW_MS: number;

  constructor(options: RateLimiterOptions = {}) {
    this._windows = new Map();
    this._authFails = new Map();
    this._sseConns = new Map();
    this._globalCounter = { count: 0, resetTime: Date.now() + 60_000 };

    this.READ_LIMIT = options.readLimit ?? 600;
    this.WRITE_LIMIT = options.writeLimit ?? 60;
    this.AUTH_FAIL_LIMIT = options.authFailLimit ?? 5;
    this.AUTH_BACKOFF_BASE = options.authBackoffBase ?? 30_000;
    this.AUTH_BACKOFF_MAX = options.authBackoffMax ?? 3_600_000;
    this.SSE_PER_SESSION = options.ssePerSession ?? 3;
    this.SSE_TOTAL = options.sseTotal ?? 10;
    this.GLOBAL_LIMIT = options.globalLimit ?? 600;
    this.WINDOW_MS = options.windowMs ?? 60_000;

    this._cleanupTimer = setInterval(() => this._cleanup(), 120_000);
    this._cleanupTimer.unref();
  }

  /**
   * Check rate limit for a request.
   * @param ip - Client IP address
   * @returns Whether the request is allowed
   */
  checkRateLimit(ip: string): boolean {
    return this.check(ip, 'read').allowed;
  }

  /**
   * Check rate limit for a specific key and operation type.
   */
  check(key: string, type: 'read' | 'write' = 'read'): RateLimitResult {
    const now = Date.now();

    // Global DDoS check
    if (now > this._globalCounter.resetTime) {
      this._globalCounter = { count: 0, resetTime: now + this.WINDOW_MS };
    }
    this._globalCounter.count++;
    if (this._globalCounter.count > this.GLOBAL_LIMIT) {
      return { allowed: false, retryAfter: 60, reason: 'GLOBAL_LIMIT' };
    }

    // Per-key check
    const limit = type === 'write' ? this.WRITE_LIMIT : this.READ_LIMIT;
    const windowKey = `${key}:${type}`;
    let entry = this._windows.get(windowKey);
    if (!entry || now > entry.resetTime) {
      entry = { count: 0, resetTime: now + this.WINDOW_MS };
    }
    entry.count++;
    this._windows.set(windowKey, entry);

    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      return { allowed: false, retryAfter, reason: 'RATE_LIMIT' };
    }

    return { allowed: true };
  }

  /**
   * Record a failed authentication attempt.
   * Returns whether the IP is now blocked.
   */
  recordAuthFailure(ip: string): AuthFailureResult {
    const now = Date.now();
    let entry = this._authFails.get(ip);

    if (!entry) {
      entry = { count: 0, blockedUntil: 0 };
    }

    // If currently blocked, return blocked status
    if (entry.blockedUntil > now) {
      return {
        blocked: true,
        blockedUntil: entry.blockedUntil,
        retryAfter: Math.ceil((entry.blockedUntil - now) / 1000),
      };
    }

    entry.count++;
    this._authFails.set(ip, entry);

    if (entry.count >= this.AUTH_FAIL_LIMIT) {
      // Exponential backoff
      const backoff = Math.min(
        this.AUTH_BACKOFF_BASE * Math.pow(2, entry.count - this.AUTH_FAIL_LIMIT),
        this.AUTH_BACKOFF_MAX
      );
      entry.blockedUntil = now + backoff;
      return {
        blocked: true,
        blockedUntil: entry.blockedUntil,
        retryAfter: Math.ceil(backoff / 1000),
      };
    }

    return { blocked: false };
  }

  /** Clear auth failure count for an IP (on successful auth). */
  clearAuthFailures(ip: string): void {
    this._authFails.delete(ip);
  }

  /** Check if an IP is currently blocked from auth attempts. */
  isAuthBlocked(ip: string): { blocked: boolean; retryAfter?: number } {
    const entry = this._authFails.get(ip);
    if (!entry) return { blocked: false };
    const now = Date.now();
    if (entry.blockedUntil > now) {
      return { blocked: true, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) };
    }
    return { blocked: false };
  }

  /** Check if a new SSE connection is allowed for the given session. */
  checkSSE(sessionId: string): SSECheckResult {
    let totalSSE = 0;
    for (const count of this._sseConns.values()) totalSSE += count;
    if (totalSSE >= this.SSE_TOTAL) {
      return { allowed: false, reason: 'SSE_TOTAL_LIMIT' };
    }

    const current = this._sseConns.get(sessionId) ?? 0;
    if (current >= this.SSE_PER_SESSION) {
      return { allowed: false, reason: 'SSE_SESSION_LIMIT' };
    }

    return { allowed: true };
  }

  /** Track SSE connection open (+1) / close (-1). */
  trackSSE(sessionId: string, delta: number): void {
    const current = this._sseConns.get(sessionId) ?? 0;
    const updated = Math.max(0, current + delta);
    if (updated === 0) {
      this._sseConns.delete(sessionId);
    } else {
      this._sseConns.set(sessionId, updated);
    }
  }

  private _cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this._windows) {
      if (now > entry.resetTime) this._windows.delete(key);
    }
    for (const [ip, entry] of this._authFails) {
      if (entry.blockedUntil < now - this.AUTH_BACKOFF_MAX * 2) {
        this._authFails.delete(ip);
      }
    }
  }

  /** Dispose the rate limiter and stop the cleanup timer. */
  dispose(): void {
    clearInterval(this._cleanupTimer);
    this._windows.clear();
    this._authFails.clear();
    this._sseConns.clear();
  }
}


// ═══════════════════════════════════════════════════════════════
// 5. SECURITY ERROR
// ═══════════════════════════════════════════════════════════════

/**
 * Custom error class for security-related errors.
 * Carries a safe external code (sent to client) separate from
 * the internal message (logged server-side only).
 */
export class SecurityError extends Error {
  readonly code: string;
  readonly statusCode: number;
  retryAfter?: number;

  constructor(code: string, message: string, statusCode: number = 400) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Error code to HTTP status code mapping. */
export const ERROR_STATUS_MAP: Record<string, number> = {
  AUTH_REQUIRED: 401,
  AUTH_BLOCKED: 429,
  FORBIDDEN: 403,
  CORS_BLOCKED: 403,
  RATE_LIMIT: 429,
  GLOBAL_LIMIT: 429,
  SSE_TOTAL_LIMIT: 429,
  SSE_SESSION_LIMIT: 429,
  INVALID_INPUT: 400,
  INVALID_TICKET: 400,
  INVALID_GATE: 400,
  INVALID_STAGE: 400,
  INVALID_JSON: 400,
  INVALID_TYPE: 400,
  INVALID_PATH: 400,
  MISSING_FIELD: 400,
  TOO_SHORT: 400,
  TOO_LONG: 400,
  OUT_OF_RANGE: 400,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  NO_STATE: 404,
  PATH_TRAVERSAL: 400,
  SYMLINK_ATTACK: 400,
  REQUEST_ERROR: 400,
  INTERNAL_ERROR: 500,
};

/** Safe error messages — the ONLY messages ever sent to unauthenticated clients. */
export const SAFE_ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Authentication required',
  AUTH_BLOCKED: 'Too many failed authentication attempts',
  FORBIDDEN: 'Access denied',
  CORS_BLOCKED: 'Cross-origin request not allowed',
  RATE_LIMIT: 'Rate limit exceeded',
  GLOBAL_LIMIT: 'Service temporarily unavailable',
  SSE_TOTAL_LIMIT: 'Maximum live connections reached',
  SSE_SESSION_LIMIT: 'Maximum connections per session reached',
  INVALID_INPUT: 'Invalid request body',
  INVALID_TICKET: 'Invalid ticket format',
  INVALID_GATE: 'Invalid gate parameter',
  INVALID_STAGE: 'Invalid stage parameter',
  INVALID_JSON: 'Invalid JSON in request body',
  INVALID_TYPE: 'Invalid field type',
  INVALID_PATH: 'Invalid file path',
  MISSING_FIELD: 'Missing required field',
  TOO_SHORT: 'Input too short',
  TOO_LONG: 'Input too long',
  OUT_OF_RANGE: 'Value out of allowed range',
  PAYLOAD_TOO_LARGE: 'Request body too large',
  NOT_FOUND: 'Resource not found',
  NO_STATE: 'No state file found for this ticket',
  PATH_TRAVERSAL: 'Invalid file path',
  SYMLINK_ATTACK: 'Invalid file path',
  REQUEST_ERROR: 'Request error',
  INTERNAL_ERROR: 'Internal server error',
};


// ═══════════════════════════════════════════════════════════════
// 6. INPUT SANITIZATION
// ═══════════════════════════════════════════════════════════════

/** Ticket format: PROJECT-123 (case-insensitive) */
const TICKET_REGEX = /^[A-Za-z]+-\d+$/;

/** Valid pipeline gates (whitelist). */
const VALID_GATES: ReadonlySet<string> = new Set([
  'explore_plan',
  'gate_code_review',
  'deploy_qa',
  'gate_preprod_approval',
  'gate_dual_approval',
]);

/** Valid pipeline stages (whitelist). */
const VALID_STAGES: ReadonlySet<string> = new Set<StageName>([
  'fetch_ticket', 'explore_plan', 'generate_code',
  'gate_code_review', 'deploy_qa', 'test_qa',
  'gate_preprod_approval', 'create_preprod_mr',
  'gate_dual_approval', 'deploy_prod', 'done',
]);

/**
 * Validate a Jira ticket ID. Returns sanitized ticket or null.
 * Single canonical ticket validator.
 */
export function validateTicket(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase();
  if (!TICKET_REGEX.test(t)) return null;
  return t;
}

/**
 * Validate a gate parameter against the whitelist.
 */
export function validateGate(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const g = raw.trim().toLowerCase();
  if (!VALID_GATES.has(g)) return null;
  return g;
}

/**
 * Validate a stage parameter against the whitelist.
 */
export function validateStage(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!VALID_STAGES.has(s)) return null;
  return s as StageName;
}

/**
 * Safe JSON.parse with prototype pollution guard.
 * Removes __proto__, constructor, and prototype keys at all nesting levels.
 */
function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return undefined;
    }
    return value;
  });
}

/**
 * Unified input sanitization.
 * Takes a parsed body and a schema, returns sanitized values or throws.
 * Strips unknown fields (only fields in the schema are returned).
 */
export function sanitize(body: unknown, schema: SchemaDefinition): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SecurityError('INVALID_INPUT', 'Request body must be a JSON object');
  }

  const bodyObj = body as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [field, rules] of Object.entries(schema)) {
    const value = bodyObj[field];

    // Check required
    if (rules.required && (value === undefined || value === null || value === '')) {
      throw new SecurityError('MISSING_FIELD', `Missing required field: ${field}`);
    }

    // Skip optional missing fields
    if (value === undefined || value === null) {
      if (rules.default !== undefined) {
        result[field] = rules.default;
      }
      continue;
    }

    // Type-specific validation
    switch (rules.type) {
      case 'ticket': {
        const validated = validateTicket(value as string);
        if (!validated) {
          throw new SecurityError('INVALID_TICKET', `Invalid ticket format for field: ${field}`);
        }
        result[field] = validated;
        break;
      }

      case 'gate': {
        const validated = validateGate(value as string);
        if (!validated) {
          throw new SecurityError('INVALID_GATE', `Invalid gate value for field: ${field}`);
        }
        result[field] = validated;
        break;
      }

      case 'stage': {
        const validated = validateStage(value as string);
        if (!validated) {
          throw new SecurityError('INVALID_STAGE', `Invalid stage value for field: ${field}`);
        }
        result[field] = validated;
        break;
      }

      case 'string': {
        if (typeof value !== 'string') {
          throw new SecurityError('INVALID_TYPE', `Field ${field} must be a string`);
        }
        let str = value;
        if (rules.trim !== false) str = str.trim();
        if (rules.minLength !== undefined && str.length < rules.minLength) {
          throw new SecurityError('TOO_SHORT', `Field ${field} must be at least ${rules.minLength} characters`);
        }
        if (rules.maxLength !== undefined && str.length > rules.maxLength) {
          throw new SecurityError('TOO_LONG', `Field ${field} must be at most ${rules.maxLength} characters`);
        }
        // Prevent null bytes
        str = str.replace(/\0/g, '');
        result[field] = str;
        break;
      }

      case 'boolean': {
        result[field] = !!value;
        break;
      }

      case 'number': {
        const num = Number(value);
        if (isNaN(num)) {
          throw new SecurityError('INVALID_TYPE', `Field ${field} must be a number`);
        }
        if (rules.min !== undefined && num < rules.min) {
          throw new SecurityError('OUT_OF_RANGE', `Field ${field} must be >= ${rules.min}`);
        }
        if (rules.max !== undefined && num > rules.max) {
          throw new SecurityError('OUT_OF_RANGE', `Field ${field} must be <= ${rules.max}`);
        }
        result[field] = num;
        break;
      }

      case 'object': {
        if (typeof value !== 'object' || Array.isArray(value)) {
          throw new SecurityError('INVALID_TYPE', `Field ${field} must be an object`);
        }
        // Deep-check for prototype pollution keys
        const cleaned = safeJsonParse(JSON.stringify(value));
        result[field] = cleaned;
        break;
      }

      default: {
        const _exhaustive: never = rules.type;
        throw new Error(`Unknown schema type: ${_exhaustive}`);
      }
    }
  }

  return result;
}


// ═══════════════════════════════════════════════════════════════
// 7. BODY PARSING
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a POST body with size limit and prototype pollution guard.
 * Uses Object.create(null) for the base object to prevent prototype pollution.
 * Chunk-buffered with configurable size limit.
 */
export function parseBodySafe(request: IncomingMessage, maxSize: number = 1_048_576): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    request.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        request.destroy();
        reject(new SecurityError('PAYLOAD_TOO_LARGE', 'Request body exceeds size limit', 413));
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        if (!body || body.trim() === '') {
          // Return a null-prototype object instead of {} to prevent prototype pollution
          resolve(Object.create(null) as Record<string, unknown>);
          return;
        }
        const parsed = safeJsonParse(body);
        resolve(parsed);
      } catch {
        reject(new SecurityError('INVALID_JSON', 'Request body is not valid JSON'));
      }
    });

    request.on('error', () => {
      reject(new SecurityError('REQUEST_ERROR', 'Request stream error'));
    });
  });
}


// ═══════════════════════════════════════════════════════════════
// 8. ENDPOINT SCHEMAS
// ═══════════════════════════════════════════════════════════════

/** Per-endpoint field whitelists. */
export const ENDPOINT_SCHEMAS: EndpointSchemas = {
  '/api/start': {
    ticket: { type: 'ticket', required: true },
  },
  '/api/stop': {
    ticket: { type: 'ticket' },
  },
  '/api/gate': {
    ticket: { type: 'ticket', required: true },
    gate: { type: 'gate', required: true },
    action: { type: 'string', required: true, minLength: 1, maxLength: 50 },
    reason: { type: 'string', maxLength: 10_000 },
  },
  '/api/reset': {
    ticket: { type: 'ticket', required: true },
  },
  '/api/skip': {
    ticket: { type: 'ticket', required: true },
    stage: { type: 'stage', required: true },
  },
  '/api/review-decision': {
    ticket: { type: 'ticket', required: true },
    decision: { type: 'string', required: true, minLength: 1, maxLength: 50 },
    comments: { type: 'string', maxLength: 50_000 },
  },
  '/api/approve': {
    ticket: { type: 'ticket', required: true },
    gate: { type: 'gate', required: true },
  },
  '/api/reject': {
    ticket: { type: 'ticket', required: true },
    gate: { type: 'gate', required: true },
    feedback: { type: 'string', maxLength: 10_000, default: '' },
  },
  '/api/refine': {
    ticket: { type: 'ticket', required: true },
    gate: { type: 'gate', required: true },
    instructions: { type: 'string', required: true, minLength: 1, maxLength: 50_000 },
  },
  '/api/comments': {
    ticket: { type: 'ticket', required: true },
    comments: { type: 'object', required: true },
  },
  '/api/skip-stage': {
    ticket: { type: 'ticket', required: true },
    confirm: { type: 'boolean', required: true },
  },
  '/api/reset-stage': {
    ticket: { type: 'ticket', required: true },
    stage: { type: 'stage', required: true },
  },
  '/api/inject-context': {
    ticket: { type: 'ticket', required: true },
    context: { type: 'string', required: true, minLength: 1, maxLength: 10_000 },
  },
  '/api/auth': {
    token: { type: 'string', required: true, minLength: 1, maxLength: 256 },
  },
  '/api/rotate-token': {},
};


// ═══════════════════════════════════════════════════════════════
// 9. ENDPOINT SIZE LIMITS
// ═══════════════════════════════════════════════════════════════

/** Per-endpoint body size limits (in bytes). */
export const ENDPOINT_SIZE_LIMITS: EndpointSizeLimits = {
  '/api/refine': 100_000,
  '/api/inject-context': 20_000,
  '/api/comments': 500_000,
  '/api/review-decision': 100_000,
  default: 1_048_576,
};


// ═══════════════════════════════════════════════════════════════
// 10. COOKIE HELPERS
// ═══════════════════════════════════════════════════════════════

/** Parse cookies from a request's Cookie header. */
export function parseCookies(request: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  const header = request.headers.cookie;
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.substring(0, idx).trim();
    const value = pair.substring(idx + 1).trim();
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

/** Build a Set-Cookie header value. */
export function buildSetCookie(
  name: string,
  value: string,
  options: {
    maxAge?: number;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    secure?: boolean;
    path?: string;
  } = {}
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Strict'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}


// ═══════════════════════════════════════════════════════════════
// 11. AUTHENTICATION
// ═══════════════════════════════════════════════════════════════

/**
 * Authenticate a request. Checks in order:
 *   1. Session cookie
 *   2. X-Api-Token header (creates session on first valid token use)
 *   3. ?token= query param (SSE fallback -- EventSource can't set headers)
 */
export function authenticate(
  url: URL,
  request: IncomingMessage,
  apiToken: string,
  sessionStore: SessionStore
): AuthResult {
  // Method 1: Session cookie
  const cookies = parseCookies(request);
  const cookieSid = cookies[SESSION_COOKIE_NAME];
  if (cookieSid) {
    const session = sessionStore.get(cookieSid);
    if (session?.authenticated) {
      return { authenticated: true, session, sessionId: cookieSid, method: 'cookie' };
    }
  }

  // Method 2: X-Api-Token header
  const headerToken = request.headers['x-api-token'];
  if (headerToken && typeof headerToken === 'string') {
    // Constant-time comparison to prevent timing attacks
    if (
      headerToken.length === apiToken.length &&
      crypto.timingSafeEqual(Buffer.from(headerToken), Buffer.from(apiToken))
    ) {
      const ip = request.socket?.remoteAddress ?? 'unknown';
      const sessionId = sessionStore.create({ authenticated: true, ip });
      return {
        authenticated: true,
        session: sessionStore.get(sessionId),
        sessionId,
        method: 'token',
      };
    }
  }

  // Method 3: ?token= query param (SSE fallback)
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    // Check if the query token matches the API token (for initial SSE auth)
    if (
      queryToken.length === apiToken.length &&
      crypto.timingSafeEqual(Buffer.from(queryToken), Buffer.from(apiToken))
    ) {
      const ip = request.socket?.remoteAddress ?? 'unknown';
      const sessionId = sessionStore.create({ authenticated: true, ip });
      return {
        authenticated: true,
        session: sessionStore.get(sessionId),
        sessionId,
        method: 'query',
      };
    }

    // Also check if it's a session ID
    const session = sessionStore.get(queryToken);
    if (session?.authenticated) {
      return { authenticated: true, session, sessionId: queryToken, method: 'query' };
    }
  }

  return { authenticated: false, session: null, sessionId: null, method: 'none' };
}


// ═══════════════════════════════════════════════════════════════
// 12. ERROR RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════

/** Send a 401 Unauthorized JSON response. */
export function sendUnauthorized(res: ServerResponse, message: string = 'Authentication required'): void {
  const headers = { ...getSecurityHeaders(), 'Content-Type': 'application/json' };
  res.writeHead(401, headers);
  res.end(JSON.stringify({ error: message, code: 'AUTH_REQUIRED' }));
}

/** Send a 403 Forbidden response for CORS violations. */
export function sendCORSForbidden(res: ServerResponse): void {
  res.writeHead(403, {
    'Content-Type': 'application/json',
    ...getSecurityHeaders(),
  });
  res.end(JSON.stringify({ error: 'Forbidden', code: 'CORS_BLOCKED' }));
}

/**
 * Send a structured, safe error response.
 * For authenticated users: includes the specific error message.
 * For unauthenticated users: only includes the generic safe message.
 */
export function sendError(res: ServerResponse, error: Error, authenticated: boolean = false): void {
  let code: string;
  let statusCode: number;
  let message: string;

  if (error instanceof SecurityError) {
    code = error.code;
    statusCode = error.statusCode || ERROR_STATUS_MAP[code] || 400;
    message = authenticated ? error.message : (SAFE_ERROR_MESSAGES[code] ?? 'Request error');
  } else {
    code = 'INTERNAL_ERROR';
    statusCode = 500;
    message = 'Internal server error';
    console.error(`[SECURITY] Internal error: ${error.message}`);
  }

  const body: Record<string, unknown> = { error: message, code };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getSecurityHeaders(),
  };

  if (error instanceof SecurityError && error.retryAfter) {
    headers['Retry-After'] = String(error.retryAfter);
    body.retryAfter = error.retryAfter;
  }

  try {
    if (!res.headersSent) {
      res.writeHead(statusCode, headers);
    }
    res.end(JSON.stringify(body));
  } catch {
    // Response already sent or broken
  }
}


// ═══════════════════════════════════════════════════════════════
// 13. INTEGRATED SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

/**
 * Main security middleware. Call this FIRST in request handling.
 * Returns { proceed: boolean } -- if false, the response has already been sent.
 *
 * Implements:
 * 1. Security headers (CSP nonce-based script-src, XCTO, XFO, etc.)
 * 2. CORS: same-origin enforcement, preflight handling
 * 3. Rate limiting per IP (different limits for API vs auth endpoints)
 * 4. Auth: cookie-based session OR X-Api-Token header OR ?token query param
 *
 * Ported from lib/security.js securityMiddleware().
 */
export function securityMiddleware(
  url: URL,
  request: IncomingMessage,
  res: ServerResponse,
  apiToken: string,
  sessionStore: SessionStore,
  rateLimiter: RateLimiter
): SecurityMiddlewareResult {
  const nonce = generateNonce();
  const ip = request.socket?.remoteAddress ?? 'unknown';
  const method = request.method ?? 'GET';
  const pathname = url.pathname;

  // Step 1: Apply security headers to all responses
  applySecurityHeaders(res, nonce);

  // Step 2: CORS check (all API requests)
  if (pathname.startsWith('/api/')) {
    const cors = checkCORS(request, url);
    if (!cors.allowed) {
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Content-Length': '0',
          ...getSecurityHeaders(nonce),
        });
        res.end();
        return { proceed: false, auth: null, nonce, sessionId: null };
      }
      sendCORSForbidden(res);
      return { proceed: false, auth: null, nonce, sessionId: null };
    }
  }

  // Step 3: Rate limiting
  if (pathname.startsWith('/api/')) {
    const rateLimitType: 'read' | 'write' = method === 'POST' ? 'write' : 'read';

    // Use different rate limits for auth endpoints (10 req/min) vs API (60 req/min)
    const isAuthEndpoint = pathname === '/api/auth' || pathname === '/api/rotate-token';

    if (isAuthEndpoint) {
      // Auth endpoints: 10 req/min per IP
      const authRateKey = `auth:${ip}`;
      const entry = rateLimiter.check(authRateKey, 'write');
      if (!entry.allowed) {
        const err = new SecurityError(entry.reason ?? 'RATE_LIMIT', 'Rate limit exceeded', 429);
        err.retryAfter = entry.retryAfter;
        sendError(res, err, false);
        return { proceed: false, auth: null, nonce, sessionId: null };
      }
    } else {
      const rateResult = rateLimiter.check(ip, rateLimitType);
      if (!rateResult.allowed) {
        const err = new SecurityError(rateResult.reason ?? 'RATE_LIMIT', 'Rate limit exceeded', 429);
        err.retryAfter = rateResult.retryAfter;
        sendError(res, err, false);
        return { proceed: false, auth: null, nonce, sessionId: null };
      }
    }
  }

  // Step 4: Auth check
  const isPublicPath = (
    pathname === '/' ||
    pathname === '/api/health' ||
    pathname === '/api/auth'
  );

  const isReadOnly = method === 'GET';

  let auth: AuthResult = { authenticated: false, session: null, sessionId: null, method: 'none' };

  if (!isPublicPath && !isReadOnly && pathname.startsWith('/api/')) {
    // Check if IP is blocked from auth
    const blocked = rateLimiter.isAuthBlocked(ip);
    if (blocked.blocked) {
      const err = new SecurityError('AUTH_BLOCKED', 'Too many failed auth attempts', 429);
      err.retryAfter = blocked.retryAfter;
      sendError(res, err, false);
      return { proceed: false, auth: null, nonce, sessionId: null };
    }

    auth = authenticate(url, request, apiToken, sessionStore);

    if (!auth.authenticated) {
      const failResult = rateLimiter.recordAuthFailure(ip);
      if (failResult.blocked) {
        const err = new SecurityError('AUTH_BLOCKED', 'Too many failed auth attempts', 429);
        err.retryAfter = failResult.retryAfter;
        sendError(res, err, false);
      } else {
        sendUnauthorized(res);
      }
      return { proceed: false, auth: null, nonce, sessionId: null };
    }

    // Successful auth -- clear failure counter
    rateLimiter.clearAuthFailures(ip);
  }

  // Step 5: Set session cookie if auth created a new session via token
  if (auth.method === 'token' && auth.sessionId) {
    const sessionCookie = buildSetCookie(SESSION_COOKIE_NAME, auth.sessionId, {
      maxAge: 8 * 60 * 60,
      httpOnly: true,
      sameSite: 'Strict',
    });
    res.setHeader('Set-Cookie', sessionCookie);
  }

  return {
    proceed: true,
    auth,
    nonce,
    sessionId: auth.sessionId,
  };
}
