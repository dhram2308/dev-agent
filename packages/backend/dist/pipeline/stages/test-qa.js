"use strict";
// =====================================================================
// MI Dev Agent -- Test QA (TypeScript port of stages/test-qa.js)
// =====================================================================
//
// Stage 6: Run QA tests across two environments in parallel.
//
// Environments:
//   - QA Main (5 modules): Dashboard, GST Return, Reports, Configurations, Import
//   - QA1 (2 modules): IMS (Inventory), Reconcile
//
// Features:
//   - Parallel environment testing with 5-minute timeout
//   - Three smoke test levels: basic, auth (login), full (DOM checks)
//   - Session cookie management for authenticated tests
//   - Network error classification: ENV_DOWN vs TEST_FAIL
//   - Separate Jira/Slack reporting for environment-down vs test failures
//   - Report results to Jira + Slack
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTestQaHandler = createTestQaHandler;
const logger_1 = require("../../lib/logger");
const utils_1 = require("../../lib/utils");
const state_manager_1 = require("../../state/state-manager");
const loader_1 = require("../../config/loader");
const client_1 = require("../../http/client");
// ── Constants ────────────────────────────────────────────────────────
const QA_TEST_TIMEOUT = 300_000; // 5 minutes
const NETWORK_ERROR_CODES = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
]);
// ── Default QA modules ──────────────────────────────────────────
const QA_MAIN_MODULES = [
    { name: 'Dashboard', path: '/dashboard' },
    { name: 'GST Return', path: '/gst-return' },
    { name: 'Reports', path: '/reports' },
    { name: 'Configurations', path: '/configurations' },
    { name: 'Import', path: '/import' },
];
const QA1_MODULES = [
    { name: 'IMS (Inventory)', path: '/ims' },
    { name: 'Reconcile', path: '/reconcile' },
];
// ── Stage Handler ────────────────────────────────────────────────
function createTestQaHandler(deps) {
    const { jira, slack } = deps;
    return async function stageTestQA(state) {
        const cfg = (0, loader_1.loadConfig)();
        const ext = (0, loader_1.loadExtendedConfig)();
        const data = state.data;
        const ticket = state.ticket;
        (0, logger_1.logStep)(6, 'Test QA -- 7 modules (2 environments in parallel)');
        (0, logger_1.logInfo)(`QA smoke test level: ${ext.qaSmokeLevel}`);
        // Build environment configs
        const qaMain = {
            url: ext.qaUrl,
            user: ext.qaMainUser,
            pass: ext.qaMainPass,
            modules: QA_MAIN_MODULES,
        };
        const qa1 = {
            url: ext.qa1Url,
            user: ext.qa1User,
            pass: ext.qa1Pass,
            modules: QA1_MODULES,
        };
        // ── Test a single environment ──
        async function testEnv(envName, envCfg) {
            (0, logger_1.logInfo)(`[${envName}] Testing ${envCfg.modules.length} modules on ${envCfg.url} (user: ${envCfg.user})...`);
            const results = [];
            // Login for auth/full levels
            let sessionCookie = '';
            if (ext.qaSmokeLevel === 'auth' || ext.qaSmokeLevel === 'full') {
                (0, logger_1.logInfo)(`[${envName}] Login as ${envCfg.user} (level: ${ext.qaSmokeLevel})...`);
                try {
                    const loginResp = await (0, client_1.req)(`${envCfg.url}/api/auth/login`, {
                        method: 'POST',
                        body: { username: envCfg.user, password: envCfg.pass },
                    });
                    if (loginResp.status >= 200 && loginResp.status < 400) {
                        const setCookie = loginResp.headers['set-cookie'];
                        if (setCookie) {
                            const cookies = setCookie.split(',').map((c) => c.trim());
                            sessionCookie = cookies.map((c) => c.split(';')[0]).join('; ');
                        }
                        (0, logger_1.logOk)(`[${envName}] Login successful`);
                    }
                    else {
                        (0, logger_1.logWarn)(`[${envName}] Login returned HTTP ${loginResp.status} -- falling back to basic smoke test`);
                    }
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    (0, logger_1.logWarn)(`[${envName}] Login failed: ${msg} -- falling back to basic smoke test`);
                }
            }
            else {
                (0, logger_1.logInfo)(`[${envName}] Login as ${envCfg.user}...`);
            }
            // Test each module
            for (const m of envCfg.modules) {
                try {
                    const headers = sessionCookie ? { Cookie: sessionCookie } : {};
                    const r = await (0, client_1.req)(`${envCfg.url}${m.path}`, { method: 'GET', headers });
                    let ok = r.status >= 200 && r.status < 400;
                    // Full level: check for DOM markers (page actually rendered)
                    if (ok && ext.qaSmokeLevel === 'full' && typeof r.data === 'string') {
                        const hasContent = r.data.includes('<div') ||
                            r.data.includes('__next') ||
                            r.data.includes('root');
                        const hasError = r.data.includes('Error') && r.data.includes('500');
                        if (!hasContent || hasError) {
                            ok = false;
                            (0, logger_1.logWarn)(`[${envName}] ${m.name}: HTTP ${r.status} but DOM check failed`);
                        }
                    }
                    results.push({ ...m, env: envName, status: r.status, ok });
                    (ok ? logger_1.logOk : logger_1.logErr)(`[${envName}] ${m.name}: HTTP ${r.status}`);
                }
                catch (e) {
                    const err = e;
                    const isNetworkError = NETWORK_ERROR_CODES.has(err.code || '');
                    const errorType = isNetworkError ? 'ENV_DOWN' : 'TEST_FAIL';
                    const errMsg = err.message || String(e);
                    results.push({ ...m, env: envName, status: 0, ok: false, error: errMsg, errorType });
                    (0, logger_1.logErr)(`[${envName}] ${m.name}: ${errMsg} [${errorType}]`);
                }
            }
            (0, logger_1.logInfo)(`[${envName}] Logout`);
            return results;
        }
        // Run both environments in parallel with timeout
        let mainResults;
        let qa1Results;
        try {
            const testPromise = Promise.all([
                testEnv('QA Main', qaMain),
                testEnv('QA1', qa1),
            ]);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('QA test suite timeout (5 min)')), QA_TEST_TIMEOUT));
            [mainResults, qa1Results] = await Promise.race([testPromise, timeoutPromise]);
        }
        catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            if (errMsg.includes('timeout')) {
                (0, logger_1.logErr)('QA test suite timed out after 5 minutes');
                (0, utils_1.addWarning)(state, 'test_qa', 'QA test suite timed out');
                await slack.send(`Timeout -- QA Tests -- ${ticket}\nQA test suite exceeded 5 minutes.`, [cfg.slack.ownerSlackId || '']);
                try {
                    (0, state_manager_1.save)(state);
                }
                catch (saveErr) {
                    const saveMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
                    (0, logger_1.logWarn)(`[test-qa] save before throw failed: ${saveMsg}`);
                }
                throw e;
            }
            throw e;
        }
        const results = [...mainResults, ...qa1Results];
        const fails = results.filter((r) => !r.ok);
        if (fails.length) {
            // Separate ENV_DOWN from TEST_FAIL
            const envDownFails = fails.filter((f) => f.errorType === 'ENV_DOWN');
            const testFails = fails.filter((f) => f.errorType !== 'ENV_DOWN');
            const detail = fails
                .map((f) => {
                const type = f.errorType === 'ENV_DOWN' ? ' [ENV_DOWN]' : '';
                return `- [${f.env}] ${f.name} (${f.path}): ${f.error || 'HTTP ' + f.status}${type}`;
            })
                .join('\n');
            // Different Jira comments for ENV_DOWN vs TEST_FAIL
            if (envDownFails.length > 0 && testFails.length === 0) {
                const envDetail = envDownFails
                    .map((f) => `- [${f.env}] ${f.name}: ${f.error}`)
                    .join('\n');
                await jira.addComment(ticket, `QA Environment Down\n\n` +
                    `The following environments appear to be unreachable (network error, not test failure):\n${envDetail}\n\n` +
                    `This is an infrastructure issue, not a code problem. Retrying after environment recovery.`);
                await slack.send(`QA Environment DOWN -- ${ticket}\n` +
                    `${envDownFails.length} module(s) unreachable (not test failures):\n${envDetail}`, [cfg.slack.ownerSlackId || '']);
            }
            else {
                await jira.addComment(ticket, `QA Test Failed\n\n${detail}`);
                await slack.send(`QA Test FAILED -- ${ticket}\n` +
                    `${fails.length}/${results.length} module(s) failed:\n${detail}\n` +
                    `Jira: ${jira.issueUrl(ticket)}`, [cfg.slack.ownerSlackId || '']);
            }
            data.qa_test = results;
            (0, state_manager_1.save)(state);
            throw new Error(`QA verification failed: ${fails.length} module(s) down`);
        }
        (0, logger_1.logOk)(`All ${results.length} modules passed (QA Main: ${mainResults.length}, QA1: ${qa1Results.length})`);
        data.qa_test = results;
        state.stage = 'gate_preprod_approval';
        (0, state_manager_1.save)(state);
    };
}
//# sourceMappingURL=test-qa.js.map