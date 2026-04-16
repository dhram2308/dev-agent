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
export {};
//# sourceMappingURL=http-client.d.ts.map