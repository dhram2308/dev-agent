"use strict";
// =====================================================================
// MI Dev Agent -- Config Validator
// =====================================================================
// Port of lib/config-validate.js to TypeScript.
//
// Provides:
//   1. validateAllConfig() -- validates ALL config vars
//   2. Structured results with severity levels (FATAL/ERROR/WARN/INFO)
//   3. Cross-field validation (port ranges, approval ordering, etc.)
//   4. formatValidationResults() for console output
//   5. Callback-based wrapper for backward compatibility
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.Severity = void 0;
exports.validateAllConfig = validateAllConfig;
exports.formatValidationResults = formatValidationResults;
exports.validateConfig = validateConfig;
const loader_1 = require("./loader");
// -- Severity levels ---------------------------------------------------
var Severity;
(function (Severity) {
    Severity["FATAL"] = "FATAL";
    Severity["ERROR"] = "ERROR";
    Severity["WARN"] = "WARN";
    Severity["INFO"] = "INFO";
})(Severity || (exports.Severity = Severity = {}));
// -- Validation helpers -------------------------------------------------
/** Check if a string looks like an email address. */
function isEmail(val) {
    return val.includes('@');
}
/** Check if a string is a valid URL (http/https). */
function isValidUrl(val) {
    if (!val.startsWith('http://') && !val.startsWith('https://'))
        return false;
    try {
        new URL(val);
        return true;
    }
    catch {
        return false;
    }
}
// -- Core validation function -------------------------------------------
/**
 * Validate ALL config variables from the environment.
 *
 * Checks:
 *   - Required fields present (TICKET, JIRA_TOKEN, GITLAB_TOKEN, etc.)
 *   - Numeric fields valid (GITLAB_PROJECT_ID, timeouts)
 *   - URL format checks (JIRA_BASE_URL, GITLAB_URL)
 *   - Cross-field validation (OWNER_JIRA_ID != QA_JIRA_ID)
 *   - Boolean flags (RUN_BUILD_CHECK, BROWSER_VERIFY, etc.)
 *   - Port range ordering
 *   - Timeout ordering
 *   - QA credential presence
 *
 * @param env - The environment record (defaults to process.env)
 * @returns Structured validation output
 */
function validateAllConfig(env = process.env) {
    const results = [];
    // -- Required string fields -------------------------------------------
    const requiredFields = [
        { field: 'TICKET', group: 'identity', description: 'Jira ticket key' },
        { field: 'JIRA_TOKEN', group: 'jira', description: 'Jira API token' },
        { field: 'JIRA_EMAIL', group: 'jira', description: 'Jira account email' },
        { field: 'GITLAB_TOKEN', group: 'gitlab', description: 'GitLab personal access token' },
        { field: 'GITLAB_PROJECT_ID', group: 'gitlab', description: 'GitLab project ID' },
    ];
    for (const req of requiredFields) {
        const val = env[req.field];
        if (!val || val.trim() === '') {
            results.push({
                field: req.field,
                severity: Severity.FATAL,
                message: `${req.field} is required but missing or empty`,
                group: req.group,
            });
        }
    }
    // -- TICKET format validation -----------------------------------------
    const ticket = env['TICKET'];
    if (ticket && ticket.trim() !== '') {
        if (!/^[A-Z]+-\d+$/i.test(ticket.trim())) {
            results.push({
                field: 'TICKET',
                severity: Severity.ERROR,
                message: `TICKET: Invalid ticket format: "${ticket}" -- expected "PROJ-123"`,
                group: 'identity',
            });
        }
    }
    // -- Email format validation ------------------------------------------
    const jiraEmail = env['JIRA_EMAIL'];
    if (jiraEmail && jiraEmail.trim() !== '' && !isEmail(jiraEmail.trim())) {
        results.push({
            field: 'JIRA_EMAIL',
            severity: Severity.ERROR,
            message: `JIRA_EMAIL: Expected email address, got: "${jiraEmail}"`,
            group: 'jira',
        });
    }
    // -- Numeric field validation -----------------------------------------
    const numericFields = [
        { field: 'GITLAB_PROJECT_ID', group: 'gitlab', required: true, min: 1 },
        { field: 'GITLAB_ASSIGNEE_ID', group: 'gitlab', required: false, min: 1 },
        { field: 'POLL_INTERVAL', group: 'polling', required: false, min: 5000, max: 300_000 },
        { field: 'CI_POLL', group: 'polling', required: false, min: 10_000, max: 300_000 },
        { field: 'CI_TIMEOUT', group: 'polling', required: false, min: 60_000, max: 7_200_000 },
        { field: 'MAX_APPROVAL_TIMEOUT', group: 'timeouts', required: false, min: 60_000 },
        { field: 'MAX_REJECTIONS', group: 'limits', required: false, min: 1, max: 20 },
        { field: 'MAX_PIPELINE_DURATION', group: 'timeouts', required: false, min: 3_600_000 },
        { field: 'MAX_CONTINUE_WAIT', group: 'timeouts', required: false, min: 60_000 },
        { field: 'MAX_PLAN_REJECTIONS', group: 'limits', required: false, min: 1, max: 20 },
        { field: 'ANALYSIS_TIMEOUT', group: 'timeouts', required: false, min: 60_000, max: 3_600_000 },
        { field: 'DEVELOPER_TIMEOUT', group: 'timeouts', required: false, min: 60_000, max: 3_600_000 },
        { field: 'REVIEWER_TIMEOUT', group: 'timeouts', required: false, min: 60_000, max: 3_600_000 },
        { field: 'TEST_FIXER_TIMEOUT', group: 'timeouts', required: false, min: 30_000, max: 1_800_000 },
        { field: 'MAX_PROMPT_TOKENS', group: 'limits', required: false, min: 10_000, max: 500_000 },
        { field: 'FETCH_CONCURRENCY', group: 'limits', required: false, min: 1, max: 20 },
        { field: 'URL_FETCH_TIMEOUT', group: 'timeouts', required: false, min: 5000, max: 600_000 },
        { field: 'MAX_TOTAL_COMMENTS', group: 'limits', required: false, min: 10, max: 500 },
        { field: 'MAX_TOTAL_ATTACHMENTS', group: 'limits', required: false, min: 1, max: 100 },
        { field: 'MAX_TOTAL_URL_CONTENT', group: 'limits', required: false, min: 10_000, max: 5_000_000 },
        { field: 'MAX_STATE_SIZE', group: 'limits', required: false, min: 1_000_000, max: 100_000_000 },
        { field: 'MERGE_POLL_TIMEOUT', group: 'timeouts', required: false, min: 60_000 },
        { field: 'BUILD_INSTALL_TIMEOUT', group: 'build', required: false, min: 30_000, max: 600_000 },
        { field: 'BUILD_TSC_TIMEOUT', group: 'build', required: false, min: 10_000, max: 600_000 },
        { field: 'BUILD_ESLINT_TIMEOUT', group: 'build', required: false, min: 10_000, max: 300_000 },
        { field: 'APPROVAL_REMINDER_1H', group: 'timeouts', required: false, min: 60_000 },
        { field: 'APPROVAL_REMINDER_4H', group: 'timeouts', required: false, min: 60_000 },
        { field: 'GIT_CLONE_DEPTH', group: 'git', required: false, min: 1, max: 10_000 },
        { field: 'MAX_COMMIT_FILE_SIZE', group: 'git', required: false, min: 1024, max: 10_000_000 },
        { field: 'UNIT_TESTS_TIMEOUT', group: 'testing', required: false, min: 10_000, max: 600_000 },
        { field: 'E2E_TESTS_TIMEOUT', group: 'testing', required: false, min: 30_000, max: 1_200_000 },
        { field: 'VITE_PREVIEW_TIMEOUT', group: 'testing', required: false, min: 5_000, max: 120_000 },
        { field: 'VITE_BUILD_TIMEOUT', group: 'testing', required: false, min: 30_000, max: 1_800_000 },
        { field: 'MAX_UNIT_TEST_RETRIES', group: 'testing', required: false, min: 0, max: 10 },
        { field: 'MAX_E2E_TEST_RETRIES', group: 'testing', required: false, min: 0, max: 10 },
        { field: 'CONSOLE_WARNING_THRESHOLD', group: 'testing', required: false, min: 0, max: 100 },
        { field: 'MAX_VERIFY_RETRIES', group: 'browser', required: false, min: 0, max: 10 },
        { field: 'NX_SERVE_TIMEOUT', group: 'browser', required: false, min: 10_000, max: 600_000 },
        { field: 'VERIFICATION_TIMEOUT', group: 'browser', required: false, min: 30_000, max: 1_200_000 },
        { field: 'EVIDENCE_MAX_SIZE', group: 'browser', required: false, min: 1024, max: 1_000_000 },
        { field: 'QA_HEALTH_TIMEOUT', group: 'qa', required: false, min: 1000, max: 120_000 },
        { field: 'MAX_CONCURRENT_AGENTS', group: 'limits', required: false, min: 1, max: 10 },
        { field: 'MAX_FREE_SOCKETS', group: 'limits', required: false, min: 1, max: 100 },
        { field: 'CLAUDE_TIMEOUT', group: 'timeouts', required: false, min: 10_000, max: 1_800_000 },
        { field: 'VITE_PRODUCT_ID', group: 'vite', required: false, min: 1 },
    ];
    for (const nf of numericFields) {
        const rawVal = env[nf.field];
        if (rawVal === undefined || rawVal === null || rawVal === '')
            continue;
        const parsed = parseInt(rawVal, 10);
        if (isNaN(parsed)) {
            results.push({
                field: nf.field,
                severity: nf.required ? Severity.FATAL : Severity.ERROR,
                message: `${nf.field}: Invalid numeric value: "${rawVal}"`,
                group: nf.group,
            });
            continue;
        }
        if (nf.min !== undefined && parsed < nf.min) {
            results.push({
                field: nf.field,
                severity: Severity.ERROR,
                message: `${nf.field}: Value ${parsed} below minimum ${nf.min}`,
                group: nf.group,
            });
        }
        if (nf.max !== undefined && parsed > nf.max) {
            results.push({
                field: nf.field,
                severity: Severity.ERROR,
                message: `${nf.field}: Value ${parsed} above maximum ${nf.max}`,
                group: nf.group,
            });
        }
    }
    // -- URL format validation --------------------------------------------
    const urlFields = [
        { field: 'JIRA_BASE_URL', group: 'jira' },
        { field: 'GITLAB_URL', group: 'gitlab' },
        { field: 'SLACK_WEBHOOK', group: 'slack' },
        { field: 'QA_URL', group: 'qa' },
        { field: 'QA1_URL', group: 'qa' },
        { field: 'VITE_APP_API_URL', group: 'vite' },
        { field: 'VITE_APP_QA', group: 'vite' },
    ];
    for (const uf of urlFields) {
        const val = env[uf.field];
        if (!val || val.trim() === '')
            continue;
        if (!isValidUrl(val.trim())) {
            results.push({
                field: uf.field,
                severity: Severity.ERROR,
                message: `${uf.field}: URL must start with http:// or https://, got: "${val}"`,
                group: uf.group,
            });
        }
    }
    // -- Boolean flag validation ------------------------------------------
    const boolFields = [
        { field: 'RUN_BUILD_CHECK', group: 'build' },
        { field: 'BROWSER_VERIFY', group: 'browser' },
        { field: 'RUN_RUNTIME_TESTS', group: 'testing' },
        { field: 'JIRA_COMMENTS_ENABLED', group: 'jira' },
        { field: 'SKIP_SMOKE_CHECK', group: 'qa' },
        { field: 'SAVE_DEBUG_OUTPUT', group: 'logging' },
        { field: 'ALLOW_ANY_APPROVER', group: 'jira' },
        { field: 'ALLOW_STAGE_SKIP', group: 'server' },
    ];
    for (const bf of boolFields) {
        const val = env[bf.field];
        if (val === undefined || val === null || val === '')
            continue;
        const parsed = (0, loader_1.parseBoolean)(val);
        if (parsed === null) {
            results.push({
                field: bf.field,
                severity: Severity.ERROR,
                message: `${bf.field}: Invalid boolean: "${val}". Use true/false/1/0/yes/no`,
                group: bf.group,
            });
        }
    }
    // -- Enum validation --------------------------------------------------
    const enumFields = [
        { field: 'LOG_LEVEL', group: 'logging', allowed: ['trace', 'debug', 'info', 'warn', 'error'] },
        { field: 'LOG_FORMAT', group: 'logging', allowed: ['text', 'json'] },
        { field: 'QA_SMOKE_LEVEL', group: 'qa', allowed: ['basic', 'full', 'none'] },
        { field: 'PLAYWRIGHT_BROWSER', group: 'testing', allowed: ['chromium', 'firefox', 'webkit'] },
    ];
    for (const ef of enumFields) {
        const val = env[ef.field];
        if (val === undefined || val === null || val === '')
            continue;
        const normalized = val.trim().toLowerCase();
        const normalizedAllowed = ef.allowed.map((a) => a.toLowerCase());
        if (!normalizedAllowed.includes(normalized)) {
            results.push({
                field: ef.field,
                severity: Severity.ERROR,
                message: `${ef.field}: Invalid value "${val}". Allowed: ${ef.allowed.join(', ')}`,
                group: ef.group,
            });
        }
    }
    // -- Cross-field validation -------------------------------------------
    // Port range validation
    const nxPortStart = (0, loader_1.parseIntSafe)(env['NX_SERVE_PORT_RANGE_START'], 4200);
    const nxPortEnd = (0, loader_1.parseIntSafe)(env['NX_SERVE_PORT_RANGE_END'], 4299);
    if (nxPortStart > nxPortEnd) {
        results.push({
            field: 'NX_SERVE_PORT_RANGE_START/END',
            severity: Severity.ERROR,
            message: `Port range invalid: START (${nxPortStart}) > END (${nxPortEnd}). Swap the values.`,
            group: 'browser',
        });
    }
    const vitePortStart = (0, loader_1.parseIntSafe)(env['VITE_PREVIEW_PORT_START'], 4300);
    const vitePortEnd = (0, loader_1.parseIntSafe)(env['VITE_PREVIEW_PORT_END'], 4399);
    if (vitePortStart > vitePortEnd) {
        results.push({
            field: 'VITE_PREVIEW_PORT_START/END',
            severity: Severity.ERROR,
            message: `Port range invalid: START (${vitePortStart}) > END (${vitePortEnd}). Swap the values.`,
            group: 'runtime_tests',
        });
    }
    // Approval reminder ordering
    const rem1 = (0, loader_1.parseIntSafe)(env['APPROVAL_REMINDER_1H'], 3_600_000);
    const rem4 = (0, loader_1.parseIntSafe)(env['APPROVAL_REMINDER_4H'], 14_400_000);
    if (env['APPROVAL_REMINDER_1H'] && env['APPROVAL_REMINDER_4H'] && rem1 >= rem4) {
        results.push({
            field: 'APPROVAL_REMINDER_1H/4H',
            severity: Severity.WARN,
            message: `First reminder (${rem1}ms) >= second reminder (${rem4}ms). First reminder should be shorter.`,
            group: 'timeouts',
        });
    }
    // Approval timeout must be less than pipeline duration
    const approvalTimeout = (0, loader_1.parseIntSafe)(env['MAX_APPROVAL_TIMEOUT'], 28_800_000);
    const pipelineDuration = (0, loader_1.parseIntSafe)(env['MAX_PIPELINE_DURATION'], 86_400_000);
    if (env['MAX_APPROVAL_TIMEOUT'] &&
        env['MAX_PIPELINE_DURATION'] &&
        approvalTimeout >= pipelineDuration) {
        results.push({
            field: 'MAX_APPROVAL_TIMEOUT',
            severity: Severity.WARN,
            message: `Approval timeout (${approvalTimeout}ms) >= pipeline duration (${pipelineDuration}ms). Pipeline may timeout before approval.`,
            group: 'timeouts',
        });
    }
    // Same approver warning (OWNER_JIRA_ID != QA_JIRA_ID for dual approval)
    const ownerJira = env['OWNER_JIRA_ID'];
    const qaJira = env['QA_JIRA_ID'];
    if (ownerJira && qaJira && ownerJira.trim() === qaJira.trim()) {
        results.push({
            field: 'OWNER_JIRA_ID/QA_JIRA_ID',
            severity: Severity.WARN,
            message: 'Both approver IDs are the same -- dual approval gate will be ineffective',
            group: 'jira',
        });
    }
    // HTTP GitLab warning
    const gitlabUrl = env['GITLAB_URL'];
    if (gitlabUrl && gitlabUrl.startsWith('http://')) {
        results.push({
            field: 'GITLAB_URL',
            severity: Severity.WARN,
            message: 'GitLab URL uses HTTP -- API tokens transmitted unencrypted. Use HTTPS for production.',
            group: 'gitlab',
        });
    }
    // Empty approvers + ALLOW_ANY_APPROVER check
    const allowAny = (0, loader_1.parseBoolean)(env['ALLOW_ANY_APPROVER']);
    if (!ownerJira && !qaJira && !allowAny) {
        results.push({
            field: 'OWNER_JIRA_ID/QA_JIRA_ID',
            severity: Severity.FATAL,
            message: 'Both approver IDs empty and ALLOW_ANY_APPROVER is false. Set at least one approver or ALLOW_ANY_APPROVER=true.',
            group: 'jira',
        });
    }
    // QA credential warnings
    if (!env['QA_MAIN_USER'] || !env['QA_MAIN_PASS']) {
        results.push({
            field: 'QA_MAIN_USER/QA_MAIN_PASS',
            severity: Severity.WARN,
            message: 'QA main credentials not configured -- QA testing stage will fail. Set QA_MAIN_USER and QA_MAIN_PASS.',
            group: 'qa',
        });
    }
    if (!env['QA1_USER'] || !env['QA1_PASS']) {
        results.push({
            field: 'QA1_USER/QA1_PASS',
            severity: Severity.WARN,
            message: 'QA1 credentials not configured -- QA1 testing will fail. Set QA1_USER and QA1_PASS.',
            group: 'qa',
        });
    }
    // BIND_HOST validation
    const bindHost = env['BIND_HOST'];
    if (bindHost && bindHost.trim() !== '') {
        const bh = bindHost.trim();
        if (bh !== '127.0.0.1' && bh !== '0.0.0.0' && bh !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(bh)) {
            results.push({
                field: 'BIND_HOST',
                severity: Severity.ERROR,
                message: `BIND_HOST: Invalid bind host: "${bh}"`,
                group: 'server',
            });
        }
    }
    // Port range validation (0-65535)
    const portFields = [
        'PORT',
        'NX_SERVE_PORT_RANGE_START',
        'NX_SERVE_PORT_RANGE_END',
        'VITE_PREVIEW_PORT_START',
        'VITE_PREVIEW_PORT_END',
    ];
    for (const pf of portFields) {
        const val = env[pf];
        if (val === undefined || val === '')
            continue;
        const parsed = parseInt(val, 10);
        if (!isNaN(parsed) && (parsed < 0 || parsed > 65535)) {
            results.push({
                field: pf,
                severity: Severity.ERROR,
                message: `${pf}: Port ${parsed} out of range (0-65535)`,
                group: 'server',
            });
        }
    }
    // -- Informational: sensitive vars using defaults ----------------------
    const sensitiveWithDefaults = [
        { field: 'SLACK_WEBHOOK', group: 'slack' },
        { field: 'OWNER_SLACK_ID', group: 'slack' },
        { field: 'QA_SLACK_ID', group: 'slack' },
        { field: 'OWNER_JIRA_ID', group: 'jira' },
        { field: 'QA_JIRA_ID', group: 'jira' },
    ];
    for (const sf of sensitiveWithDefaults) {
        const val = env[sf.field];
        if (!val || val.trim() === '') {
            results.push({
                field: sf.field,
                severity: Severity.INFO,
                message: `${sf.field} not set -- using default (sensitive)`,
                group: sf.group,
            });
        }
    }
    // -- Determine overall validity ----------------------------------------
    const hasFatal = results.some((r) => r.severity === Severity.FATAL);
    return { valid: !hasFatal, results };
}
/**
 * Format validation results for console output.
 * Groups results by severity with color-coded output.
 */
function formatValidationResults(results) {
    const lines = [];
    const icons = {
        [Severity.FATAL]: '\x1b[31mFATAL\x1b[0m',
        [Severity.ERROR]: '\x1b[31mERROR\x1b[0m',
        [Severity.WARN]: '\x1b[33m WARN\x1b[0m',
        [Severity.INFO]: '\x1b[36m INFO\x1b[0m',
    };
    // Group by severity
    const grouped = {};
    for (const r of results) {
        if (!grouped[r.severity])
            grouped[r.severity] = [];
        grouped[r.severity].push(r);
    }
    for (const sev of [Severity.FATAL, Severity.ERROR, Severity.WARN, Severity.INFO]) {
        const items = grouped[sev];
        if (!items || items.length === 0)
            continue;
        lines.push(`\n  ${icons[sev]} (${items.length}):`);
        for (const item of items) {
            lines.push(`    [${item.group}] ${item.field}: ${item.message}`);
        }
    }
    return lines.join('\n');
}
/**
 * Backward-compatible wrapper: validates config using callback functions.
 *
 * When called with (errFn, infoFn, warnFn):
 *   - Logs errors via errFn
 *   - Calls process.exit(1) on fatal/error
 *   - Logs warnings via warnFn
 *
 * When called with no arguments:
 *   - Returns { valid, results } for programmatic use
 */
function validateConfig(errFn, infoFn, warnFn) {
    const output = validateAllConfig();
    // No-argument call: return structured results
    if (!errFn) {
        return output;
    }
    // With arguments: log and exit on failure
    const fatals = output.results.filter((r) => r.severity === Severity.FATAL);
    const errors = output.results.filter((r) => r.severity === Severity.ERROR);
    const warns = output.results.filter((r) => r.severity === Severity.WARN);
    if (fatals.length > 0 || errors.length > 0) {
        for (const f of fatals)
            errFn(f.message);
        for (const e of errors)
            errFn(e.message);
        if (infoFn)
            infoFn('Run ./start.sh first, or export these env vars.');
        process.exit(1);
    }
    for (const w of warns) {
        if (warnFn)
            warnFn(w.message);
    }
}
//# sourceMappingURL=validator.js.map