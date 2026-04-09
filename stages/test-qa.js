"use strict";

const { cfg, TICKET, QA_SMOKE_LEVEL } = require("../lib/config");
const { logStep, logOk, logErr, logInfo, logWarn } = require("../lib/logging");
const { req } = require("../lib/http-client");
const { addWarning } = require("../lib/utils");
const { save } = require("../lib/state");
const { jira, jiraUrl } = require("../lib/jira");
const { slack } = require("../lib/slack");

async function stageTestQA(state) {
  logStep(6, "Test QA — 7 modules (2 environments in parallel)");
  logInfo(`QA smoke test level: ${QA_SMOKE_LEVEL}`);

  // ── QA Main: 5 modules (prateekrai + sandboxtwo) ──
  // ── QA1:     2 modules (aman + entp · qa1-enterprise) ──

  async function testEnv(envName, envCfg) {
    logInfo(`[${envName}] Testing ${envCfg.modules.length} modules on ${envCfg.url} (user: ${envCfg.user})…`);
    const results = [];

    // E1: "auth" or "full" level — login first to get session cookie
    let sessionCookie = "";
    if (QA_SMOKE_LEVEL === "auth" || QA_SMOKE_LEVEL === "full") {
      logInfo(`[${envName}] Login as ${envCfg.user} (level: ${QA_SMOKE_LEVEL})…`);
      try {
        const loginResp = await req(`${envCfg.url}/api/auth/login`, {
          method: "POST",
          body: { username: envCfg.user, password: envCfg.pass },
        });
        if (loginResp.status >= 200 && loginResp.status < 400) {
          // Extract Set-Cookie header
          const setCookie = loginResp.headers["set-cookie"];
          if (setCookie) {
            sessionCookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
              .map((c) => c.split(";")[0]).join("; ");
          }
          logOk(`[${envName}] Login successful`);
        } else {
          logWarn(`[${envName}] Login returned HTTP ${loginResp.status} — falling back to basic smoke test`);
        }
      } catch (e) {
        logWarn(`[${envName}] Login failed: ${e.message} — falling back to basic smoke test`);
      }
    } else {
      logInfo(`[${envName}] Login as ${envCfg.user}…`);
    }

    for (const m of envCfg.modules) {
      try {
        const headers = sessionCookie ? { Cookie: sessionCookie } : {};
        const r = await req(`${envCfg.url}${m.path}`, { method: "GET", headers });
        let ok = r.status >= 200 && r.status < 400;

        // E1: "full" level — check for DOM markers (page actually rendered)
        if (ok && QA_SMOKE_LEVEL === "full" && typeof r.data === "string") {
          const hasContent = r.data.includes("<div") || r.data.includes("__next") || r.data.includes("root");
          const hasError = r.data.includes("Error") && r.data.includes("500");
          if (!hasContent || hasError) {
            ok = false;
            logWarn(`[${envName}] ${m.name}: HTTP ${r.status} but DOM check failed`);
          }
        }

        results.push({ ...m, env: envName, status: r.status, ok });
        (ok ? logOk : logErr)(`[${envName}] ${m.name}: HTTP ${r.status}`);
      } catch (e) {
        // E1: Classify network errors as ENV_DOWN vs TEST_FAIL
        const isNetworkError = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"].includes(e.code);
        const errorType = isNetworkError ? "ENV_DOWN" : "TEST_FAIL";
        results.push({ ...m, env: envName, status: 0, ok: false, error: e.message, errorType });
        logErr(`[${envName}] ${m.name}: ${e.message} [${errorType}]`);
      }
    }

    logInfo(`[${envName}] Logout`);
    return results;
  }

  // E1: Run both environments in parallel with 5 min total timeout
  const QA_TEST_TIMEOUT = 300_000; // 5 min
  let mainResults, qa1Results;
  try {
    const testPromise = Promise.all([
      testEnv("QA Main", cfg.qa.main),
      testEnv("QA1", cfg.qa.qa1),
    ]);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("QA test suite timeout (5 min)")), QA_TEST_TIMEOUT));
    [mainResults, qa1Results] = await Promise.race([testPromise, timeoutPromise]);
  } catch (e) {
    if (e.message.includes("timeout")) {
      logErr("QA test suite timed out after 5 minutes");
      addWarning(state, "test_qa", "QA test suite timed out");
      await slack(`⏰ *QA Tests Timeout — ${TICKET}*\nQA test suite exceeded 5 minutes.`, [cfg.slack.ownerId]);
      throw e;
    }
    throw e;
  }

  const results = [...mainResults, ...qa1Results];
  const fails = results.filter((r) => !r.ok);

  if (fails.length) {
    // E1: Separate ENV_DOWN from TEST_FAIL
    const envDownFails = fails.filter((f) => f.errorType === "ENV_DOWN");
    const testFails = fails.filter((f) => f.errorType !== "ENV_DOWN");

    const detail = fails.map((f) => {
      const type = f.errorType === "ENV_DOWN" ? " [ENV_DOWN]" : "";
      return `- [${f.env}] ${f.name} (${f.path}): ${f.error || "HTTP " + f.status}${type}`;
    }).join("\n");

    // E1: Different Jira comments for ENV_DOWN vs TEST_FAIL
    if (envDownFails.length > 0 && testFails.length === 0) {
      // All failures are environment-down
      const envDetail = envDownFails.map((f) => `- [${f.env}] ${f.name}: ${f.error}`).join("\n");
      await jira.addComment(TICKET,
        `QA Environment Down\n\n` +
        `The following environments appear to be unreachable (network error, not test failure):\n${envDetail}\n\n` +
        `This is an infrastructure issue, not a code problem. Retrying after environment recovery.`);
      await slack(
        `🔌 *QA Environment DOWN — ${TICKET}*\n` +
        `${envDownFails.length} module(s) unreachable (not test failures):\n${envDetail}`,
        [cfg.slack.ownerId],
      );
    } else {
      // Regular test failures
      await jira.addComment(TICKET, `QA Test Failed\n\n${detail}`);
      await slack(
        `🚨 *QA Test FAILED — ${TICKET}*\n` +
        `${fails.length}/${results.length} module(s) failed:\n${detail}\n` +
        `📋 ${jiraUrl(TICKET)}`,
        [cfg.slack.ownerId],
      );
    }

    state.data.qa_test = results;
    save(state);
    throw new Error(`QA verification failed: ${fails.length} module(s) down`);
  }

  logOk(`All ${results.length} modules passed (QA Main: ${mainResults.length}, QA1: ${qa1Results.length})`);
  state.data.qa_test = results;
  state.stage = "gate_preprod_approval";
  save(state);
}

module.exports = { stageTestQA };
