"use strict";
// =====================================================================
// MI Dev Agent -- Done Stage (TypeScript port of stages/done.js)
// =====================================================================
//
// Stage 11: Final stage -- transition Jira to "Done", post summary
// comment and Slack notification, archive state file.
//
// Features:
//   - P12: Log warning summary
//   - Transition Jira issue to "Done" status
//   - Post deployment summary comment to Jira (MR URLs, environments, time)
//   - Final Slack notification with all relevant links
//   - E9: Archive state file on completion
//   - Remove lock file
//   - Non-fatal error handling (done stage errors don't halt pipeline)
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
exports.createDoneHandler = createDoneHandler;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../../lib/logger");
const state_manager_1 = require("../../state/state-manager");
const loader_1 = require("../../config/loader");
// ── Stage Handler ────────────────────────────────────────────────
function createDoneHandler(deps) {
    const { jira, slack } = deps;
    return async function stageDone(state) {
        const cfg = (0, loader_1.loadConfig)();
        const data = state.data;
        const ticket = state.ticket;
        (0, logger_1.logStep)(11, 'Done');
        // P12: Log warning summary
        const warnings = data._warnings;
        if (warnings && warnings.length > 0) {
            (0, logger_1.logInfo)(`Pipeline completed with ${warnings.length} warning(s):`);
            for (const w of warnings) {
                (0, logger_1.logWarn)(`  [${w.stage}] ${w.message}`);
            }
        }
        try {
            // Transition Jira to "Done"
            if (!data.jira_closed) {
                try {
                    await jira.transitionIssue(ticket, 'done');
                    (0, logger_1.logOk)('Jira -> Done');
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    (0, logger_1.logErr)(`Jira transition: ${msg}`);
                }
                data.jira_closed = true;
                (0, state_manager_1.save)(state);
            }
            // Post final Jira comment
            if (!data.final_comment) {
                const startedAt = state.startedAt;
                const elapsed = startedAt
                    ? ((Date.now() - new Date(startedAt).getTime()) / 60_000).toFixed(1)
                    : 'unknown';
                const ticketData = data.ticket;
                const warningText = warnings && warnings.length > 0
                    ? `\n\nKnown Limitations:\n${warnings.map((w) => `- [${w.stage}] ${w.message}`).join('\n')}`
                    : '';
                await jira.addComment(ticket, `Deployment Complete\n` +
                    `\n` +
                    `${ticket}: ${ticketData?.summary || ''}\n` +
                    `\n` +
                    `Summary:\n` +
                    `- QA MR: ${data.qa_mr_url || '--'}\n` +
                    `- Pre-Prod MR: ${data.preprod_mr_url || '--'}\n` +
                    `- Production MR: ${data.prod_mr_url || '--'}\n` +
                    `\n` +
                    `Total time: ${elapsed} minutes\n` +
                    `All gates passed. Production is live.` +
                    warningText);
                data.final_comment = true;
                (0, state_manager_1.save)(state);
            }
            // Final Slack notification
            if (!data.final_slack) {
                const startedAt = state.startedAt;
                const elapsed = startedAt
                    ? ((Date.now() - new Date(startedAt).getTime()) / 60_000).toFixed(1)
                    : 'unknown';
                const ticketData = data.ticket;
                await slack.send(`${ticket} deployed to Production\n` +
                    `${ticketData?.summary || ''}\n\n` +
                    `Jira: ${jira.issueUrl(ticket)}\n` +
                    `MR: ${data.prod_mr_url || '--'}\n` +
                    `Time: ${elapsed} min`, [cfg.slack.ownerSlackId || '']);
                data.final_slack = true;
                (0, state_manager_1.save)(state);
            }
            // Banner
            console.log();
            console.log(`${logger_1.C.bold}${logger_1.C.green}  ${ticket} -- DEPLOYED TO PRODUCTION${logger_1.C.reset}`);
            console.log();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            (0, logger_1.logErr)(`Done stage error (non-fatal): ${msg}`);
        }
        // E9: Archive state file on completion
        try {
            const stateFilePath = (0, state_manager_1.getStateFilePath)(ticket);
            const archiveName = path.join(path.dirname(stateFilePath), `state-${ticket}.done.${Date.now()}.json`);
            if (fs.existsSync(stateFilePath)) {
                fs.copyFileSync(stateFilePath, archiveName);
                fs.unlinkSync(stateFilePath);
            }
            // Remove lock file
            const lockFile = path.join(path.dirname(stateFilePath), `state-${ticket}.lock`);
            if (fs.existsSync(lockFile))
                fs.unlinkSync(lockFile);
            (0, logger_1.logOk)('State archived');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            (0, logger_1.logWarn)(`State archive failed: ${msg}`);
        }
    };
}
//# sourceMappingURL=done.js.map