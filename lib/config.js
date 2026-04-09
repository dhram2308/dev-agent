"use strict";

/**
 * config.js — Schema-driven configuration for MI Dev Agent
 *
 * Rewritten to use:
 *   - env-parser.js     for robust .env loading (quotes, comments, multiline)
 *   - config-schema.js  for type-safe parsing (fixes parseInt(0), boolean, enum bugs)
 *   - config-validate.js for comprehensive validation (80+ vars, cross-field checks)
 *   - config-snapshot.js for pipeline snapshot & freeze
 *
 * BACKWARD COMPAT: Every export name and cfg path is identical to the original.
 * All 34 consumer files continue to work without changes.
 */

const path = require("path");
const { ALLOWED_MR_TARGETS } = require("./constants");
const { loadAndApplyEnv } = require("./env-parser");
const { CONFIG_SCHEMA, parseByType } = require("./config-schema");
const {
  validateAllConfig,
  formatValidationResults,
  createConfigSnapshot: createValidateSnapshot,
  hotReloadConfig,
} = require("./config-validate");

// ── Load .env (backward-compat wrapper) ───────────────────────────
// Uses env-parser.js instead of the old buggy line-by-line parser.
// Strips quotes, handles comments, supports multiline, warns on dupes.

const _warnings = [];

function loadEnv() {
  loadAndApplyEnv(undefined, {
    override: false,
    onWarning: (msg) => _warnings.push(msg),
  });
}

// Load on require (same behavior as original)
loadEnv();

// ── Parse ALL config vars through the schema ──────────────────────
// This fixes:
//   Bug #2: parseInt("0") || default  -> parseIntSafe returns 0 correctly
//   Bug #3: boolean "1"/"yes"/"TRUE"  -> parseBoolean handles all cases
//   Bug #4: enum "verbose"            -> parseEnum rejects invalid values
//   Bug #5: quoted env values         -> env-parser strips quotes
//   Bug #6: inline comments           -> env-parser strips them

function _parseAll() {
  const parsed = {};
  const errors = [];

  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    const rawVal = process.env[schema.env];
    const { value, error } = parseByType(rawVal, schema);
    parsed[key] = value;
    if (error) {
      errors.push({ key, env: schema.env, error });
    }
  }

  return { parsed, errors };
}

const { parsed: _parsed, errors: _parseErrors } = _parseAll();

// ── Core identifiers ──────────────────────────────────────────────
// TICKET is required — validate immediately (same as original behavior).

const TICKET = _parsed.TICKET || (process.env.TICKET || "").trim().toUpperCase() || "";
const STATE_FILE = TICKET ? path.join(__dirname, "..", `state-${TICKET}.json`) : "";

// ── Polling & timeout constants ───────────────────────────────────
// All parsed through schema with type-safe parseInt (no parseInt(0) bug).

let POLL_INTERVAL            = _parsed.POLL_INTERVAL;
let CI_POLL                  = _parsed.CI_POLL;
let CI_TIMEOUT               = _parsed.CI_TIMEOUT;
let JIRA_COMMENTS            = _parsed.JIRA_COMMENTS_ENABLED;
let MAX_APPROVAL_TIMEOUT     = _parsed.MAX_APPROVAL_TIMEOUT;
let MAX_REJECTIONS           = _parsed.MAX_REJECTIONS;
let MAX_PIPELINE_DURATION    = _parsed.MAX_PIPELINE_DURATION;
let MAX_CONTINUE_WAIT        = _parsed.MAX_CONTINUE_WAIT;
let MAX_PLAN_REJECTIONS      = _parsed.MAX_PLAN_REJECTIONS;

// ── Named timeouts for each agent ─────────────────────────────────

let ANALYSIS_TIMEOUT_MS      = _parsed.ANALYSIS_TIMEOUT;
let DEVELOPER_TIMEOUT_MS     = _parsed.DEVELOPER_TIMEOUT;
let REVIEWER_TIMEOUT_MS      = _parsed.REVIEWER_TIMEOUT;
let TEST_FIXER_TIMEOUT_MS    = _parsed.TEST_FIXER_TIMEOUT;

// ── Complexity-aware timeout multiplier ───────────────────────────

function applyComplexityTimeout(baseTimeout, state) {
  const multiplier = state?.data?.ticket?.complexity?.timeoutMultiplier;
  if (!multiplier || multiplier === 1) return baseTimeout;
  return Math.round(baseTimeout * multiplier);
}

// ── Prompt size validation ────────────────────────────────────────

let MAX_PROMPT_TOKENS        = _parsed.MAX_PROMPT_TOKENS;

// ── Parallel fetching ─────────────────────────────────────────────

let FETCH_CONCURRENCY        = _parsed.FETCH_CONCURRENCY;
let URL_FETCH_TIMEOUT        = _parsed.URL_FETCH_TIMEOUT;

// ── Total context accumulation caps ───────────────────────────────

let MAX_TOTAL_COMMENTS       = _parsed.MAX_TOTAL_COMMENTS;
let MAX_TOTAL_ATTACHMENTS    = _parsed.MAX_TOTAL_ATTACHMENTS;
let MAX_TOTAL_URL_CONTENT    = _parsed.MAX_TOTAL_URL_CONTENT;
let MAX_STATE_SIZE           = _parsed.MAX_STATE_SIZE;

// ── QA & merge controls ──────────────────────────────────────────

let QA_SMOKE_LEVEL           = _parsed.QA_SMOKE_LEVEL;
let MERGE_POLL_TIMEOUT       = _parsed.MERGE_POLL_TIMEOUT;
let SKIP_SMOKE_CHECK         = _parsed.SKIP_SMOKE_CHECK;

// ── Build verification ───────────────────────────────────────────

let RUN_BUILD_CHECK          = _parsed.RUN_BUILD_CHECK;
let BUILD_INSTALL_TIMEOUT    = _parsed.BUILD_INSTALL_TIMEOUT;
let BUILD_TSC_TIMEOUT        = _parsed.BUILD_TSC_TIMEOUT;
let BUILD_ESLINT_TIMEOUT     = _parsed.BUILD_ESLINT_TIMEOUT;

// ── Approval escalation ─────────────────────────────────────────

let APPROVAL_REMINDER_1H     = _parsed.APPROVAL_REMINDER_1H;
let APPROVAL_REMINDER_4H     = _parsed.APPROVAL_REMINDER_4H;

// ── Git controls ────────────────────────────────────────────────

const GIT_CLONE_DEPTH        = _parsed.GIT_CLONE_DEPTH;
let MAX_COMMIT_FILE_SIZE     = _parsed.MAX_COMMIT_FILE_SIZE;

// ── Runtime Testing Pipeline ────────────────────────────────────

let RUN_RUNTIME_TESTS        = _parsed.RUN_RUNTIME_TESTS;
let UNIT_TESTS_TIMEOUT       = _parsed.UNIT_TESTS_TIMEOUT;
let E2E_TESTS_TIMEOUT        = _parsed.E2E_TESTS_TIMEOUT;
let VITE_PREVIEW_TIMEOUT     = _parsed.VITE_PREVIEW_TIMEOUT;
let VITE_BUILD_TIMEOUT       = _parsed.VITE_BUILD_TIMEOUT;
let MAX_UNIT_TEST_RETRIES    = _parsed.MAX_UNIT_TEST_RETRIES;
let MAX_E2E_TEST_RETRIES     = _parsed.MAX_E2E_TEST_RETRIES;
let CONSOLE_WARNING_THRESHOLD = _parsed.CONSOLE_WARNING_THRESHOLD;
let TEST_ARTIFACTS_DIR       = _parsed.TEST_ARTIFACTS_DIR;
const PLAYWRIGHT_BROWSER     = _parsed.PLAYWRIGHT_BROWSER;

// ── Browser Verification Pipeline ───────────────────────────────

let BROWSER_VERIFY           = _parsed.BROWSER_VERIFY;
let MAX_VERIFY_RETRIES       = _parsed.MAX_VERIFY_RETRIES;
let NX_SERVE_TIMEOUT         = _parsed.NX_SERVE_TIMEOUT;
const NX_SERVE_PORT_RANGE_START = _parsed.NX_SERVE_PORT_RANGE_START;
const NX_SERVE_PORT_RANGE_END   = _parsed.NX_SERVE_PORT_RANGE_END;
const VITE_PREVIEW_PORT_START   = _parsed.VITE_PREVIEW_PORT_START;
const VITE_PREVIEW_PORT_END     = _parsed.VITE_PREVIEW_PORT_END;
let VERIFICATION_TIMEOUT     = _parsed.VERIFICATION_TIMEOUT;
let EVIDENCE_MAX_SIZE        = _parsed.EVIDENCE_MAX_SIZE;
let QA_HEALTH_TIMEOUT        = _parsed.QA_HEALTH_TIMEOUT;

// ── Logging configuration ───────────────────────────────────────

let LOG_LEVEL                = _parsed.LOG_LEVEL;
let SAVE_DEBUG_OUTPUT        = _parsed.SAVE_DEBUG_OUTPUT;
let LOG_FORMAT               = _parsed.LOG_FORMAT;

// ── V9: Monotonic clock ─────────────────────────────────────────

function monotonicMs() { return Number(process.hrtime.bigint() / 1_000_000n); }

// ── S5: MR target validation ────────────────────────────────────

function validateMRTarget(targetBranch) {
  if (!ALLOWED_MR_TARGETS.includes(targetBranch)) {
    throw new Error(`S5: Invalid MR target branch: "${targetBranch}". Allowed: ${ALLOWED_MR_TARGETS.join(", ")}`);
  }
}

// ── Master configuration object ─────────────────────────────────
// EXACT same shape as original — all consumer paths unchanged.

const cfg = {
  jira: {
    base:  _parsed.JIRA_BASE_URL || "https://mastersindia-sols.atlassian.net",
    email: _parsed.JIRA_EMAIL,
    token: _parsed.JIRA_TOKEN,
    get auth() { return Buffer.from(`${this.email}:${this.token}`).toString("base64"); },
  },
  gitlab: {
    base:      _parsed.GITLAB_URL || "http://10.200.11.32",
    token:     _parsed.GITLAB_TOKEN,
    projectId: _parsed.GITLAB_PROJECT_ID !== undefined ? String(_parsed.GITLAB_PROJECT_ID) : undefined,
    cloneUrl:  _parsed.GITLAB_CLONE_URL || "git@10.200.11.32:mastersindia/mi_frontend_apps.git",
  },
  slack: {
    webhook:  _parsed.SLACK_WEBHOOK,
    ownerId:  _parsed.OWNER_SLACK_ID,
    anshitId: _parsed.ANSHIT_SLACK_ID,
  },
  ids: {
    owner:  _parsed.OWNER_JIRA_ID,
    anshit: _parsed.ANSHIT_JIRA_ID,
  },
  urls: {
    qa:      _parsed.QA_URL || "https://qa-enterprise.mastersindia-einv.com",
    qa1:     _parsed.QA1_URL || "https://qa1-enterprise.mastersindia-einv.com",
    preProd: "https://pre-gst.mastersindia.co",
    prod:    "https://gst.mastersindia.co",
  },
  qa: {
    main: {
      url:  _parsed.QA_URL || "https://qa-enterprise.mastersindia-einv.com",
      user: _parsed.QA_MAIN_USER || "",
      pass: _parsed.QA_MAIN_PASS || "",
      modules: [
        { name: "Dashboard",      path: "/dashboard" },
        { name: "GST Return",     path: "/gst-return" },
        { name: "Reports",        path: "/reports" },
        { name: "Configurations", path: "/config" },
        { name: "Import",         path: "/import" },
      ],
    },
    qa1: {
      url:  _parsed.QA1_URL || "https://qa1-enterprise.mastersindia-einv.com",
      user: _parsed.QA1_USER || "",
      pass: _parsed.QA1_PASS || "",
      modules: [
        { name: "IMS (Inventory)", path: "/ims" },
        { name: "Reconcile",       path: "/reconcile" },
      ],
    },
  },
  branch: {
    ts:      "enterprise-ts",
    qa:      "enterprise-qa",
    preProd: "enterprise-pre-pro",
    prod:    "enterprise-master",
  },
  git: {
    authorName:  _parsed.GIT_AUTHOR_NAME || "Yogendra",
    authorEmail: _parsed.GIT_AUTHOR_EMAIL || "yogendrasingh@mastersindia.co",
    assigneeId:  _parsed.GITLAB_ASSIGNEE_ID !== undefined ? String(_parsed.GITLAB_ASSIGNEE_ID) : "123",
  },
  // Flag: local repo mode (set by main after ensureLocalRepo succeeds)
  localRepo: false,
};

// ── Comprehensive validation (replaces old 4-var check) ──────────
// Returns structured errors instead of calling process.exit().

/**
 * validateConfig() — backward-compatible wrapper.
 *
 * When called with (logErr, logInfo, logWarn) — original behavior:
 *   logs errors and calls process.exit(1) on fatal errors.
 *
 * When called with no arguments — new behavior:
 *   returns { valid, results, parsed } for programmatic use.
 */
function validateConfig(logErr, logInfo, logWarn) {
  const { valid, results, parsed } = validateAllConfig(process.env);

  // No-argument call: return structured results (new API)
  if (!logErr) {
    return { valid, results, parsed };
  }

  // With arguments: original behavior — log and exit
  const fatals = results.filter((r) => r.severity === "FATAL");
  const errors = results.filter((r) => r.severity === "ERROR");
  const warns  = results.filter((r) => r.severity === "WARN");

  if (fatals.length > 0 || errors.length > 0) {
    for (const f of fatals) logErr(f.message);
    for (const e of errors) logErr(e.message);
    logInfo("Run ./start.sh first, or export these env vars.");
    process.exit(1);
  }

  for (const w of warns) {
    if (logWarn) logWarn(w.message);
  }
}

// ── Hot-reload: mutate cfg in-place ──────────────────────────────
// Re-reads .env, re-parses all vars through schema, updates cfg and
// top-level exports for hot-reloadable vars only.

function reloadConfig(options = {}) {
  const topLevelExports = module.exports;
  return hotReloadConfig(cfg, topLevelExports, options);
}

// ── Config snapshot using config-validate.js ─────────────────────

function getConfigSnapshot(metadata = {}) {
  const { parsed } = validateAllConfig(process.env);
  return createValidateSnapshot(parsed, metadata);
}

// ── Exports ──────────────────────────────────────────────────────
// EXACT same export list as original + new additions at the end.

module.exports = {
  // Backward compat — original exports
  loadEnv,
  TICKET,
  STATE_FILE,
  POLL_INTERVAL,
  CI_POLL,
  CI_TIMEOUT,
  JIRA_COMMENTS,
  MAX_APPROVAL_TIMEOUT,
  MAX_REJECTIONS,
  MAX_PIPELINE_DURATION,
  MAX_CONTINUE_WAIT,
  MAX_PLAN_REJECTIONS,
  ANALYSIS_TIMEOUT_MS,
  DEVELOPER_TIMEOUT_MS,
  REVIEWER_TIMEOUT_MS,
  TEST_FIXER_TIMEOUT_MS,
  applyComplexityTimeout,
  MAX_PROMPT_TOKENS,
  FETCH_CONCURRENCY,
  URL_FETCH_TIMEOUT,
  MAX_TOTAL_COMMENTS,
  MAX_TOTAL_ATTACHMENTS,
  MAX_TOTAL_URL_CONTENT,
  MAX_STATE_SIZE,
  QA_SMOKE_LEVEL,
  MERGE_POLL_TIMEOUT,
  SKIP_SMOKE_CHECK,
  RUN_BUILD_CHECK,
  BUILD_INSTALL_TIMEOUT,
  BUILD_TSC_TIMEOUT,
  BUILD_ESLINT_TIMEOUT,
  APPROVAL_REMINDER_1H,
  APPROVAL_REMINDER_4H,
  GIT_CLONE_DEPTH,
  MAX_COMMIT_FILE_SIZE,
  RUN_RUNTIME_TESTS,
  UNIT_TESTS_TIMEOUT,
  E2E_TESTS_TIMEOUT,
  VITE_PREVIEW_TIMEOUT,
  VITE_BUILD_TIMEOUT,
  MAX_UNIT_TEST_RETRIES,
  MAX_E2E_TEST_RETRIES,
  CONSOLE_WARNING_THRESHOLD,
  TEST_ARTIFACTS_DIR,
  PLAYWRIGHT_BROWSER,
  BROWSER_VERIFY,
  MAX_VERIFY_RETRIES,
  NX_SERVE_TIMEOUT,
  NX_SERVE_PORT_RANGE_START,
  NX_SERVE_PORT_RANGE_END,
  VITE_PREVIEW_PORT_START,
  VITE_PREVIEW_PORT_END,
  VERIFICATION_TIMEOUT,
  EVIDENCE_MAX_SIZE,
  QA_HEALTH_TIMEOUT,
  LOG_LEVEL,
  SAVE_DEBUG_OUTPUT,
  LOG_FORMAT,
  monotonicMs,
  validateMRTarget,
  cfg,
  validateConfig,

  // New additions — schema-driven system
  reloadConfig,
  getConfigSnapshot,
};
