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
import type * as http from "http";
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
declare class SessionStore {
    private _sessions;
    private _ttlMs;
    private _maxSessions;
    private _cleanupInterval;
    constructor(options?: SessionStoreOptions);
    /**
     * Create a new session. Returns the session ID (cookie value).
     */
    create(data?: SessionData): string;
    /**
     * Retrieve session by ID. Returns null if expired/missing.
     */
    get(sessionId: string): SessionData | null;
    /** Destroy a specific session. */
    destroy(sessionId: string): void;
    /** Destroy all sessions (e.g., on token rotation). */
    destroyAll(): void;
    /** Active session count. */
    get size(): number;
    private _cleanup;
    dispose(): void;
}
declare const sessionStore: SessionStore;
/** Cookie name for session. */
declare const SESSION_COOKIE_NAME = "__mi_agent_sid";
/** Cookie name for CSRF token (double-submit). */
declare const CSRF_COOKIE_NAME = "__mi_agent_csrf";
/**
 * Parse cookies from a request's Cookie header.
 */
declare function parseCookies(request: http.IncomingMessage): Record<string, string>;
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
declare function buildSetCookie(name: string, value: string, options?: CookieOptions): string;
interface AuthResult {
    authenticated: boolean;
    session: SessionData | null;
    sessionId: string | null;
    method: string;
}
/**
 * Authenticate a request.
 */
declare function authenticate(url: URL, request: http.IncomingMessage, apiToken: string): AuthResult;
/**
 * Send a 401 Unauthorized JSON response.
 */
declare function sendUnauthorized(res: http.ServerResponse, message?: string): void;
/**
 * Create a session for a valid token and set the cookie on the response.
 */
declare function createAuthSession(request: http.IncomingMessage, res: http.ServerResponse, _apiToken: string): {
    ok: boolean;
    sessionId?: string;
    csrf?: string;
};
/** Valid pipeline stages (whitelist for gate parameter). */
declare const VALID_GATES: Set<string>;
/** Valid stages for reset-stage. */
declare const VALID_STAGES: Set<string>;
/**
 * Validate a Jira ticket ID. Returns sanitized ticket or null.
 */
declare function validateTicket(raw: any): string | null;
/**
 * Validate a gate parameter against the whitelist.
 */
declare function validateGate(raw: any): string | null;
/**
 * Validate a stage parameter against the whitelist.
 */
declare function validateStage(raw: any): string | null;
/**
 * Safe JSON.parse with prototype pollution guard.
 */
declare function safeJsonParse(text: string): any;
/**
 * Parse a POST body with size limit and prototype pollution guard.
 */
declare function parseBodySafe(request: http.IncomingMessage, maxSize?: number): Promise<any>;
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
declare function sanitize(body: any, schema: Record<string, SanitizationRule>): Record<string, any>;
/**
 * Validate a file path to prevent path traversal attacks.
 */
declare function safePath(basedir: string, filename: string): string;
declare function generateNonce(): string;
declare function buildCSP(_nonce: string): string;
declare function getSecurityHeaders(options?: {
    nonce?: string;
}): Record<string, string>;
declare function applySecurityHeaders(res: http.ServerResponse, nonce: string): void;
declare function checkCORS(request: http.IncomingMessage, url: URL): {
    allowed: boolean;
    reason?: string;
};
declare function sendCORSForbidden(res: http.ServerResponse, _reason?: string): void;
declare function loadOrCreateToken(): {
    token: string;
    created: boolean;
};
declare function rotateToken(): string;
declare function safeTokenInjection(token: string, nonce: string): string;
declare function redactSecrets(text: any): any;
declare function redactObject(obj: any): any;
declare function atomicWriteFile(filepath: string, data: string | Buffer, options?: {
    mode?: number;
}): void;
declare function safeUnlink(filepath: string): boolean;
declare function safeReadFile(filepath: string): string | null;
declare function setFilePermissions(filepath: string, mode?: number): void;
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
declare class RateLimiter {
    private _windows;
    private _authFails;
    private _sseConns;
    private _globalCounter;
    private _cleanupTimer;
    READ_LIMIT: number;
    WRITE_LIMIT: number;
    AUTH_FAIL_LIMIT: number;
    AUTH_BACKOFF_BASE: number;
    AUTH_BACKOFF_MAX: number;
    SSE_PER_SESSION: number;
    SSE_TOTAL: number;
    GLOBAL_LIMIT: number;
    WINDOW_MS: number;
    constructor(options?: RateLimiterOptions);
    check(key: string, type?: "read" | "write"): {
        allowed: boolean;
        retryAfter?: number;
        reason?: string;
    };
    recordAuthFailure(ip: string): {
        blocked: boolean;
        blockedUntil?: number;
        retryAfter?: number;
    };
    clearAuthFailures(ip: string): void;
    isAuthBlocked(ip: string): {
        blocked: boolean;
        retryAfter?: number;
    };
    checkSSE(sessionId: string): {
        allowed: boolean;
        reason?: string;
    };
    trackSSE(sessionId: string, delta: number): void;
    private _cleanup;
    dispose(): void;
}
declare const rateLimiter: RateLimiter;
declare class SecurityError extends Error {
    code: string;
    statusCode: number;
    retryAfter?: number;
    constructor(code: string, message: string, statusCode?: number);
}
declare const ERROR_STATUS_MAP: Record<string, number>;
declare const SAFE_ERROR_MESSAGES: Record<string, string>;
declare function sendError(res: http.ServerResponse, error: any, authenticated?: boolean): void;
declare function sanitizeErrorMessage(message: any): string;
interface SecurityMiddlewareResult {
    proceed: boolean;
    auth: AuthResult | null;
    nonce: string;
    sessionId: string | null;
}
declare function securityMiddleware(url: URL, request: http.IncomingMessage, res: http.ServerResponse, apiToken: string): SecurityMiddlewareResult;
declare const ENDPOINT_SCHEMAS: Record<string, Record<string, SanitizationRule>>;
declare const ENDPOINT_SIZE_LIMITS: Record<string, number>;
declare function escapeHtml(str: any): string;
export { SessionStore, sessionStore, parseCookies, buildSetCookie, authenticate, createAuthSession, sendUnauthorized, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, validateTicket, validateGate, validateStage, safeJsonParse, parseBodySafe, sanitize, safePath, VALID_GATES, VALID_STAGES, ENDPOINT_SCHEMAS, ENDPOINT_SIZE_LIMITS, generateNonce, buildCSP, getSecurityHeaders, applySecurityHeaders, checkCORS, sendCORSForbidden, loadOrCreateToken, rotateToken, safeTokenInjection, redactSecrets, redactObject, atomicWriteFile, safeUnlink, safeReadFile, setFilePermissions, RateLimiter, rateLimiter, SecurityError, sendError, sanitizeErrorMessage, ERROR_STATUS_MAP, SAFE_ERROR_MESSAGES, securityMiddleware, escapeHtml, };
//# sourceMappingURL=security.d.ts.map