/**
 * security.ts — Comprehensive Security Layer for MI Dev Agent
 *
 * Converted from lib/security.js (zero functional changes).
 *
 * Covers all 18 identified vulnerabilities:
 *   1.  Auth middleware (cookie-based sessions, SSE query param fallback)
 *   2.  Input sanitization (unified schema-based validation)
 *   3.  Security headers (CSP, Cache-Control, HSTS, etc.)
 *   4.  CORS policy (same-origin enforcement)
 *   5.  Token management (persistent, rotatable, nonce-injected)
 *   6.  Redaction engine (complete regex set)
 *   7.  File security (atomic ops, symlink prevention, permissions)
 *   8.  Rate limiting (per-session, auth backoff, SSE limits)
 *   9.  Secure error responses (structured codes, no internal leaks)
 *
 * Zero external dependencies. Works with raw http.createServer.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

import type * as http from "http";

// ═══════════════════════════════════════════════════════════════════
// 1. SESSION & AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════

interface SessionData {
  authenticated?: boolean;
  createdAt?: number;
  lastAccess?: number;
  ip?: string;
  csrf?: string;
  [key: string]: any;
}

interface SessionStoreOptions {
  ttlMs?: number;
  maxSessions?: number;
}

/**
 * In-memory session store with TTL-based expiry.
 * Sessions are keyed by a random 32-byte hex token stored in a cookie.
 */
class SessionStore {
  private _sessions: Map<string, SessionData>;
  private _ttlMs: number;
  private _maxSessions: number;
  private _cleanupInterval: ReturnType<typeof setInterval>;

  constructor(options: SessionStoreOptions = {}) {
    this._sessions = new Map();
    this._ttlMs = options.ttlMs || 8 * 60 * 60 * 1000; // 8 hours default
    this._maxSessions = options.maxSessions || 100;
    this._cleanupInterval = setInterval(() => this._cleanup(), 60_000);
    this._cleanupInterval.unref();
  }

  /**
   * Create a new session. Returns the session ID (cookie value).
   */
  create(data: SessionData = {}): string {
    // Enforce max sessions — evict oldest
    if (this._sessions.size >= this._maxSessions) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, session] of this._sessions) {
        if ((session.createdAt || 0) < oldestTime) {
          oldestTime = session.createdAt || 0;
          oldestKey = key;
        }
      }
      if (oldestKey) this._sessions.delete(oldestKey);
    }

    const sessionId = crypto.randomBytes(32).toString("hex");
    this._sessions.set(sessionId, {
      ...data,
      createdAt: Date.now(),
      lastAccess: Date.now(),
    });
    return sessionId;
  }

  /**
   * Retrieve session by ID. Returns null if expired/missing.
   */
  get(sessionId: string): SessionData | null {
    if (!sessionId || typeof sessionId !== "string") return null;
    // Constant-time length check to prevent timing attacks
    if (sessionId.length !== 64) return null;
    // Validate hex-only
    if (!/^[0-9a-f]{64}$/.test(sessionId)) return null;

    const session = this._sessions.get(sessionId);
    if (!session) return null;
    // TTL based on lastAccess (sliding window) — not createdAt (fixed window)
    if (Date.now() - (session.lastAccess || 0) > this._ttlMs) {
      this._sessions.delete(sessionId);
      return null;
    }
    session.lastAccess = Date.now();
    return session;
  }

  /** Destroy a specific session. */
  destroy(sessionId: string): void {
    this._sessions.delete(sessionId);
  }

  /** Destroy all sessions (e.g., on token rotation). */
  destroyAll(): void {
    this._sessions.clear();
  }

  /** Active session count. */
  get size(): number { return this._sessions.size; }

  private _cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this._sessions) {
      if (now - (session.createdAt || 0) > this._ttlMs) {
        this._sessions.delete(key);
      }
    }
  }

  dispose(): void {
    clearInterval(this._cleanupInterval);
    this._sessions.clear();
  }
}

// Singleton session store
const sessionStore = new SessionStore();

/** Cookie name for session. */
const SESSION_COOKIE_NAME = "__mi_agent_sid";

/** Cookie name for CSRF token (double-submit). */
const CSRF_COOKIE_NAME = "__mi_agent_csrf";

/**
 * Parse cookies from a request's Cookie header.
 */
function parseCookies(request: http.IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  const header = request.headers.cookie;
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.substring(0, idx).trim();
    const value = pair.substring(idx + 1).trim();
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  sameSite?: string;
  secure?: boolean;
  path?: string;
}

/**
 * Build a Set-Cookie header value.
 */
function buildSetCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${options.sameSite || "Strict"}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

interface AuthResult {
  authenticated: boolean;
  session: SessionData | null;
  sessionId: string | null;
  method: string;
}

/**
 * Authenticate a request.
 */
function authenticate(url: URL, request: http.IncomingMessage, apiToken: string): AuthResult {
  // Method 1: Session cookie
  const cookies = parseCookies(request);
  const cookieSid = cookies[SESSION_COOKIE_NAME];
  if (cookieSid) {
    const session = sessionStore.get(cookieSid);
    if (session && session.authenticated) {
      return { authenticated: true, session, sessionId: cookieSid, method: "cookie" };
    }
  }

  // Method 2: X-Api-Token header
  const headerToken = request.headers["x-api-token"];
  if (headerToken && typeof headerToken === "string") {
    if (headerToken.length === apiToken.length &&
        crypto.timingSafeEqual(Buffer.from(headerToken), Buffer.from(apiToken))) {
      const ip = (request.socket as any).remoteAddress || "unknown";
      const sessionId = sessionStore.create({ authenticated: true, ip });
      return { authenticated: true, session: sessionStore.get(sessionId), sessionId, method: "token" };
    }
  }

  // Method 3: ?session= query param (SSE fallback)
  const querySid = url.searchParams.get("session");
  if (querySid) {
    const session = sessionStore.get(querySid);
    if (session && session.authenticated) {
      return { authenticated: true, session, sessionId: querySid, method: "query" };
    }
  }

  return { authenticated: false, session: null, sessionId: null, method: "none" };
}

/**
 * Send a 401 Unauthorized JSON response.
 */
function sendUnauthorized(res: http.ServerResponse, message: string = "Authentication required"): void {
  const headers = { ...getSecurityHeaders(), "Content-Type": "application/json" };
  res.writeHead(401, headers);
  res.end(JSON.stringify({ error: message, code: "AUTH_REQUIRED" }));
}

/**
 * Create a session for a valid token and set the cookie on the response.
 */
function createAuthSession(request: http.IncomingMessage, res: http.ServerResponse, _apiToken: string): { ok: boolean; sessionId?: string; csrf?: string } {
  const ip = (request.socket as any).remoteAddress || "unknown";
  const sessionId = sessionStore.create({ authenticated: true, ip });
  const csrf = crypto.randomBytes(24).toString("hex");

  const session = sessionStore.get(sessionId);
  if (session) session.csrf = csrf;

  const sessionCookie = buildSetCookie(SESSION_COOKIE_NAME, sessionId, {
    maxAge: 8 * 60 * 60,
    httpOnly: true,
    sameSite: "Strict",
  });

  const csrfCookie = buildSetCookie(CSRF_COOKIE_NAME, csrf, {
    maxAge: 8 * 60 * 60,
    httpOnly: false,
    sameSite: "Strict",
  });

  res.setHeader("Set-Cookie", [sessionCookie, csrfCookie]);

  return { ok: true, sessionId, csrf };
}


// ═══════════════════════════════════════════════════════════════════
// 2. INPUT SANITIZATION LAYER
// ═══════════════════════════════════════════════════════════════════

/** Valid pipeline stages (whitelist for gate parameter). */
const VALID_GATES = new Set([
  "explore_plan",
  "gate_code_review",
  "deploy_qa",
  "gate_preprod_approval",
  "gate_dual_approval",
]);

/** Valid stages for reset-stage. */
const VALID_STAGES = new Set([
  "fetch_ticket", "explore_plan", "generate_code",
  "gate_code_review", "deploy_qa", "test_qa",
  "gate_preprod_approval", "create_preprod_mr",
  "gate_dual_approval", "deploy_prod", "done",
]);

/** Ticket format: PROJECT-123 */
const TICKET_REGEX = /^[A-Z]{1,10}-\d{1,6}$/;

/**
 * Validate a Jira ticket ID. Returns sanitized ticket or null.
 */
function validateTicket(raw: any): string | null {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  if (!TICKET_REGEX.test(t)) return null;
  return t;
}

/**
 * Validate a gate parameter against the whitelist.
 */
function validateGate(raw: any): string | null {
  if (!raw || typeof raw !== "string") return null;
  const g = raw.trim().toLowerCase();
  if (!VALID_GATES.has(g)) return null;
  return g;
}

/**
 * Validate a stage parameter against the whitelist.
 */
function validateStage(raw: any): string | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!VALID_STAGES.has(s)) return null;
  return s;
}

/**
 * Safe JSON.parse with prototype pollution guard.
 */
function safeJsonParse(text: string): any {
  return JSON.parse(text, (key, value) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return undefined;
    }
    return value;
  });
}

/**
 * Parse a POST body with size limit and prototype pollution guard.
 */
function parseBodySafe(request: http.IncomingMessage, maxSize: number = 1_048_576): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    request.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        request.destroy();
        reject(new SecurityError("PAYLOAD_TOO_LARGE", "Request body exceeds size limit"));
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        if (!body || body.trim() === "") {
          resolve({});
          return;
        }
        resolve(safeJsonParse(body));
      } catch (e) {
        reject(new SecurityError("INVALID_JSON", "Request body is not valid JSON"));
      }
    });

    request.on("error", (e) => {
      reject(new SecurityError("REQUEST_ERROR", "Request stream error"));
    });
  });
}

interface SanitizationRule {
  type: string;
  required?: boolean;
  default?: any;
  maxLength?: number;
  minLength?: number;
  min?: number;
  max?: number;
  trim?: boolean;
}

/**
 * Unified input validation.
 */
function sanitize(body: any, schema: Record<string, SanitizationRule>): Record<string, any> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SecurityError("INVALID_INPUT", "Request body must be a JSON object");
  }

  const result: Record<string, any> = {};

  for (const [field, rules] of Object.entries(schema)) {
    const value = body[field];

    if (rules.required && (value === undefined || value === null || value === "")) {
      throw new SecurityError("MISSING_FIELD", `Missing required field: ${field}`);
    }

    if (value === undefined || value === null) {
      if (rules.default !== undefined) {
        result[field] = rules.default;
      }
      continue;
    }

    switch (rules.type) {
      case "ticket": {
        const validated = validateTicket(value);
        if (!validated) {
          throw new SecurityError("INVALID_TICKET", `Invalid ticket format for field: ${field}`);
        }
        result[field] = validated;
        break;
      }

      case "gate": {
        const validated = validateGate(value);
        if (!validated) {
          throw new SecurityError("INVALID_GATE", `Invalid gate value for field: ${field}`);
        }
        result[field] = validated;
        break;
      }

      case "stage": {
        const validated = validateStage(value);
        if (!validated) {
          throw new SecurityError("INVALID_STAGE", `Invalid stage value for field: ${field}`);
        }
        result[field] = validated;
        break;
      }

      case "string": {
        if (typeof value !== "string") {
          throw new SecurityError("INVALID_TYPE", `Field ${field} must be a string`);
        }
        let str = value;
        if (rules.trim !== false) str = str.trim();
        if (rules.minLength && str.length < rules.minLength) {
          throw new SecurityError("TOO_SHORT", `Field ${field} must be at least ${rules.minLength} characters`);
        }
        if (rules.maxLength && str.length > rules.maxLength) {
          throw new SecurityError("TOO_LONG", `Field ${field} must be at most ${rules.maxLength} characters`);
        }
        str = str.replace(/\0/g, "");
        result[field] = str;
        break;
      }

      case "boolean": {
        result[field] = !!value;
        break;
      }

      case "number": {
        const num = Number(value);
        if (isNaN(num)) {
          throw new SecurityError("INVALID_TYPE", `Field ${field} must be a number`);
        }
        if (rules.min !== undefined && num < rules.min) {
          throw new SecurityError("OUT_OF_RANGE", `Field ${field} must be >= ${rules.min}`);
        }
        if (rules.max !== undefined && num > rules.max) {
          throw new SecurityError("OUT_OF_RANGE", `Field ${field} must be <= ${rules.max}`);
        }
        result[field] = num;
        break;
      }

      case "object": {
        if (typeof value !== "object" || Array.isArray(value)) {
          throw new SecurityError("INVALID_TYPE", `Field ${field} must be an object`);
        }
        const cleaned = safeJsonParse(JSON.stringify(value));
        result[field] = cleaned;
        break;
      }

      default:
        throw new Error(`Unknown schema type: ${rules.type}`);
    }
  }

  return result;
}

/**
 * Validate a file path to prevent path traversal attacks.
 */
function safePath(basedir: string, filename: string): string {
  if (!filename || typeof filename !== "string") {
    throw new SecurityError("INVALID_PATH", "Filename is required");
  }
  const clean = filename.replace(/\0/g, "");
  const resolved = path.resolve(basedir, clean);
  if (!resolved.startsWith(path.resolve(basedir) + path.sep) && resolved !== path.resolve(basedir)) {
    throw new SecurityError("PATH_TRAVERSAL", "Path traversal attempt detected");
  }
  return resolved;
}


// ═══════════════════════════════════════════════════════════════════
// 3. SECURITY HEADERS
// ═══════════════════════════════════════════════════════════════════

function generateNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

function buildCSP(_nonce: string): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `img-src 'self' data:`,
    `font-src 'self' https://fonts.gstatic.com`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join("; ");
}

function getSecurityHeaders(options: { nonce?: string } = {}): Record<string, string> {
  const nonce = options.nonce || generateNonce();
  return {
    "Content-Security-Policy": buildCSP(nonce),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "0",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "Pragma": "no-cache",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

function applySecurityHeaders(res: http.ServerResponse, nonce: string): void {
  const headers = getSecurityHeaders({ nonce });
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}


// ═══════════════════════════════════════════════════════════════════
// 4. CORS POLICY
// ═══════════════════════════════════════════════════════════════════

function checkCORS(request: http.IncomingMessage, url: URL): { allowed: boolean; reason?: string } {
  const method = request.method;

  if (method === "OPTIONS") {
    return { allowed: false, reason: "CORS preflight denied: cross-origin not supported" };
  }

  const secFetchSite = request.headers["sec-fetch-site"];
  if (secFetchSite) {
    if (secFetchSite === "same-origin" || secFetchSite === "none") {
      return { allowed: true };
    }
    return { allowed: false, reason: `Cross-origin request blocked (sec-fetch-site: ${secFetchSite})` };
  }

  const origin = request.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const serverHost = request.headers.host || `${url.hostname}:${url.port}`;
      const expectedOrigin = `${url.protocol}//${serverHost}`;
      if (origin !== expectedOrigin && originUrl.host !== (request.headers.host || "")) {
        return { allowed: false, reason: `Cross-origin request blocked (origin: ${origin})` };
      }
    } catch {
      return { allowed: false, reason: "Cross-origin request blocked (malformed Origin header)" };
    }
  }

  if (method === "POST") {
    const referer = request.headers.referer;
    if (referer) {
      try {
        const refUrl = new URL(referer);
        if (refUrl.host !== (request.headers.host || "")) {
          return { allowed: false, reason: "Cross-origin POST blocked (Referer mismatch)" };
        }
      } catch {
        return { allowed: false, reason: "Cross-origin POST blocked (malformed Referer)" };
      }
    }
  }

  return { allowed: true };
}

function sendCORSForbidden(res: http.ServerResponse, _reason?: string): void {
  res.writeHead(403, {
    "Content-Type": "application/json",
    ...getSecurityHeaders(),
  });
  res.end(JSON.stringify({ error: "Forbidden", code: "CORS_BLOCKED" }));
}


// ═══════════════════════════════════════════════════════════════════
// 5. TOKEN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

const TOKEN_FILE = path.join(__dirname, "..", ".api-token");
const TOKEN_BYTES = 32;

function loadOrCreateToken(): { token: string; created: boolean } {
  try {
    const stat = fs.statSync(TOKEN_FILE);
    if (stat.mode & 0o044) {
      console.warn("[SECURITY] .api-token is readable by other users! Run: chmod 600 .api-token");
    }
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing.length >= 48) {
      return { token: existing, created: false };
    }
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      console.warn(`[SECURITY] Failed to read .api-token: ${e.message}`);
    }
  }

  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  try {
    atomicWriteFile(TOKEN_FILE, token, { mode: 0o600 });
  } catch (e: any) {
    console.error(`[SECURITY] Failed to write .api-token: ${e.message}`);
  }
  return { token, created: true };
}

function rotateToken(): string {
  const newToken = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  try {
    atomicWriteFile(TOKEN_FILE, newToken, { mode: 0o600 });
  } catch (e: any) {
    console.error(`[SECURITY] Token rotation write failed: ${e.message}`);
  }
  sessionStore.destroyAll();
  return newToken;
}

function safeTokenInjection(token: string, nonce: string): string {
  const safeToken = JSON.stringify(token)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return `<script nonce="${nonce}">window.__MI_TOKEN=${safeToken};</script>`;
}


// ═══════════════════════════════════════════════════════════════════
// 6. REDACTION ENGINE
// ═══════════════════════════════════════════════════════════════════

function redactSecrets(text: any): any {
  if (typeof text !== "string") return text;

  return text
    .replace(/ATATT3x[A-Za-z0-9+/=_-]{20,}/g, "[JIRA_TOKEN_REDACTED]")
    .replace(/glpat-[A-Za-z0-9_-]{20,}/g, "[GITLAB_TOKEN_REDACTED]")
    .replace(/gldt-[A-Za-z0-9_-]{20,}/g, "[GITLAB_DEPLOY_TOKEN_REDACTED]")
    .replace(/ghp_[A-Za-z0-9]{36,}/g, "[GITHUB_PAT_REDACTED]")
    .replace(/gho_[A-Za-z0-9]{36,}/g, "[GITHUB_OAUTH_REDACTED]")
    .replace(/ghu_[A-Za-z0-9]{36,}/g, "[GITHUB_USER_REDACTED]")
    .replace(/ghs_[A-Za-z0-9]{36,}/g, "[GITHUB_SERVER_REDACTED]")
    .replace(/ghr_[A-Za-z0-9]{36,}/g, "[GITHUB_REFRESH_REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{36,}/g, "[GITHUB_FINE_PAT_REDACTED]")
    .replace(/xoxb-[A-Za-z0-9\-]{20,}/g, "[SLACK_BOT_REDACTED]")
    .replace(/xoxp-[A-Za-z0-9\-]{20,}/g, "[SLACK_USER_REDACTED]")
    .replace(/xoxa-[A-Za-z0-9\-]{20,}/g, "[SLACK_APP_REDACTED]")
    .replace(/xoxr-[A-Za-z0-9\-]{20,}/g, "[SLACK_REFRESH_REDACTED]")
    .replace(/xoxs-[A-Za-z0-9\-]{20,}/g, "[SLACK_SESSION_REDACTED]")
    .replace(/sk-ant-api03-[A-Za-z0-9_-]{80,}/g, "[ANTHROPIC_KEY_REDACTED]")
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[ANTHROPIC_KEY_REDACTED]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[API_KEY_REDACTED]")
    .replace(/AKIA[A-Z0-9]{16}/g, "[AWS_ACCESS_KEY_REDACTED]")
    .replace(/ASIA[A-Z0-9]{16}/g, "[AWS_TEMP_KEY_REDACTED]")
    .replace(/(aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9+/=]{40}/gi, "$1[AWS_SECRET_REDACTED]")
    .replace(/-----BEGIN\s+(RSA|DSA|EC|OPENSSH|PGP)\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+\1\s+PRIVATE\s+KEY-----/g,
      "[SSH_PRIVATE_KEY_REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/g, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/=]{10,}/g, "Basic [REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      "[JWT_REDACTED]")
    .replace(/((?:secret|token|key|password|apikey|api_key|auth)\s*[=:]\s*["']?)[0-9a-f]{64,}/gi,
      "$1[HEX_SECRET_REDACTED]")
    .replace(/:\/\/[^:]+:[^@]+@/g, "://[CREDENTIALS_REDACTED]@")
    .replace(/sk_live_[A-Za-z0-9]{20,}/g, "[STRIPE_SECRET_REDACTED]")
    .replace(/pk_live_[A-Za-z0-9]{20,}/g, "[STRIPE_PUBLIC_REDACTED]")
    .replace(/rk_live_[A-Za-z0-9]{20,}/g, "[STRIPE_RESTRICTED_REDACTED]")
    .replace(/SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, "[SENDGRID_KEY_REDACTED]")
    .replace(/SK[0-9a-f]{32}/g, "[TWILIO_KEY_REDACTED]");
}

function redactObject(obj: any): any {
  if (typeof obj === "string") return redactSecrets(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj && typeof obj === "object") {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase();
      if (keyLower.includes("token") || keyLower.includes("secret") ||
          keyLower.includes("password") || keyLower.includes("apikey") ||
          keyLower.includes("credential") || keyLower === "auth") {
        if (typeof value === "string" && value.length > 0) {
          result[key] = "[REDACTED]";
          continue;
        }
      }
      result[key] = redactObject(value);
    }
    return result;
  }
  return obj;
}


// ═══════════════════════════════════════════════════════════════════
// 7. FILE SECURITY
// ═══════════════════════════════════════════════════════════════════

function atomicWriteFile(filepath: string, data: string | Buffer, options: { mode?: number } = {}): void {
  const mode = options.mode || 0o600;
  const dir = path.dirname(filepath);
  const tmpFile = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}`);

  try {
    try {
      const lstat = fs.lstatSync(filepath);
      if (lstat.isSymbolicLink()) {
        throw new SecurityError("SYMLINK_ATTACK", `Refusing to write to symlink: ${filepath}`);
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        if (e instanceof SecurityError) throw e;
      }
    }

    const fd = fs.openSync(tmpFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    try {
      fs.writeSync(fd, data as any);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmpFile, filepath);
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw e;
  }
}

function safeUnlink(filepath: string): boolean {
  try {
    const lstat = fs.lstatSync(filepath);
    if (lstat.isSymbolicLink()) {
      throw new SecurityError("SYMLINK_ATTACK", `Refusing to delete symlink: ${filepath}`);
    }
    fs.unlinkSync(filepath);
    return true;
  } catch (e: any) {
    if (e.code === "ENOENT") return false;
    if (e instanceof SecurityError) throw e;
    throw e;
  }
}

function safeReadFile(filepath: string): string | null {
  try {
    const lstat = fs.lstatSync(filepath);
    if (lstat.isSymbolicLink()) {
      throw new SecurityError("SYMLINK_ATTACK", `Refusing to read symlink: ${filepath}`);
    }
    return fs.readFileSync(filepath, "utf8");
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    if (e instanceof SecurityError) throw e;
    throw e;
  }
}

function setFilePermissions(filepath: string, mode: number = 0o600): void {
  try {
    fs.chmodSync(filepath, mode);
  } catch (e: any) {
    console.warn(`[SECURITY] Could not set permissions on ${filepath}: ${e.message}`);
  }
}


// ═══════════════════════════════════════════════════════════════════
// 8. RATE LIMITING (Enhanced)
// ═══════════════════════════════════════════════════════════════════

interface RateLimiterOptions {
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

interface RateWindow {
  count: number;
  resetTime: number;
}

interface AuthFailEntry {
  count: number;
  blockedUntil: number;
}

class RateLimiter {
  private _windows: Map<string, RateWindow>;
  private _authFails: Map<string, AuthFailEntry>;
  private _sseConns: Map<string, number>;
  private _globalCounter: RateWindow;
  private _cleanupTimer: ReturnType<typeof setInterval>;

  READ_LIMIT: number;
  WRITE_LIMIT: number;
  AUTH_FAIL_LIMIT: number;
  AUTH_BACKOFF_BASE: number;
  AUTH_BACKOFF_MAX: number;
  SSE_PER_SESSION: number;
  SSE_TOTAL: number;
  GLOBAL_LIMIT: number;
  WINDOW_MS: number;

  constructor(options: RateLimiterOptions = {}) {
    this._windows = new Map();
    this._authFails = new Map();
    this._sseConns = new Map();
    this._globalCounter = { count: 0, resetTime: Date.now() + 60_000 };

    this.READ_LIMIT = options.readLimit || 600;
    this.WRITE_LIMIT = options.writeLimit || 60;
    this.AUTH_FAIL_LIMIT = options.authFailLimit || 5;
    this.AUTH_BACKOFF_BASE = options.authBackoffBase || 30_000;
    this.AUTH_BACKOFF_MAX = options.authBackoffMax || 3_600_000;
    this.SSE_PER_SESSION = options.ssePerSession || 3;
    this.SSE_TOTAL = options.sseTotal || 10;
    this.GLOBAL_LIMIT = options.globalLimit || 600;
    this.WINDOW_MS = options.windowMs || 60_000;

    this._cleanupTimer = setInterval(() => this._cleanup(), 120_000);
    this._cleanupTimer.unref();
  }

  check(key: string, type: "read" | "write" = "read"): { allowed: boolean; retryAfter?: number; reason?: string } {
    const now = Date.now();

    if (now > this._globalCounter.resetTime) {
      this._globalCounter = { count: 0, resetTime: now + this.WINDOW_MS };
    }
    this._globalCounter.count++;
    if (this._globalCounter.count > this.GLOBAL_LIMIT) {
      return { allowed: false, retryAfter: 60, reason: "GLOBAL_LIMIT" };
    }

    const limit = type === "write" ? this.WRITE_LIMIT : this.READ_LIMIT;
    const windowKey = `${key}:${type}`;
    let entry = this._windows.get(windowKey);
    if (!entry || now > entry.resetTime) {
      entry = { count: 0, resetTime: now + this.WINDOW_MS };
    }
    entry.count++;
    this._windows.set(windowKey, entry);

    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      return { allowed: false, retryAfter, reason: "RATE_LIMIT" };
    }

    return { allowed: true };
  }

  recordAuthFailure(ip: string): { blocked: boolean; blockedUntil?: number; retryAfter?: number } {
    const now = Date.now();
    let entry = this._authFails.get(ip);

    if (!entry) {
      entry = { count: 0, blockedUntil: 0 };
    }

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

  clearAuthFailures(ip: string): void {
    this._authFails.delete(ip);
  }

  isAuthBlocked(ip: string): { blocked: boolean; retryAfter?: number } {
    const entry = this._authFails.get(ip);
    if (!entry) return { blocked: false };
    const now = Date.now();
    if (entry.blockedUntil > now) {
      return { blocked: true, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) };
    }
    return { blocked: false };
  }

  checkSSE(sessionId: string): { allowed: boolean; reason?: string } {
    let totalSSE = 0;
    for (const count of this._sseConns.values()) totalSSE += count;
    if (totalSSE >= this.SSE_TOTAL) {
      return { allowed: false, reason: "SSE_TOTAL_LIMIT" };
    }

    const current = this._sseConns.get(sessionId) || 0;
    if (current >= this.SSE_PER_SESSION) {
      return { allowed: false, reason: "SSE_SESSION_LIMIT" };
    }

    return { allowed: true };
  }

  trackSSE(sessionId: string, delta: number): void {
    const current = this._sseConns.get(sessionId) || 0;
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

  dispose(): void {
    clearInterval(this._cleanupTimer);
    this._windows.clear();
    this._authFails.clear();
    this._sseConns.clear();
  }
}

// Singleton rate limiter
const rateLimiter = new RateLimiter();


// ═══════════════════════════════════════════════════════════════════
// 9. SECURE ERROR RESPONSES
// ═══════════════════════════════════════════════════════════════════

class SecurityError extends Error {
  code: string;
  statusCode: number;
  retryAfter?: number;

  constructor(code: string, message: string, statusCode: number = 400) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const ERROR_STATUS_MAP: Record<string, number> = {
  AUTH_REQUIRED:      401,
  AUTH_BLOCKED:       429,
  FORBIDDEN:          403,
  CORS_BLOCKED:       403,
  RATE_LIMIT:         429,
  GLOBAL_LIMIT:       429,
  SSE_TOTAL_LIMIT:    429,
  SSE_SESSION_LIMIT:  429,
  INVALID_INPUT:      400,
  INVALID_TICKET:     400,
  INVALID_GATE:       400,
  INVALID_STAGE:      400,
  INVALID_JSON:       400,
  INVALID_TYPE:       400,
  INVALID_PATH:       400,
  MISSING_FIELD:      400,
  TOO_SHORT:          400,
  TOO_LONG:           400,
  OUT_OF_RANGE:       400,
  PAYLOAD_TOO_LARGE:  413,
  NOT_FOUND:          404,
  NO_STATE:           404,
  PATH_TRAVERSAL:     400,
  SYMLINK_ATTACK:     400,
  REQUEST_ERROR:      400,
  INTERNAL_ERROR:     500,
};

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED:      "Authentication required",
  AUTH_BLOCKED:       "Too many failed authentication attempts",
  FORBIDDEN:          "Access denied",
  CORS_BLOCKED:       "Cross-origin request not allowed",
  RATE_LIMIT:         "Rate limit exceeded",
  GLOBAL_LIMIT:       "Service temporarily unavailable",
  SSE_TOTAL_LIMIT:    "Maximum live connections reached",
  SSE_SESSION_LIMIT:  "Maximum connections per session reached",
  INVALID_INPUT:      "Invalid request body",
  INVALID_TICKET:     "Invalid ticket format",
  INVALID_GATE:       "Invalid gate parameter",
  INVALID_STAGE:      "Invalid stage parameter",
  INVALID_JSON:       "Invalid JSON in request body",
  INVALID_TYPE:       "Invalid field type",
  INVALID_PATH:       "Invalid file path",
  MISSING_FIELD:      "Missing required field",
  TOO_SHORT:          "Input too short",
  TOO_LONG:           "Input too long",
  OUT_OF_RANGE:       "Value out of allowed range",
  PAYLOAD_TOO_LARGE:  "Request body too large",
  NOT_FOUND:          "Resource not found",
  NO_STATE:           "No state file found for this ticket",
  PATH_TRAVERSAL:     "Invalid file path",
  SYMLINK_ATTACK:     "Invalid file path",
  REQUEST_ERROR:      "Request error",
  INTERNAL_ERROR:     "Internal server error",
};

function sendError(res: http.ServerResponse, error: any, authenticated: boolean = false): void {
  let code: string, statusCode: number, message: string;

  if (error instanceof SecurityError) {
    code = error.code;
    statusCode = error.statusCode || ERROR_STATUS_MAP[code] || 400;
    message = authenticated ? error.message : (SAFE_ERROR_MESSAGES[code] || "Request error");
  } else {
    code = "INTERNAL_ERROR";
    statusCode = 500;
    message = "Internal server error";

    console.error(`[SECURITY] Internal error: ${error.message}`);
    if (error.stack) {
      console.error(`[SECURITY] Stack: ${redactSecrets(error.stack)}`);
    }
  }

  const body: Record<string, any> = { error: message, code };

  const headers: Record<string, string> = { "Content-Type": "application/json", ...getSecurityHeaders() };
  if (error.retryAfter) {
    headers["Retry-After"] = String(error.retryAfter);
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

function sanitizeErrorMessage(message: any): string {
  if (typeof message !== "string") return "Unknown error";
  let safe = message;
  safe = safe.replace(/\/[^\s:]+\.(js|ts|json|mjs|cjs)/g, "[path]");
  safe = safe.replace(/:\d+:\d+/g, "");
  safe = redactSecrets(safe);
  return safe;
}


// ═══════════════════════════════════════════════════════════════════
// INTEGRATED MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════

interface SecurityMiddlewareResult {
  proceed: boolean;
  auth: AuthResult | null;
  nonce: string;
  sessionId: string | null;
}

function securityMiddleware(url: URL, request: http.IncomingMessage, res: http.ServerResponse, apiToken: string): SecurityMiddlewareResult {
  const nonce = generateNonce();
  const ip = (request.socket as any).remoteAddress || "unknown";
  const method = request.method;
  const pathname = url.pathname;

  applySecurityHeaders(res, nonce);

  if (pathname.startsWith("/api/")) {
    const cors = checkCORS(request, url);
    if (!cors.allowed) {
      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Content-Length": "0",
          ...getSecurityHeaders({ nonce }),
        });
        res.end();
        return { proceed: false, auth: null, nonce, sessionId: null };
      }
      sendCORSForbidden(res, cors.reason);
      return { proceed: false, auth: null, nonce, sessionId: null };
    }
  }

  if (pathname.startsWith("/api/")) {
    const rateLimitType: "read" | "write" = method === "POST" ? "write" : "read";
    const rateResult = rateLimiter.check(ip, rateLimitType);
    if (!rateResult.allowed) {
      const err = new SecurityError(rateResult.reason || "RATE_LIMIT", "Rate limit exceeded", 429);
      err.retryAfter = rateResult.retryAfter;
      sendError(res, err, false);
      return { proceed: false, auth: null, nonce, sessionId: null };
    }
  }

  const isPublicPath = (
    pathname === "/" ||
    pathname === "/api/health" ||
    pathname === "/api/auth"
  );

  const isReadOnly = method === "GET";

  let auth: AuthResult = { authenticated: false, session: null, sessionId: null, method: "none" };

  if (!isPublicPath && !isReadOnly && pathname.startsWith("/api/")) {
    const blocked = rateLimiter.isAuthBlocked(ip);
    if (blocked.blocked) {
      const err = new SecurityError("AUTH_BLOCKED", "Too many failed auth attempts", 429);
      err.retryAfter = blocked.retryAfter;
      sendError(res, err, false);
      return { proceed: false, auth: null, nonce, sessionId: null };
    }

    auth = authenticate(url, request, apiToken);

    if (!auth.authenticated) {
      const failResult = rateLimiter.recordAuthFailure(ip);
      if (failResult.blocked) {
        const err = new SecurityError("AUTH_BLOCKED", "Too many failed auth attempts", 429);
        err.retryAfter = failResult.retryAfter;
        sendError(res, err, false);
      } else {
        sendUnauthorized(res);
      }
      return { proceed: false, auth: null, nonce, sessionId: null };
    }

    rateLimiter.clearAuthFailures(ip);

    if (auth.sessionId) {
      const sessionRateType: "read" | "write" = method === "POST" ? "write" : "read";
      const sessionRate = rateLimiter.check(`session:${auth.sessionId}`, sessionRateType);
      if (!sessionRate.allowed) {
        const err = new SecurityError("RATE_LIMIT", "Rate limit exceeded", 429);
        err.retryAfter = sessionRate.retryAfter;
        sendError(res, err, true);
        return { proceed: false, auth, nonce, sessionId: auth.sessionId };
      }
    }
  }

  if (auth.method === "token" && auth.sessionId) {
    const sessionCookie = buildSetCookie(SESSION_COOKIE_NAME, auth.sessionId, {
      maxAge: 8 * 60 * 60,
      httpOnly: true,
      sameSite: "Strict",
    });
    res.setHeader("Set-Cookie", sessionCookie);
  }

  return {
    proceed: true,
    auth,
    nonce,
    sessionId: auth.sessionId,
  };
}


// ═══════════════════════════════════════════════════════════════════
// ENDPOINT SCHEMAS
// ═══════════════════════════════════════════════════════════════════

const ENDPOINT_SCHEMAS: Record<string, Record<string, SanitizationRule>> = {
  "/api/start": {
    ticket: { type: "ticket", required: true },
  },
  "/api/stop": {
    ticket: { type: "ticket" },
  },
  "/api/reset": {
    ticket: { type: "ticket", required: true },
  },
  "/api/approve": {
    ticket: { type: "ticket", required: true },
    gate: { type: "gate", required: true },
  },
  "/api/reject": {
    ticket: { type: "ticket", required: true },
    gate: { type: "gate", required: true },
    feedback: { type: "string", maxLength: 10_000, default: "" },
  },
  "/api/refine": {
    ticket: { type: "ticket", required: true },
    gate: { type: "gate", required: true },
    instructions: { type: "string", required: true, minLength: 1, maxLength: 50_000 },
  },
  "/api/comments": {
    ticket: { type: "ticket", required: true },
    comments: { type: "object", required: true },
  },
  "/api/skip-stage": {
    ticket: { type: "ticket", required: true },
    confirm: { type: "boolean", required: true },
  },
  "/api/reset-stage": {
    ticket: { type: "ticket", required: true },
    stage: { type: "stage", required: true },
  },
  "/api/inject-context": {
    ticket: { type: "ticket", required: true },
    context: { type: "string", required: true, minLength: 1, maxLength: 10_000 },
  },
  "/api/auth": {
    token: { type: "string", required: true, minLength: 1, maxLength: 256 },
  },
  "/api/rotate-token": {},
};

const ENDPOINT_SIZE_LIMITS: Record<string, number> = {
  "/api/refine": 100_000,
  "/api/inject-context": 20_000,
  "/api/comments": 500_000,
  default: 1_048_576,
};


// ═══════════════════════════════════════════════════════════════════
// HTML ESCAPING
// ═══════════════════════════════════════════════════════════════════

function escapeHtml(str: any): string {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}


// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

export {
  // Session & Auth
  SessionStore,
  sessionStore,
  parseCookies,
  buildSetCookie,
  authenticate,
  createAuthSession,
  sendUnauthorized,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,

  // Input Sanitization
  validateTicket,
  validateGate,
  validateStage,
  safeJsonParse,
  parseBodySafe,
  sanitize,
  safePath,
  VALID_GATES,
  VALID_STAGES,
  ENDPOINT_SCHEMAS,
  ENDPOINT_SIZE_LIMITS,

  // Security Headers
  generateNonce,
  buildCSP,
  getSecurityHeaders,
  applySecurityHeaders,

  // CORS
  checkCORS,
  sendCORSForbidden,

  // Token Management
  loadOrCreateToken,
  rotateToken,
  safeTokenInjection,

  // Redaction
  redactSecrets,
  redactObject,

  // File Security
  atomicWriteFile,
  safeUnlink,
  safeReadFile,
  setFilePermissions,

  // Rate Limiting
  RateLimiter,
  rateLimiter,

  // Error Handling
  SecurityError,
  sendError,
  sanitizeErrorMessage,
  ERROR_STATUS_MAP,
  SAFE_ERROR_MESSAGES,

  // Integrated Middleware
  securityMiddleware,

  // HTML Utilities
  escapeHtml,
};
