"use strict";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Shared Type Definitions
// ═══════════════════════════════════════════════════════════════
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceName = exports.ErrorClass = exports.STAGE_ORDER = void 0;
/** Ordered array of all stages */
exports.STAGE_ORDER = [
    'fetch_ticket', 'explore_plan', 'generate_code',
    'gate_code_review', 'deploy_qa', 'test_qa',
    'gate_preprod_approval', 'create_preprod_mr',
    'gate_dual_approval', 'deploy_prod', 'done'
];
/** Error classification categories */
var ErrorClass;
(function (ErrorClass) {
    ErrorClass["TRANSIENT"] = "TRANSIENT";
    ErrorClass["AUTH"] = "AUTH";
    ErrorClass["PERMANENT"] = "PERMANENT";
    ErrorClass["TIMEOUT"] = "TIMEOUT";
})(ErrorClass || (exports.ErrorClass = ErrorClass = {}));
/** External service names */
var ServiceName;
(function (ServiceName) {
    ServiceName["JIRA"] = "jira";
    ServiceName["GITLAB"] = "gitlab";
    ServiceName["SLACK"] = "slack";
    ServiceName["CLAUDE"] = "claude";
})(ServiceName || (exports.ServiceName = ServiceName = {}));
//# sourceMappingURL=index.js.map