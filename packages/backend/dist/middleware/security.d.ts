import type { IncomingMessage, ServerResponse } from 'http';
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
/** Cookie name for session. */
export declare const SESSION_COOKIE_NAME = "__mi_agent_sid";
/** Cookie name for CSRF token (double-submit). */
export declare const CSRF_COOKIE_NAME = "__mi_agent_csrf";
/**
 * In-memory session store with TTL-based expiry.
 * Sessions are keyed by a random 32-byte hex token stored in a cookie.
 *
 * Ported from lib/security.js SessionStore class.
 */
export declare class SessionStore {
    private _sessions;
    private _ttlMs;
    private _maxSessions;
    private _cleanupInterval;
    constructor(options?: SessionStoreOptions);
    /**
     * Create a new session. Returns the session ID (cookie value).
     * Evicts the oldest session if max capacity is reached.
     */
    create(data?: Partial<SessionData>): string;
    /**
     * Retrieve session by ID. Returns null if expired/missing.
     * Uses constant-time length check and hex validation to prevent timing attacks.
     */
    get(sessionId: string): SessionData | null;
    /**
     * Touch a session (update lastAccess without retrieving data).
     */
    touch(sessionId: string): void;
    /**
     * Destroy a specific session.
     */
    destroy(sessionId: string): void;
    /**
     * Destroy all sessions (e.g., on token rotation).
     */
    destroyAll(): void;
    /** Active session count. */
    get size(): number;
    /** Periodic cleanup of expired sessions. */
    private _cleanup;
    /** Dispose the store and stop the cleanup timer. */
    dispose(): void;
}
/**
 * Generate a random CSP nonce for this response.
 */
export declare function generateNonce(): string;
/**
 * Build the Content-Security-Policy header value.
 * Nonce-based script-src for secure inline script execution.
 */
export declare function buildCSP(nonce: string): string;
/**
 * Get the standard security headers to apply to every response.
 * Call once per response (nonce must be unique per response).
 */
export declare function getSecurityHeaders(nonce?: string): Record<string, string>;
/**
 * Apply security headers to a response object.
 */
export declare function applySecurityHeaders(res: ServerResponse, nonce: string): void;
/**
 * Check if the request is same-origin. Blocks cross-origin requests.
 * Ported from lib/security.js checkCORS().
 */
export declare function checkCORS(request: IncomingMessage, url: URL): CORSResult;
/**
 * Token bucket rate limiter per IP.
 * Supports separate limits for read/write, auth failure backoff,
 * SSE connection limits, and global DDoS mitigation.
 *
 * Ported from lib/security.js RateLimiter class.
 */
export declare class RateLimiter {
    private _windows;
    private _authFails;
    private _sseConns;
    private _globalCounter;
    private _cleanupTimer;
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
    constructor(options?: RateLimiterOptions);
    /**
     * Check rate limit for a request.
     * @param ip - Client IP address
     * @returns Whether the request is allowed
     */
    checkRateLimit(ip: string): boolean;
    /**
     * Check rate limit for a specific key and operation type.
     */
    check(key: string, type?: 'read' | 'write'): RateLimitResult;
    /**
     * Record a failed authentication attempt.
     * Returns whether the IP is now blocked.
     */
    recordAuthFailure(ip: string): AuthFailureResult;
    /** Clear auth failure count for an IP (on successful auth). */
    clearAuthFailures(ip: string): void;
    /** Check if an IP is currently blocked from auth attempts. */
    isAuthBlocked(ip: string): {
        blocked: boolean;
        retryAfter?: number;
    };
    /** Check if a new SSE connection is allowed for the given session. */
    checkSSE(sessionId: string): SSECheckResult;
    /** Track SSE connection open (+1) / close (-1). */
    trackSSE(sessionId: string, delta: number): void;
    private _cleanup;
    /** Dispose the rate limiter and stop the cleanup timer. */
    dispose(): void;
}
/**
 * Custom error class for security-related errors.
 * Carries a safe external code (sent to client) separate from
 * the internal message (logged server-side only).
 */
export declare class SecurityError extends Error {
    readonly code: string;
    readonly statusCode: number;
    retryAfter?: number;
    constructor(code: string, message: string, statusCode?: number);
}
/** Error code to HTTP status code mapping. */
export declare const ERROR_STATUS_MAP: Record<string, number>;
/** Safe error messages — the ONLY messages ever sent to unauthenticated clients. */
export declare const SAFE_ERROR_MESSAGES: Record<string, string>;
/**
 * Validate a Jira ticket ID. Returns sanitized ticket or null.
 * Single canonical ticket validator.
 */
export declare function validateTicket(raw: string): string | null;
/**
 * Validate a gate parameter against the whitelist.
 */
export declare function validateGate(raw: string): string | null;
/**
 * Validate a stage parameter against the whitelist.
 */
export declare function validateStage(raw: string): string | null;
/**
 * Unified input sanitization.
 * Takes a parsed body and a schema, returns sanitized values or throws.
 * Strips unknown fields (only fields in the schema are returned).
 */
export declare function sanitize(body: unknown, schema: SchemaDefinition): Record<string, unknown>;
/**
 * Parse a POST body with size limit and prototype pollution guard.
 * Uses Object.create(null) for the base object to prevent prototype pollution.
 * Chunk-buffered with configurable size limit.
 */
export declare function parseBodySafe(request: IncomingMessage, maxSize?: number): Promise<unknown>;
/** Per-endpoint field whitelists. */
export declare const ENDPOINT_SCHEMAS: EndpointSchemas;
/** Per-endpoint body size limits (in bytes). */
export declare const ENDPOINT_SIZE_LIMITS: EndpointSizeLimits;
/** Parse cookies from a request's Cookie header. */
export declare function parseCookies(request: IncomingMessage): Record<string, string>;
/** Build a Set-Cookie header value. */
export declare function buildSetCookie(name: string, value: string, options?: {
    maxAge?: number;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    secure?: boolean;
    path?: string;
}): string;
/**
 * Authenticate a request. Checks in order:
 *   1. Session cookie
 *   2. X-Api-Token header (creates session on first valid token use)
 *   3. ?token= query param (SSE fallback -- EventSource can't set headers)
 */
export declare function authenticate(url: URL, request: IncomingMessage, apiToken: string, sessionStore: SessionStore): AuthResult;
/** Send a 401 Unauthorized JSON response. */
export declare function sendUnauthorized(res: ServerResponse, message?: string): void;
/** Send a 403 Forbidden response for CORS violations. */
export declare function sendCORSForbidden(res: ServerResponse): void;
/**
 * Send a structured, safe error response.
 * For authenticated users: includes the specific error message.
 * For unauthenticated users: only includes the generic safe message.
 */
export declare function sendError(res: ServerResponse, error: Error, authenticated?: boolean): void;
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
export declare function securityMiddleware(url: URL, request: IncomingMessage, res: ServerResponse, apiToken: string, sessionStore: SessionStore, rateLimiter: RateLimiter): SecurityMiddlewareResult;
