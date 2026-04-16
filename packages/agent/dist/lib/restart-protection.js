"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const { logInfo, logWarn, logErr } = require('./logging');
// ── Backoff configuration ───────────────────────────────────────────
const BACKOFF_SCHEDULE_MS = [
    0, // 1st restart: immediate
    5_000, // 2nd: 5s
    15_000, // 3rd: 15s
    30_000, // 4th: 30s
    60_000, // 5th: 1m
    120_000, // 6th: 2m
    300_000, // 7th+: 5m (max)
];
const STABILITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes of stable running resets backoff
const CRASH_LOOP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const CRASH_LOOP_MAX_RESTARTS = 5; // 5 restarts in window = crash loop
/**
 * Get the restart history from state, initializing if needed.
 */
function getRestartHistory(state) {
    if (!state || !state.data)
        return { restarts: [], lastStableTs: null };
    if (!state.data._restart_history) {
        state.data._restart_history = { restarts: [], lastStableTs: null };
    }
    return state.data._restart_history;
}
/**
 * Record a restart event.
 */
function recordRestart(state, reason = "unknown") {
    const history = getRestartHistory(state);
    history.restarts.push({
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        reason,
        pid: process.pid,
    });
    // Keep only last 20 restart records
    if (history.restarts.length > 20) {
        history.restarts = history.restarts.slice(-20);
    }
    return history;
}
/**
 * Check if we are in a crash loop (too many restarts in a window).
 */
function checkCrashLoop(state) {
    const history = getRestartHistory(state);
    const windowStart = Date.now() - CRASH_LOOP_WINDOW_MS;
    const recentRestarts = history.restarts.filter((r) => r.timestamp > windowStart);
    if (recentRestarts.length >= CRASH_LOOP_MAX_RESTARTS) {
        return {
            inCrashLoop: true,
            recentCount: recentRestarts.length,
            oldestRecent: recentRestarts[0].iso,
            message: `Crash loop detected: ${recentRestarts.length} restarts in ${CRASH_LOOP_WINDOW_MS / 60000} minutes`,
        };
    }
    return {
        inCrashLoop: false,
        recentCount: recentRestarts.length,
    };
}
/**
 * Calculate the backoff delay before this restart should proceed.
 */
function calculateRestartDelay(state) {
    const history = getRestartHistory(state);
    const windowStart = Date.now() - CRASH_LOOP_WINDOW_MS;
    const recentRestarts = history.restarts.filter((r) => r.timestamp > windowStart);
    // If we were stable long enough, reset backoff
    if (history.lastStableTs) {
        const stableDuration = Date.now() - history.lastStableTs;
        if (stableDuration < STABILITY_WINDOW_MS) {
            // We recently marked as stable - use recent restart count for backoff
            const idx = Math.min(recentRestarts.length, BACKOFF_SCHEDULE_MS.length - 1);
            return BACKOFF_SCHEDULE_MS[idx];
        }
        // We've been stable long enough - reset
        return 0;
    }
    // Use recent restart count to determine backoff
    const idx = Math.min(recentRestarts.length, BACKOFF_SCHEDULE_MS.length - 1);
    return BACKOFF_SCHEDULE_MS[idx];
}
/**
 * Mark the agent as stably running (call this after a period of success).
 */
function markStable(state) {
    const history = getRestartHistory(state);
    history.lastStableTs = Date.now();
}
/**
 * Apply restart protection: check crash loop, apply backoff delay.
 */
async function applyRestartProtection(state, reason = "startup") {
    // Record this restart
    recordRestart(state, reason);
    // Check for crash loop
    const crashCheck = checkCrashLoop(state);
    if (crashCheck.inCrashLoop) {
        logErr(`[Restart] ${crashCheck.message}`);
        logErr("[Restart] Agent is in a crash loop — halting. Manual intervention required.");
        state.data._crash_loop = {
            detected: true,
            count: crashCheck.recentCount,
            timestamp: new Date().toISOString(),
        };
        return {
            proceed: false,
            delayMs: 0,
            crashLoop: true,
            reason: crashCheck.message,
        };
    }
    // Calculate backoff
    const delayMs = calculateRestartDelay(state);
    if (delayMs > 0) {
        logWarn(`[Restart] Backoff delay: ${(delayMs / 1000).toFixed(1)}s (${crashCheck.recentCount} recent restarts)`);
        await _sleep(delayMs);
        logInfo(`[Restart] Backoff complete — proceeding`);
    }
    return {
        proceed: true,
        delayMs,
        crashLoop: false,
        recentRestarts: crashCheck.recentCount,
    };
}
/**
 * Stability monitoring timer.
 */
function startStabilityMonitor(state, save) {
    const timer = setTimeout(() => {
        markStable(state);
        logInfo("[Restart] Agent marked as stable (10 minutes without crash)");
        try {
            save(state);
        }
        catch { }
    }, STABILITY_WINDOW_MS);
    // Don't let the timer prevent process exit
    if (timer.unref)
        timer.unref();
    return function stopMonitor() {
        clearTimeout(timer);
    };
}
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
module.exports = {
    BACKOFF_SCHEDULE_MS,
    STABILITY_WINDOW_MS,
    CRASH_LOOP_WINDOW_MS,
    CRASH_LOOP_MAX_RESTARTS,
    getRestartHistory,
    recordRestart,
    checkCrashLoop,
    calculateRestartDelay,
    markStable,
    applyRestartProtection,
    startStabilityMonitor,
};
//# sourceMappingURL=restart-protection.js.map