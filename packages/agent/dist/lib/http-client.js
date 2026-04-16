"use strict";
/**
 * http-client.ts -- Production HTTP Client for MI Dev Agent
 *
 * Converted from lib/http-client.js (zero functional changes).
 *
 * Features:
 *   1. Smart retry strategy (per-status-class behavior)
 *   2. Per-service circuit breaker (Jira, GitLab, Slack, QA)
 *   3. Response size protection (compressed + decompressed limits)
 *   4. Configurable timeouts (socket / response / total, per-request)
 *   5. Unified rate limit handler (Jira, GitLab, Slack header formats)
 *   6. Request metrics (count, latency, P95, bytes, circuit state)
 *   7. Request deduplication (in-flight coalescing + GET cache)
 *   8. Graceful degradation matrix (critical vs optional services)
 *
 * Zero external dependencies -- Node.js built-ins only.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const zlib_1 = __importDefault(require("zlib"));
let _log = null;
function log() {
    if (!_log) {
        try {
            _log = require("./logging");
        }
        catch (e) {
            console.warn("[HTTP] logging module not available:", e.message);
            _log = { logInfo: () => { }, logWarn: () => { }, logDebug: () => { }, logErr: () => { } };
        }
    }
    return _log;
}
// =====================================================================
// Section 0 -- Constants & Configuration
// =====================================================================
const MAX_FREE_SOCKETS = parseInt(process.env.MAX_FREE_SOCKETS, 10) || 10;
/** Keep-alive agents -- reuse TCP connections across requests */
const httpAgent = new http_1.default.Agent({ keepAlive: true, maxFreeSockets: MAX_FREE_SOCKETS });
const httpsAgent = new https_1.default.Agent({ keepAlive: true, maxFreeSockets: MAX_FREE_SOCKETS });
/**
 * Service identifiers used for circuit breakers, metrics, rate limits.
 */
const SERVICE = Object.freeze({
    JIRA: "jira",
    GITLAB: "gitlab",
    SLACK: "slack",
    QA: "qa",
    UNKNOWN: "unknown",
});
/**
 * Default configuration. Every value is overridable per-request via opts.
 */
const DEFAULTS = Object.freeze({
    // Retry
    maxRetries: 3,
    maxRetries429: 5,
    maxRetriesDecompress: 1,
    baseBackoffMs: 1000,
    maxBackoffMs: 30_000,
    // Timeouts (milliseconds)
    socketTimeoutMs: 30_000,
    responseTimeoutMs: 60_000,
    totalTimeoutMs: 120_000,
    // Response size limits
    maxCompressedBytes: 10_000_000, // 10 MB on the wire
    maxDecompressedBytes: 50_000_000, // 50 MB in memory
    // Rate limit wait clamping
    minRateLimitWaitMs: 1_000,
    maxRateLimitWaitMs: 120_000,
    // Redirects
    maxRedirects: 5,
    // Dedup cache TTL for GET requests (0 = disabled)
    dedupCacheTtlMs: 0,
});
/**
 * Per-service default timeout overrides.
 */
const SERVICE_TIMEOUTS = Object.freeze({
    [SERVICE.JIRA]: { socketTimeoutMs: 15_000, responseTimeoutMs: 30_000, totalTimeoutMs: 90_000 },
    [SERVICE.GITLAB]: { socketTimeoutMs: 30_000, responseTimeoutMs: 60_000, totalTimeoutMs: 180_000 },
    [SERVICE.SLACK]: { socketTimeoutMs: 10_000, responseTimeoutMs: 15_000, totalTimeoutMs: 30_000 },
    [SERVICE.QA]: { socketTimeoutMs: 10_000, responseTimeoutMs: 20_000, totalTimeoutMs: 60_000 },
    [SERVICE.UNKNOWN]: {},
});
/**
 * Network error codes that are safe to retry.
 */
const RETRYABLE_NET_CODES = new Set([
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE",
    "SOCKET_TIMEOUT", "ENOTFOUND", "EHOSTUNREACH", "EAI_AGAIN",
]);
// =====================================================================
// Section 1 -- Service Classifier
// =====================================================================
const _hostCache = new Map();
function classifyService(urlStr) {
    try {
        const u = new URL(urlStr);
        const host = u.hostname.toLowerCase();
        if (_hostCache.has(host))
            return _hostCache.get(host);
        let svc = SERVICE.UNKNOWN;
        if (host.includes("atlassian.net") || host.includes("jira"))
            svc = SERVICE.JIRA;
        else if (host.includes("gitlab") || host.includes("10.200.11.32"))
            svc = SERVICE.GITLAB;
        else if (host.includes("hooks.slack.com") || host.includes("slack"))
            svc = SERVICE.SLACK;
        else if (host.includes("mastersindia-einv.com") || host.includes("mastersindia.co"))
            svc = SERVICE.QA;
        _hostCache.set(host, svc);
        return svc;
    }
    catch {
        return SERVICE.UNKNOWN;
    }
}
function cancellableSleep(ms) {
    let timer = null;
    let resolveFn = null;
    const promise = new Promise((resolve) => {
        resolveFn = resolve;
        timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
    });
    return {
        promise,
        cancel() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (resolveFn)
                resolveFn("cancelled");
        },
    };
}
/** Backwards-compatible simple sleep (non-cancellable) */
function sleep(ms) { return cancellableSleep(Math.max(0, ms)).promise; }
// =====================================================================
// Section 3 -- Circuit Breaker
// =====================================================================
const CB_STATE = Object.freeze({ CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" });
class CircuitBreaker {
    name;
    threshold;
    windowMs;
    cooldownMs;
    state;
    failures;
    openedAt;
    halfOpenReq;
    totalTrips;
    lastTrip;
    constructor(name, { threshold = 5, windowMs = 60_000, cooldownMs = 30_000 } = {}) {
        this.name = name;
        this.threshold = threshold;
        this.windowMs = windowMs;
        this.cooldownMs = cooldownMs;
        this.state = CB_STATE.CLOSED;
        this.failures = []; // timestamps of recent failures
        this.openedAt = 0;
        this.halfOpenReq = false; // only one probe at a time
        // Stats
        this.totalTrips = 0;
        this.lastTrip = null;
    }
    /** Prune failures outside the rolling window */
    _prune() {
        const cutoff = Date.now() - this.windowMs;
        while (this.failures.length > 0 && this.failures[0] < cutoff) {
            this.failures.shift();
        }
    }
    /**
     * Call before making a request.
     * Returns true if the request is allowed, false if the circuit is open.
     */
    allowRequest() {
        if (this.state === CB_STATE.CLOSED)
            return true;
        if (this.state === CB_STATE.OPEN) {
            if (Date.now() - this.openedAt >= this.cooldownMs) {
                // Transition to HALF_OPEN and immediately claim the probe slot atomically
                this.state = CB_STATE.HALF_OPEN;
                this.halfOpenReq = true;
                this._prune();
                log().logInfo(`Circuit [${this.name}] -> HALF_OPEN (probing)`);
                return true;
            }
            return false;
        }
        // HALF_OPEN: allow exactly one probe request
        if (this.state === CB_STATE.HALF_OPEN) {
            if (this.halfOpenReq)
                return false; // probe already in flight
            this.halfOpenReq = true;
            return true;
        }
        return true;
    }
    /** Record a successful request -- closes the circuit */
    recordSuccess() {
        if (this.state === CB_STATE.HALF_OPEN) {
            this.state = CB_STATE.CLOSED;
            this.failures = [];
            this.halfOpenReq = false;
            log().logInfo(`Circuit [${this.name}] -> CLOSED (probe succeeded)`);
        }
        // In CLOSED state, nothing to do
    }
    /** Record a failed request -- may trip the circuit */
    recordFailure() {
        if (this.state === CB_STATE.HALF_OPEN) {
            // Probe failed -- re-open
            this.state = CB_STATE.OPEN;
            this.openedAt = Date.now();
            this.halfOpenReq = false;
            log().logWarn(`Circuit [${this.name}] -> OPEN (probe failed, cooldown ${this.cooldownMs}ms)`);
            return;
        }
        // CLOSED state -- track failure
        this.failures.push(Date.now());
        this._prune();
        if (this.failures.length >= this.threshold) {
            this.state = CB_STATE.OPEN;
            this.openedAt = Date.now();
            this.totalTrips++;
            this.lastTrip = new Date().toISOString();
            log().logWarn(`Circuit [${this.name}] -> OPEN (${this.failures.length} failures in ${this.windowMs}ms window)`);
        }
    }
    /** Return a snapshot for the health endpoint */
    snapshot() {
        this._prune();
        return {
            name: this.name,
            state: this.state,
            recentFails: this.failures.length,
            threshold: this.threshold,
            totalTrips: this.totalTrips,
            lastTrip: this.lastTrip,
            openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
        };
    }
    /** Manually reset the circuit (e.g., after token rotation) */
    reset() {
        this.state = CB_STATE.CLOSED;
        this.failures = [];
        this.openedAt = 0;
        this.halfOpenReq = false;
        log().logInfo(`Circuit [${this.name}] manually reset -> CLOSED`);
    }
}
/** One breaker per service */
const _breakers = new Map();
function getBreaker(service) {
    if (!_breakers.has(service)) {
        _breakers.set(service, new CircuitBreaker(service));
    }
    return _breakers.get(service);
}
class RateLimitTracker {
    _state;
    constructor() {
        this._state = new Map();
    }
    /**
     * Parse response headers and update state.
     * @returns recommended wait in ms if rate-limited, else null
     */
    update(service, statusCode, headers) {
        if (!headers)
            return null;
        // 1. Parse remaining quota from headers
        const remaining = this._parseRemaining(headers);
        const resetAt = this._parseReset(headers);
        if (remaining !== null) {
            this._state.set(service, {
                remaining,
                resetAt: resetAt || 0,
                blockedUntil: remaining <= 0 && resetAt ? resetAt : 0,
            });
        }
        // 2. On 429, compute how long to wait
        if (statusCode === 429) {
            const waitMs = this._parseRetryAfter(headers, resetAt);
            const clamped = this._clamp(waitMs);
            const blockedUntil = Date.now() + clamped;
            this._state.set(service, {
                remaining: 0,
                resetAt: resetAt || blockedUntil,
                blockedUntil,
            });
            return clamped;
        }
        return null;
    }
    /**
     * Pre-flight check: if we know the service is blocked, return ms to wait.
     * Returns 0 if OK to proceed.
     */
    preFlightWait(service) {
        const st = this._state.get(service);
        if (!st || !st.blockedUntil)
            return 0;
        const wait = st.blockedUntil - Date.now();
        if (wait <= 0) {
            // Reset -- block period passed
            st.blockedUntil = 0;
            return 0;
        }
        return this._clamp(wait);
    }
    /** Snapshot for health endpoint */
    snapshot() {
        const out = {};
        for (const [svc, st] of this._state) {
            out[svc] = {
                remaining: st.remaining,
                resetAt: st.resetAt ? new Date(st.resetAt).toISOString() : null,
                blockedUntil: st.blockedUntil ? new Date(st.blockedUntil).toISOString() : null,
            };
        }
        return out;
    }
    /** Reset a service's rate limit tracking */
    reset(service) {
        this._state.delete(service);
    }
    // -- Private helpers -------------------------------------------------------
    _parseRemaining(h) {
        const v = h["x-ratelimit-remaining"] || h["ratelimit-remaining"];
        if (v === undefined)
            return null;
        const n = parseInt(v, 10);
        return isNaN(n) ? null : n;
    }
    _parseReset(h) {
        const v = h["x-ratelimit-reset"] || h["ratelimit-reset"];
        if (v === undefined)
            return null;
        const n = parseInt(v, 10);
        if (isNaN(n))
            return null;
        return n < 1e12 ? n * 1000 : n;
    }
    _parseRetryAfter(h, resetAtMs) {
        const ra = h["retry-after"];
        if (ra !== undefined) {
            const n = Number(ra);
            if (!isNaN(n)) {
                if (n > 1e12)
                    return Math.max(0, n - Date.now()); // epoch ms
                else if (n > 1e9)
                    return Math.max(0, (n * 1000) - Date.now()); // epoch seconds
                else
                    return n * 1000; // seconds -> ms
            }
            // Try parsing as HTTP-date
            const d = Date.parse(ra);
            if (!isNaN(d))
                return Math.max(0, d - Date.now());
        }
        // Fallback: use reset header
        if (resetAtMs) {
            return Math.max(0, resetAtMs - Date.now());
        }
        return 5000; // safe default
    }
    _clamp(ms) {
        return Math.max(DEFAULTS.minRateLimitWaitMs, Math.min(ms, DEFAULTS.maxRateLimitWaitMs));
    }
}
const rateLimiter = new RateLimitTracker();
class MetricsCollector {
    _data;
    _startedAt;
    constructor() {
        this._data = new Map();
        this._startedAt = Date.now();
    }
    _ensure(service) {
        if (!this._data.has(service)) {
            this._data.set(service, {
                requests: 0,
                successes: 0,
                failures: 0,
                latencies: [],
                bytesIn: 0,
                bytesOut: 0,
                lastError: null,
                lastErrorAt: null,
            });
        }
        return this._data.get(service);
    }
    recordRequest(service) {
        this._ensure(service).requests++;
    }
    recordSuccess(service, latencyMs, bytesIn) {
        const m = this._ensure(service);
        m.successes++;
        m.latencies.push(latencyMs);
        if (m.latencies.length > 1000)
            m.latencies.shift();
        m.bytesIn += bytesIn || 0;
    }
    recordFailure(service, latencyMs, errorMsg) {
        const m = this._ensure(service);
        m.failures++;
        m.latencies.push(latencyMs);
        if (m.latencies.length > 1000)
            m.latencies.shift();
        m.lastError = errorMsg;
        m.lastErrorAt = new Date().toISOString();
    }
    recordBytesOut(service, bytes) {
        this._ensure(service).bytesOut += bytes || 0;
    }
    _p95(latencies) {
        if (latencies.length === 0)
            return 0;
        const sorted = [...latencies].sort((a, b) => a - b);
        const idx = Math.floor(sorted.length * 0.95);
        return sorted[Math.min(idx, sorted.length - 1)];
    }
    _avg(latencies) {
        if (latencies.length === 0)
            return 0;
        return Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    }
    /**
     * Full snapshot for the /health endpoint.
     */
    snapshot() {
        const out = { uptimeMs: Date.now() - this._startedAt, services: {} };
        for (const [svc, m] of this._data) {
            const breaker = _breakers.get(svc);
            out.services[svc] = {
                requests: m.requests,
                successes: m.successes,
                failures: m.failures,
                errorRate: m.requests > 0 ? +(m.failures / m.requests).toFixed(4) : 0,
                avgLatencyMs: this._avg(m.latencies),
                p95LatencyMs: this._p95(m.latencies),
                bytesIn: m.bytesIn,
                bytesOut: m.bytesOut,
                lastError: m.lastError,
                lastErrorAt: m.lastErrorAt,
                circuit: breaker ? breaker.snapshot() : null,
            };
        }
        out.rateLimits = rateLimiter.snapshot();
        return out;
    }
    /** Reset all metrics (useful for tests) */
    reset() {
        this._data.clear();
        this._startedAt = Date.now();
    }
}
const metrics = new MetricsCollector();
class Deduplicator {
    _inflight;
    _cache;
    _cleanupTimer;
    constructor() {
        this._inflight = new Map();
        this._cache = new Map();
        this._cleanupTimer = setInterval(() => this._cleanup(), 60_000);
        if (this._cleanupTimer.unref)
            this._cleanupTimer.unref();
    }
    key(method, url) {
        const m = (method || "GET").toUpperCase();
        if (m !== "GET" && m !== "HEAD")
            return null;
        return `${m}:${url}`;
    }
    get(key, cacheTtlMs) {
        if (!key)
            return null;
        // 1. In-flight coalescing
        const flight = this._inflight.get(key);
        if (flight) {
            if (Date.now() - flight.createdAt > 300_000) {
                this._inflight.delete(key);
            }
            else {
                return flight.promise;
            }
        }
        // 2. Cache hit
        if (cacheTtlMs > 0) {
            const cached = this._cache.get(key);
            if (cached && cached.expiresAt > Date.now()) {
                return Promise.resolve(cached.result);
            }
            this._cache.delete(key);
        }
        return null;
    }
    register(key, promise, cacheTtlMs) {
        if (!key)
            return promise;
        const entry = { promise, createdAt: Date.now() };
        this._inflight.set(key, entry);
        const cleanup = (result, isSuccess) => {
            this._inflight.delete(key);
            if (isSuccess && cacheTtlMs > 0) {
                this._cache.set(key, { result, expiresAt: Date.now() + cacheTtlMs });
            }
        };
        promise.then((res) => cleanup(res, true), () => cleanup(null, false));
        return promise;
    }
    _cleanup() {
        const now = Date.now();
        for (const [k, v] of this._cache) {
            if (v.expiresAt <= now)
                this._cache.delete(k);
        }
    }
    reset() {
        this._inflight.clear();
        this._cache.clear();
    }
    destroy() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
        this.reset();
    }
}
const dedup = new Deduplicator();
const DEGRADATION = Object.freeze({
    [SERVICE.JIRA]: {
        critical: true,
        message: "Jira API is unavailable. Pipeline halted -- ticket data cannot be fetched or updated.",
    },
    [SERVICE.GITLAB]: {
        critical: true,
        message: "GitLab API is unavailable. Pipeline halted -- code operations cannot proceed.",
    },
    [SERVICE.SLACK]: {
        critical: false,
        message: "Slack is unreachable. Notifications will be skipped until recovery.",
        fallback: () => ({ status: 200, data: { ok: true, degraded: true }, headers: {} }),
    },
    [SERVICE.QA]: {
        critical: false,
        message: "QA environment is unreachable. Health checks will be retried later.",
        fallback: () => ({ status: 503, data: null, headers: {}, degraded: true }),
    },
    [SERVICE.UNKNOWN]: {
        critical: true,
        message: "Unknown service is unavailable.",
    },
});
function checkDegradation(service) {
    const breaker = getBreaker(service);
    if (breaker.allowRequest())
        return null; // circuit allows it
    const policy = DEGRADATION[service] || DEGRADATION[SERVICE.UNKNOWN];
    if (policy.critical) {
        const err = new Error(`[Circuit OPEN] ${policy.message}`);
        err.code = "ECIRCUIT_OPEN";
        err.service = service;
        throw err;
    }
    // Non-critical: return fallback
    log().logWarn(`[Degraded] ${policy.message}`);
    return policy.fallback ? policy.fallback() : { status: 503, data: null, headers: {} };
}
function classifyStatus(status) {
    if (status === 401) {
        return { retry: false, immediate: true, reason: "Authentication failed (401). Check API tokens." };
    }
    if (status === 403) {
        return { retry: false, immediate: true, reason: "Forbidden (403). Insufficient permissions." };
    }
    if (status === 429) {
        return { retry: true, useRetryAfter: true, maxRetries: DEFAULTS.maxRetries429, reason: "Rate limited (429)" };
    }
    if (status >= 500 && status <= 599) {
        return { retry: true, maxRetries: DEFAULTS.maxRetries, reason: `Server error (${status})` };
    }
    if (status >= 400 && status < 500) {
        return { retry: false, reason: `Client error (${status})` };
    }
    return { retry: false, reason: null };
}
function classifyError(err) {
    if (err._isDecompressionError) {
        return { retry: true, maxRetries: DEFAULTS.maxRetriesDecompress, disableCompression: true, reason: "Decompression error" };
    }
    if (RETRYABLE_NET_CODES.has(err.code)) {
        return { retry: true, maxRetries: DEFAULTS.maxRetries, reason: `Network error: ${err.code}` };
    }
    return { retry: false, reason: err.message };
}
// [OAuth] Check if a service is using OAuth tokens (vs PAT/static tokens)
function _isOAuthProvider(service) {
    const oauthEnvMap = {
        gitlab: 'GITLAB_OAUTH_ACCESS_TOKEN',
        figma: 'FIGMA_OAUTH_ACCESS_TOKEN',
        google: 'GOOGLE_OAUTH_ACCESS_TOKEN',
        gdrive: 'GOOGLE_OAUTH_ACCESS_TOKEN',
    };
    const envKey = oauthEnvMap[service.toLowerCase()];
    return !!envKey && !!process.env[envKey];
}
function httpOnce(currentUrl, opts, signal, disableCompress) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            return reject(Object.assign(new Error("Request aborted"), { code: "EABORTED" }));
        }
        const u = new URL(currentUrl);
        const mod = u.protocol === "https:" ? https_1.default : http_1.default;
        const ag = u.protocol === "https:" ? httpsAgent : httpAgent;
        const body = opts.body
            ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body))
            : null;
        const headers = { "User-Agent": "MI-Dev-Agent/2.0", ...opts.headers };
        if (!disableCompress) {
            headers["Accept-Encoding"] = headers["Accept-Encoding"] || "gzip, deflate";
        }
        if (body) {
            headers["Content-Type"] = headers["Content-Type"] || "application/json";
            headers["Content-Length"] = Buffer.byteLength(body);
        }
        // Resolve effective limits
        const maxCompressed = opts.maxCompressedBytes || DEFAULTS.maxCompressedBytes;
        const maxDecompressed = opts.maxDecompressedBytes || DEFAULTS.maxDecompressedBytes;
        const socketTimeout = opts.socketTimeoutMs || DEFAULTS.socketTimeoutMs;
        const responseTimeout = opts.responseTimeoutMs || DEFAULTS.responseTimeoutMs;
        let settled = false;
        function settle(fn, val) {
            if (settled)
                return;
            settled = true;
            fn(val);
        }
        const r = mod.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + u.search,
            method: opts.method || "GET",
            headers,
            agent: ag,
        }, (res) => {
            // -- Response timeout --
            let responseTimer = null;
            if (responseTimeout > 0) {
                responseTimer = setTimeout(() => {
                    r.destroy(Object.assign(new Error("Response timeout"), { code: "ERESPONSE_TIMEOUT" }));
                }, responseTimeout);
            }
            // -- Decompress --
            let stream = res;
            const encoding = (res.headers["content-encoding"] || "").toLowerCase();
            if (encoding === "gzip") {
                stream = res.pipe(zlib_1.default.createGunzip());
            }
            else if (encoding === "deflate") {
                stream = res.pipe(zlib_1.default.createInflate());
            }
            else if (encoding === "br") {
                stream = res.pipe(zlib_1.default.createBrotliDecompress());
            }
            // -- Size tracking --
            let compressedBytes = 0;
            let decompressedBytes = 0;
            const chunks = [];
            // Track compressed (wire) size on the raw response
            res.on("data", (chunk) => {
                compressedBytes += chunk.length;
                if (compressedBytes > maxCompressed) {
                    if (responseTimer)
                        clearTimeout(responseTimer);
                    r.destroy();
                    settle(reject, new Error(`Compressed response too large: ${compressedBytes} bytes exceeds limit of ${maxCompressed} bytes`));
                }
            });
            // Track decompressed size on the (possibly piped) stream
            stream.on("data", (chunk) => {
                decompressedBytes += chunk.length;
                if (decompressedBytes > maxDecompressed) {
                    if (responseTimer)
                        clearTimeout(responseTimer);
                    r.destroy();
                    settle(reject, new Error(`Decompressed response too large: ${decompressedBytes} bytes exceeds limit of ${maxDecompressed} bytes`));
                }
                chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            });
            stream.on("error", (err) => {
                if (responseTimer)
                    clearTimeout(responseTimer);
                const decomErr = new Error(`Decompression error: ${err.message}`);
                decomErr._isDecompressionError = true;
                decomErr.code = "EDECOMPRESS";
                settle(reject, decomErr);
            });
            stream.on("end", () => {
                if (responseTimer)
                    clearTimeout(responseTimer);
                const buf = Buffer.concat(chunks);
                const d = buf.toString("utf8");
                let parsed;
                try {
                    parsed = d ? JSON.parse(d) : null;
                }
                catch {
                    parsed = d;
                }
                settle(resolve, {
                    status: res.statusCode,
                    data: parsed,
                    headers: res.headers,
                    bytesIn: decompressedBytes,
                });
            });
        });
        // -- Socket timeout --
        r.setTimeout(socketTimeout, () => {
            r.destroy(Object.assign(new Error("Socket timeout"), { code: "SOCKET_TIMEOUT" }));
        });
        // -- AbortController integration --
        if (signal) {
            const onAbort = () => {
                r.destroy(Object.assign(new Error("Request aborted"), { code: "EABORTED" }));
            };
            if (signal.aborted) {
                onAbort();
            }
            else {
                signal.addEventListener("abort", onAbort, { once: true });
                r.on("close", () => {
                    try {
                        signal.removeEventListener("abort", onAbort);
                    }
                    catch { /* ignore */ }
                });
            }
        }
        r.on("error", (err) => settle(reject, err));
        if (body) {
            metrics.recordBytesOut(classifyService(currentUrl), Buffer.byteLength(body));
            r.write(body);
        }
        r.end();
    });
}
// =====================================================================
// Section 10 -- Main Request Function (retry loop + all features)
// =====================================================================
function req(url, opts = {}) {
    const service = opts.service || classifyService(url);
    const method = (opts.method || "GET").toUpperCase();
    // -- Deduplication --
    const dedupKey = dedup.key(method, url);
    const cacheTtl = opts.dedupCacheTtlMs !== undefined ? opts.dedupCacheTtlMs : DEFAULTS.dedupCacheTtlMs;
    const existing = dedup.get(dedupKey, cacheTtl);
    if (existing) {
        log().logDebug(`[Dedup] Reusing in-flight/cached request: ${method} ${url}`);
        return existing;
    }
    // The actual request logic (wrapped so we can register it with dedup)
    const promise = _reqInternal(url, opts, service, method);
    // Register with dedup (only for GET/HEAD)
    return dedup.register(dedupKey, promise, cacheTtl);
}
async function _reqInternal(url, opts, service, method) {
    // -- Degradation check --
    const degraded = checkDegradation(service);
    if (degraded)
        return degraded;
    // -- Resolve effective timeouts --
    const svcDefaults = SERVICE_TIMEOUTS[service] || {};
    const socketTimeout = opts.socketTimeoutMs || svcDefaults.socketTimeoutMs || DEFAULTS.socketTimeoutMs;
    const responseTimeout = opts.responseTimeoutMs || svcDefaults.responseTimeoutMs || DEFAULTS.responseTimeoutMs;
    const totalTimeout = opts.totalTimeoutMs || svcDefaults.totalTimeoutMs || DEFAULTS.totalTimeoutMs;
    const maxRetries = opts.maxRetries || DEFAULTS.maxRetries;
    // Merge effective timeouts into opts for httpOnce
    const effectiveOpts = {
        ...opts,
        socketTimeoutMs: socketTimeout,
        responseTimeoutMs: responseTimeout,
    };
    // -- Total timeout via AbortController --
    let totalAc = null;
    let totalTimer = null;
    let signal = opts.signal || null;
    if (totalTimeout > 0) {
        totalAc = new AbortController();
        totalTimer = setTimeout(() => totalAc.abort(), totalTimeout);
        if (totalTimer.unref)
            totalTimer.unref();
        // If caller provided a signal, chain it
        if (signal) {
            const callerSignal = signal;
            callerSignal.addEventListener("abort", () => totalAc.abort(), { once: true });
        }
        signal = totalAc.signal;
    }
    const reqStart = Date.now();
    let currentUrl = url;
    let attempt = 0;
    let redirects = 0;
    let disableCompress = false;
    const visited = new Set();
    const breaker = getBreaker(service);
    metrics.recordRequest(service);
    try {
        while (true) {
            // -- Pre-flight rate limit check --
            const preWait = rateLimiter.preFlightWait(service);
            if (preWait > 0) {
                log().logWarn(`[RateLimit] ${service} blocked for ${preWait}ms -- waiting`);
                const { promise: sleepP, cancel: sleepCancel } = cancellableSleep(preWait);
                if (signal) {
                    signal.addEventListener("abort", sleepCancel, { once: true });
                }
                await sleepP;
                if (signal && signal.aborted) {
                    throw Object.assign(new Error("Request aborted during rate limit wait"), { code: "EABORTED" });
                }
            }
            try {
                const res = await httpOnce(currentUrl, effectiveOpts, signal, disableCompress);
                // -- Redirect following --
                if ([301, 302, 307, 308].includes(res.status) && res.headers && res.headers.location) {
                    redirects++;
                    const maxRedir = opts.maxRedirects || DEFAULTS.maxRedirects;
                    if (redirects > maxRedir) {
                        throw new Error(`Too many redirects (${maxRedir}) for ${url}`);
                    }
                    let location = res.headers.location;
                    if (location.startsWith("/")) {
                        const u = new URL(currentUrl);
                        location = `${u.protocol}//${u.host}${location}`;
                    }
                    if (visited.has(location)) {
                        throw new Error(`Redirect loop detected: ${location}`);
                    }
                    visited.add(currentUrl);
                    currentUrl = location;
                    log().logInfo(`HTTP ${res.status} redirect -> ${location}`);
                    continue;
                }
                // -- Rate limit update --
                const rateLimitWait = rateLimiter.update(service, res.status, res.headers);
                // -- Status classification --
                const cls = classifyStatus(res.status);
                const latency = Date.now() - reqStart;
                if (cls.retry === false && cls.reason === null) {
                    // 2xx success
                    breaker.recordSuccess();
                    metrics.recordSuccess(service, latency, res.bytesIn || 0);
                    log().logDebug(`HTTP ${res.status} ${method} ${currentUrl} (${latency}ms)`);
                    return { status: res.status, data: res.data, headers: res.headers };
                }
                if (cls.immediate) {
                    // 401/403 -- never retry
                    breaker.recordFailure();
                    metrics.recordFailure(service, latency, cls.reason);
                    // [OAuth] If 401 from an OAuth-mode provider, write auth failure to state and exit-78
                    if (res.status === 401 && _isOAuthProvider(service)) {
                        log().logWarn(`[OAuth] 401 from ${service} (OAuth mode). Writing _authFailure and exiting with code 78.`);
                        try {
                            const { updateSync } = require('./state-unified');
                            updateSync((state) => {
                                if (!state.data)
                                    state.data = {};
                                state.data._authFailure = { provider: service, ts: Date.now() };
                            });
                        }
                        catch (e) {
                            log().logWarn(`[OAuth] Failed to write _authFailure to state: ${e.message}`);
                        }
                        process.exit(78);
                    }
                    const err = new Error(`HTTP ${res.status}: ${cls.reason} for ${currentUrl}`);
                    err.status = res.status;
                    err.service = service;
                    log().logWarn(`HTTP ${res.status} ${method} ${currentUrl}: ${cls.reason}`);
                    throw err;
                }
                if (cls.retry) {
                    const effectiveMax = cls.maxRetries || maxRetries;
                    if (attempt < effectiveMax) {
                        attempt++;
                        // Compute backoff
                        let delay;
                        if (cls.useRetryAfter && rateLimitWait) {
                            delay = rateLimitWait;
                        }
                        else {
                            // Exponential backoff with jitter
                            const base = DEFAULTS.baseBackoffMs * Math.pow(2, attempt - 1);
                            const jitter = Math.floor(Math.random() * DEFAULTS.baseBackoffMs * 0.5);
                            delay = Math.min(base + jitter, DEFAULTS.maxBackoffMs);
                        }
                        log().logWarn(`HTTP ${res.status} ${method} ${currentUrl} -- retry ${attempt}/${effectiveMax} ` +
                            `in ${delay}ms (elapsed ${Date.now() - reqStart}ms)`);
                        const { promise: sleepP, cancel: sleepCancel } = cancellableSleep(delay);
                        if (signal)
                            signal.addEventListener("abort", sleepCancel, { once: true });
                        await sleepP;
                        if (signal && signal.aborted) {
                            throw Object.assign(new Error("Request aborted during retry backoff"), { code: "EABORTED" });
                        }
                        continue;
                    }
                    // Exhausted retries
                    breaker.recordFailure();
                    metrics.recordFailure(service, latency, cls.reason);
                    log().logWarn(`HTTP ${res.status} ${method} ${currentUrl} -- retries exhausted (${latency}ms)`);
                }
                else {
                    // Non-retryable status (4xx other than 401/403)
                    breaker.recordSuccess(); // 4xx is not a server health issue
                    metrics.recordSuccess(service, latency, res.bytesIn || 0);
                    log().logDebug(`HTTP ${res.status} ${method} ${currentUrl} (${latency}ms)`);
                }
                return { status: res.status, data: res.data, headers: res.headers };
            }
            catch (err) {
                // Aborted -- propagate immediately
                if (err.code === "EABORTED")
                    throw err;
                const cls = classifyError(err);
                const latency = Date.now() - reqStart;
                if (cls.retry) {
                    const effectiveMax = cls.maxRetries || maxRetries;
                    if (attempt < effectiveMax) {
                        attempt++;
                        if (cls.disableCompression)
                            disableCompress = true;
                        const base = DEFAULTS.baseBackoffMs * Math.pow(2, attempt - 1);
                        const jitter = Math.floor(Math.random() * DEFAULTS.baseBackoffMs * 0.3);
                        const delay = Math.min(base + jitter, DEFAULTS.maxBackoffMs);
                        log().logWarn(`${err.code || "ERROR"} ${method} ${currentUrl} -- retry ${attempt}/${effectiveMax} ` +
                            `in ${delay}ms (elapsed ${latency}ms)${cls.disableCompression ? " [no-compress]" : ""}`);
                        const { promise: sleepP, cancel: sleepCancel } = cancellableSleep(delay);
                        if (signal)
                            signal.addEventListener("abort", sleepCancel, { once: true });
                        await sleepP;
                        if (signal && signal.aborted) {
                            throw Object.assign(new Error("Request aborted during error backoff"), { code: "EABORTED" });
                        }
                        continue;
                    }
                }
                // Not retryable or retries exhausted
                breaker.recordFailure();
                metrics.recordFailure(service, latency, err.message);
                throw err;
            }
        }
    }
    finally {
        if (totalTimer)
            clearTimeout(totalTimer);
    }
}
// =====================================================================
// Section 11 -- Health & Diagnostics API
// =====================================================================
function getHealth() {
    const snap = metrics.snapshot();
    // Connection pool stats
    snap.connectionPool = {
        http: {
            freeSockets: _countSockets(httpAgent.freeSockets),
            activeSockets: _countSockets(httpAgent.sockets),
            pendingRequests: _countSockets(httpAgent.requests),
        },
        https: {
            freeSockets: _countSockets(httpsAgent.freeSockets),
            activeSockets: _countSockets(httpsAgent.sockets),
            pendingRequests: _countSockets(httpsAgent.requests),
        },
    };
    return snap;
}
function _countSockets(pool) {
    if (!pool)
        return 0;
    let count = 0;
    for (const key of Object.keys(pool)) {
        count += (pool[key] || []).length;
    }
    return count;
}
function resetCircuit(service) {
    const breaker = _breakers.get(service);
    if (breaker)
        breaker.reset();
}
function resetAll() {
    for (const b of _breakers.values())
        b.reset();
    metrics.reset();
    dedup.reset();
    for (const svc of Object.values(SERVICE))
        rateLimiter.reset(svc);
}
// =====================================================================
// Exports -- backwards compatible with existing codebase
// =====================================================================
module.exports = {
    // Core
    req,
    sleep,
    httpAgent,
    httpsAgent,
    // Cancellable sleep
    cancellableSleep,
    // Service classification
    SERVICE,
    classifyService,
    // Circuit breaker
    CircuitBreaker,
    getBreaker,
    resetCircuit,
    CB_STATE,
    // Rate limiting
    rateLimiter,
    // Metrics
    metrics,
    getHealth,
    // Deduplication
    dedup,
    // Degradation
    DEGRADATION,
    // Config defaults
    DEFAULTS,
    SERVICE_TIMEOUTS,
    // Reset (testing)
    resetAll,
};
//# sourceMappingURL=http-client.js.map