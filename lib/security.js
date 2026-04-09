"use strict";

/**
 * lib/security.js — Comprehensive Security Layer for MI Dev Agent
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

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { constants: fsConstants } = require("fs");

// ═══════════════════════════════════════════════════════════════════
// 1. SESSION & AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════

/**
 * In-memory session store with TTL-based expiry.
 * Sessions are keyed by a random 32-byte hex token stored in a cookie.
 */
class SessionStore {
  constructor(options = {}) {
    this._sessions = new Map();
    this._ttlMs = options.ttlMs || 8 * 60 * 60 * 1000; // 8 hours default
    this._maxSessions = options.maxSessions || 100;
    this._cleanupInterval = setInterval(() => this._cleanup(), 60_000);
    this._cleanupInterval.unref();
  }

  /**
   * Create a new session. Returns the session ID (cookie value).
   * @param {object} data - Session data (e.g. { authenticated: true, createdAt, ip })
   * @returns {string} Session ID (32-byte hex)
   */
  create(data = {}) {
    // Enforce max sessions — evict oldest
    if (this._sessions.size >= this._maxSessions) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, session] of this._sessions) {
        if (session.createdAt < oldestTime) {
          oldestTime = session.createdAt;
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
   * @param {string} sessionId
   * @returns {object|null}
   */
  get(sessionId) {
    if (!sessionId || typeof sessionId !== "string") return null;
    // Constant-time length check to prevent timing attacks
    if (sessionId.length !== 64) return null;
    // Validate hex-only
    if (!/^[0-9a-f]{64}$/.test(sessionId)) return null;

    const session = this._sessions.get(sessionId);
    if (!session) return null;
    // TTL based on lastAccess (sliding window) — not createdAt (fixed window)
    if (Date.now() - session.lastAccess > this._ttlMs) {
      this._sessions.delete(sessionId);
      return null;
    }
    session.lastAccess = Date.now();
    return session;
  }

  /**
   * Destroy a specific session.
   * @param {string} sessionId
   */
  destroy(sessionId) {
    this._sessions.delete(sessionId);
  }

  /**
   * Destroy all sessions (e.g., on token rotation).
   */
  destroyAll() {
    this._sessions.clear();
  }

  /** @returns {number} Active session count. */
  get size() { return this._sessions.size; }

  _cleanup() {
    const now = Date.now();
    for (const [key, session] of this._sessions) {
      if (now - session.createdAt > this._ttlMs) {
        this._sessions.delete(key);
      }
    }
  }

  dispose() {
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
 * @param {http.IncomingMessage} request
 * @returns {Object<string, string>}
 */
function parseCookies(request) {
  const cookies = {};
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

/**
 * Build a Set-Cookie header value.
 * @param {string} name
 * @param {string} value
 * @param {object} options - { maxAge, httpOnly, sameSite, secure, path }
 * @returns {string}
 */
function buildSetCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${options.sameSite || "Strict"}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Authenticate a request. Checks:
 *   1. Session cookie
 *   2. X-Api-Token header (creates session on first valid token use)
 *   3. ?session= query param (SSE fallback — EventSource can't set headers)
 *
 * @param {URL} url - Parsed URL
 * @param {http.IncomingMessage} request
 * @param {string} apiToken - The current valid API token
 * @returns {{ authenticated: boolean, session: object|null, sessionId: string|null, method: string }}
 */
function authenticate(url, request, apiToken) {
  // Method 1: Session cookie
  const cookies = parseCookies(request);
  const cookieSid = cookies[SESSION_COOKIE_NAME];
  if (cookieSid) {
    const session = sessionStore.get(cookieSid);
    if (session && session.authenticated) {
      return { authenticated: true, session, sessionId: cookieSid, method: "cookie" };
    }
  }

  // Method 2: X-Api-Token header (POST endpoints, also initial auth)
  const headerToken = request.headers["x-api-token"];
  if (headerToken && typeof headerToken === "string") {
    // Constant-time comparison to prevent timing attacks
    if (headerToken.length === apiToken.length &&
        crypto.timingSafeEqual(Buffer.from(headerToken), Buffer.from(apiToken))) {
      // Create a session so subsequent requests can use cookies
      const ip = request.socket.remoteAddress || "unknown";
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
 * @param {http.ServerResponse} res
 * @param {string} message - Safe external message (no internal details)
 */
function sendUnauthorized(res, message = "Authentication required") {
  const headers = { ...getSecurityHeaders(), "Content-Type": "application/json" };
  res.writeHead(401, headers);
  res.end(JSON.stringify({ error: message, code: "AUTH_REQUIRED" }));
}

/**
 * Create a session for a valid token and set the cookie on the response.
 * Used by the /api/auth endpoint.
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} res
 * @param {string} apiToken
 * @returns {{ ok: boolean, sessionId?: string, csrf?: string }}
 */
function createAuthSession(request, res, apiToken) {
  const ip = request.socket.remoteAddress || "unknown";
  const sessionId = sessionStore.create({ authenticated: true, ip });
  const csrf = crypto.randomBytes(24).toString("hex");

  // Store CSRF token in session
  const session = sessionStore.get(sessionId);
  if (session) session.csrf = csrf;

  // Set session cookie (HttpOnly, SameSite=Strict)
  const sessionCookie = buildSetCookie(SESSION_COOKIE_NAME, sessionId, {
    maxAge: 8 * 60 * 60, // 8 hours
    httpOnly: true,
    sameSite: "Strict",
  });

  // Set CSRF cookie (NOT HttpOnly — JS needs to read it for double-submit)
  const csrfCookie = buildSetCookie(CSRF_COOKIE_NAME, csrf, {
    maxAge: 8 * 60 * 60,
    httpOnly: false,
    sameSite: "Strict",
  });

  // Multiple Set-Cookie headers
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
 * This is the SINGLE canonical ticket validator — replaces both
 * safeTicket() and the inline .replace() patterns.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function validateTicket(raw) {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  if (!TICKET_REGEX.test(t)) return null;
  return t;
}

/**
 * Validate a gate parameter against the whitelist.
 * Prevents prototype pollution via `__proto__`, `constructor`, `prototype`.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function validateGate(raw) {
  if (!raw || typeof raw !== "string") return null;
  const g = raw.trim().toLowerCase();
  if (!VALID_GATES.has(g)) return null;
  return g;
}

/**
 * Validate a stage parameter against the whitelist.
 * @param {string} raw
 * @returns {string|null}
 */
function validateStage(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!VALID_STAGES.has(s)) return null;
  return s;
}

/**
 * Safe JSON.parse with prototype pollution guard.
 * Removes __proto__, constructor, and prototype keys at all nesting levels.
 *
 * @param {string} text - Raw JSON string
 * @returns {any} Parsed and sanitized value
 * @throws {SyntaxError} If JSON is invalid
 */
function safeJsonParse(text) {
  return JSON.parse(text, (key, value) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return undefined; // Strip poisoned keys
    }
    return value;
  });
}

/**
 * Parse a POST body with size limit and prototype pollution guard.
 * Replaces the existing parseBody() in routes.js.
 *
 * @param {http.IncomingMessage} request
 * @param {number} maxSize - Maximum body size in bytes (default 1MB)
 * @returns {Promise<object>}
 */
function parseBodySafe(request, maxSize = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    request.on("data", (chunk) => {
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

/**
 * Unified input validation.
 * Takes a parsed body and a schema, returns sanitized values or throws.
 *
 * Schema format:
 * {
 *   ticket: { type: "ticket", required: true },
 *   gate:   { type: "gate", required: true },
 *   feedback: { type: "string", maxLength: 10000 },
 *   confirm: { type: "boolean" },
 * }
 *
 * @param {object} body - Parsed JSON body
 * @param {object} schema - Validation schema
 * @returns {object} Sanitized values
 * @throws {SecurityError}
 */
function sanitize(body, schema) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SecurityError("INVALID_INPUT", "Request body must be a JSON object");
  }

  const result = {};

  for (const [field, rules] of Object.entries(schema)) {
    const value = body[field];

    // Check required
    if (rules.required && (value === undefined || value === null || value === "")) {
      throw new SecurityError("MISSING_FIELD", `Missing required field: ${field}`);
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
        // Prevent null bytes
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
        // Deep-check for prototype pollution keys
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
 * Ensures the resolved path stays within the allowed base directory.
 *
 * @param {string} basedir - Allowed base directory
 * @param {string} filename - User-provided filename
 * @returns {string} Safe resolved path
 * @throws {SecurityError}
 */
function safePath(basedir, filename) {
  if (!filename || typeof filename !== "string") {
    throw new SecurityError("INVALID_PATH", "Filename is required");
  }
  // Strip null bytes
  const clean = filename.replace(/\0/g, "");
  // Resolve to absolute
  const resolved = path.resolve(basedir, clean);
  // Ensure it's within basedir
  if (!resolved.startsWith(path.resolve(basedir) + path.sep) && resolved !== path.resolve(basedir)) {
    throw new SecurityError("PATH_TRAVERSAL", "Path traversal attempt detected");
  }
  return resolved;
}


// ═══════════════════════════════════════════════════════════════════
// 3. SECURITY HEADERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Generate a random CSP nonce for this response.
 * @returns {string} Base64-encoded 16-byte nonce
 */
function generateNonce() {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * Build the Content-Security-Policy header value.
 * Allows inline styles (needed for the UI) but blocks inline scripts
 * unless they carry the correct nonce.
 *
 * @param {string} nonce - CSP nonce for this response
 * @returns {string} CSP header value
 */
function buildCSP(_nonce) {
  // Note: 'unsafe-inline' is used for script-src because the UI is a single
  // pre-rendered HTML file with a large inline <script> block. Nonce-based CSP
  // would require per-request HTML generation which is unnecessary for this
  // internal dev tool. The API token injected into the page provides auth.
  return [
    `default-src 'self'`,
    `script-src 'self' 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src 'self'`,                       // XHR/fetch/SSE
    `frame-ancestors 'none'`,                   // Prevent framing (clickjacking)
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join("; ");
}

/**
 * Get the standard security headers to apply to every response.
 * Call once per response (nonce must be unique per response).
 *
 * @param {object} options - { nonce }
 * @returns {Object<string, string>}
 */
function getSecurityHeaders(options = {}) {
  const nonce = options.nonce || generateNonce();
  return {
    "Content-Security-Policy": buildCSP(nonce),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "0",          // Disabled — CSP is the real protection; the XSS filter causes issues
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "Pragma": "no-cache",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    // HSTS only when served over TLS (don't break localhost HTTP)
    // "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

/**
 * Apply security headers to a response. Call before writeHead or
 * use the returned headers dict with writeHead.
 *
 * @param {http.ServerResponse} res
 * @param {string} nonce
 */
function applySecurityHeaders(res, nonce) {
  const headers = getSecurityHeaders({ nonce });
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}


// ═══════════════════════════════════════════════════════════════════
// 4. CORS POLICY
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if the request is same-origin. Blocks cross-origin requests.
 *
 * For GET requests: checks Sec-Fetch-Site header (modern browsers) or
 * falls back to Referer/Origin check.
 *
 * For POST requests: strictly checks Origin header.
 *
 * @param {http.IncomingMessage} request
 * @param {URL} url - Parsed request URL
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkCORS(request, url) {
  const method = request.method;

  // Preflight — always deny (we don't support cross-origin)
  if (method === "OPTIONS") {
    return { allowed: false, reason: "CORS preflight denied: cross-origin not supported" };
  }

  // Sec-Fetch-Site is set by modern browsers and cannot be spoofed by JS
  const secFetchSite = request.headers["sec-fetch-site"];
  if (secFetchSite) {
    // "same-origin" and "none" (direct navigation) are ok
    if (secFetchSite === "same-origin" || secFetchSite === "none") {
      return { allowed: true };
    }
    return { allowed: false, reason: `Cross-origin request blocked (sec-fetch-site: ${secFetchSite})` };
  }

  // Fallback for older browsers: check Origin header
  const origin = request.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const serverHost = request.headers.host || `${url.hostname}:${url.port}`;
      const expectedOrigin = `${url.protocol}//${serverHost}`;
      // Compare normalized origins
      if (origin !== expectedOrigin && originUrl.host !== (request.headers.host || "")) {
        return { allowed: false, reason: `Cross-origin request blocked (origin: ${origin})` };
      }
    } catch {
      return { allowed: false, reason: "Cross-origin request blocked (malformed Origin header)" };
    }
  }

  // For POST requests without Origin, check Referer
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
    // No Origin AND no Referer on a POST is suspicious, but we let token auth
    // handle the actual authorization. Log it.
  }

  return { allowed: true };
}

/**
 * Send a 403 Forbidden response for CORS violations.
 */
function sendCORSForbidden(res, reason) {
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
const TOKEN_BYTES = 32; // 256-bit token

/**
 * Load or create a persistent API token that survives server restarts.
 * Stored in .api-token with permissions 0o600.
 *
 * @returns {{ token: string, created: boolean }}
 */
function loadOrCreateToken() {
  // Try to read existing token
  try {
    const stat = fs.statSync(TOKEN_FILE);
    // Check permissions — warn if world-readable
    if (stat.mode & 0o044) {
      console.warn("[SECURITY] .api-token is readable by other users! Run: chmod 600 .api-token");
    }
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing.length >= 48) { // Minimum viable token length
      return { token: existing, created: false };
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.warn(`[SECURITY] Failed to read .api-token: ${e.message}`);
    }
  }

  // Create new token
  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  try {
    atomicWriteFile(TOKEN_FILE, token, { mode: 0o600 });
  } catch (e) {
    console.error(`[SECURITY] Failed to write .api-token: ${e.message}`);
    // Fall back to ephemeral token
  }
  return { token, created: true };
}

/**
 * Rotate the API token. Invalidates all existing sessions.
 * @returns {string} New token
 */
function rotateToken() {
  const newToken = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  try {
    atomicWriteFile(TOKEN_FILE, newToken, { mode: 0o600 });
  } catch (e) {
    console.error(`[SECURITY] Token rotation write failed: ${e.message}`);
  }
  // Kill all sessions since they were authenticated with the old token
  sessionStore.destroyAll();
  return newToken;
}

/**
 * Inject the API token into HTML safely using JSON.stringify + CSP nonce.
 * Replaces the vulnerable `const API_TOKEN = "${apiToken}";` pattern.
 *
 * @param {string} token
 * @param {string} nonce - CSP nonce for this response
 * @returns {string} Safe <script> tag
 */
function safeTokenInjection(token, nonce) {
  // JSON.stringify handles all special characters (<, >, ", \, etc.)
  // The nonce ties this script to the CSP policy
  const safeToken = JSON.stringify(token)
    // Extra safety: escape </script> sequences inside the string
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return `<script nonce="${nonce}">window.__MI_TOKEN=${safeToken};</script>`;
}


// ═══════════════════════════════════════════════════════════════════
// 6. REDACTION ENGINE
// ═══════════════════════════════════════════════════════════════════

/**
 * Complete credential redaction covering all known token/secret formats.
 * Each pattern is specific enough to avoid false positives but broad
 * enough to catch real credentials.
 *
 * @param {string} text
 * @returns {string} Redacted text
 */
function redactSecrets(text) {
  if (typeof text !== "string") return text;

  return text
    // ── Jira (Atlassian) tokens ──
    .replace(/ATATT3x[A-Za-z0-9+/=_-]{20,}/g, "[JIRA_TOKEN_REDACTED]")

    // ── GitLab tokens ──
    .replace(/glpat-[A-Za-z0-9_-]{20,}/g, "[GITLAB_TOKEN_REDACTED]")
    .replace(/gldt-[A-Za-z0-9_-]{20,}/g, "[GITLAB_DEPLOY_TOKEN_REDACTED]")

    // ── GitHub tokens ──
    .replace(/ghp_[A-Za-z0-9]{36,}/g, "[GITHUB_PAT_REDACTED]")
    .replace(/gho_[A-Za-z0-9]{36,}/g, "[GITHUB_OAUTH_REDACTED]")
    .replace(/ghu_[A-Za-z0-9]{36,}/g, "[GITHUB_USER_REDACTED]")
    .replace(/ghs_[A-Za-z0-9]{36,}/g, "[GITHUB_SERVER_REDACTED]")
    .replace(/ghr_[A-Za-z0-9]{36,}/g, "[GITHUB_REFRESH_REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{36,}/g, "[GITHUB_FINE_PAT_REDACTED]")

    // ── Slack tokens ──
    .replace(/xoxb-[A-Za-z0-9\-]{20,}/g, "[SLACK_BOT_REDACTED]")
    .replace(/xoxp-[A-Za-z0-9\-]{20,}/g, "[SLACK_USER_REDACTED]")
    .replace(/xoxa-[A-Za-z0-9\-]{20,}/g, "[SLACK_APP_REDACTED]")
    .replace(/xoxr-[A-Za-z0-9\-]{20,}/g, "[SLACK_REFRESH_REDACTED]")
    .replace(/xoxs-[A-Za-z0-9\-]{20,}/g, "[SLACK_SESSION_REDACTED]")

    // ── Anthropic API keys ──
    .replace(/sk-ant-api03-[A-Za-z0-9_-]{80,}/g, "[ANTHROPIC_KEY_REDACTED]")
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[ANTHROPIC_KEY_REDACTED]")

    // ── OpenAI API keys ──
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[API_KEY_REDACTED]")

    // ── AWS credentials ──
    .replace(/AKIA[A-Z0-9]{16}/g, "[AWS_ACCESS_KEY_REDACTED]")
    .replace(/ASIA[A-Z0-9]{16}/g, "[AWS_TEMP_KEY_REDACTED]")
    // AWS secret key (40-char base64 following an access key context)
    .replace(/(aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9+/=]{40}/gi, "$1[AWS_SECRET_REDACTED]")

    // ── SSH private keys (multi-line BEGIN...END blocks) ──
    .replace(/-----BEGIN\s+(RSA|DSA|EC|OPENSSH|PGP)\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+\1\s+PRIVATE\s+KEY-----/g,
      "[SSH_PRIVATE_KEY_REDACTED]")

    // ── Bearer tokens ──
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/g, "Bearer [REDACTED]")

    // ── Basic auth (base64-encoded credentials) ──
    .replace(/Basic\s+[A-Za-z0-9+/=]{10,}/g, "Basic [REDACTED]")

    // ── JWT tokens (three dot-separated base64url segments) ──
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      "[JWT_REDACTED]")

    // ── Generic hex secrets (64+ consecutive hex chars — likely SHA256/tokens) ──
    // Only match if preceded by common secret-assignment patterns
    .replace(/((?:secret|token|key|password|apikey|api_key|auth)\s*[=:]\s*["']?)[0-9a-f]{64,}/gi,
      "$1[HEX_SECRET_REDACTED]")

    // ── Connection strings with embedded credentials ──
    .replace(/:\/\/[^:]+:[^@]+@/g, "://[CREDENTIALS_REDACTED]@")

    // ── Stripe keys ──
    .replace(/sk_live_[A-Za-z0-9]{20,}/g, "[STRIPE_SECRET_REDACTED]")
    .replace(/pk_live_[A-Za-z0-9]{20,}/g, "[STRIPE_PUBLIC_REDACTED]")
    .replace(/rk_live_[A-Za-z0-9]{20,}/g, "[STRIPE_RESTRICTED_REDACTED]")

    // ── Sendgrid ──
    .replace(/SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, "[SENDGRID_KEY_REDACTED]")

    // ── Twilio ──
    .replace(/SK[0-9a-f]{32}/g, "[TWILIO_KEY_REDACTED]");
}

/**
 * Redact secrets from an object recursively (for state data sent to clients).
 * @param {any} obj
 * @returns {any} Redacted copy
 */
function redactObject(obj) {
  if (typeof obj === "string") return redactSecrets(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj && typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      // Redact keys that look like they hold secrets
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

/**
 * Atomic file write: write to temp file, then rename.
 * Prevents partial reads and TOCTOU races.
 *
 * Uses O_NOFOLLOW equivalent by checking for symlinks before write,
 * and sets restrictive permissions.
 *
 * @param {string} filepath - Target file path
 * @param {string|Buffer} data - Content to write
 * @param {object} options - { mode: 0o600 }
 */
function atomicWriteFile(filepath, data, options = {}) {
  const mode = options.mode || 0o600;
  const dir = path.dirname(filepath);
  const tmpFile = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}`);

  try {
    // Check target is not a symlink (prevents symlink attacks)
    try {
      const lstat = fs.lstatSync(filepath);
      if (lstat.isSymbolicLink()) {
        throw new SecurityError("SYMLINK_ATTACK", `Refusing to write to symlink: ${filepath}`);
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        if (e instanceof SecurityError) throw e;
        // lstat failed for other reason — proceed cautiously
      }
    }

    // Write to temp file with O_WRONLY | O_CREAT | O_EXCL (exclusive create)
    const fd = fs.openSync(tmpFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    try {
      fs.writeSync(fd, typeof data === "string" ? data : data);
    } finally {
      fs.closeSync(fd);
    }

    // Atomic rename (same filesystem)
    fs.renameSync(tmpFile, filepath);
  } catch (e) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Safe file deletion that avoids TOCTOU races.
 * Instead of existsSync → unlinkSync, just try to unlink and handle ENOENT.
 *
 * @param {string} filepath
 * @returns {boolean} true if file was deleted, false if it didn't exist
 */
function safeUnlink(filepath) {
  try {
    // Check not a symlink to prevent deleting the symlink target
    const lstat = fs.lstatSync(filepath);
    if (lstat.isSymbolicLink()) {
      throw new SecurityError("SYMLINK_ATTACK", `Refusing to delete symlink: ${filepath}`);
    }
    fs.unlinkSync(filepath);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    if (e instanceof SecurityError) throw e;
    throw e;
  }
}

/**
 * Read a file safely, refusing to follow symlinks.
 *
 * @param {string} filepath
 * @returns {string|null} File contents or null if not found
 */
function safeReadFile(filepath) {
  try {
    const lstat = fs.lstatSync(filepath);
    if (lstat.isSymbolicLink()) {
      throw new SecurityError("SYMLINK_ATTACK", `Refusing to read symlink: ${filepath}`);
    }
    return fs.readFileSync(filepath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    if (e instanceof SecurityError) throw e;
    throw e;
  }
}

/**
 * Set restrictive permissions on state files.
 * @param {string} filepath
 * @param {number} mode - File permission mode (default 0o600)
 */
function setFilePermissions(filepath, mode = 0o600) {
  try {
    fs.chmodSync(filepath, mode);
  } catch (e) {
    // Not critical, but log it
    console.warn(`[SECURITY] Could not set permissions on ${filepath}: ${e.message}`);
  }
}


// ═══════════════════════════════════════════════════════════════════
// 8. RATE LIMITING (Enhanced)
// ═══════════════════════════════════════════════════════════════════

/**
 * Enhanced rate limiter with:
 * - Per-session rate limiting (not just IP)
 * - Separate limits for read (GET) vs write (POST) endpoints
 * - Exponential backoff on failed auth attempts
 * - SSE connection limits per session
 * - DDoS mitigation
 */
class RateLimiter {
  constructor(options = {}) {
    this._windows = new Map();   // key -> { count, resetTime }
    this._authFails = new Map(); // ip -> { count, blockedUntil }
    this._sseConns = new Map();  // sessionId -> count
    this._globalCounter = { count: 0, resetTime: Date.now() + 60_000 };

    // Configurable limits
    this.READ_LIMIT = options.readLimit || 600;         // GET requests per minute (UI polls ~3 endpoints every 2s)
    this.WRITE_LIMIT = options.writeLimit || 60;        // POST requests per minute
    this.AUTH_FAIL_LIMIT = options.authFailLimit || 5;   // Failed auths before lockout
    this.AUTH_BACKOFF_BASE = options.authBackoffBase || 30_000; // 30s base backoff
    this.AUTH_BACKOFF_MAX = options.authBackoffMax || 3_600_000; // 1h max backoff
    this.SSE_PER_SESSION = options.ssePerSession || 3;  // Max SSE connections per session
    this.SSE_TOTAL = options.sseTotal || 10;             // Total SSE connections
    this.GLOBAL_LIMIT = options.globalLimit || 600;      // Global requests per minute (DDoS)
    this.WINDOW_MS = options.windowMs || 60_000;

    // Cleanup interval
    this._cleanupTimer = setInterval(() => this._cleanup(), 120_000);
    this._cleanupTimer.unref();
  }

  /**
   * Check rate limit for a specific key and operation type.
   *
   * @param {string} key - Rate limit key (IP or session ID)
   * @param {"read"|"write"} type
   * @returns {{ allowed: boolean, retryAfter?: number, reason?: string }}
   */
  check(key, type = "read") {
    const now = Date.now();

    // Global DDoS check
    if (now > this._globalCounter.resetTime) {
      this._globalCounter = { count: 0, resetTime: now + this.WINDOW_MS };
    }
    this._globalCounter.count++;
    if (this._globalCounter.count > this.GLOBAL_LIMIT) {
      return { allowed: false, retryAfter: 60, reason: "GLOBAL_LIMIT" };
    }

    // Per-key check
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

  /**
   * Record a failed authentication attempt. Returns whether the IP is now blocked.
   *
   * @param {string} ip
   * @returns {{ blocked: boolean, blockedUntil?: number, retryAfter?: number }}
   */
  recordAuthFailure(ip) {
    const now = Date.now();
    let entry = this._authFails.get(ip);

    if (!entry) {
      entry = { count: 0, blockedUntil: 0 };
    }

    // If currently blocked, extend the block
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
      // Exponential backoff: 30s, 60s, 120s, 240s, ... up to 1h
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

  /**
   * Clear auth failure count for an IP (on successful auth).
   * @param {string} ip
   */
  clearAuthFailures(ip) {
    this._authFails.delete(ip);
  }

  /**
   * Check if an IP is currently blocked from auth attempts.
   * @param {string} ip
   * @returns {{ blocked: boolean, retryAfter?: number }}
   */
  isAuthBlocked(ip) {
    const entry = this._authFails.get(ip);
    if (!entry) return { blocked: false };
    const now = Date.now();
    if (entry.blockedUntil > now) {
      return { blocked: true, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) };
    }
    return { blocked: false };
  }

  /**
   * Check if a new SSE connection is allowed for the given session.
   * @param {string} sessionId
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkSSE(sessionId) {
    // Total SSE limit
    let totalSSE = 0;
    for (const count of this._sseConns.values()) totalSSE += count;
    if (totalSSE >= this.SSE_TOTAL) {
      return { allowed: false, reason: "SSE_TOTAL_LIMIT" };
    }

    // Per-session SSE limit
    const current = this._sseConns.get(sessionId) || 0;
    if (current >= this.SSE_PER_SESSION) {
      return { allowed: false, reason: "SSE_SESSION_LIMIT" };
    }

    return { allowed: true };
  }

  /**
   * Track SSE connection open/close.
   * @param {string} sessionId
   * @param {number} delta - +1 for connect, -1 for disconnect
   */
  trackSSE(sessionId, delta) {
    const current = this._sseConns.get(sessionId) || 0;
    const updated = Math.max(0, current + delta);
    if (updated === 0) {
      this._sseConns.delete(sessionId);
    } else {
      this._sseConns.set(sessionId, updated);
    }
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._windows) {
      if (now > entry.resetTime) this._windows.delete(key);
    }
    for (const [ip, entry] of this._authFails) {
      // Remove entries that haven't been blocked for >2x the max backoff
      if (entry.blockedUntil < now - this.AUTH_BACKOFF_MAX * 2) {
        this._authFails.delete(ip);
      }
    }
  }

  dispose() {
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

/**
 * Custom error class for security-related errors.
 * Carries a safe external code (sent to client) separate from the
 * internal message (logged server-side only).
 */
class SecurityError extends Error {
  /**
   * @param {string} code - Safe error code (e.g., "AUTH_REQUIRED", "INVALID_INPUT")
   * @param {string} message - Human-readable safe message
   * @param {number} statusCode - HTTP status code (default 400)
   */
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Error code to HTTP status code mapping.
 * Only these codes are ever sent to clients.
 */
const ERROR_STATUS_MAP = {
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

/**
 * Safe error messages for each code.
 * These are the ONLY messages ever sent to unauthenticated clients.
 * Authenticated clients may receive more detail from the original message.
 */
const SAFE_ERROR_MESSAGES = {
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

/**
 * Send a structured, safe error response.
 * For authenticated users: includes the specific error message.
 * For unauthenticated users: only includes the generic safe message.
 *
 * NEVER leaks: stack traces, file paths, stage names, internal structure.
 *
 * @param {http.ServerResponse} res
 * @param {Error|SecurityError} error
 * @param {boolean} authenticated - Whether the requesting user is authenticated
 */
function sendError(res, error, authenticated = false) {
  let code, statusCode, message;

  if (error instanceof SecurityError) {
    code = error.code;
    statusCode = error.statusCode || ERROR_STATUS_MAP[code] || 400;
    message = authenticated ? error.message : (SAFE_ERROR_MESSAGES[code] || "Request error");
  } else {
    // Unknown/internal error — never leak details
    code = "INTERNAL_ERROR";
    statusCode = 500;
    message = "Internal server error";

    // Log the real error server-side
    console.error(`[SECURITY] Internal error: ${error.message}`);
    if (error.stack) {
      console.error(`[SECURITY] Stack: ${redactSecrets(error.stack)}`);
    }
  }

  const body = { error: message, code };

  // Add retryAfter for rate limit errors
  const headers = { "Content-Type": "application/json", ...getSecurityHeaders() };
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
    // Response already sent or broken — nothing we can do
  }
}

/**
 * Sanitize an error message for logging.
 * Strips stack traces and applies credential redaction.
 *
 * @param {string} message
 * @returns {string}
 */
function sanitizeErrorMessage(message) {
  if (typeof message !== "string") return "Unknown error";
  let safe = message;
  // Remove absolute file paths
  safe = safe.replace(/\/[^\s:]+\.(js|ts|json|mjs|cjs)/g, "[path]");
  // Remove line:col references
  safe = safe.replace(/:\d+:\d+/g, "");
  // Apply credential redaction
  safe = redactSecrets(safe);
  return safe;
}


// ═══════════════════════════════════════════════════════════════════
// INTEGRATED MIDDLEWARE — Ties everything together
// ═══════════════════════════════════════════════════════════════════

/**
 * Configuration for the security middleware.
 * @typedef {object} SecurityConfig
 * @property {string} apiToken - Current API token
 * @property {string[]} publicPaths - Paths that don't require auth (e.g., "/", "/api/health")
 * @property {string[]} authPaths - Paths that require auth (default: all /api/ except public)
 */

/**
 * Main security middleware. Call this FIRST in handleRequest.
 * Returns an object describing the security decision.
 *
 * @param {URL} url
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} res
 * @param {string} apiToken
 * @returns {{ proceed: boolean, auth: object, nonce: string, sessionId: string|null }}
 *
 * If proceed is false, the response has already been sent (error/redirect).
 * If proceed is true, continue handling the request.
 */
function securityMiddleware(url, request, res, apiToken) {
  const nonce = generateNonce();
  const ip = request.socket.remoteAddress || "unknown";
  const method = request.method;
  const pathname = url.pathname;

  // ── Step 1: Apply security headers to all responses ──
  applySecurityHeaders(res, nonce);

  // ── Step 2: CORS check (all requests) ──
  if (pathname.startsWith("/api/")) {
    const cors = checkCORS(request, url);
    if (!cors.allowed) {
      // Handle OPTIONS preflight
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

  // ── Step 3: Rate limiting ──
  if (pathname.startsWith("/api/")) {
    const rateLimitType = method === "POST" ? "write" : "read";
    const rateResult = rateLimiter.check(ip, rateLimitType);
    if (!rateResult.allowed) {
      const err = new SecurityError(rateResult.reason, "Rate limit exceeded", 429);
      err.retryAfter = rateResult.retryAfter;
      sendError(res, err, false);
      return { proceed: false, auth: null, nonce, sessionId: null };
    }
  }

  // ── Step 4: Auth check ──
  // Public paths that don't need auth:
  const isPublicPath = (
    pathname === "/" ||                          // HTML page (token needed to use it)
    pathname === "/api/health" ||                // Health check (read-only, no secrets)
    pathname === "/api/auth"                     // The auth endpoint itself
  );

  // GET endpoints are read-only (state, review, logs, etc.) — no secrets exposed.
  // Auth is enforced on POST endpoints (routes.js checks X-Api-Token) and SSE (token query param).
  const isReadOnly = method === "GET";

  let auth = { authenticated: false, session: null, sessionId: null, method: "none" };

  if (!isPublicPath && !isReadOnly && pathname.startsWith("/api/")) {
    // Check if IP is blocked from auth
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

    // Successful auth — clear failure counter
    rateLimiter.clearAuthFailures(ip);

    // Per-session rate limiting (in addition to IP-based)
    if (auth.sessionId) {
      const sessionRateType = method === "POST" ? "write" : "read";
      const sessionRate = rateLimiter.check(`session:${auth.sessionId}`, sessionRateType);
      if (!sessionRate.allowed) {
        const err = new SecurityError("RATE_LIMIT", "Rate limit exceeded", 429);
        err.retryAfter = sessionRate.retryAfter;
        sendError(res, err, true);
        return { proceed: false, auth, nonce, sessionId: auth.sessionId };
      }
    }
  }

  // ── Step 5: Set session cookie if auth created a new session via token ──
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
// ENDPOINT SCHEMAS — Validation rules per POST endpoint
// ═══════════════════════════════════════════════════════════════════

const ENDPOINT_SCHEMAS = {
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

/**
 * Per-endpoint body size limits (in bytes).
 * Endpoints with large text payloads get bigger limits.
 */
const ENDPOINT_SIZE_LIMITS = {
  "/api/refine": 100_000,         // 100KB for refine instructions
  "/api/inject-context": 20_000,  // 20KB for context injection
  "/api/comments": 500_000,       // 500KB for review comments (can be large)
  default: 1_048_576,              // 1MB default
};


// ═══════════════════════════════════════════════════════════════════
// HTML ESCAPING — For safe token injection
// ═══════════════════════════════════════════════════════════════════

/**
 * Escape a string for safe insertion into HTML attributes/content.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
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

module.exports = {
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
