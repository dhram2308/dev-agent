"use strict";
// ═══════════════════════════════════════════════════════════════
// server/rate-limiter.ts — In-memory rate limiter per IP
// Converted from: server/rate-limiter.js (29 lines)
// ═══════════════════════════════════════════════════════════════
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkRateLimit = checkRateLimit;
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 300;
const RATE_LIMIT_WINDOW_MS = 60_000;
function checkRateLimit(ip) {
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
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetTime)
            rateLimitMap.delete(ip);
    }
}, 120_000);
cleanupInterval.unref(); // Don't prevent process exit
//# sourceMappingURL=rate-limiter.js.map