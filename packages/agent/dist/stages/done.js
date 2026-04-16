"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stageDone = stageDone;
const fs = require("fs");
const path = require("path");
const { cfg, TICKET, STATE_FILE } = require("../lib/config");
const { logStep, logOk, logErr, logInfo, logWarn, C } = require("../lib/logging");
const { save } = require("../lib/state");
const { jira, jiraUrl } = require("../lib/jira");
const { slack } = require("../lib/slack");
const { isChannelEnabled } = require("../lib/notification-config");
async function stageDone(state) {
    logStep(11, "Done");
    // P12: Log warning summary
    if (state.data._warnings && state.data._warnings.length > 0) {
        logInfo(`Pipeline completed with ${state.data._warnings.length} warning(s):`);
        for (const w of state.data._warnings) {
            logWarn(`  [${w.stage}] ${w.message}`);
        }
    }
    try {
        if (!state.data.jira_closed) {
            try {
                await jira.transition(TICKET, "done");
                logOk("Jira → Done");
            }
            catch (e) {
                logErr(`Jira transition: ${e.message}`);
            }
            state.data.jira_closed = true;
            save(state);
        }
        if (!state.data.final_comment) {
            const elapsed = ((Date.now() - new Date(state.startedAt).getTime()) / 60000).toFixed(1);
            if (isChannelEnabled("done", "jira")) {
                await jira.addComment(TICKET, `Deployment Complete \u2705\n` +
                    `\n` +
                    `${TICKET}: ${state.data.ticket.summary}\n` +
                    `\n` +
                    `\ud83d\udcca Summary:\n` +
                    `\u2022 QA MR: ${state.data.qa_mr_url || "\u2014"}\n` +
                    `\u2022 Pre-Prod MR: ${state.data.preprod_mr_url || "\u2014"}\n` +
                    `\u2022 Production MR: ${state.data.prod_mr_url || "\u2014"}\n` +
                    `\n` +
                    `\ud83c\udf10 Environments:\n` +
                    `\u2022 QA: ${cfg.urls.qa}\n` +
                    `\u2022 Pre-Prod: ${cfg.urls.preProd}\n` +
                    `\u2022 Production: ${cfg.urls.prod}\n` +
                    `\n` +
                    `\u23f1 Total time: ${elapsed} minutes\n` +
                    `All gates passed. Production is live.` +
                    ((state.data._warnings && state.data._warnings.length > 0)
                        ? `\n\nKnown Limitations:\n${state.data._warnings.map((w) => `\u2022 [${w.stage}] ${w.message}`).join("\n")}`
                        : ""));
            }
            state.data.final_comment = true;
            save(state);
        }
        if (!state.data.final_slack) {
            const elapsed = ((Date.now() - new Date(state.startedAt).getTime()) / 60000).toFixed(1);
            if (isChannelEnabled("done", "slack")) {
                await slack(`\u2705 *${TICKET} deployed to Production*\n` +
                    `*${state.data.ticket.summary}*\n\n` +
                    `\ud83c\udf10 ${cfg.urls.prod}\n` +
                    `\ud83d\udccb ${jiraUrl(TICKET)}\n` +
                    `\ud83d\udd00 ${state.data.prod_mr_url || "\u2014"}\n` +
                    `\u23f1 ${elapsed} min`, [cfg.slack.ownerId, cfg.slack.anshitId]);
            }
            state.data.final_slack = true;
            save(state);
        }
        console.log();
        console.log(`${C.bold}${C.green}  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557${C.reset}`);
        console.log(`${C.bold}${C.green}  \u2551   ${TICKET} — DEPLOYED TO PRODUCTION \u2705        \u2551${C.reset}`);
        console.log(`${C.bold}${C.green}  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d${C.reset}`);
        console.log();
    }
    catch (err) {
        logErr(`Done stage error (non-fatal): ${err.message}`);
    }
    // E9: Archive state file on completion
    try {
        const archiveName = path.join(path.dirname(STATE_FILE), `state-${TICKET}.done.${Date.now()}.json`);
        if (fs.existsSync(STATE_FILE)) {
            fs.copyFileSync(STATE_FILE, archiveName);
            fs.unlinkSync(STATE_FILE);
        }
        // Remove lock file
        const lockFile = path.join(path.dirname(STATE_FILE), `state-${TICKET}.lock`);
        if (fs.existsSync(lockFile))
            fs.unlinkSync(lockFile);
        logOk("State archived");
    }
    catch (err) {
        logWarn(`State archive failed: ${err.message}`);
    }
}
//# sourceMappingURL=done.js.map