/**
 * restart-protection.ts -- Agent Restart Protection
 *
 * Converted from lib/restart-protection.js (zero functional changes).
 *
 * Solves problem #7:
 * - Exponential backoff on restart: 0s, 5s, 15s, 30s, 60s, max 5min
 * - Reset backoff after 10 minutes of successful running
 * - Track restart history in state
 * - Crash loop detection (>5 restarts in 30 minutes = halt)
 */
export {};
//# sourceMappingURL=restart-protection.d.ts.map