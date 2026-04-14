"use strict";
// =====================================================================
// MI Dev Agent -- Config Snapshot & Freeze
// =====================================================================
// Port of lib/config-snapshot.js to TypeScript.
//
// Solves:
// - Captures ALL config at fetch_ticket into state._config_snapshot
// - Classifies fields as FROZEN (identity/security) vs FRESH (tunable)
// - getTimeout(name, default, state) reads fresh for tunable, snapshot for frozen
// - Compares live vs snapshot on each stage entry, logs drifts
// =====================================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FRESH_FIELDS = exports.FROZEN_FIELDS = void 0;
exports.captureConfigSnapshot = captureConfigSnapshot;
exports.detectConfigDrift = detectConfigDrift;
exports.logConfigDrifts = logConfigDrifts;
exports.checkConfigOnStageEntry = checkConfigOnStageEntry;
exports.getTimeout = getTimeout;
exports.getFlag = getFlag;
exports.getInt = getInt;
exports.getString = getString;
exports.getFrozen = getFrozen;
const crypto = __importStar(require("crypto"));
// =====================================================================
// Field Classification
// =====================================================================
// FROZEN fields: identity, security, project structure - must not change mid-pipeline
// FRESH fields: timeouts, flags, limits - can be tuned mid-run
exports.FROZEN_FIELDS = new Set([
    // Project identity
    'TICKET',
    'GITLAB_PROJECT_ID',
    'GITLAB_URL',
    'GITLAB_CLONE_URL',
    'GITLAB_TOKEN',
    'GITLAB_ASSIGNEE_ID',
    'JIRA_EMAIL',
    'JIRA_TOKEN',
    // Branch structure
    'BRANCH_TS',
    'BRANCH_QA',
    'BRANCH_PREPROD',
    'BRANCH_PROD',
    // Credentials
    'QA_MAIN_USER',
    'QA_MAIN_PASS',
    'QA1_USER',
    'QA1_PASS',
    'SLACK_WEBHOOK',
    'OWNER_SLACK_ID',
    'ANSHIT_SLACK_ID',
    'OWNER_JIRA_ID',
    'ANSHIT_JIRA_ID',
    // URLs
    'QA_URL',
    'QA1_URL',
]);
exports.FRESH_FIELDS = new Set([
    // Timeouts (tunable mid-run)
    'MAX_PIPELINE_DURATION',
    'MAX_APPROVAL_TIMEOUT',
    'MAX_CONTINUE_WAIT',
    'ANALYSIS_TIMEOUT',
    'DEVELOPER_TIMEOUT',
    'REVIEWER_TIMEOUT',
    'TEST_FIXER_TIMEOUT',
    'CI_TIMEOUT',
    'CLAUDE_TIMEOUT',
    'URL_FETCH_TIMEOUT',
    'BUILD_INSTALL_TIMEOUT',
    'BUILD_TSC_TIMEOUT',
    'BUILD_ESLINT_TIMEOUT',
    'UNIT_TESTS_TIMEOUT',
    'E2E_TESTS_TIMEOUT',
    'VITE_PREVIEW_TIMEOUT',
    'VITE_BUILD_TIMEOUT',
    'VERIFICATION_TIMEOUT',
    'NX_SERVE_TIMEOUT',
    'QA_HEALTH_TIMEOUT',
    'MERGE_POLL_TIMEOUT',
    // Flags (can toggle mid-run)
    'RUN_BUILD_CHECK',
    'BROWSER_VERIFY',
    'RUN_RUNTIME_TESTS',
    'JIRA_COMMENTS_ENABLED',
    'SKIP_SMOKE_CHECK',
    // Limits (tunable)
    'MAX_REJECTIONS',
    'MAX_PLAN_REJECTIONS',
    'MAX_PROMPT_TOKENS',
    'FETCH_CONCURRENCY',
    'MAX_VERIFY_RETRIES',
    'MAX_UNIT_TEST_RETRIES',
    'MAX_E2E_TEST_RETRIES',
    'CONSOLE_WARNING_THRESHOLD',
    // Logging
    'LOG_LEVEL',
    'LOG_FORMAT',
    'SAVE_DEBUG_OUTPUT',
]);
// =====================================================================
// Internal Helpers
// =====================================================================
/** Hash a token for comparison without storing the raw value. */
function hashToken(token) {
    if (!token)
        return null;
    return crypto.createHash('sha256').update(token).digest('hex').substring(0, 16);
}
// =====================================================================
// Snapshot Capture
// =====================================================================
/**
 * Capture a complete config snapshot at a point in time.
 * This is called at the start of the pipeline (fetch_ticket stage).
 *
 * @param cfg - The live AppConfig object.
 * @param env - Environment variables (defaults to process.env).
 * @returns A snapshot object for storage in pipeline state.
 */
function captureConfigSnapshot(cfg, env = process.env) {
    const snapshot = {
        _captured_at: new Date().toISOString(),
        _captured_pid: process.pid,
        // Frozen: project identity
        TICKET: env['TICKET'],
        GITLAB_PROJECT_ID: String(cfg.gitlab.projectId),
        GITLAB_URL: cfg.gitlab.base,
        GITLAB_CLONE_URL: env['GITLAB_CLONE_URL'] || 'git@10.200.11.32:mastersindia/mi_frontend_apps.git',
        GITLAB_ASSIGNEE_ID: String(cfg.owner.gitlabId ?? 123),
        // Frozen: credentials (store hashes, not values)
        GITLAB_TOKEN_HASH: hashToken(cfg.gitlab.token),
        JIRA_TOKEN_HASH: hashToken(cfg.jira.token),
        JIRA_EMAIL: cfg.jira.email,
        SLACK_WEBHOOK_SET: !!cfg.slack.token,
        // Frozen: branch structure
        BRANCH_TS: cfg.branches.source,
        BRANCH_QA: cfg.branches.qa,
        BRANCH_PREPROD: cfg.branches.preprod,
        BRANCH_PROD: cfg.branches.prod,
        // Frozen: approver IDs
        OWNER_JIRA_ID: cfg.owner.jiraId,
        ANSHIT_JIRA_ID: env['ANSHIT_JIRA_ID'],
        OWNER_SLACK_ID: cfg.slack.ownerSlackId,
        ANSHIT_SLACK_ID: env['ANSHIT_SLACK_ID'],
        // Frozen: QA credentials
        QA_MAIN_USER: env['QA_MAIN_USER'] || 'prateekrai',
        QA_MAIN_PASS_SET: !!(env['QA_MAIN_PASS'] || 'sandboxtwo'),
        QA1_USER: env['QA1_USER'] || 'aman',
        QA1_PASS_SET: !!(env['QA1_PASS'] || 'entp'),
        // Frozen: URLs
        QA_URL: env['QA_URL'] || 'https://qa-enterprise.mastersindia-einv.com',
        QA1_URL: env['QA1_URL'] || 'https://qa1-enterprise.mastersindia-einv.com',
        // Fresh: current timeout values (for drift detection)
        MAX_PIPELINE_DURATION: parseInt(env['MAX_PIPELINE_DURATION'] || '', 10) || 86_400_000,
        MAX_APPROVAL_TIMEOUT: parseInt(env['MAX_APPROVAL_TIMEOUT'] || '', 10) || 28_800_000,
        MAX_REJECTIONS: parseInt(env['MAX_REJECTIONS'] || '', 10) || 3,
        RUN_BUILD_CHECK: (env['RUN_BUILD_CHECK'] || 'true').toLowerCase() === 'true',
        BROWSER_VERIFY: (env['BROWSER_VERIFY'] || 'true').toLowerCase() === 'true',
        RUN_RUNTIME_TESTS: (env['RUN_RUNTIME_TESTS'] || 'true').toLowerCase() === 'true',
        ANALYSIS_TIMEOUT: parseInt(env['ANALYSIS_TIMEOUT'] || '', 10) || 600_000,
        DEVELOPER_TIMEOUT: parseInt(env['DEVELOPER_TIMEOUT'] || '', 10) || 900_000,
        REVIEWER_TIMEOUT: parseInt(env['REVIEWER_TIMEOUT'] || '', 10) || 600_000,
    };
    return snapshot;
}
// =====================================================================
// Drift Detection
// =====================================================================
/**
 * Detect config drift between a stored snapshot and the live config.
 *
 * @param snapshot - The stored snapshot from pipeline state.
 * @param cfg - The live AppConfig object.
 * @param env - Environment variables (defaults to process.env).
 * @returns Array of drift records.
 */
function detectConfigDrift(snapshot, cfg, env = process.env) {
    if (!snapshot)
        return [];
    const drifts = [];
    // Check frozen fields for unexpected changes
    const frozenChecks = [
        { field: 'GITLAB_PROJECT_ID', snapshotVal: snapshot.GITLAB_PROJECT_ID, liveVal: String(cfg.gitlab.projectId) },
        { field: 'GITLAB_URL', snapshotVal: snapshot.GITLAB_URL, liveVal: cfg.gitlab.base },
        { field: 'JIRA_EMAIL', snapshotVal: snapshot.JIRA_EMAIL, liveVal: cfg.jira.email },
        { field: 'BRANCH_TS', snapshotVal: snapshot.BRANCH_TS, liveVal: cfg.branches.source },
        { field: 'BRANCH_QA', snapshotVal: snapshot.BRANCH_QA, liveVal: cfg.branches.qa },
        { field: 'OWNER_JIRA_ID', snapshotVal: snapshot.OWNER_JIRA_ID, liveVal: cfg.owner.jiraId },
        { field: 'ANSHIT_JIRA_ID', snapshotVal: snapshot.ANSHIT_JIRA_ID, liveVal: env['ANSHIT_JIRA_ID'] },
        { field: 'QA_URL', snapshotVal: snapshot.QA_URL, liveVal: env['QA_URL'] || 'https://qa-enterprise.mastersindia-einv.com' },
        { field: 'QA1_URL', snapshotVal: snapshot.QA1_URL, liveVal: env['QA1_URL'] || 'https://qa1-enterprise.mastersindia-einv.com' },
    ];
    // Token change detection (compare hashes)
    const currentGitlabHash = hashToken(cfg.gitlab.token);
    if (snapshot.GITLAB_TOKEN_HASH && currentGitlabHash !== snapshot.GITLAB_TOKEN_HASH) {
        drifts.push({
            field: 'GITLAB_TOKEN',
            severity: 'CRITICAL',
            message: 'GitLab token changed mid-pipeline',
            frozen: true,
        });
    }
    const currentJiraHash = hashToken(cfg.jira.token);
    if (snapshot.JIRA_TOKEN_HASH && currentJiraHash !== snapshot.JIRA_TOKEN_HASH) {
        drifts.push({
            field: 'JIRA_TOKEN',
            severity: 'CRITICAL',
            message: 'Jira token changed mid-pipeline',
            frozen: true,
        });
    }
    for (const check of frozenChecks) {
        if (check.snapshotVal !== undefined && check.liveVal !== check.snapshotVal) {
            const frozen = exports.FROZEN_FIELDS.has(check.field);
            drifts.push({
                field: check.field,
                severity: frozen ? 'CRITICAL' : 'INFO',
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
        {
            field: 'MAX_REJECTIONS',
            snapshotVal: snapshot.MAX_REJECTIONS,
            liveVal: parseInt(env['MAX_REJECTIONS'] || '', 10) || 3,
        },
        {
            field: 'RUN_BUILD_CHECK',
            snapshotVal: snapshot.RUN_BUILD_CHECK,
            liveVal: (env['RUN_BUILD_CHECK'] || 'true').toLowerCase() === 'true',
        },
        {
            field: 'BROWSER_VERIFY',
            snapshotVal: snapshot.BROWSER_VERIFY,
            liveVal: (env['BROWSER_VERIFY'] || 'true').toLowerCase() === 'true',
        },
        {
            field: 'RUN_RUNTIME_TESTS',
            snapshotVal: snapshot.RUN_RUNTIME_TESTS,
            liveVal: (env['RUN_RUNTIME_TESTS'] || 'true').toLowerCase() === 'true',
        },
    ];
    for (const check of freshChecks) {
        if (check.snapshotVal !== undefined && check.liveVal !== check.snapshotVal) {
            drifts.push({
                field: check.field,
                severity: 'INFO',
                snapshotVal: check.snapshotVal,
                liveVal: check.liveVal,
                frozen: false,
                message: `Fresh field "${check.field}" changed: ${check.snapshotVal} -> ${check.liveVal} (using live value)`,
            });
        }
    }
    return drifts;
}
/**
 * Log config drifts using the provided logger.
 */
function logConfigDrifts(drifts, logger) {
    if (!drifts || drifts.length === 0)
        return;
    for (const drift of drifts) {
        if (drift.severity === 'CRITICAL') {
            logger.warn(`CONFIG DRIFT [FROZEN]: ${drift.message}`);
        }
        else {
            logger.debug(`CONFIG DRIFT [FRESH]: ${drift.message}`);
        }
    }
}
/**
 * Check config on stage entry: detect frozen field drift and log it.
 *
 * @param state - The pipeline state (must contain data._config_snapshot).
 * @param cfg - The live AppConfig object.
 * @param logger - Logger for outputting drift warnings.
 */
function checkConfigOnStageEntry(state, cfg, logger) {
    if (!state || !state.data || !state.data._config_snapshot)
        return;
    const snapshot = state.data._config_snapshot;
    const drifts = detectConfigDrift(snapshot, cfg);
    if (drifts.length > 0) {
        logConfigDrifts(drifts, logger);
        // Store drifts in state for UI display
        const driftRecords = state.data['_config_drifts'] || [];
        driftRecords.push({
            stage: state.stage,
            timestamp: new Date().toISOString(),
            drifts: drifts.map((d) => ({
                field: d.field,
                severity: d.severity,
                message: d.message,
            })),
        });
        // Keep only last 20 drift checks
        if (driftRecords.length > 20) {
            driftRecords.splice(0, driftRecords.length - 20);
        }
        state.data['_config_drifts'] = driftRecords;
    }
}
// =====================================================================
// Fresh Config Getters
// =====================================================================
/**
 * Get a timeout value fresh from env (not cached at module load).
 * Falls back to snapshot value, then default.
 *
 * @param name - Environment variable name for the timeout.
 * @param defaultMs - Default value in milliseconds.
 * @param state - Optional pipeline state for snapshot fallback.
 * @param env - Optional environment record.
 * @returns The timeout value in milliseconds.
 */
function getTimeout(name, defaultMs, state, env = process.env) {
    const envVal = parseInt(env[name] || '', 10);
    if (!isNaN(envVal) && envVal > 0)
        return envVal;
    // Fall back to snapshot if available
    if (state && state.data && state.data._config_snapshot) {
        const snap = state.data._config_snapshot;
        const snapVal = snap[name];
        if (snapVal !== undefined && typeof snapVal === 'number' && !isNaN(snapVal)) {
            return snapVal;
        }
    }
    return defaultMs;
}
/**
 * Get a boolean flag fresh from env.
 *
 * @param name - Environment variable name.
 * @param defaultVal - Default boolean value.
 * @param env - Optional environment record.
 * @returns The boolean flag value.
 */
function getFlag(name, defaultVal = true, env = process.env) {
    const envVal = env[name];
    if (envVal === undefined || envVal === '')
        return defaultVal;
    return envVal.toLowerCase() === 'true';
}
/**
 * Get an integer config value fresh from env.
 *
 * @param name - Environment variable name.
 * @param defaultVal - Default integer value.
 * @param env - Optional environment record.
 * @returns The integer value.
 */
function getInt(name, defaultVal, env = process.env) {
    const envVal = parseInt(env[name] || '', 10);
    return isNaN(envVal) ? defaultVal : envVal;
}
/**
 * Get a string config value fresh from env.
 *
 * @param name - Environment variable name.
 * @param defaultVal - Default string value.
 * @param env - Optional environment record.
 * @returns The string value.
 */
function getString(name, defaultVal, env = process.env) {
    return env[name] || defaultVal;
}
/**
 * Get a frozen config value from snapshot (or live fallback if no snapshot).
 *
 * @param name - Config field name.
 * @param state - Pipeline state containing snapshot.
 * @param liveFallback - Fallback value if no snapshot.
 * @returns The frozen config value.
 */
function getFrozen(name, state, liveFallback) {
    if (state && state.data && state.data._config_snapshot) {
        const snap = state.data._config_snapshot;
        const snapVal = snap[name];
        if (snapVal !== undefined)
            return snapVal;
    }
    return liveFallback;
}
//# sourceMappingURL=snapshot.js.map