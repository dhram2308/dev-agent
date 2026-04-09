"use strict";

/**
 * Pipeline Health Monitor
 *
 * Solves problem #14:
 * - Background monitor that checks pipeline progress
 * - Tracks last stage change timestamp
 * - Monitors external service health (Jira, GitLab, Slack)
 * - Tracks memory usage trends
 * - Reports to state for UI display
 * - Emits warnings when stuck or services unhealthy
 */

const { logInfo, logWarn, logErr, logDebug } = require("./logging");

// ── Health check configuration ──────────────────────────────────────

const MONITOR_INTERVAL_MS = 60_000;        // Check every 1 minute
const STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes without stage change = stuck
const GATE_STUCK_THRESHOLD_MS = 10 * 60 * 60 * 1000; // 10 hours for gate stages (> MAX_APPROVAL_TIMEOUT of 8h)
const MEMORY_WARNING_MB = 512;             // Warn above 512MB RSS
const MEMORY_CRITICAL_MB = 1024;           // Critical above 1GB RSS
const MEMORY_SAMPLES_MAX = 60;             // Keep last 60 memory samples

// Gate stages have longer acceptable durations
const GATE_STAGES = new Set([
  "gate_code_review",
  "gate_preprod_approval",
  "gate_dual_approval",
]);

// ── Service health tracking ─────────────────────────────────────────

const _serviceHealth = {
  jira: { lastSuccess: null, lastFailure: null, consecutiveFailures: 0, status: "unknown" },
  gitlab: { lastSuccess: null, lastFailure: null, consecutiveFailures: 0, status: "unknown" },
  slack: { lastSuccess: null, lastFailure: null, consecutiveFailures: 0, status: "unknown" },
  claude: { lastSuccess: null, lastFailure: null, consecutiveFailures: 0, status: "unknown" },
};

/**
 * Record a successful service call.
 */
function recordServiceSuccess(serviceName) {
  const svc = _serviceHealth[serviceName];
  if (!svc) return;
  svc.lastSuccess = Date.now();
  svc.consecutiveFailures = 0;
  svc.status = "healthy";
}

/**
 * Record a failed service call.
 */
function recordServiceFailure(serviceName, error) {
  const svc = _serviceHealth[serviceName];
  if (!svc) return;
  svc.lastFailure = Date.now();
  svc.consecutiveFailures++;
  svc.lastError = error ? error.message || String(error) : "unknown";
  svc.status = svc.consecutiveFailures >= 3 ? "unhealthy" : "degraded";
}

/**
 * Get current service health snapshot.
 */
function getServiceHealth() {
  const snapshot = {};
  for (const [name, svc] of Object.entries(_serviceHealth)) {
    snapshot[name] = {
      status: svc.status,
      lastSuccess: svc.lastSuccess ? new Date(svc.lastSuccess).toISOString() : null,
      lastFailure: svc.lastFailure ? new Date(svc.lastFailure).toISOString() : null,
      consecutiveFailures: svc.consecutiveFailures,
      lastError: svc.lastError || null,
    };
  }
  return snapshot;
}

// ── Memory tracking ─────────────────────────────────────────────────

const _memorySamples = [];

function sampleMemory() {
  const usage = process.memoryUsage();
  const sample = {
    timestamp: Date.now(),
    rss: Math.round(usage.rss / 1024 / 1024),          // MB
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
    external: Math.round(usage.external / 1024 / 1024),
  };
  _memorySamples.push(sample);
  if (_memorySamples.length > MEMORY_SAMPLES_MAX) {
    _memorySamples.shift();
  }
  return sample;
}

/**
 * Detect memory trends (is memory growing?).
 */
function analyzeMemoryTrend() {
  if (_memorySamples.length < 5) return { trend: "insufficient_data" };

  const recent = _memorySamples.slice(-5);
  const older = _memorySamples.slice(-10, -5);

  if (older.length === 0) return { trend: "insufficient_data" };

  const recentAvg = recent.reduce((sum, s) => sum + s.rss, 0) / recent.length;
  const olderAvg = older.reduce((sum, s) => sum + s.rss, 0) / older.length;
  const growth = recentAvg - olderAvg;
  const growthPercent = olderAvg > 0 ? (growth / olderAvg) * 100 : 0;

  const current = recent[recent.length - 1];
  let status = "ok";
  if (current.rss > MEMORY_CRITICAL_MB) status = "critical";
  else if (current.rss > MEMORY_WARNING_MB) status = "warning";

  return {
    trend: growth > 10 ? "growing" : growth < -10 ? "shrinking" : "stable",
    currentMB: current.rss,
    growthMB: Math.round(growth),
    growthPercent: Math.round(growthPercent * 10) / 10,
    status,
  };
}

// ── Pipeline progress tracking ──────────────────────────────────────

let _lastStageChange = Date.now();
let _lastStage = null;

function recordStageChange(stageName) {
  _lastStageChange = Date.now();
  _lastStage = stageName;
}

function checkProgress(currentStage) {
  const elapsed = Date.now() - _lastStageChange;
  const threshold = GATE_STAGES.has(currentStage) ? GATE_STUCK_THRESHOLD_MS : STUCK_THRESHOLD_MS;

  if (elapsed > threshold) {
    return {
      stuck: true,
      stuckMinutes: Math.floor(elapsed / 60000),
      stage: currentStage,
      threshold: threshold / 60000,
      message: `Pipeline appears stuck on "${currentStage}" — ${Math.floor(elapsed / 60000)} minutes without progress`,
    };
  }

  return {
    stuck: false,
    elapsedMinutes: Math.floor(elapsed / 60000),
    stage: currentStage,
  };
}

// ── Health check runner ─────────────────────────────────────────────

/**
 * Run a full health check and update state.
 */
function runHealthCheck(state) {
  if (!state || !state.data) return null;

  const memorySample = sampleMemory();
  const memoryTrend = analyzeMemoryTrend();
  const serviceHealth = getServiceHealth();
  const progress = checkProgress(state.stage);
  const warnings = [];

  // Check for stuck pipeline
  if (progress.stuck) {
    warnings.push({
      level: "WARNING",
      category: "progress",
      message: progress.message,
    });
  }

  // Check memory
  if (memoryTrend.status === "critical") {
    warnings.push({
      level: "CRITICAL",
      category: "memory",
      message: `Memory usage critical: ${memoryTrend.currentMB}MB RSS (threshold: ${MEMORY_CRITICAL_MB}MB)`,
    });
  } else if (memoryTrend.status === "warning") {
    warnings.push({
      level: "WARNING",
      category: "memory",
      message: `Memory usage high: ${memoryTrend.currentMB}MB RSS (threshold: ${MEMORY_WARNING_MB}MB)`,
    });
  }
  if (memoryTrend.trend === "growing" && memoryTrend.growthPercent > 20) {
    warnings.push({
      level: "WARNING",
      category: "memory",
      message: `Memory growing: +${memoryTrend.growthMB}MB (+${memoryTrend.growthPercent}%) in recent window`,
    });
  }

  // Check services
  for (const [name, health] of Object.entries(serviceHealth)) {
    if (health.status === "unhealthy") {
      warnings.push({
        level: "WARNING",
        category: "service",
        message: `${name} service unhealthy: ${health.consecutiveFailures} consecutive failures (last: ${health.lastError || "unknown"})`,
      });
    }
  }

  // Build health report
  const report = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    stage: state.stage,
    memory: {
      current: memorySample,
      trend: memoryTrend,
    },
    services: serviceHealth,
    progress,
    warnings,
    warningCount: warnings.length,
  };

  // Store in state for UI
  state.data._health = report;

  // Log warnings
  for (const w of warnings) {
    if (w.level === "CRITICAL") {
      logErr(`[Health] ${w.message}`);
    } else {
      logWarn(`[Health] ${w.message}`);
    }
  }

  return report;
}

// ── Background monitor ──────────────────────────────────────────────

let _monitorTimer = null;

/**
 * Start the background health monitor.
 * Runs a health check every MONITOR_INTERVAL_MS.
 *
 * @param {object} state - Pipeline state
 * @param {Function} save - State save function
 * @returns {Function} Stop function
 */
function startHealthMonitor(state, save) {
  if (_monitorTimer) {
    logWarn("[Health] Monitor already running — stopping old one");
    stopHealthMonitor();
  }

  logInfo(`[Health] Starting pipeline health monitor (interval: ${MONITOR_INTERVAL_MS / 1000}s)`);
  recordStageChange(state.stage);

  _monitorTimer = setInterval(() => {
    try {
      const report = runHealthCheck(state);
      if (report && report.warningCount > 0) {
        try { save(state); } catch {}
      }
    } catch (e) {
      logDebug(`[Health] Monitor tick failed: ${e.message}`);
    }
  }, MONITOR_INTERVAL_MS);

  // Don't prevent process exit
  if (_monitorTimer.unref) _monitorTimer.unref();

  return stopHealthMonitor;
}

/**
 * Stop the background health monitor.
 */
function stopHealthMonitor() {
  if (_monitorTimer) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
    logInfo("[Health] Pipeline health monitor stopped");
  }
}

module.exports = {
  MONITOR_INTERVAL_MS,
  STUCK_THRESHOLD_MS,
  GATE_STUCK_THRESHOLD_MS,
  MEMORY_WARNING_MB,
  MEMORY_CRITICAL_MB,
  recordServiceSuccess,
  recordServiceFailure,
  getServiceHealth,
  sampleMemory,
  analyzeMemoryTrend,
  recordStageChange,
  checkProgress,
  runHealthCheck,
  startHealthMonitor,
  stopHealthMonitor,
};
