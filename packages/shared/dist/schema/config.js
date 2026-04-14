"use strict";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Config Zod Schemas
// ═══════════════════════════════════════════════════════════════
//
// Ported from:
//   - lib/config-schema.js   (CONFIG_SCHEMA: field types, defaults, bounds)
//   - lib/config-snapshot.js  (FROZEN_FIELDS / FRESH_FIELDS classification)
//   - lib/config-validate.js  (cross-field validation rules)
//
// NOTE: zod is listed as a dependency but may not be installed yet.
// It will resolve once `npm install` runs against the workspace package.json.
Object.defineProperty(exports, "__esModule", { value: true });
exports.FRESH_FIELD_NAMES = exports.FROZEN_FIELD_NAMES = exports.flatConfigSchema = exports.configSchema = exports.freshConfigSchema = exports.frozenConfigSchema = exports.riskLevelSchema = void 0;
exports.validateConfig = validateConfig;
exports.validateFrozenConfig = validateFrozenConfig;
exports.validateFreshConfig = validateFreshConfig;
exports.validateFlatConfig = validateFlatConfig;
exports.isFrozenField = isFrozenField;
exports.isFreshField = isFreshField;
const zod_1 = require("zod");
// ── Reusable refinement helpers ────────────────────────────────────
/** URL that starts with http:// or https:// */
const httpUrlSchema = zod_1.z.string().url().or(zod_1.z.string().regex(/^https?:\/\/.+/, 'Must be a valid HTTP/HTTPS URL'));
/** Optional URL — allows undefined or a valid http(s) URL */
const optionalUrlSchema = httpUrlSchema.optional();
/** Git clone URL — git@host:path or http(s)://host/path */
const gitUrlSchema = zod_1.z.string().regex(/^(git@|https?:\/\/).+/, 'Must start with git@, http://, or https://');
/** Port number (0-65535) */
const portSchema = zod_1.z.number().int().min(0).max(65535);
// ── Risk levels for config change classification ───────────────────
exports.riskLevelSchema = zod_1.z.enum(['SAFE', 'CAUTION', 'DANGEROUS']);
// ═══════════════════════════════════════════════════════════════
// Frozen config fields — cannot change mid-pipeline
// ═══════════════════════════════════════════════════════════════
// Source: lib/config-snapshot.js FROZEN_FIELDS
//
// These represent project identity, credentials, branch structure,
// and environment URLs. Changing any of these mid-pipeline would
// break the pipeline's assumptions about which project/ticket/env
// it is operating on.
exports.frozenConfigSchema = zod_1.z.object({
    // ── Project identity ─────────────────────────────────────────
    /** Jira ticket key (e.g., AUT-8031) */
    TICKET: zod_1.z.string().regex(/^[A-Z]+-\d+$/, 'Must match Jira ticket format (e.g., AUT-1234)'),
    // ── GitLab identity ──────────────────────────────────────────
    /** GitLab project ID (numeric, >= 1) */
    GITLAB_PROJECT_ID: zod_1.z.number().int().min(1),
    /** GitLab instance base URL */
    GITLAB_URL: httpUrlSchema.default('http://10.200.11.32'),
    /** Git clone URL for local repo cache */
    GITLAB_CLONE_URL: gitUrlSchema.default('git@10.200.11.32:mastersindia/mi_frontend_apps.git'),
    /** GitLab personal access token */
    GITLAB_TOKEN: zod_1.z.string().min(1, 'GitLab token is required'),
    /** GitLab user ID for MR assignee */
    GITLAB_ASSIGNEE_ID: zod_1.z.number().int().min(1).default(123),
    // ── Jira credentials ─────────────────────────────────────────
    /** Jira account email for API auth */
    JIRA_EMAIL: zod_1.z.string().email('Must be a valid email address'),
    /** Jira API token (Atlassian personal access token) */
    JIRA_TOKEN: zod_1.z.string().min(1, 'Jira token is required'),
    // ── Branch structure ─────────────────────────────────────────
    /** Source branch (read-only) */
    BRANCH_TS: zod_1.z.string().default('enterprise-ts'),
    /** QA target branch */
    BRANCH_QA: zod_1.z.string().default('enterprise-qa'),
    /** Pre-production target branch */
    BRANCH_PREPROD: zod_1.z.string().default('enterprise-pre-pro'),
    /** Production target branch */
    BRANCH_PROD: zod_1.z.string().default('enterprise-master'),
    // ── QA credentials ───────────────────────────────────────────
    /** QA Main login username */
    QA_MAIN_USER: zod_1.z.string().default('prateekrai'),
    /** QA Main login password */
    QA_MAIN_PASS: zod_1.z.string().default('sandboxtwo'),
    /** QA1 login username */
    QA1_USER: zod_1.z.string().default('aman'),
    /** QA1 login password */
    QA1_PASS: zod_1.z.string().default('entp'),
    // ── Slack identity ───────────────────────────────────────────
    /** Slack incoming webhook URL */
    SLACK_WEBHOOK: optionalUrlSchema,
    /** Slack user ID for owner mentions */
    OWNER_SLACK_ID: zod_1.z.string().optional(),
    /** Slack user ID for Anshit mentions */
    ANSHIT_SLACK_ID: zod_1.z.string().optional(),
    // ── Jira approvers ──────────────────────────────────────────
    /** Jira account ID for owner (approver 1) */
    OWNER_JIRA_ID: zod_1.z.string().optional(),
    /** Jira account ID for Anshit (approver 2) */
    ANSHIT_JIRA_ID: zod_1.z.string().optional(),
    /** Allow any Jira user to approve */
    ALLOW_ANY_APPROVER: zod_1.z.boolean().default(false),
    // ── Environment URLs ─────────────────────────────────────────
    /** QA Main environment URL */
    QA_URL: httpUrlSchema.default('https://qa-enterprise.mastersindia-einv.com'),
    /** QA1 environment URL */
    QA1_URL: httpUrlSchema.default('https://qa1-enterprise.mastersindia-einv.com'),
    /** Jira instance base URL */
    JIRA_BASE_URL: httpUrlSchema.default('https://mastersindia-sols.atlassian.net'),
    // ── Git author ───────────────────────────────────────────────
    /** Git commit author name */
    GIT_AUTHOR_NAME: zod_1.z.string().default('Yogendra'),
    /** Git commit author email */
    GIT_AUTHOR_EMAIL: zod_1.z.string().email().default('yogendrasingh@mastersindia.co'),
    /** Git clone depth for local repo cache */
    GIT_CLONE_DEPTH: zod_1.z.number().int().min(1).max(10000).default(50),
    // ── Server / UI (restart required) ───────────────────────────
    /** Web UI HTTP port */
    PORT: portSchema.default(3000),
    /** Web UI bind address */
    BIND_HOST: zod_1.z.string().regex(/^(127\.0\.0\.1|0\.0\.0\.0|localhost|\d+\.\d+\.\d+\.\d+)$/, 'Must be a valid bind address').default('127.0.0.1'),
    /** Allow skipping pipeline stages via UI */
    ALLOW_STAGE_SKIP: zod_1.z.boolean().default(false),
    // ── Playwright browser (immutable once started) ──────────────
    /** Playwright browser engine for E2E tests */
    PLAYWRIGHT_BROWSER: zod_1.z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
    // ── Port ranges (immutable once started) ─────────────────────
    /** Start of NX dev server port range */
    NX_SERVE_PORT_RANGE_START: portSchema.default(4200),
    /** End of NX dev server port range */
    NX_SERVE_PORT_RANGE_END: portSchema.default(4299),
    /** Start of Vite preview port range */
    VITE_PREVIEW_PORT_START: portSchema.default(4300),
    /** End of Vite preview port range */
    VITE_PREVIEW_PORT_END: portSchema.default(4399),
    // ── Claude CLI (restart recommended) ─────────────────────────
    /** Override Claude model */
    CLAUDE_MODEL: zod_1.z.string().optional(),
    /** Anthropic API key for direct API calls */
    ANTHROPIC_API_KEY: zod_1.z.string().optional(),
    // ── Concurrency (restart required) ───────────────────────────
    /** Max keep-alive free sockets per HTTP agent */
    MAX_FREE_SOCKETS: zod_1.z.number().int().min(1).max(100).default(10),
    /** Max concurrent agent processes */
    MAX_CONCURRENT_AGENTS: zod_1.z.number().int().min(1).max(10).default(3),
    // ── Browser verification login (frozen) ──────────────────────
    /** Browser verification login email */
    VERIFY_LOGIN_EMAIL: zod_1.z.string().optional(),
    /** Browser verification login password */
    VERIFY_LOGIN_PASS: zod_1.z.string().optional(),
});
// ═══════════════════════════════════════════════════════════════
// Fresh config fields — can be tuned mid-run
// ═══════════════════════════════════════════════════════════════
// Source: lib/config-snapshot.js FRESH_FIELDS
//
// These are timeouts, flags, limits, and logging settings that can
// be adjusted mid-pipeline without breaking pipeline integrity.
exports.freshConfigSchema = zod_1.z.object({
    // ── Timeouts — Pipeline ──────────────────────────────────────
    /** Max total pipeline duration before abort (ms, default 24h) */
    MAX_PIPELINE_DURATION: zod_1.z.number().int().min(3_600_000).default(86_400_000),
    /** Max wait for human approval (ms, default 8h) */
    MAX_APPROVAL_TIMEOUT: zod_1.z.number().int().min(60_000).default(28_800_000),
    /** Max wait for continue signal at gates (ms, default 2h) */
    MAX_CONTINUE_WAIT: zod_1.z.number().int().min(60_000).default(7_200_000),
    /** Max wait for MR merge + pipeline (ms, default 30m) */
    MERGE_POLL_TIMEOUT: zod_1.z.number().int().min(60_000).default(1_800_000),
    /** Timeout for fetching external URLs from tickets (ms) */
    URL_FETCH_TIMEOUT: zod_1.z.number().int().min(5_000).max(600_000).default(120_000),
    /** First approval reminder threshold (ms, default 1h) */
    APPROVAL_REMINDER_1H: zod_1.z.number().int().min(60_000).default(3_600_000),
    /** Second approval reminder threshold (ms, default 4h) */
    APPROVAL_REMINDER_4H: zod_1.z.number().int().min(60_000).default(14_400_000),
    // ── Timeouts — Agent CLI ─────────────────────────────────────
    /** Default Claude CLI call timeout (ms) */
    CLAUDE_TIMEOUT: zod_1.z.number().int().min(10_000).max(1_800_000).default(180_000),
    /** Analysis agent timeout (ms) */
    ANALYSIS_TIMEOUT: zod_1.z.number().int().min(60_000).max(3_600_000).default(600_000),
    /** Developer agent timeout (ms) */
    DEVELOPER_TIMEOUT: zod_1.z.number().int().min(60_000).max(3_600_000).default(900_000),
    /** Reviewer agent timeout (ms) */
    REVIEWER_TIMEOUT: zod_1.z.number().int().min(60_000).max(3_600_000).default(600_000),
    /** Test fixer agent timeout (ms) */
    TEST_FIXER_TIMEOUT: zod_1.z.number().int().min(30_000).max(1_800_000).default(180_000),
    /** CI pipeline max wait time (ms, default 30m) */
    CI_TIMEOUT: zod_1.z.number().int().min(60_000).max(7_200_000).default(1_800_000),
    // ── Timeouts — Build ─────────────────────────────────────────
    /** npm install timeout for build check (ms) */
    BUILD_INSTALL_TIMEOUT: zod_1.z.number().int().min(30_000).max(600_000).default(180_000),
    /** TypeScript compiler timeout (ms) */
    BUILD_TSC_TIMEOUT: zod_1.z.number().int().min(10_000).max(600_000).default(120_000),
    /** ESLint check timeout (ms) */
    BUILD_ESLINT_TIMEOUT: zod_1.z.number().int().min(10_000).max(300_000).default(60_000),
    // ── Timeouts — Testing ───────────────────────────────────────
    /** Unit test suite timeout (ms) */
    UNIT_TESTS_TIMEOUT: zod_1.z.number().int().min(10_000).max(600_000).default(180_000),
    /** E2E test suite timeout (ms) */
    E2E_TESTS_TIMEOUT: zod_1.z.number().int().min(30_000).max(1_200_000).default(300_000),
    /** Vite preview server startup timeout (ms) */
    VITE_PREVIEW_TIMEOUT: zod_1.z.number().int().min(5_000).max(120_000).default(30_000),
    /** Vite build timeout (ms) */
    VITE_BUILD_TIMEOUT: zod_1.z.number().int().min(30_000).max(1_800_000).default(600_000),
    // ── Timeouts — Browser Verification ──────────────────────────
    /** Total browser verification timeout (ms) */
    VERIFICATION_TIMEOUT: zod_1.z.number().int().min(30_000).max(1_200_000).default(300_000),
    /** NX dev server startup timeout (ms) */
    NX_SERVE_TIMEOUT: zod_1.z.number().int().min(10_000).max(600_000).default(120_000),
    /** Timeout for QA health check (ms) */
    QA_HEALTH_TIMEOUT: zod_1.z.number().int().min(1_000).max(120_000).default(10_000),
    // ── Flags ────────────────────────────────────────────────────
    /** Run TSC + ESLint build checks on generated code */
    RUN_BUILD_CHECK: zod_1.z.boolean().default(true),
    /** Enable browser-based verification of generated code */
    BROWSER_VERIFY: zod_1.z.boolean().default(true),
    /** Run unit + E2E tests on generated code */
    RUN_RUNTIME_TESTS: zod_1.z.boolean().default(true),
    /** Whether to post comments to Jira tickets */
    JIRA_COMMENTS_ENABLED: zod_1.z.boolean().default(true),
    /** Skip QA smoke check after deploy */
    SKIP_SMOKE_CHECK: zod_1.z.boolean().default(false),
    /** Save Claude prompt/output to .debug/ directory */
    SAVE_DEBUG_OUTPUT: zod_1.z.boolean().default(false),
    // ── Limits ───────────────────────────────────────────────────
    /** Max code review rejection cycles before halting */
    MAX_REJECTIONS: zod_1.z.number().int().min(1).max(20).default(3),
    /** Max plan rejection iterations before halting */
    MAX_PLAN_REJECTIONS: zod_1.z.number().int().min(1).max(20).default(5),
    /** Max estimated tokens per Claude prompt */
    MAX_PROMPT_TOKENS: zod_1.z.number().int().min(10_000).max(500_000).default(180_000),
    /** Max parallel HTTP fetches for ticket context */
    FETCH_CONCURRENCY: zod_1.z.number().int().min(1).max(20).default(5),
    /** Max browser verification retry attempts */
    MAX_VERIFY_RETRIES: zod_1.z.number().int().min(0).max(10).default(3),
    /** Max retries for failing unit tests */
    MAX_UNIT_TEST_RETRIES: zod_1.z.number().int().min(0).max(10).default(2),
    /** Max retries for failing E2E tests */
    MAX_E2E_TEST_RETRIES: zod_1.z.number().int().min(0).max(10).default(3),
    /** Max browser console warnings before flagging */
    CONSOLE_WARNING_THRESHOLD: zod_1.z.number().int().min(0).max(100).default(5),
    /** Maximum file size for a single commit action (bytes) */
    MAX_COMMIT_FILE_SIZE: zod_1.z.number().int().min(1_024).max(10_000_000).default(512_000),
    /** Max size for verification evidence (bytes) */
    EVIDENCE_MAX_SIZE: zod_1.z.number().int().min(1_024).max(1_000_000).default(10_240),
    /** Max Jira comments to fetch per ticket */
    MAX_TOTAL_COMMENTS: zod_1.z.number().int().min(10).max(500).default(100),
    /** Max attachments to process per ticket */
    MAX_TOTAL_ATTACHMENTS: zod_1.z.number().int().min(1).max(100).default(20),
    /** Max total bytes of URL content to fetch */
    MAX_TOTAL_URL_CONTENT: zod_1.z.number().int().min(10_000).max(5_000_000).default(500_000),
    /** Max state file size before warning (bytes) */
    MAX_STATE_SIZE: zod_1.z.number().int().min(1_000_000).max(100_000_000).default(10_000_000),
    // ── Polling ──────────────────────────────────────────────────
    /** Jira approval polling interval (ms) */
    POLL_INTERVAL: zod_1.z.number().int().min(5_000).max(300_000).default(30_000),
    /** CI pipeline polling interval (ms) */
    CI_POLL: zod_1.z.number().int().min(10_000).max(300_000).default(60_000),
    // ── Logging ──────────────────────────────────────────────────
    /** Logging verbosity level */
    LOG_LEVEL: zod_1.z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    /** Log output format */
    LOG_FORMAT: zod_1.z.enum(['text', 'json']).default('text'),
    // ── QA settings ──────────────────────────────────────────────
    /** QA smoke test level */
    QA_SMOKE_LEVEL: zod_1.z.enum(['basic', 'full', 'none']).default('basic'),
    // ── Testing config ───────────────────────────────────────────
    /** Directory for test screenshots/artifacts */
    TEST_ARTIFACTS_DIR: zod_1.z.string().default('.test-artifacts'),
    // ── Vite env (for generated project) ─────────────────────────
    /** Vite app API URL */
    VITE_APP_API_URL: httpUrlSchema.default('https://qa-enterprise.mastersindia-einv.com/api/v2.1/'),
    /** Vite app QA base URL */
    VITE_APP_QA: httpUrlSchema.default('https://qa-enterprise.mastersindia-einv.com'),
    /** Enterprise product ID */
    VITE_PRODUCT_ID: zod_1.z.number().int().min(1).default(2),
});
// ═══════════════════════════════════════════════════════════════
// Full config schema — frozen + fresh combined
// ═══════════════════════════════════════════════════════════════
exports.configSchema = zod_1.z.object({
    frozen: exports.frozenConfigSchema,
    fresh: exports.freshConfigSchema,
});
// ═══════════════════════════════════════════════════════════════
// Flat config schema — all fields at one level with cross-field
// validation (ported from config-validate.js)
// ═══════════════════════════════════════════════════════════════
exports.flatConfigSchema = exports.frozenConfigSchema.merge(exports.freshConfigSchema).superRefine((cfg, ctx) => {
    // Cross-field validation #1: NX port range START must be <= END
    if (cfg.NX_SERVE_PORT_RANGE_START > cfg.NX_SERVE_PORT_RANGE_END) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: `NX serve port range invalid: START (${cfg.NX_SERVE_PORT_RANGE_START}) > END (${cfg.NX_SERVE_PORT_RANGE_END}). Swap the values.`,
            path: ['NX_SERVE_PORT_RANGE_START'],
        });
    }
    // Cross-field validation #2: Vite preview port range START must be <= END
    if (cfg.VITE_PREVIEW_PORT_START > cfg.VITE_PREVIEW_PORT_END) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: `Vite preview port range invalid: START (${cfg.VITE_PREVIEW_PORT_START}) > END (${cfg.VITE_PREVIEW_PORT_END}). Swap the values.`,
            path: ['VITE_PREVIEW_PORT_START'],
        });
    }
    // Cross-field validation #3: First approval reminder must be < second
    if (cfg.APPROVAL_REMINDER_1H >= cfg.APPROVAL_REMINDER_4H) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: `First approval reminder (${cfg.APPROVAL_REMINDER_1H}ms) >= second reminder (${cfg.APPROVAL_REMINDER_4H}ms). First should be shorter.`,
            path: ['APPROVAL_REMINDER_1H'],
        });
    }
    // Cross-field validation #4: Approval timeout must be < pipeline duration
    if (cfg.MAX_APPROVAL_TIMEOUT >= cfg.MAX_PIPELINE_DURATION) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: `Approval timeout (${cfg.MAX_APPROVAL_TIMEOUT}ms) >= pipeline duration (${cfg.MAX_PIPELINE_DURATION}ms). Pipeline may timeout before approval.`,
            path: ['MAX_APPROVAL_TIMEOUT'],
        });
    }
    // Cross-field validation #5: Both approver IDs must not be the same
    if (cfg.OWNER_JIRA_ID && cfg.ANSHIT_JIRA_ID && cfg.OWNER_JIRA_ID === cfg.ANSHIT_JIRA_ID) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: 'Both approver IDs are the same — dual approval gate will be ineffective.',
            path: ['OWNER_JIRA_ID'],
        });
    }
    // Cross-field validation #6: At least one approver OR ALLOW_ANY_APPROVER
    if (!cfg.OWNER_JIRA_ID && !cfg.ANSHIT_JIRA_ID && !cfg.ALLOW_ANY_APPROVER) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: 'Both approver IDs empty and ALLOW_ANY_APPROVER is false. Set at least one approver or enable ALLOW_ANY_APPROVER.',
            path: ['ALLOW_ANY_APPROVER'],
        });
    }
    // Cross-field validation #7: GitLab URL should use HTTPS in production
    if (cfg.GITLAB_URL && cfg.GITLAB_URL.startsWith('http://')) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: 'GitLab URL uses HTTP — API tokens transmitted unencrypted. Use HTTPS for production.',
            path: ['GITLAB_URL'],
        });
    }
});
// ═══════════════════════════════════════════════════════════════
// Validation helpers
// ═══════════════════════════════════════════════════════════════
/** Validate a complete config (frozen + fresh) */
function validateConfig(data) {
    return exports.configSchema.safeParse(data);
}
/** Validate only frozen fields */
function validateFrozenConfig(data) {
    return exports.frozenConfigSchema.safeParse(data);
}
/** Validate only fresh fields */
function validateFreshConfig(data) {
    return exports.freshConfigSchema.safeParse(data);
}
/** Validate a flat config object with cross-field checks */
function validateFlatConfig(data) {
    return exports.flatConfigSchema.safeParse(data);
}
// ═══════════════════════════════════════════════════════════════
// Field classification sets (mirrors config-snapshot.js)
// ═══════════════════════════════════════════════════════════════
/** Set of field names that are frozen mid-pipeline */
exports.FROZEN_FIELD_NAMES = new Set(Object.keys(exports.frozenConfigSchema.shape));
/** Set of field names that can be tuned mid-run */
exports.FRESH_FIELD_NAMES = new Set(Object.keys(exports.freshConfigSchema.shape));
/** Check if a field name is frozen */
function isFrozenField(name) {
    return exports.FROZEN_FIELD_NAMES.has(name);
}
/** Check if a field name is fresh (hot-reloadable) */
function isFreshField(name) {
    return exports.FRESH_FIELD_NAMES.has(name);
}
//# sourceMappingURL=config.js.map