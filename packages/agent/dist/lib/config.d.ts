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
interface ValidationResult {
    field: string;
    severity: "FATAL" | "ERROR" | "WARN" | "INFO";
    message: string;
    group: string;
}
interface ConfigSnapshot {
    _version: number;
    _createdAt: string;
    _schemaVersion: number;
    metadata: Record<string, any>;
    values: Record<string, any>;
}
interface ReloadOptions {
    onWarning?: (msg: string) => void;
    onReloaded?: (keys: string[]) => void;
}
interface ReloadResult {
    reloaded: string[];
    skipped: string[];
    errors: string[];
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
interface CfgObject {
    jira: {
        base: string;
        email: string | undefined;
        token: string | undefined;
        readonly auth: string;
    };
    gitlab: {
        base: string;
        token: string | undefined;
        projectId: string | undefined;
        cloneUrl: string;
        authMode: 'oauth' | 'pat';
    };
    slack: {
        webhook: string | undefined;
        ownerId: string | undefined;
        anshitId: string | undefined;
    };
    ids: {
        owner: string | undefined;
        anshit: string | undefined;
    };
    urls: {
        qa: string;
        qa1: string;
        preProd: string;
        prod: string;
    };
    qa: {
        main: QaEnvConfig;
        qa1: QaEnvConfig;
    };
    branch: {
        ts: string;
        qa: string;
        preProd: string;
        prod: string;
    };
    git: {
        authorName: string;
        authorEmail: string;
        assigneeId: string;
    };
    localRepo: boolean;
}
export declare const TICKET: string;
export declare const STATE_FILE: string;
export declare let POLL_INTERVAL: number;
export declare let CI_POLL: number;
export declare let CI_TIMEOUT: number;
export declare let JIRA_COMMENTS: boolean;
export declare let MAX_APPROVAL_TIMEOUT: number;
export declare let MAX_REJECTIONS: number;
export declare let MAX_PIPELINE_DURATION: number;
export declare let MAX_CONTINUE_WAIT: number;
export declare let MAX_PLAN_REJECTIONS: number;
export declare let ANALYSIS_TIMEOUT_MS: number;
export declare let DEVELOPER_TIMEOUT_MS: number;
export declare let REVIEWER_TIMEOUT_MS: number;
export declare let TEST_FIXER_TIMEOUT_MS: number;
export declare function applyComplexityTimeout(baseTimeout: number, state: any): number;
export declare let MAX_PROMPT_TOKENS: number;
export declare let FETCH_CONCURRENCY: number;
export declare let URL_FETCH_TIMEOUT: number;
export declare let MAX_TOTAL_COMMENTS: number;
export declare let MAX_TOTAL_ATTACHMENTS: number;
export declare let MAX_TOTAL_URL_CONTENT: number;
export declare let MAX_STATE_SIZE: number;
export declare let QA_SMOKE_LEVEL: string;
export declare let MERGE_POLL_TIMEOUT: number;
export declare let SKIP_SMOKE_CHECK: boolean;
export declare let RUN_BUILD_CHECK: boolean;
export declare let BUILD_INSTALL_TIMEOUT: number;
export declare let BUILD_TSC_TIMEOUT: number;
export declare let BUILD_ESLINT_TIMEOUT: number;
export declare let APPROVAL_REMINDER_1H: number;
export declare let APPROVAL_REMINDER_4H: number;
export declare const GIT_CLONE_DEPTH: number;
export declare let MAX_COMMIT_FILE_SIZE: number;
export declare let RUN_RUNTIME_TESTS: boolean;
export declare let UNIT_TESTS_TIMEOUT: number;
export declare let E2E_TESTS_TIMEOUT: number;
export declare let VITE_PREVIEW_TIMEOUT: number;
export declare let VITE_BUILD_TIMEOUT: number;
export declare let MAX_UNIT_TEST_RETRIES: number;
export declare let MAX_E2E_TEST_RETRIES: number;
export declare let CONSOLE_WARNING_THRESHOLD: number;
export declare let TEST_ARTIFACTS_DIR: string;
export declare const PLAYWRIGHT_BROWSER: string;
export declare let BROWSER_VERIFY: boolean;
export declare let MAX_VERIFY_RETRIES: number;
export declare let NX_SERVE_TIMEOUT: number;
export declare const NX_SERVE_PORT_RANGE_START: number;
export declare const NX_SERVE_PORT_RANGE_END: number;
export declare const VITE_PREVIEW_PORT_START: number;
export declare const VITE_PREVIEW_PORT_END: number;
export declare let VERIFICATION_TIMEOUT: number;
export declare let EVIDENCE_MAX_SIZE: number;
export declare let QA_HEALTH_TIMEOUT: number;
export declare let LOG_LEVEL: string;
export declare let SAVE_DEBUG_OUTPUT: boolean;
export declare let LOG_FORMAT: string;
export declare function monotonicMs(): number;
export declare function validateMRTarget(targetBranch: string): void;
export declare const cfg: CfgObject;
/**
 * validateConfig() — backward-compatible wrapper.
 *
 * When called with (logErr, logInfo, logWarn) — original behavior:
 *   logs errors and calls process.exit(1) on fatal errors.
 *
 * When called with no arguments — new behavior:
 *   returns { valid, results, parsed } for programmatic use.
 */
export declare function validateConfig(logErr?: (msg: string) => void, logInfo?: (msg: string) => void, logWarn?: (msg: string) => void): {
    valid: boolean;
    results: ValidationResult[];
    parsed: Record<string, any>;
} | void;
export declare function reloadConfig(options?: ReloadOptions): ReloadResult;
export declare function getConfigSnapshot(metadata?: Record<string, any>): ConfigSnapshot;
export {};
//# sourceMappingURL=config.d.ts.map