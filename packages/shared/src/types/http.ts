// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — HTTP Client Type Definitions
// ═══════════════════════════════════════════════════════════════
//
// Derived from: lib/http-client.js
// Describes the req() function signature, circuit breaker,
// rate limiter, metrics, and related data shapes.
// ═══════════════════════════════════════════════════════════════

/**
 * HTTP response returned by req() in lib/http-client.js.
 * Generic over the response data type.
 */
export interface HttpResponse<T = unknown> {
  /** HTTP status code (e.g., 200, 404, 500) */
  status: number;
  /** Parsed response data (JSON or string depending on Content-Type) */
  data: T;
  /** Lowercase response headers */
  headers: Record<string, string>;
}

/**
 * Options passed to the req() function.
 * All fields are optional and fall back to per-service defaults.
 */
export interface HttpRequestOptions {
  /** HTTP method (defaults to "GET") */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  /** Request headers */
  headers?: Record<string, string>;
  /** Request body (will be JSON.stringify'd if object) */
  body?: unknown;
  /** Maximum retry attempts for transient errors */
  maxRetries?: number;
  /** Maximum retry attempts for 429 rate limit responses */
  maxRetries429?: number;
  /** Base backoff delay in ms for exponential retry */
  baseBackoffMs?: number;
  /** Maximum backoff delay in ms */
  maxBackoffMs?: number;
  /** Socket idle timeout in ms */
  socketTimeoutMs?: number;
  /** Response stream timeout in ms (first byte to last byte) */
  responseTimeoutMs?: number;
  /** Total wall-clock timeout in ms (including all retries) */
  totalTimeoutMs?: number;
  /** Maximum compressed response size in bytes */
  maxCompressedBytes?: number;
  /** Maximum decompressed response size in bytes */
  maxDecompressedBytes?: number;
  /** Maximum number of HTTP redirects to follow */
  maxRedirects?: number;
  /** GET request deduplication cache TTL in ms (0 = disabled) */
  dedupCacheTtlMs?: number;
  /** AbortSignal for request cancellation */
  signal?: AbortSignal;
  [key: string]: unknown;
}

/**
 * Circuit breaker states.
 * Used by the CircuitBreaker class in lib/http-client.js.
 */
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Configuration for a circuit breaker instance.
 */
export interface CircuitBreakerConfig {
  /** Number of failures in the rolling window to trip the circuit */
  threshold?: number;
  /** Rolling window duration in ms */
  windowMs?: number;
  /** Time in OPEN state before transitioning to HALF_OPEN for probing */
  cooldownMs?: number;
}

/**
 * Snapshot of a circuit breaker's current state.
 * Returned by CircuitBreaker.snapshot() for health endpoints.
 */
export interface CircuitBreakerSnapshot {
  /** Service name */
  name: string;
  /** Current circuit state */
  state: CircuitBreakerState;
  /** Number of recent failures in the rolling window */
  recentFails: number;
  /** Failure threshold to trip the circuit */
  threshold: number;
  /** Total number of times this circuit has tripped */
  totalTrips: number;
  /** ISO 8601 timestamp of the last trip (null if never tripped) */
  lastTrip: string | null;
  /** ISO 8601 timestamp when the circuit was opened (null if closed) */
  openedAt: string | null;
}

/**
 * Rate limit info for a single service.
 * Part of the RateLimitTracker.snapshot() output.
 */
export interface RateLimitInfo {
  /** Remaining requests allowed before rate limit */
  remaining: number;
  /** ISO 8601 timestamp when the rate limit resets (null if unknown) */
  resetAt: string | null;
  /** ISO 8601 timestamp until which requests are blocked (null if not blocked) */
  blockedUntil: string | null;
}

/**
 * Per-service request metrics.
 * Part of the MetricsCollector.snapshot() output.
 */
export interface RequestMetrics {
  /** Total number of requests made */
  requests: number;
  /** Number of successful requests (2xx/3xx) */
  successes: number;
  /** Number of failed requests */
  failures: number;
  /** Error rate (failures / requests, 0-1) */
  errorRate: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** 95th percentile latency in ms */
  p95LatencyMs: number;
  /** Total bytes received */
  bytesIn: number;
  /** Total bytes sent */
  bytesOut: number;
  /** Last error message (null if no errors) */
  lastError: string | null;
  /** ISO 8601 timestamp of the last error (null if no errors) */
  lastErrorAt: string | null;
  /** Circuit breaker snapshot for this service (null if no breaker) */
  circuit: CircuitBreakerSnapshot | null;
}

/**
 * Full health snapshot from MetricsCollector.snapshot().
 * Combines uptime, per-service metrics, and rate limit info.
 */
export interface HealthSnapshot {
  /** Uptime in ms since the MetricsCollector was created */
  uptimeMs: number;
  /** Per-service request metrics */
  services: Record<string, RequestMetrics>;
  /** Per-service rate limit state */
  rateLimits: Record<string, RateLimitInfo>;
}
