"use strict";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Shared Type Definitions
// ═══════════════════════════════════════════════════════════════
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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
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
// ── Domain type modules (Section 2: Jira, GitLab, ADF, etc.) ──
__exportStar(require("./jira"), exports);
__exportStar(require("./gitlab"), exports);
__exportStar(require("./adf"), exports);
__exportStar(require("./tickets"), exports);
__exportStar(require("./codegen"), exports);
__exportStar(require("./http"), exports);
__exportStar(require("./state"), exports);
// ── Domain type modules (Section 3: Process, SSE, Connectors, etc.) ──
__exportStar(require("./process"), exports);
__exportStar(require("./sse"), exports);
__exportStar(require("./connectors"), exports);
__exportStar(require("./slack"), exports);
__exportStar(require("./approval"), exports);
__exportStar(require("./review"), exports);
__exportStar(require("./diff"), exports);
__exportStar(require("./logging"), exports);
__exportStar(require("./metrics"), exports);
__exportStar(require("./notifications"), exports);
__exportStar(require("./qa"), exports);
//# sourceMappingURL=index.js.map