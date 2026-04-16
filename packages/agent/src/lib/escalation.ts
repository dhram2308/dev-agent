/**
 * escalation.ts -- Alert Escalation Engine for MI Dev Agent
 *
 * Converted from lib/escalation.js (zero functional changes).
 * Uses shared types from @mi/shared for EscalationRecord.
 *
 * Rules-based escalation system that monitors pipeline health and
 * triggers appropriate alerts when critical events occur.
 *
 * Escalation Rules:
 * 1. Pipeline stuck: no stage change in 30 min -> escalate to Slack
 * 2. 3 consecutive notification failures -> log prominently, set UI banner
 * 3. Auth failure (401 from any service) -> immediate alert with fix guidance
 * 4. Pipeline timeout approaching (80% of MAX_PIPELINE_DURATION) -> warning alert
 */

import type {
  EscalationRecord,
  PipelineState,
} from '@mi/shared';

const { MAX_PIPELINE_DURATION } = require('./config') as {
  MAX_PIPELINE_DURATION: number;
};
const { logErr, logWarn, logInfo, getCorrelationId } = require('./logging') as {
  logErr: (msg: string) => void;
  logWarn: (msg: string) => void;
  logInfo: (msg: string) => void;
  getCorrelationId: () => string;
};

// ── Configuration ────────────────────────────────────────────────
const STUCK_THRESHOLD_MS: number = parseInt(process.env.STUCK_THRESHOLD as string, 10) || 1_800_000; // 30 min
const TIMEOUT_WARNING_THRESHOLD: number = parseFloat(process.env.TIMEOUT_WARNING_PCT || "0.8"); // 80%
const CONSECUTIVE_FAIL_THRESHOLD = 3;
const CHECK_INTERVAL_MS: number = parseInt(process.env.ESCALATION_CHECK_INTERVAL as string, 10) || 60_000; // 1 min

// ── Internal State ───────────────────────────────────────────────
let _notifyFn: ((text: string, mentionIds: string[]) => Promise<void>) | null = null;
let _getStateFn: (() => any) | null = null;
let _checkInterval: ReturnType<typeof setInterval> | null = null;
let _lastStuckAlert = 0;
let _lastTimeoutWarning = 0;
let _escalationLog: any[] = []; // In-memory log of triggered escalations
const MAX_ESCALATION_LOG = 50;

// ── Dependency Injection ─────────────────────────────────────────

/**
 * Set the notification function (slack).
 */
function setNotifier(fn: any): void {
  if (typeof fn === "function") _notifyFn = fn;
}

/**
 * Set the state accessor function.
 */
function setStateAccessor(fn: any): void {
  if (typeof fn === "function") _getStateFn = fn;
}

// ── Escalation Rules ─────────────────────────────────────────────

interface EscalationRule {
  name: string;
  severity: 'critical' | 'warning' | 'info';
  check: (state: any) => { triggered: boolean; message?: string; data?: any };
  cooldownMs: number;
  lastTriggered: number;
  notifySlack: boolean;
  setUIBanner: boolean;
}

const RULES: EscalationRule[] = [
  // Rule 1: Pipeline stuck — no stage change in 30 min
  {
    name: "pipeline_stuck",
    severity: "critical",
    cooldownMs: STUCK_THRESHOLD_MS, // Don't re-alert within the same threshold
    lastTriggered: 0,
    notifySlack: true,
    setUIBanner: true,
    check(state: any) {
      if (!state || !state.data) return { triggered: false };

      const lastActivity = state.data._lastActivity;
      if (!lastActivity) return { triggered: false };

      const elapsed = Date.now() - new Date(lastActivity).getTime();
      if (elapsed < STUCK_THRESHOLD_MS) return { triggered: false };

      const minutes = Math.floor(elapsed / 60000);
      return {
        triggered: true,
        message: `Pipeline STUCK for ${minutes} min (stage: ${state.stage || "unknown"}). ` +
          `No activity since ${lastActivity}. Check agent process health.`,
        data: { stage: state.stage, minutesStuck: minutes, lastActivity },
      };
    },
  },

  // Rule 2: Consecutive notification failures
  {
    name: "notification_failures",
    severity: "critical",
    cooldownMs: 300_000, // 5 min cooldown
    lastTriggered: 0,
    notifySlack: false, // Cannot notify via Slack if Slack is broken
    setUIBanner: true,
    check(state: any) {
      if (!state || !state.data) return { triggered: false };

      const failures = state.data._notificationFailures;
      if (!Array.isArray(failures)) return { triggered: false };

      // Count recent failures (within last 10 min)
      const recentCutoff = Date.now() - 600_000;
      const recentFailures = failures.filter(
        (f: any) => new Date(f.ts).getTime() > recentCutoff
      );

      if (recentFailures.length < CONSECUTIVE_FAIL_THRESHOLD) return { triggered: false };

      return {
        triggered: true,
        message: `${recentFailures.length} notification failures in the last 10 minutes. ` +
          `Team is NOT receiving Slack alerts. Check SLACK_WEBHOOK and network.`,
        data: { failureCount: recentFailures.length, lastError: recentFailures[recentFailures.length - 1]?.slackError },
      };
    },
  },

  // Rule 3: Auth failure (401) from any service
  {
    name: "auth_failure",
    severity: "critical",
    cooldownMs: 600_000, // 10 min cooldown
    lastTriggered: 0,
    notifySlack: true,
    setUIBanner: true,
    check(state: any) {
      if (!state || !state.data) return { triggered: false };

      const lastError = state.data._lastError;
      if (!lastError) return { triggered: false };

      const errorMsg: string = lastError.message || "";
      const isAuthError =
        errorMsg.includes("401") ||
        errorMsg.includes("Unauthorized") ||
        errorMsg.includes("Authentication failed") ||
        errorMsg.includes("token expired") ||
        errorMsg.includes("token invalid");

      if (!isAuthError) return { triggered: false };

      // Determine which service
      let service = "unknown";
      let fixGuidance = "";
      if (errorMsg.includes("jira") || errorMsg.includes("atlassian")) {
        service = "Jira";
        fixGuidance = "Update JIRA_TOKEN and JIRA_EMAIL in .env, then restart.";
      } else if (errorMsg.includes("gitlab") || errorMsg.includes("10.200.11.32")) {
        service = "GitLab";
        fixGuidance = "Update GITLAB_TOKEN in .env, then restart.";
      } else if (errorMsg.includes("slack")) {
        service = "Slack";
        fixGuidance = "Update SLACK_WEBHOOK in .env, then restart.";
      } else {
        fixGuidance = "Check all API tokens in .env and restart.";
      }

      return {
        triggered: true,
        message: `AUTH FAILURE: ${service} returned 401 (Unauthorized). ` +
          `Pipeline cannot continue. Fix: ${fixGuidance}`,
        data: { service, error: errorMsg.substring(0, 200), stage: lastError.stage },
      };
    },
  },

  // Rule 4: Pipeline timeout approaching (80% of MAX_PIPELINE_DURATION)
  {
    name: "timeout_approaching",
    severity: "warning",
    cooldownMs: 1_800_000, // 30 min cooldown
    lastTriggered: 0,
    notifySlack: true,
    setUIBanner: true,
    check(state: any) {
      if (!state || !state.data) return { triggered: false };

      const pipelineStart = state.data._pipeline_start;
      if (!pipelineStart) return { triggered: false };

      const elapsed = Date.now() - pipelineStart;
      const threshold = MAX_PIPELINE_DURATION * TIMEOUT_WARNING_THRESHOLD;

      if (elapsed < threshold) return { triggered: false };

      // Don't alert if we're already past the timeout (main loop handles that)
      if (elapsed > MAX_PIPELINE_DURATION) return { triggered: false };

      const remainingMin = Math.floor((MAX_PIPELINE_DURATION - elapsed) / 60000);
      const elapsedHours = (elapsed / 3_600_000).toFixed(1);

      return {
        triggered: true,
        message: `Pipeline timeout WARNING: ${elapsedHours}h elapsed, ` +
          `only ${remainingMin} min remaining before ${(MAX_PIPELINE_DURATION / 3_600_000).toFixed(0)}h limit. ` +
          `Current stage: ${state.stage || "unknown"}.`,
        data: { elapsedMs: elapsed, remainingMs: MAX_PIPELINE_DURATION - elapsed, stage: state.stage },
      };
    },
  },
];

// ── Rule Engine ──────────────────────────────────────────────────

/**
 * Evaluate all escalation rules against the current state.
 * Triggered rules fire notifications and set state flags.
 */
async function evaluateRules(): Promise<Array<{ name: string; severity: string; message: string }>> {
  if (!_getStateFn) return [];

  let state: any;
  try {
    state = _getStateFn();
  } catch {
    return [];
  }

  if (!state) return [];

  const triggered: any[] = [];

  for (const rule of RULES) {
    const now = Date.now();

    // Cooldown check
    if (now - rule.lastTriggered < rule.cooldownMs) continue;

    try {
      const result = rule.check(state);
      if (!result.triggered) continue;

      rule.lastTriggered = now;

      const escalation = {
        name: rule.name,
        severity: rule.severity,
        message: result.message,
        data: result.data || {},
        ts: new Date().toISOString(),
        cid: getCorrelationId(),
      };

      triggered.push(escalation);

      // Log escalation
      _escalationLog.push(escalation);
      if (_escalationLog.length > MAX_ESCALATION_LOG) {
        _escalationLog = _escalationLog.slice(-MAX_ESCALATION_LOG);
      }

      // Log prominently
      if (rule.severity === "critical") {
        logErr(`ESCALATION [${rule.name}]: ${result.message}`);
      } else {
        logWarn(`ESCALATION [${rule.name}]: ${result.message}`);
      }

      // Set UI banner
      if (rule.setUIBanner && state.data) {
        if (!state.data._escalations) state.data._escalations = [];
        state.data._escalations.push({
          rule: rule.name,
          severity: rule.severity,
          message: result.message,
          ts: new Date().toISOString(),
        });
        // Keep last 20
        if (state.data._escalations.length > 20) {
          state.data._escalations = state.data._escalations.slice(-20);
        }
      }

      // Send Slack notification
      if (rule.notifySlack && _notifyFn) {
        try {
          const emoji = rule.severity === "critical" ? ":rotating_light:" : ":warning:";
          const slackMsg = `${emoji} *ESCALATION: ${rule.name}*\n${result.message}`;
          await _notifyFn(slackMsg, []);
        } catch (notifyErr: any) {
          logWarn(`Escalation Slack notify failed: ${notifyErr.message}`);
        }
      }
    } catch (err: any) {
      logWarn(`Escalation rule "${rule.name}" evaluation failed: ${err.message}`);
    }
  }

  return triggered;
}

// ── Periodic Evaluation ──────────────────────────────────────────

/**
 * Start periodic evaluation of escalation rules.
 */
function startMonitoring(intervalMs: number = CHECK_INTERVAL_MS): void {
  if (_checkInterval) {
    clearInterval(_checkInterval);
  }
  _checkInterval = setInterval(() => {
    evaluateRules().catch((err: any) => {
      logWarn(`Escalation monitor error: ${err.message}`);
    });
  }, intervalMs);

  // Don't prevent process exit
  if (_checkInterval.unref) {
    _checkInterval.unref();
  }

  logInfo(`Escalation monitoring started (check every ${intervalMs / 1000}s)`);
}

/**
 * Stop periodic evaluation.
 */
function stopMonitoring(): void {
  if (_checkInterval) {
    clearInterval(_checkInterval);
    _checkInterval = null;
  }
}

// ── Immediate Escalation ─────────────────────────────────────────

/**
 * Trigger an immediate escalation (not rule-based).
 * Use for one-off critical events like auth failures detected inline.
 */
async function escalateImmediate(
  name: string,
  severity: 'critical' | 'warning' | 'info',
  message: string,
  options: { notifySlack?: boolean; setUIBanner?: boolean } = {},
): Promise<void> {
  const { notifySlack = true, setUIBanner = true } = options;

  const escalation = {
    name,
    severity,
    message,
    ts: new Date().toISOString(),
    cid: getCorrelationId(),
    immediate: true,
  };

  _escalationLog.push(escalation);
  if (_escalationLog.length > MAX_ESCALATION_LOG) {
    _escalationLog = _escalationLog.slice(-MAX_ESCALATION_LOG);
  }

  if (severity === "critical") {
    logErr(`ESCALATION [${name}]: ${message}`);
  } else {
    logWarn(`ESCALATION [${name}]: ${message}`);
  }

  // UI banner
  if (setUIBanner && _getStateFn) {
    try {
      const state = _getStateFn();
      if (state && state.data) {
        if (!state.data._escalations) state.data._escalations = [];
        state.data._escalations.push({ rule: name, severity, message, ts: escalation.ts });
        if (state.data._escalations.length > 20) {
          state.data._escalations = state.data._escalations.slice(-20);
        }
      }
    } catch { /* swallow */ }
  }

  // Slack
  if (notifySlack && _notifyFn) {
    try {
      const emoji = severity === "critical" ? ":rotating_light:" : ":warning:";
      await _notifyFn(`${emoji} *ESCALATION: ${name}*\n${message}`, []);
    } catch (err: any) {
      logWarn(`Immediate escalation Slack notify failed: ${err.message}`);
    }
  }
}

// ── Query API ────────────────────────────────────────────────────

/**
 * Get the escalation log (for API/UI display).
 */
function getEscalationLog(): any[] {
  return [..._escalationLog];
}

/**
 * Get a summary of active escalations (not yet cooled down).
 */
function getActiveEscalations(): Array<{ name: string; severity: string; lastTriggered: string; cooldownRemainingMs: number }> {
  const now = Date.now();
  return RULES
    .filter((r) => r.lastTriggered > 0 && (now - r.lastTriggered) < r.cooldownMs)
    .map((r) => ({
      name: r.name,
      severity: r.severity,
      lastTriggered: new Date(r.lastTriggered).toISOString(),
      cooldownRemainingMs: r.cooldownMs - (now - r.lastTriggered),
    }));
}

/**
 * Add a custom escalation rule at runtime.
 */
function addRule(rule: Partial<EscalationRule> & { name: string; check: EscalationRule['check'] }): void {
  if (!rule || !rule.name || !rule.check) {
    throw new Error("addRule requires name and check function");
  }
  if (RULES.some((r) => r.name === rule.name)) {
    throw new Error(`Escalation rule "${rule.name}" already exists`);
  }
  RULES.push({
    name: rule.name,
    severity: rule.severity || "warning",
    cooldownMs: rule.cooldownMs || 300_000,
    lastTriggered: 0,
    notifySlack: rule.notifySlack !== false,
    setUIBanner: rule.setUIBanner !== false,
    check: rule.check,
  });
}

/**
 * Reset all rule cooldowns (for testing or restart).
 */
function resetCooldowns(): void {
  for (const rule of RULES) {
    rule.lastTriggered = 0;
  }
}

/**
 * Clear the escalation log (for testing).
 */
function clearEscalationLog(): void {
  _escalationLog = [];
}

module.exports = {
  setNotifier,
  setStateAccessor,
  evaluateRules,
  startMonitoring,
  stopMonitoring,
  escalateImmediate,
  getEscalationLog,
  getActiveEscalations,
  addRule,
  resetCooldowns,
  clearEscalationLog,
  // Exported for testing
  _RULES: RULES,
};
