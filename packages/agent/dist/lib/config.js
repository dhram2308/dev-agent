"use strict";
/**
 * config.ts -- Schema-driven configuration for MI Dev Agent
 *
 * Converted from lib/config.js (zero functional changes).
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_VERIFY_RETRIES = exports.BROWSER_VERIFY = exports.PLAYWRIGHT_BROWSER = exports.TEST_ARTIFACTS_DIR = exports.CONSOLE_WARNING_THRESHOLD = exports.MAX_E2E_TEST_RETRIES = exports.MAX_UNIT_TEST_RETRIES = exports.VITE_BUILD_TIMEOUT = exports.VITE_PREVIEW_TIMEOUT = exports.E2E_TESTS_TIMEOUT = exports.UNIT_TESTS_TIMEOUT = exports.RUN_RUNTIME_TESTS = exports.MAX_COMMIT_FILE_SIZE = exports.GIT_CLONE_DEPTH = exports.APPROVAL_REMINDER_4H = exports.APPROVAL_REMINDER_1H = exports.BUILD_ESLINT_TIMEOUT = exports.BUILD_TSC_TIMEOUT = exports.BUILD_INSTALL_TIMEOUT = exports.RUN_BUILD_CHECK = exports.SKIP_SMOKE_CHECK = exports.MERGE_POLL_TIMEOUT = exports.QA_SMOKE_LEVEL = exports.MAX_STATE_SIZE = exports.MAX_TOTAL_URL_CONTENT = exports.MAX_TOTAL_ATTACHMENTS = exports.MAX_TOTAL_COMMENTS = exports.URL_FETCH_TIMEOUT = exports.FETCH_CONCURRENCY = exports.MAX_PROMPT_TOKENS = exports.TEST_FIXER_TIMEOUT_MS = exports.SECURITY_TIMEOUT_MS = exports.REVIEWER_TIMEOUT_MS = exports.BUILD_FIXER_MAX_TURNS = exports.FIXER_MAX_TURNS = exports.REVIEWER_MAX_TURNS = exports.DEVELOPER_MAX_TURNS = exports.DEVELOPER_TIMEOUT_MS = exports.ANALYSIS_TIMEOUT_MS = exports.MAX_PLAN_REJECTIONS = exports.MAX_CONTINUE_WAIT = exports.MAX_PIPELINE_DURATION = exports.MAX_REJECTIONS = exports.MAX_APPROVAL_TIMEOUT = exports.JIRA_COMMENTS = exports.CI_TIMEOUT = exports.CI_POLL = exports.POLL_INTERVAL = exports.STATE_FILE = exports.TICKET = void 0;
exports.cfg = exports.LOG_FORMAT = exports.SAVE_DEBUG_OUTPUT = exports.LOG_LEVEL = exports.QA_HEALTH_TIMEOUT = exports.EVIDENCE_MAX_SIZE = exports.VERIFICATION_TIMEOUT = exports.VITE_PREVIEW_PORT_END = exports.VITE_PREVIEW_PORT_START = exports.NX_SERVE_PORT_RANGE_END = exports.NX_SERVE_PORT_RANGE_START = exports.NX_SERVE_TIMEOUT = void 0;
exports.applyComplexityTimeout = applyComplexityTimeout;
exports.monotonicMs = monotonicMs;
exports.validateMRTarget = validateMRTarget;
exports.validateConfig = validateConfig;
exports.reloadConfig = reloadConfig;
exports.getConfigSnapshot = getConfigSnapshot;
const path_1 = __importDefault(require("path"));
const constants_1 = require("./constants");
// TODO: tighten type — these come from unconverted modules
const { loadAndApplyEnv } = require("./env-parser");
const { CONFIG_SCHEMA, parseByType } = require("./config-schema");
const { validateAllConfig, formatValidationResults: _formatValidationResults, createConfigSnapshot: createValidateSnapshot, hotReloadConfig, } = require("./config-validate");
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
exports.TICKET = _parsed.TICKET || (process.env.TICKET || "").trim().toUpperCase() || "";
exports.STATE_FILE = exports.TICKET ? path_1.default.join(__dirname, "..", "..", `state-${exports.TICKET}.json`) : "";
// ── Polling & timeout constants ───────────────────────────────────
// All parsed through schema with type-safe parseInt (no parseInt(0) bug).
exports.POLL_INTERVAL = _parsed.POLL_INTERVAL;
exports.CI_POLL = _parsed.CI_POLL;
exports.CI_TIMEOUT = _parsed.CI_TIMEOUT;
exports.JIRA_COMMENTS = _parsed.JIRA_COMMENTS_ENABLED;
exports.MAX_APPROVAL_TIMEOUT = _parsed.MAX_APPROVAL_TIMEOUT;
exports.MAX_REJECTIONS = _parsed.MAX_REJECTIONS;
exports.MAX_PIPELINE_DURATION = _parsed.MAX_PIPELINE_DURATION;
exports.MAX_CONTINUE_WAIT = _parsed.MAX_CONTINUE_WAIT;
exports.MAX_PLAN_REJECTIONS = _parsed.MAX_PLAN_REJECTIONS;
// ── Named timeouts for each agent ─────────────────────────────────
exports.ANALYSIS_TIMEOUT_MS = _parsed.ANALYSIS_TIMEOUT;
exports.DEVELOPER_TIMEOUT_MS = _parsed.DEVELOPER_TIMEOUT;
exports.DEVELOPER_MAX_TURNS = _parsed.DEVELOPER_MAX_TURNS;
exports.REVIEWER_MAX_TURNS = _parsed.REVIEWER_MAX_TURNS;
exports.FIXER_MAX_TURNS = _parsed.FIXER_MAX_TURNS;
exports.BUILD_FIXER_MAX_TURNS = _parsed.BUILD_FIXER_MAX_TURNS;
exports.REVIEWER_TIMEOUT_MS = _parsed.REVIEWER_TIMEOUT;
// M23: Security audits do deeper grep/read work than reviewer pattern checks
// and deserve their own budget. Falls back to REVIEWER_TIMEOUT to preserve
// existing behavior when SECURITY_TIMEOUT isn't set in the env.
exports.SECURITY_TIMEOUT_MS = _parsed.SECURITY_TIMEOUT || _parsed.REVIEWER_TIMEOUT;
exports.TEST_FIXER_TIMEOUT_MS = _parsed.TEST_FIXER_TIMEOUT;
// ── Complexity-aware timeout multiplier ───────────────────────────
// TODO: tighten type — state has a complex shape
function applyComplexityTimeout(baseTimeout, state) {
    const multiplier = state?.data?.ticket?.complexity?.timeoutMultiplier;
    if (!multiplier || multiplier === 1)
        return baseTimeout;
    return Math.round(baseTimeout * multiplier);
}
// ── Prompt size validation ────────────────────────────────────────
exports.MAX_PROMPT_TOKENS = _parsed.MAX_PROMPT_TOKENS;
// ── Parallel fetching ─────────────────────────────────────────────
exports.FETCH_CONCURRENCY = _parsed.FETCH_CONCURRENCY;
exports.URL_FETCH_TIMEOUT = _parsed.URL_FETCH_TIMEOUT;
// ── Total context accumulation caps ───────────────────────────────
exports.MAX_TOTAL_COMMENTS = _parsed.MAX_TOTAL_COMMENTS;
exports.MAX_TOTAL_ATTACHMENTS = _parsed.MAX_TOTAL_ATTACHMENTS;
exports.MAX_TOTAL_URL_CONTENT = _parsed.MAX_TOTAL_URL_CONTENT;
exports.MAX_STATE_SIZE = _parsed.MAX_STATE_SIZE;
// ── QA & merge controls ──────────────────────────────────────────
exports.QA_SMOKE_LEVEL = _parsed.QA_SMOKE_LEVEL;
exports.MERGE_POLL_TIMEOUT = _parsed.MERGE_POLL_TIMEOUT;
exports.SKIP_SMOKE_CHECK = _parsed.SKIP_SMOKE_CHECK;
// ── Build verification ───────────────────────────────────────────
exports.RUN_BUILD_CHECK = _parsed.RUN_BUILD_CHECK;
exports.BUILD_INSTALL_TIMEOUT = _parsed.BUILD_INSTALL_TIMEOUT;
exports.BUILD_TSC_TIMEOUT = _parsed.BUILD_TSC_TIMEOUT;
exports.BUILD_ESLINT_TIMEOUT = _parsed.BUILD_ESLINT_TIMEOUT;
// ── Approval escalation ─────────────────────────────────────────
exports.APPROVAL_REMINDER_1H = _parsed.APPROVAL_REMINDER_1H;
exports.APPROVAL_REMINDER_4H = _parsed.APPROVAL_REMINDER_4H;
// ── Git controls ────────────────────────────────────────────────
exports.GIT_CLONE_DEPTH = _parsed.GIT_CLONE_DEPTH;
exports.MAX_COMMIT_FILE_SIZE = _parsed.MAX_COMMIT_FILE_SIZE;
// ── Runtime Testing Pipeline ────────────────────────────────────
exports.RUN_RUNTIME_TESTS = _parsed.RUN_RUNTIME_TESTS;
exports.UNIT_TESTS_TIMEOUT = _parsed.UNIT_TESTS_TIMEOUT;
exports.E2E_TESTS_TIMEOUT = _parsed.E2E_TESTS_TIMEOUT;
exports.VITE_PREVIEW_TIMEOUT = _parsed.VITE_PREVIEW_TIMEOUT;
exports.VITE_BUILD_TIMEOUT = _parsed.VITE_BUILD_TIMEOUT;
exports.MAX_UNIT_TEST_RETRIES = _parsed.MAX_UNIT_TEST_RETRIES;
exports.MAX_E2E_TEST_RETRIES = _parsed.MAX_E2E_TEST_RETRIES;
exports.CONSOLE_WARNING_THRESHOLD = _parsed.CONSOLE_WARNING_THRESHOLD;
exports.TEST_ARTIFACTS_DIR = _parsed.TEST_ARTIFACTS_DIR;
exports.PLAYWRIGHT_BROWSER = _parsed.PLAYWRIGHT_BROWSER;
// ── Browser Verification Pipeline ───────────────────────────────
exports.BROWSER_VERIFY = _parsed.BROWSER_VERIFY;
exports.MAX_VERIFY_RETRIES = _parsed.MAX_VERIFY_RETRIES;
exports.NX_SERVE_TIMEOUT = _parsed.NX_SERVE_TIMEOUT;
exports.NX_SERVE_PORT_RANGE_START = _parsed.NX_SERVE_PORT_RANGE_START;
exports.NX_SERVE_PORT_RANGE_END = _parsed.NX_SERVE_PORT_RANGE_END;
exports.VITE_PREVIEW_PORT_START = _parsed.VITE_PREVIEW_PORT_START;
exports.VITE_PREVIEW_PORT_END = _parsed.VITE_PREVIEW_PORT_END;
exports.VERIFICATION_TIMEOUT = _parsed.VERIFICATION_TIMEOUT;
exports.EVIDENCE_MAX_SIZE = _parsed.EVIDENCE_MAX_SIZE;
exports.QA_HEALTH_TIMEOUT = _parsed.QA_HEALTH_TIMEOUT;
// ── Logging configuration ───────────────────────────────────────
exports.LOG_LEVEL = _parsed.LOG_LEVEL;
exports.SAVE_DEBUG_OUTPUT = _parsed.SAVE_DEBUG_OUTPUT;
exports.LOG_FORMAT = _parsed.LOG_FORMAT;
// ── V9: Monotonic clock ─────────────────────────────────────────
function monotonicMs() { return Number(process.hrtime.bigint() / 1000000n); }
// ── S5: MR target validation ────────────────────────────────────
function validateMRTarget(targetBranch) {
    if (!constants_1.ALLOWED_MR_TARGETS.includes(targetBranch)) {
        throw new Error(`S5: Invalid MR target branch: "${targetBranch}". Allowed: ${constants_1.ALLOWED_MR_TARGETS.join(", ")}`);
    }
}
// ── Master configuration object ─────────────────────────────────
// EXACT same shape as original — all consumer paths unchanged.
exports.cfg = {
    jira: {
        base: _parsed.JIRA_BASE_URL || "https://mastersindia-sols.atlassian.net",
        email: _parsed.JIRA_EMAIL,
        token: _parsed.JIRA_TOKEN,
        get auth() { return Buffer.from(`${this.email}:${this.token}`).toString("base64"); },
    },
    gitlab: {
        base: _parsed.GITLAB_URL || "http://10.200.11.32",
        token: _parsed.GITLAB_TOKEN,
        projectId: _parsed.GITLAB_PROJECT_ID !== undefined ? String(_parsed.GITLAB_PROJECT_ID) : undefined,
        cloneUrl: _parsed.GITLAB_CLONE_URL || "git@10.200.11.32:mastersindia/mi_frontend_apps.git",
        authMode: _parsed.GITLAB_AUTH_MODE || "pat",
    },
    slack: {
        webhook: _parsed.SLACK_WEBHOOK,
        ownerId: _parsed.OWNER_SLACK_ID,
        qaId: _parsed.QA_SLACK_ID,
    },
    ids: {
        owner: _parsed.OWNER_JIRA_ID,
        qa: _parsed.QA_JIRA_ID,
    },
    urls: {
        qa: _parsed.QA_URL || "https://qa-enterprise.mastersindia-einv.com",
        qa1: _parsed.QA1_URL || "https://qa1-enterprise.mastersindia-einv.com",
        preProd: "https://pre-gst.mastersindia.co",
        prod: "https://gst.mastersindia.co",
    },
    qa: {
        main: {
            url: _parsed.QA_URL || "https://qa-enterprise.mastersindia-einv.com",
            user: _parsed.QA_MAIN_USER || "",
            pass: _parsed.QA_MAIN_PASS || "",
            modules: [
                { name: "Dashboard", path: "/dashboard" },
                { name: "GST Return", path: "/gst-return" },
                { name: "Reports", path: "/reports" },
                { name: "Configurations", path: "/config" },
                { name: "Import", path: "/import" },
            ],
        },
        qa1: {
            url: _parsed.QA1_URL || "https://qa1-enterprise.mastersindia-einv.com",
            user: _parsed.QA1_USER || "",
            pass: _parsed.QA1_PASS || "",
            modules: [
                { name: "IMS (Inventory)", path: "/ims" },
                { name: "Reconcile", path: "/reconcile" },
            ],
        },
    },
    branch: {
        ts: "enterprise-ts",
        qa: "enterprise-qa",
        preProd: "enterprise-pre-pro",
        prod: "enterprise-master",
    },
    git: {
        authorName: _parsed.GIT_AUTHOR_NAME || "Yogendra",
        authorEmail: _parsed.GIT_AUTHOR_EMAIL || "yogendrasingh@mastersindia.co",
        assigneeId: _parsed.GITLAB_ASSIGNEE_ID !== undefined ? String(_parsed.GITLAB_ASSIGNEE_ID) : "123",
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
    const warns = results.filter((r) => r.severity === "WARN");
    if (fatals.length > 0 || errors.length > 0) {
        for (const f of fatals)
            logErr(f.message);
        for (const e of errors)
            logErr(e.message);
        logInfo("Run ./start.sh first, or export these env vars.");
        process.exit(1);
    }
    for (const w of warns) {
        if (logWarn)
            logWarn(w.message);
    }
}
// ── Hot-reload: mutate cfg in-place ──────────────────────────────
// Re-reads .env, re-parses all vars through schema, updates cfg and
// top-level exports for hot-reloadable vars only.
function reloadConfig(options = {}) {
    // TODO: tighten type — module.exports equivalent in TS is complex
    const topLevelExports = module.exports;
    return hotReloadConfig(exports.cfg, topLevelExports, options);
}
// ── Config snapshot using config-validate.js ─────────────────────
function getConfigSnapshot(metadata = {}) {
    const { parsed } = validateAllConfig(process.env);
    return createValidateSnapshot(parsed, metadata);
}
//# sourceMappingURL=config.js.map