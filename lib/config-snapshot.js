"use strict";

/**
 * Config Snapshot & Freeze + Fresh Config Reading
 *
 * Solves problems #1-5:
 * - Captures ALL config at fetch_ticket into state._config_snapshot
 * - Classifies fields as FROZEN (identity/security) vs FRESH (tunable)
 * - getConfig(name) reads fresh for tunable fields, snapshot for frozen
 * - Compares live vs snapshot on each stage entry, logs drifts
 */

const { logInfo, logWarn, logDebug } = require("./logging");

// ── Field classification ────────────────────────────────────────────
// FROZEN fields: identity, security, project structure - must not change mid-pipeline
// FRESH fields: timeouts, flags, limits - can be tuned mid-run

const FROZEN_FIELDS = new Set([
  // Project identity
  "TICKET",
  "GITLAB_PROJECT_ID",
  "GITLAB_URL",
  "GITLAB_CLONE_URL",
  "GITLAB_TOKEN",
  "GITLAB_ASSIGNEE_ID",
  "JIRA_EMAIL",
  "JIRA_TOKEN",
  // Branch structure
  "BRANCH_TS",
  "BRANCH_QA",
  "BRANCH_PREPROD",
  "BRANCH_PROD",
  // Credentials
  "QA_MAIN_USER",
  "QA_MAIN_PASS",
  "QA1_USER",
  "QA1_PASS",
  "SLACK_WEBHOOK",
  "OWNER_SLACK_ID",
  "ANSHIT_SLACK_ID",
  "OWNER_JIRA_ID",
  "ANSHIT_JIRA_ID",
  // URLs
  "QA_URL",
  "QA1_URL",
]);

const FRESH_FIELDS = new Set([
  // Timeouts (tunable mid-run)
  "MAX_PIPELINE_DURATION",
  "MAX_APPROVAL_TIMEOUT",
  "MAX_CONTINUE_WAIT",
  "ANALYSIS_TIMEOUT",
  "DEVELOPER_TIMEOUT",
  "REVIEWER_TIMEOUT",
  "TEST_FIXER_TIMEOUT",
  "CI_TIMEOUT",
  "CLAUDE_TIMEOUT",
  "URL_FETCH_TIMEOUT",
  "BUILD_INSTALL_TIMEOUT",
  "BUILD_TSC_TIMEOUT",
  "BUILD_ESLINT_TIMEOUT",
  "UNIT_TESTS_TIMEOUT",
  "E2E_TESTS_TIMEOUT",
  "VITE_PREVIEW_TIMEOUT",
  "VITE_BUILD_TIMEOUT",
  "VERIFICATION_TIMEOUT",
  "NX_SERVE_TIMEOUT",
  "QA_HEALTH_TIMEOUT",
  "MERGE_POLL_TIMEOUT",
  // Flags (can toggle mid-run)
  "RUN_BUILD_CHECK",
  "BROWSER_VERIFY",
  "RUN_RUNTIME_TESTS",
  "JIRA_COMMENTS_ENABLED",
  "SKIP_SMOKE_CHECK",
  // Limits (tunable)
  "MAX_REJECTIONS",
  "MAX_PLAN_REJECTIONS",
  "MAX_PROMPT_TOKENS",
  "FETCH_CONCURRENCY",
  "MAX_VERIFY_RETRIES",
  "MAX_UNIT_TEST_RETRIES",
  "MAX_E2E_TEST_RETRIES",
  "CONSOLE_WARNING_THRESHOLD",
  // Logging
  "LOG_LEVEL",
  "LOG_FORMAT",
  "SAVE_DEBUG_OUTPUT",
]);

// ── Snapshot capture ────────────────────────────────────────────────

function captureConfigSnapshot(cfg) {
  const snapshot = {
    _captured_at: new Date().toISOString(),
    _captured_pid: process.pid,
    // Frozen: project identity
    TICKET: process.env.TICKET,
    GITLAB_PROJECT_ID: cfg.gitlab.projectId,
    GITLAB_URL: cfg.gitlab.base,
    GITLAB_CLONE_URL: cfg.gitlab.cloneUrl,
    GITLAB_ASSIGNEE_ID: cfg.git.assigneeId,
    // Frozen: credentials (store hashes, not values)
    GITLAB_TOKEN_HASH: _hashToken(cfg.gitlab.token),
    JIRA_TOKEN_HASH: _hashToken(cfg.jira.token),
    JIRA_EMAIL: cfg.jira.email,
    SLACK_WEBHOOK_SET: !!cfg.slack.webhook,
    // Frozen: branch structure
    BRANCH_TS: cfg.branch.ts,
    BRANCH_QA: cfg.branch.qa,
    BRANCH_PREPROD: cfg.branch.preProd,
    BRANCH_PROD: cfg.branch.prod,
    // Frozen: approver IDs
    OWNER_JIRA_ID: cfg.ids.owner,
    ANSHIT_JIRA_ID: cfg.ids.anshit,
    OWNER_SLACK_ID: cfg.slack.ownerId,
    ANSHIT_SLACK_ID: cfg.slack.anshitId,
    // Frozen: QA credentials
    QA_MAIN_USER: cfg.qa.main.user,
    QA_MAIN_PASS_SET: !!cfg.qa.main.pass,
    QA1_USER: cfg.qa.qa1.user,
    QA1_PASS_SET: !!cfg.qa.qa1.pass,
    // Frozen: URLs
    QA_URL: cfg.qa.main.url,
    QA1_URL: cfg.qa.qa1.url,
    // Fresh: current timeout values (for drift detection)
    MAX_PIPELINE_DURATION: parseInt(process.env.MAX_PIPELINE_DURATION, 10) || 86_400_000,
    MAX_APPROVAL_TIMEOUT: parseInt(process.env.MAX_APPROVAL_TIMEOUT, 10) || 28_800_000,
    MAX_REJECTIONS: parseInt(process.env.MAX_REJECTIONS, 10) || 3,
    RUN_BUILD_CHECK: (process.env.RUN_BUILD_CHECK || "true").toLowerCase() === "true",
    BROWSER_VERIFY: (process.env.BROWSER_VERIFY || "true").toLowerCase() === "true",
    RUN_RUNTIME_TESTS: (process.env.RUN_RUNTIME_TESTS || "true").toLowerCase() === "true",
    ANALYSIS_TIMEOUT: parseInt(process.env.ANALYSIS_TIMEOUT, 10) || 600_000,
    DEVELOPER_TIMEOUT: parseInt(process.env.DEVELOPER_TIMEOUT, 10) || 900_000,
    REVIEWER_TIMEOUT: parseInt(process.env.REVIEWER_TIMEOUT, 10) || 600_000,
  };

  return snapshot;
}

function _hashToken(token) {
  if (!token) return null;
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(token).digest("hex").substring(0, 16);
}

// ── Drift detection on stage entry ──────────────────────────────────

function detectConfigDrift(snapshot, cfg) {
  if (!snapshot) return [];
  const drifts = [];

  // Check frozen fields for unexpected changes
  const checks = [
    { field: "GITLAB_PROJECT_ID", snapshotVal: snapshot.GITLAB_PROJECT_ID, liveVal: cfg.gitlab.projectId },
    { field: "GITLAB_URL", snapshotVal: snapshot.GITLAB_URL, liveVal: cfg.gitlab.base },
    { field: "JIRA_EMAIL", snapshotVal: snapshot.JIRA_EMAIL, liveVal: cfg.jira.email },
    { field: "BRANCH_TS", snapshotVal: snapshot.BRANCH_TS, liveVal: cfg.branch.ts },
    { field: "BRANCH_QA", snapshotVal: snapshot.BRANCH_QA, liveVal: cfg.branch.qa },
    { field: "OWNER_JIRA_ID", snapshotVal: snapshot.OWNER_JIRA_ID, liveVal: cfg.ids.owner },
    { field: "ANSHIT_JIRA_ID", snapshotVal: snapshot.ANSHIT_JIRA_ID, liveVal: cfg.ids.anshit },
    { field: "QA_URL", snapshotVal: snapshot.QA_URL, liveVal: cfg.qa.main.url },
    { field: "QA1_URL", snapshotVal: snapshot.QA1_URL, liveVal: cfg.qa.qa1.url },
  ];

  // Token change detection (compare hashes)
  const currentGitlabHash = _hashToken(cfg.gitlab.token);
  if (snapshot.GITLAB_TOKEN_HASH && currentGitlabHash !== snapshot.GITLAB_TOKEN_HASH) {
    drifts.push({
      field: "GITLAB_TOKEN",
      severity: "CRITICAL",
      message: "GitLab token changed mid-pipeline",
      frozen: true,
    });
  }
  const currentJiraHash = _hashToken(cfg.jira.token);
  if (snapshot.JIRA_TOKEN_HASH && currentJiraHash !== snapshot.JIRA_TOKEN_HASH) {
    drifts.push({
      field: "JIRA_TOKEN",
      severity: "CRITICAL",
      message: "Jira token changed mid-pipeline",
      frozen: true,
    });
  }

  for (const check of checks) {
    if (check.snapshotVal !== undefined && check.liveVal !== check.snapshotVal) {
      const frozen = FROZEN_FIELDS.has(check.field);
      drifts.push({
        field: check.field,
        severity: frozen ? "CRITICAL" : "INFO",
        snapshotVal: check.snapshotVal,
        liveVal: check.liveVal,
        frozen,
        message: frozen
          ? `FROZEN field "${check.field}" changed: "${check.snapshotVal}" -> "${check.liveVal}" (using snapshot value)`
          : `Field "${check.field}" changed: "${check.snapshotVal}" -> "${check.liveVal}" (using live value)`,
      });
    }
  }

  // Check fresh field drifts (informational only)
  const freshChecks = [
    { field: "MAX_REJECTIONS", snapshotVal: snapshot.MAX_REJECTIONS, liveVal: parseInt(process.env.MAX_REJECTIONS, 10) || 3 },
    { field: "RUN_BUILD_CHECK", snapshotVal: snapshot.RUN_BUILD_CHECK, liveVal: (process.env.RUN_BUILD_CHECK || "true").toLowerCase() === "true" },
    { field: "BROWSER_VERIFY", snapshotVal: snapshot.BROWSER_VERIFY, liveVal: (process.env.BROWSER_VERIFY || "true").toLowerCase() === "true" },
    { field: "RUN_RUNTIME_TESTS", snapshotVal: snapshot.RUN_RUNTIME_TESTS, liveVal: (process.env.RUN_RUNTIME_TESTS || "true").toLowerCase() === "true" },
  ];

  for (const check of freshChecks) {
    if (check.snapshotVal !== undefined && check.liveVal !== check.snapshotVal) {
      drifts.push({
        field: check.field,
        severity: "INFO",
        snapshotVal: check.snapshotVal,
        liveVal: check.liveVal,
        frozen: false,
        message: `Fresh field "${check.field}" changed: ${check.snapshotVal} -> ${check.liveVal} (using live value)`,
      });
    }
  }

  return drifts;
}

function logConfigDrifts(drifts) {
  if (!drifts || drifts.length === 0) return;

  for (const drift of drifts) {
    if (drift.severity === "CRITICAL") {
      logWarn(`CONFIG DRIFT [FROZEN]: ${drift.message}`);
    } else {
      logDebug(`CONFIG DRIFT [FRESH]: ${drift.message}`);
    }
  }
}

// ── Fresh config getters (read from env on every call) ──────────────

/**
 * Get a timeout value fresh from env (not cached at module load).
 * Falls back to snapshot value, then default.
 */
function getTimeout(name, defaultMs, state) {
  const envVal = parseInt(process.env[name], 10);
  if (!isNaN(envVal) && envVal > 0) return envVal;

  // Fall back to snapshot if available
  if (state && state.data && state.data._config_snapshot) {
    const snapVal = state.data._config_snapshot[name];
    if (snapVal !== undefined && !isNaN(snapVal)) return snapVal;
  }

  return defaultMs;
}

/**
 * Get a boolean flag fresh from env.
 */
function getFlag(name, defaultVal = true) {
  const envVal = process.env[name];
  if (envVal === undefined || envVal === "") return defaultVal;
  return envVal.toLowerCase() === "true";
}

/**
 * Get an integer config value fresh from env.
 */
function getInt(name, defaultVal) {
  const envVal = parseInt(process.env[name], 10);
  return isNaN(envVal) ? defaultVal : envVal;
}

/**
 * Get a string config value fresh from env.
 */
function getString(name, defaultVal) {
  return process.env[name] || defaultVal;
}

/**
 * Get a frozen config value from snapshot (or live if no snapshot).
 */
function getFrozen(name, state, liveFallback) {
  if (state && state.data && state.data._config_snapshot) {
    const snapVal = state.data._config_snapshot[name];
    if (snapVal !== undefined) return snapVal;
  }
  return liveFallback;
}

// ── Stage-entry config check ────────────────────────────────────────

function checkConfigOnStageEntry(state, cfg) {
  if (!state || !state.data || !state.data._config_snapshot) return;

  const drifts = detectConfigDrift(state.data._config_snapshot, cfg);
  if (drifts.length > 0) {
    logConfigDrifts(drifts);
    // Store drifts in state for UI display
    state.data._config_drifts = state.data._config_drifts || [];
    state.data._config_drifts.push({
      stage: state.stage,
      timestamp: new Date().toISOString(),
      drifts: drifts.map((d) => ({ field: d.field, severity: d.severity, message: d.message })),
    });
    // Keep only last 20 drift checks
    if (state.data._config_drifts.length > 20) {
      state.data._config_drifts = state.data._config_drifts.slice(-20);
    }
  }
}

module.exports = {
  FROZEN_FIELDS,
  FRESH_FIELDS,
  captureConfigSnapshot,
  detectConfigDrift,
  logConfigDrifts,
  checkConfigOnStageEntry,
  getTimeout,
  getFlag,
  getInt,
  getString,
  getFrozen,
};
