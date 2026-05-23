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

import { logStep, logOk, logErr, logInfo, logWarn } from '../../lib/logger';
import { addWarning, sleep } from '../../lib/utils';
import { save } from '../../state/state-manager';
import { loadConfig, loadExtendedConfig } from '../../config/loader';
import { req } from '../../http/client';
import { JiraService } from '../../services/jira';
import { SlackService } from '../../services/slack';
import type { PipelineState, StageHandler } from '@shared/types';
import { isChannelEnabled } from '../../lib/notification-gates';

// ── Types ────────────────────────────────────────────────────────────

interface TestQaDeps {
  jira: JiraService;
  slack: SlackService;
}

interface QaModule {
  name: string;
  path: string;
}

interface QaEnvConfig {
  url: string;
  user: string;
  pass: string;
  modules: QaModule[];
}

interface TestResult {
  name: string;
  path: string;
  env: string;
  status: number;
  ok: boolean;
  error?: string;
  errorType?: 'ENV_DOWN' | 'TEST_FAIL';
}

// ── Constants ────────────────────────────────────────────────────────

const QA_TEST_TIMEOUT = 300_000; // 5 minutes

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
]);

// ── Default QA modules ──────────────────────────────────────────

const QA_MAIN_MODULES: QaModule[] = [
  { name: 'Dashboard', path: '/dashboard' },
  { name: 'GST Return', path: '/gst-return' },
  { name: 'Reports', path: '/reports' },
  { name: 'Configurations', path: '/configurations' },
  { name: 'Import', path: '/import' },
];

const QA1_MODULES: QaModule[] = [
  { name: 'IMS (Inventory)', path: '/ims' },
  { name: 'Reconcile', path: '/reconcile' },
];

// ── Stage Handler ────────────────────────────────────────────────

export function createTestQaHandler(deps: TestQaDeps): StageHandler {
  const { jira, slack } = deps;

  return async function stageTestQA(state: PipelineState): Promise<void> {
    const cfg = loadConfig();
    const ext = loadExtendedConfig();
    const data = state.data as Record<string, unknown>;
    const ticket = state.ticket;

    logStep(6, 'Test QA -- 7 modules (2 environments in parallel)');
    logInfo(`QA smoke test level: ${ext.qaSmokeLevel}`);

    // Build environment configs
    const qaMain: QaEnvConfig = {
      url: ext.qaUrl,
      user: ext.qaMainUser,
      pass: ext.qaMainPass,
      modules: QA_MAIN_MODULES,
    };

    const qa1: QaEnvConfig = {
      url: ext.qa1Url,
      user: ext.qa1User,
      pass: ext.qa1Pass,
      modules: QA1_MODULES,
    };

    // ── Test a single environment ──
    async function testEnv(envName: string, envCfg: QaEnvConfig): Promise<TestResult[]> {
      logInfo(`[${envName}] Testing ${envCfg.modules.length} modules on ${envCfg.url} (user: ${envCfg.user})...`);
      const results: TestResult[] = [];

      // Login for auth/full levels
      let sessionCookie = '';
      if (ext.qaSmokeLevel === 'auth' || ext.qaSmokeLevel === 'full') {
        logInfo(`[${envName}] Login as ${envCfg.user} (level: ${ext.qaSmokeLevel})...`);
        try {
          const loginResp = await req(`${envCfg.url}/api/auth/login`, {
            method: 'POST',
            body: { username: envCfg.user, password: envCfg.pass },
          });
          if (loginResp.status >= 200 && loginResp.status < 400) {
            const setCookie = loginResp.headers['set-cookie'];
            if (setCookie) {
              const cookies = setCookie.split(',').map((c) => c.trim());
              sessionCookie = cookies.map((c) => c.split(';')[0]).join('; ');
            }
            logOk(`[${envName}] Login successful`);
          } else {
            logWarn(`[${envName}] Login returned HTTP ${loginResp.status} -- falling back to basic smoke test`);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logWarn(`[${envName}] Login failed: ${msg} -- falling back to basic smoke test`);
        }
      } else {
        logInfo(`[${envName}] Login as ${envCfg.user}...`);
      }

      // Test each module
      for (const m of envCfg.modules) {
        let moduleResult: TestResult;
        try {
          const headers: Record<string, string> = sessionCookie ? { Cookie: sessionCookie } : {};
          const r = await req(`${envCfg.url}${m.path}`, { method: 'GET', headers });
          let ok = r.status >= 200 && r.status < 400;

          // Full level: check for DOM markers (page actually rendered)
          if (ok && ext.qaSmokeLevel === 'full' && typeof r.data === 'string') {
            const hasContent =
              (r.data as string).includes('<div') ||
              (r.data as string).includes('__next') ||
              (r.data as string).includes('root');
            const hasError =
              (r.data as string).includes('Error') && (r.data as string).includes('500');
            if (!hasContent || hasError) {
              ok = false;
              logWarn(`[${envName}] ${m.name}: HTTP ${r.status} but DOM check failed`);
            }
          }

          moduleResult = { ...m, env: envName, status: r.status, ok };
          (ok ? logOk : logErr)(`[${envName}] ${m.name}: HTTP ${r.status}`);
        } catch (e: unknown) {
          const err = e as NodeJS.ErrnoException;
          const isNetworkError = NETWORK_ERROR_CODES.has(err.code || '');
          const errorType = isNetworkError ? 'ENV_DOWN' : 'TEST_FAIL';
          const errMsg = err.message || String(e);
          moduleResult = { ...m, env: envName, status: 0, ok: false, error: errMsg, errorType };
          logErr(`[${envName}] ${m.name}: ${errMsg} [${errorType}]`);
        }

        results.push(moduleResult);

        // Incremental state save so the UI can render live progress pills.
        // Both parallel streams append into the same qa_test array (keyed by env+name on read).
        const existing = (data.qa_test as TestResult[] | undefined) ?? [];
        data.qa_test = [...existing, moduleResult];
        try {
          save(state);
        } catch (saveErr: unknown) {
          const saveMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
          logWarn(`[test-qa] incremental save failed: ${saveMsg}`);
        }
      }

      logInfo(`[${envName}] Logout`);
      return results;
    }

    // Run both environments in parallel with timeout
    let mainResults: TestResult[];
    let qa1Results: TestResult[];
    try {
      const testPromise = Promise.all([
        testEnv('QA Main', qaMain),
        testEnv('QA1', qa1),
      ]);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('QA test suite timeout (5 min)')), QA_TEST_TIMEOUT),
      );
      [mainResults, qa1Results] = await Promise.race([testPromise, timeoutPromise]);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg.includes('timeout')) {
        logErr('QA test suite timed out after 5 minutes');
        addWarning(state, 'test_qa', 'QA test suite timed out');
        if (isChannelEnabled('test_qa', 'slack')) {
          await slack.send(`Timeout -- QA Tests -- ${ticket}\nQA test suite exceeded 5 minutes.`, [cfg.slack.ownerSlackId || '']);
        }
        try { save(state); } catch (saveErr: unknown) {
          const saveMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
          logWarn(`[test-qa] save before throw failed: ${saveMsg}`);
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
        if (isChannelEnabled('test_qa', 'jira')) {
          await jira.addComment(
            ticket,
            `QA Environment Down\n\n` +
            `The following environments appear to be unreachable (network error, not test failure):\n${envDetail}\n\n` +
            `This is an infrastructure issue, not a code problem. Retrying after environment recovery.`,
          );
        }
        if (isChannelEnabled('test_qa', 'slack')) {
          await slack.send(
            `QA Environment DOWN -- ${ticket}\n` +
            `${envDownFails.length} module(s) unreachable (not test failures):\n${envDetail}`,
            [cfg.slack.ownerSlackId || ''],
          );
        }
      } else {
        if (isChannelEnabled('test_qa', 'jira')) {
          await jira.addComment(ticket, `QA Test Failed\n\n${detail}`);
        }
        if (isChannelEnabled('test_qa', 'slack')) {
          await slack.send(
            `QA Test FAILED -- ${ticket}\n` +
            `${fails.length}/${results.length} module(s) failed:\n${detail}\n` +
            `Jira: ${jira.issueUrl(ticket)}`,
            [cfg.slack.ownerSlackId || ''],
          );
        }
      }

      data.qa_test = results;
      save(state);
      throw new Error(`QA verification failed: ${fails.length} module(s) down`);
    }

    logOk(`All ${results.length} modules passed (QA Main: ${mainResults.length}, QA1: ${qa1Results.length})`);
    data.qa_test = results;
    state.stage = 'gate_preprod_approval';
    save(state);
  };
}
