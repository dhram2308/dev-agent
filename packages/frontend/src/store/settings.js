// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Zustand Settings Store
// Manages config, notification, and connector state for the
// Settings page (3 tabs: Config, Notifications, Connectors)
// ═══════════════════════════════════════════════════════════════
import { create } from 'zustand';
import * as api from '../lib/api';
// ── Config Field Definitions ────────────────────────────────
// Derived from the shared config schema (packages/shared/src/schema/config.ts)
// Groups config fields by service for the Settings UI
export const CONFIG_GROUPS = [
    {
        id: 'jira',
        label: 'Jira',
        description: 'Jira credentials and settings',
        icon: 'jira',
        fields: [
            { key: 'JIRA_BASE_URL', label: 'Jira Base URL', type: 'string', description: 'Jira instance base URL', required: true, frozen: true },
            { key: 'JIRA_EMAIL', label: 'Jira Email', type: 'string', description: 'Jira account email for API auth', required: true, frozen: true },
            { key: 'JIRA_TOKEN', label: 'Jira API Token', type: 'password', description: 'Jira API token (Atlassian personal access token)', required: true, frozen: true },
            { key: 'JIRA_COMMENTS_ENABLED', label: 'Jira Comments', type: 'boolean', description: 'Whether to post comments to Jira tickets', required: false, frozen: false, defaultValue: true },
            { key: 'OWNER_JIRA_ID', label: 'Owner Jira ID', type: 'string', description: 'Jira account ID for owner (approver 1)', required: false, frozen: true },
            { key: 'ANSHIT_JIRA_ID', label: 'Anshit Jira ID', type: 'string', description: 'Jira account ID for Anshit (approver 2)', required: false, frozen: true },
            { key: 'ALLOW_ANY_APPROVER', label: 'Allow Any Approver', type: 'boolean', description: 'Allow any Jira user to approve', required: false, frozen: true, defaultValue: false },
        ],
    },
    {
        id: 'gitlab',
        label: 'GitLab',
        description: 'GitLab credentials and project settings',
        icon: 'gitlab',
        fields: [
            { key: 'GITLAB_URL', label: 'GitLab URL', type: 'string', description: 'GitLab instance base URL', required: true, frozen: true },
            { key: 'GITLAB_TOKEN', label: 'GitLab Token', type: 'password', description: 'GitLab personal access token', required: true, frozen: true },
            { key: 'GITLAB_PROJECT_ID', label: 'Project ID', type: 'number', description: 'GitLab project ID (numeric)', required: true, frozen: true, min: 1 },
            { key: 'GITLAB_CLONE_URL', label: 'Clone URL', type: 'string', description: 'Git clone URL for local repo cache', required: true, frozen: true },
            { key: 'GITLAB_ASSIGNEE_ID', label: 'Assignee ID', type: 'number', description: 'GitLab user ID for MR assignee', required: true, frozen: true, min: 1, defaultValue: 123 },
        ],
    },
    {
        id: 'slack',
        label: 'Slack',
        description: 'Slack webhook and user identifiers',
        icon: 'slack',
        fields: [
            { key: 'SLACK_WEBHOOK', label: 'Webhook URL', type: 'password', description: 'Slack incoming webhook URL', required: false, frozen: true },
            { key: 'OWNER_SLACK_ID', label: 'Owner Slack ID', type: 'string', description: 'Slack user ID for owner mentions', required: false, frozen: true },
            { key: 'ANSHIT_SLACK_ID', label: 'Anshit Slack ID', type: 'string', description: 'Slack user ID for Anshit mentions', required: false, frozen: true },
        ],
    },
    {
        id: 'branches',
        label: 'Branches',
        description: 'Git branch structure',
        icon: 'git',
        fields: [
            { key: 'BRANCH_TS', label: 'Source Branch', type: 'string', description: 'Source branch (read-only)', required: true, frozen: true, defaultValue: 'enterprise-ts' },
            { key: 'BRANCH_QA', label: 'QA Branch', type: 'string', description: 'QA target branch', required: true, frozen: true, defaultValue: 'enterprise-qa' },
            { key: 'BRANCH_PREPROD', label: 'Pre-Prod Branch', type: 'string', description: 'Pre-production target branch', required: true, frozen: true, defaultValue: 'enterprise-pre-pro' },
            { key: 'BRANCH_PROD', label: 'Production Branch', type: 'string', description: 'Production target branch', required: true, frozen: true, defaultValue: 'enterprise-master' },
        ],
    },
    {
        id: 'git-author',
        label: 'Git Author',
        description: 'Commit author configuration',
        icon: 'user',
        fields: [
            { key: 'GIT_AUTHOR_NAME', label: 'Author Name', type: 'string', description: 'Git commit author name', required: true, frozen: true, defaultValue: 'Yogendra' },
            { key: 'GIT_AUTHOR_EMAIL', label: 'Author Email', type: 'string', description: 'Git commit author email', required: true, frozen: true, defaultValue: 'yogendrasingh@mastersindia.co' },
            { key: 'GIT_CLONE_DEPTH', label: 'Clone Depth', type: 'number', description: 'Git clone depth for local repo cache', required: false, frozen: true, min: 1, max: 10000, defaultValue: 50 },
        ],
    },
    {
        id: 'qa',
        label: 'QA',
        description: 'QA environment and credentials',
        icon: 'flask',
        fields: [
            { key: 'QA_URL', label: 'QA Main URL', type: 'string', description: 'QA Main environment URL', required: true, frozen: true },
            { key: 'QA1_URL', label: 'QA1 URL', type: 'string', description: 'QA1 environment URL', required: true, frozen: true },
            { key: 'QA_MAIN_USER', label: 'QA Main User', type: 'string', description: 'QA Main login username', required: true, frozen: true },
            { key: 'QA_MAIN_PASS', label: 'QA Main Password', type: 'password', description: 'QA Main login password', required: true, frozen: true },
            { key: 'QA1_USER', label: 'QA1 User', type: 'string', description: 'QA1 login username', required: true, frozen: true },
            { key: 'QA1_PASS', label: 'QA1 Password', type: 'password', description: 'QA1 login password', required: true, frozen: true },
            { key: 'QA_SMOKE_LEVEL', label: 'Smoke Test Level', type: 'enum', description: 'QA smoke test level', required: false, frozen: false, enumValues: ['basic', 'full', 'none'], defaultValue: 'basic' },
            { key: 'SKIP_SMOKE_CHECK', label: 'Skip Smoke Check', type: 'boolean', description: 'Skip QA smoke check after deploy', required: false, frozen: false, defaultValue: false },
            { key: 'QA_HEALTH_TIMEOUT', label: 'Health Check Timeout', type: 'number', description: 'Timeout for QA health check (ms)', required: false, frozen: false, min: 1000, max: 120000, defaultValue: 10000 },
        ],
    },
    {
        id: 'timeouts-pipeline',
        label: 'Timeouts - Pipeline',
        description: 'Pipeline-level timeout settings',
        icon: 'clock',
        fields: [
            { key: 'MAX_PIPELINE_DURATION', label: 'Max Pipeline Duration', type: 'number', description: 'Max total pipeline duration before abort (ms, default 24h)', required: false, frozen: false, min: 3600000, defaultValue: 86400000 },
            { key: 'MAX_APPROVAL_TIMEOUT', label: 'Max Approval Timeout', type: 'number', description: 'Max wait for human approval (ms, default 8h)', required: false, frozen: false, min: 60000, defaultValue: 28800000 },
            { key: 'MAX_CONTINUE_WAIT', label: 'Max Continue Wait', type: 'number', description: 'Max wait for continue signal at gates (ms, default 2h)', required: false, frozen: false, min: 60000, defaultValue: 7200000 },
            { key: 'MERGE_POLL_TIMEOUT', label: 'Merge Poll Timeout', type: 'number', description: 'Max wait for MR merge + pipeline (ms, default 30m)', required: false, frozen: false, min: 60000, defaultValue: 1800000 },
            { key: 'URL_FETCH_TIMEOUT', label: 'URL Fetch Timeout', type: 'number', description: 'Timeout for fetching external URLs from tickets (ms)', required: false, frozen: false, min: 5000, max: 600000, defaultValue: 120000 },
            { key: 'APPROVAL_REMINDER_1H', label: '1st Approval Reminder', type: 'number', description: 'First approval reminder threshold (ms, default 1h)', required: false, frozen: false, min: 60000, defaultValue: 3600000 },
            { key: 'APPROVAL_REMINDER_4H', label: '2nd Approval Reminder', type: 'number', description: 'Second approval reminder threshold (ms, default 4h)', required: false, frozen: false, min: 60000, defaultValue: 14400000 },
        ],
    },
    {
        id: 'timeouts-agent',
        label: 'Timeouts - Agent CLI',
        description: 'Claude agent timeout settings',
        icon: 'terminal',
        fields: [
            { key: 'CLAUDE_TIMEOUT', label: 'Claude CLI Timeout', type: 'number', description: 'Default Claude CLI call timeout (ms)', required: false, frozen: false, min: 10000, max: 1800000, defaultValue: 180000 },
            { key: 'ANALYSIS_TIMEOUT', label: 'Analysis Timeout', type: 'number', description: 'Analysis agent timeout (ms)', required: false, frozen: false, min: 60000, max: 3600000, defaultValue: 600000 },
            { key: 'DEVELOPER_TIMEOUT', label: 'Developer Timeout', type: 'number', description: 'Developer agent timeout (ms)', required: false, frozen: false, min: 60000, max: 3600000, defaultValue: 900000 },
            { key: 'REVIEWER_TIMEOUT', label: 'Reviewer Timeout', type: 'number', description: 'Reviewer agent timeout (ms)', required: false, frozen: false, min: 60000, max: 3600000, defaultValue: 600000 },
            { key: 'TEST_FIXER_TIMEOUT', label: 'Test Fixer Timeout', type: 'number', description: 'Test fixer agent timeout (ms)', required: false, frozen: false, min: 30000, max: 1800000, defaultValue: 180000 },
            { key: 'CI_TIMEOUT', label: 'CI Timeout', type: 'number', description: 'CI pipeline max wait time (ms, default 30m)', required: false, frozen: false, min: 60000, max: 7200000, defaultValue: 1800000 },
        ],
    },
    {
        id: 'timeouts-build',
        label: 'Timeouts - Build',
        description: 'Build and lint timeout settings',
        icon: 'hammer',
        fields: [
            { key: 'BUILD_INSTALL_TIMEOUT', label: 'npm Install Timeout', type: 'number', description: 'npm install timeout for build check (ms)', required: false, frozen: false, min: 30000, max: 600000, defaultValue: 180000 },
            { key: 'BUILD_TSC_TIMEOUT', label: 'TSC Timeout', type: 'number', description: 'TypeScript compiler timeout (ms)', required: false, frozen: false, min: 10000, max: 600000, defaultValue: 120000 },
            { key: 'BUILD_ESLINT_TIMEOUT', label: 'ESLint Timeout', type: 'number', description: 'ESLint check timeout (ms)', required: false, frozen: false, min: 10000, max: 300000, defaultValue: 60000 },
        ],
    },
    {
        id: 'timeouts-test',
        label: 'Timeouts - Testing',
        description: 'Test suite and browser timeout settings',
        icon: 'testTube',
        fields: [
            { key: 'UNIT_TESTS_TIMEOUT', label: 'Unit Tests Timeout', type: 'number', description: 'Unit test suite timeout (ms)', required: false, frozen: false, min: 10000, max: 600000, defaultValue: 180000 },
            { key: 'E2E_TESTS_TIMEOUT', label: 'E2E Tests Timeout', type: 'number', description: 'E2E test suite timeout (ms)', required: false, frozen: false, min: 30000, max: 1200000, defaultValue: 300000 },
            { key: 'VITE_PREVIEW_TIMEOUT', label: 'Vite Preview Timeout', type: 'number', description: 'Vite preview server startup timeout (ms)', required: false, frozen: false, min: 5000, max: 120000, defaultValue: 30000 },
            { key: 'VITE_BUILD_TIMEOUT', label: 'Vite Build Timeout', type: 'number', description: 'Vite build timeout (ms)', required: false, frozen: false, min: 30000, max: 1800000, defaultValue: 600000 },
            { key: 'VERIFICATION_TIMEOUT', label: 'Verification Timeout', type: 'number', description: 'Total browser verification timeout (ms)', required: false, frozen: false, min: 30000, max: 1200000, defaultValue: 300000 },
            { key: 'NX_SERVE_TIMEOUT', label: 'NX Serve Timeout', type: 'number', description: 'NX dev server startup timeout (ms)', required: false, frozen: false, min: 10000, max: 600000, defaultValue: 120000 },
        ],
    },
    {
        id: 'flags',
        label: 'Feature Flags',
        description: 'Toggle pipeline features on/off',
        icon: 'toggle',
        fields: [
            { key: 'RUN_BUILD_CHECK', label: 'Run Build Check', type: 'boolean', description: 'Run TSC + ESLint build checks on generated code', required: false, frozen: false, defaultValue: true },
            { key: 'BROWSER_VERIFY', label: 'Browser Verify', type: 'boolean', description: 'Enable browser-based verification of generated code', required: false, frozen: false, defaultValue: true },
            { key: 'RUN_RUNTIME_TESTS', label: 'Run Runtime Tests', type: 'boolean', description: 'Run unit + E2E tests on generated code', required: false, frozen: false, defaultValue: true },
            { key: 'SAVE_DEBUG_OUTPUT', label: 'Save Debug Output', type: 'boolean', description: 'Save Claude prompt/output to .debug/ directory', required: false, frozen: false, defaultValue: false },
            { key: 'ALLOW_STAGE_SKIP', label: 'Allow Stage Skip', type: 'boolean', description: 'Allow skipping pipeline stages via UI', required: false, frozen: true, defaultValue: false },
        ],
    },
    {
        id: 'limits',
        label: 'Limits',
        description: 'Retry counts, concurrency, and size limits',
        icon: 'sliders',
        fields: [
            { key: 'MAX_REJECTIONS', label: 'Max Code Rejections', type: 'number', description: 'Max code review rejection cycles before halting', required: false, frozen: false, min: 1, max: 20, defaultValue: 3 },
            { key: 'MAX_PLAN_REJECTIONS', label: 'Max Plan Rejections', type: 'number', description: 'Max plan rejection iterations before halting', required: false, frozen: false, min: 1, max: 20, defaultValue: 5 },
            { key: 'MAX_PROMPT_TOKENS', label: 'Max Prompt Tokens', type: 'number', description: 'Max estimated tokens per Claude prompt', required: false, frozen: false, min: 10000, max: 500000, defaultValue: 180000 },
            { key: 'FETCH_CONCURRENCY', label: 'Fetch Concurrency', type: 'number', description: 'Max parallel HTTP fetches for ticket context', required: false, frozen: false, min: 1, max: 20, defaultValue: 5 },
            { key: 'MAX_VERIFY_RETRIES', label: 'Max Verify Retries', type: 'number', description: 'Max browser verification retry attempts', required: false, frozen: false, min: 0, max: 10, defaultValue: 3 },
            { key: 'MAX_UNIT_TEST_RETRIES', label: 'Max Unit Test Retries', type: 'number', description: 'Max retries for failing unit tests', required: false, frozen: false, min: 0, max: 10, defaultValue: 2 },
            { key: 'MAX_E2E_TEST_RETRIES', label: 'Max E2E Test Retries', type: 'number', description: 'Max retries for failing E2E tests', required: false, frozen: false, min: 0, max: 10, defaultValue: 3 },
            { key: 'MAX_CONCURRENT_AGENTS', label: 'Max Concurrent Agents', type: 'number', description: 'Max concurrent agent processes', required: false, frozen: true, min: 1, max: 10, defaultValue: 3 },
            { key: 'MAX_COMMIT_FILE_SIZE', label: 'Max Commit File Size', type: 'number', description: 'Maximum file size for a single commit action (bytes)', required: false, frozen: false, min: 1024, max: 10000000, defaultValue: 512000 },
            { key: 'MAX_TOTAL_COMMENTS', label: 'Max Jira Comments', type: 'number', description: 'Max Jira comments to fetch per ticket', required: false, frozen: false, min: 10, max: 500, defaultValue: 100 },
        ],
    },
    {
        id: 'polling',
        label: 'Polling',
        description: 'Polling interval settings',
        icon: 'refresh',
        fields: [
            { key: 'POLL_INTERVAL', label: 'Jira Poll Interval', type: 'number', description: 'Jira approval polling interval (ms)', required: false, frozen: false, min: 5000, max: 300000, defaultValue: 30000 },
            { key: 'CI_POLL', label: 'CI Poll Interval', type: 'number', description: 'CI pipeline polling interval (ms)', required: false, frozen: false, min: 10000, max: 300000, defaultValue: 60000 },
        ],
    },
    {
        id: 'logging',
        label: 'Logging',
        description: 'Log level and format settings',
        icon: 'file',
        fields: [
            { key: 'LOG_LEVEL', label: 'Log Level', type: 'enum', description: 'Logging verbosity level', required: false, frozen: false, enumValues: ['trace', 'debug', 'info', 'warn', 'error'], defaultValue: 'info' },
            { key: 'LOG_FORMAT', label: 'Log Format', type: 'enum', description: 'Log output format', required: false, frozen: false, enumValues: ['text', 'json'], defaultValue: 'text' },
        ],
    },
    {
        id: 'server',
        label: 'Server',
        description: 'Web UI server settings (restart required)',
        icon: 'server',
        fields: [
            { key: 'PORT', label: 'Port', type: 'number', description: 'Web UI HTTP port', required: true, frozen: true, min: 0, max: 65535, defaultValue: 3000 },
            { key: 'BIND_HOST', label: 'Bind Host', type: 'string', description: 'Web UI bind address', required: true, frozen: true, defaultValue: '127.0.0.1' },
            { key: 'MAX_FREE_SOCKETS', label: 'Max Free Sockets', type: 'number', description: 'Max keep-alive free sockets per HTTP agent', required: false, frozen: true, min: 1, max: 100, defaultValue: 10 },
        ],
    },
    {
        id: 'claude',
        label: 'Claude',
        description: 'Claude CLI and API settings',
        icon: 'bot',
        fields: [
            { key: 'CLAUDE_MODEL', label: 'Claude Model', type: 'string', description: 'Override Claude model', required: false, frozen: true },
            { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', type: 'password', description: 'Anthropic API key for direct API calls', required: false, frozen: true },
        ],
    },
    {
        id: 'browser',
        label: 'Browser',
        description: 'Playwright and verification settings',
        icon: 'monitor',
        fields: [
            { key: 'PLAYWRIGHT_BROWSER', label: 'Playwright Browser', type: 'enum', description: 'Playwright browser engine for E2E tests', required: false, frozen: true, enumValues: ['chromium', 'firefox', 'webkit'], defaultValue: 'chromium' },
            { key: 'VERIFY_LOGIN_EMAIL', label: 'Verify Login Email', type: 'string', description: 'Browser verification login email', required: false, frozen: true },
            { key: 'VERIFY_LOGIN_PASS', label: 'Verify Login Password', type: 'password', description: 'Browser verification login password', required: false, frozen: true },
            { key: 'CONSOLE_WARNING_THRESHOLD', label: 'Console Warning Threshold', type: 'number', description: 'Max browser console warnings before flagging', required: false, frozen: false, min: 0, max: 100, defaultValue: 5 },
        ],
    },
];
// ── Notification defaults ───────────────────────────────────
export const NOTIFICATION_GATES = [
    { id: 'fetch_ticket', label: 'Fetch Ticket' },
    { id: 'explore_plan', label: 'Plan Ready' },
    { id: 'generate_code', label: 'Code Generated' },
    { id: 'gate_code_review', label: 'Code Review Gate' },
    { id: 'deploy_qa', label: 'QA Deploy' },
    { id: 'test_qa', label: 'QA Testing' },
    { id: 'gate_preprod_approval', label: 'Pre-Prod Gate' },
    { id: 'gate_dual_approval', label: 'Dual Approval Gate' },
    { id: 'deploy_prod', label: 'Production Deploy' },
];
export const NOTIFICATION_CHANNELS = [
    { id: 'slack', label: 'Slack' },
    { id: 'jira', label: 'Jira' },
    { id: 'email', label: 'Email' },
    { id: 'ui', label: 'UI' },
    { id: 'log', label: 'Log' },
];
// ── Default connectors ──────────────────────────────────────
// 12 connectors total. Core services + content connectors (figma/gdrive/postman)
// have their status derived from config. Connectors without backend modules
// (confluence, notion, email) remain "coming_soon".
const DEFAULT_CONNECTORS = [
    // — Core services (status derived from config) —
    {
        id: 'jira',
        name: 'Jira',
        description: 'Issue tracking and project management. Source of ticket context.',
        icon: 'jira',
        status: 'disconnected',
    },
    {
        id: 'gitlab',
        name: 'GitLab',
        description: 'Source control, CI/CD, and merge requests for the enterprise repo.',
        icon: 'gitlab',
        status: 'disconnected',
    },
    {
        id: 'slack',
        name: 'Slack',
        description: 'Team notifications and alerts at every pipeline gate.',
        icon: 'slack',
        status: 'disconnected',
    },
    {
        id: 'claude',
        name: 'Claude CLI',
        description: 'AI code generation via the local Claude CLI (login-based).',
        icon: 'claude',
        status: 'disconnected',
    },
    // — External content connectors —
    {
        id: 'google-drive',
        name: 'Google Drive',
        description: 'Auto-fetch Google Docs and Sheets linked in Jira tickets.',
        icon: 'drive',
        status: 'disconnected',
    },
    {
        id: 'figma',
        name: 'Figma',
        description: 'Auto-fetch Figma design files, extract text and structure.',
        icon: 'figma',
        status: 'disconnected',
    },
    {
        id: 'postman',
        name: 'Postman',
        description: 'Auto-fetch Postman collections, flatten API endpoints.',
        icon: 'postman',
        status: 'disconnected',
    },
    {
        id: 'confluence',
        name: 'Confluence',
        description: 'Team wiki pages and documentation linked from tickets.',
        icon: 'confluence',
        status: 'coming_soon',
    },
    {
        id: 'notion',
        name: 'Notion',
        description: 'Notes, specs, and knowledge base pages linked from tickets.',
        icon: 'notion',
        status: 'coming_soon',
    },
    // — Runtime / API services —
    {
        id: 'anthropic',
        name: 'Anthropic API',
        description: 'Direct Anthropic API access (alternative to Claude CLI login).',
        icon: 'anthropic',
        status: 'disconnected',
    },
    {
        id: 'browser',
        name: 'Playwright / Browser',
        description: 'Browser engine for E2E tests and generated-code verification.',
        icon: 'browser',
        status: 'disconnected',
    },
    {
        id: 'email',
        name: 'Email / SMTP',
        description: 'Gate notifications via email (opt-in, per-gate channel).',
        icon: 'email',
        status: 'coming_soon',
    },
];
// ── Helpers ─────────────────────────────────────────────────
/**
 * Derive live connector status from current config. Services flip to "connected"
 * when their required credentials are present; coming-soon connectors stay as-is.
 */
export function deriveConnectorStatuses(base, cfg) {
    const has = (k) => {
        const v = cfg[k];
        return typeof v === 'string' ? v.trim().length > 0 : v != null && v !== false;
    };
    return base.map((c) => {
        if (c.status === 'coming_soon')
            return c;
        let connected = false;
        switch (c.id) {
            case 'jira':
                connected = has('JIRA_BASE_URL') && has('JIRA_TOKEN') && has('JIRA_EMAIL');
                break;
            case 'gitlab':
                connected = has('GITLAB_URL') && has('GITLAB_TOKEN') && has('GITLAB_PROJECT_ID');
                break;
            case 'slack':
                connected = has('SLACK_WEBHOOK');
                break;
            case 'claude':
                // Claude CLI is login-based; we treat it as connected if a model is set
                // OR an API key is configured (for fallback path).
                connected = has('CLAUDE_MODEL') || has('ANTHROPIC_API_KEY');
                break;
            case 'anthropic':
                connected = has('ANTHROPIC_API_KEY');
                break;
            case 'browser':
                connected = has('PLAYWRIGHT_BROWSER');
                break;
            case 'figma':
                connected = has('FIGMA_TOKEN') || has('FIGMA_OAUTH_ACCESS_TOKEN');
                break;
            case 'google-drive':
                connected = has('GDRIVE_SERVICE_ACCOUNT_JSON') || has('GOOGLE_OAUTH_ACCESS_TOKEN');
                break;
            case 'postman':
                connected = has('POSTMAN_API_KEY');
                break;
            default:
                connected = false;
        }
        return { ...c, status: connected ? 'connected' : 'disconnected' };
    });
}
// ── Store ──────────────────────────────────────────────────
export const useSettingsStore = create((set, get) => ({
    config: {},
    originalConfig: {},
    configGroups: CONFIG_GROUPS,
    loading: false,
    saving: false,
    error: null,
    activeTab: 'config',
    notificationConfig: {},
    notificationLoading: false,
    notificationSaving: false,
    connectors: DEFAULT_CONNECTORS,
    testResults: {},
    isDirty: false,
    focusGroup: null,
    oauthStatuses: {},
    setActiveTab: (tab) => {
        set({ activeTab: tab, error: null });
    },
    setFocusGroup: (id) => {
        set({ focusGroup: id });
    },
    fetchConfig: async () => {
        set({ loading: true, error: null });
        try {
            const result = await api.getConfig();
            // Backend returns `{ ok, items: [{ key, env, value, ... }, ...] }`.
            // Flatten into a key → value map so UI components can read
            // `config[field.key]` directly (previous implementation contract).
            const items = Array.isArray(result.items) ? result.items : [];
            const config = {};
            for (const item of items) {
                const k = item.env || item.key;
                if (k)
                    config[k] = item.value;
            }
            set({
                config: { ...config },
                originalConfig: { ...config },
                loading: false,
                isDirty: false,
                connectors: deriveConnectorStatuses(DEFAULT_CONNECTORS, config),
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            set({ loading: false, error: message });
        }
    },
    saveConfig: async () => {
        set({ saving: true, error: null });
        try {
            // Build `values` payload: strings only, drop masked sensitive values
            // ("****...") so we don't overwrite secrets, and only send changed fields.
            const current = get().config;
            const original = get().originalConfig;
            const values = {};
            for (const [k, v] of Object.entries(current)) {
                if (v === null || v === undefined)
                    continue;
                const str = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
                if (str.startsWith('****'))
                    continue;
                if (str === String(original[k] ?? ''))
                    continue;
                values[k] = str;
            }
            await api.saveConfig(values);
            const config = { ...get().config };
            set({
                saving: false,
                originalConfig: config,
                isDirty: false,
                connectors: deriveConnectorStatuses(DEFAULT_CONNECTORS, config),
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            set({ saving: false, error: message });
        }
    },
    updateField: (key, value) => {
        const config = { ...get().config, [key]: value };
        const original = get().originalConfig;
        // Check dirty state
        let isDirty = false;
        for (const k of Object.keys(config)) {
            if (config[k] !== original[k]) {
                isDirty = true;
                break;
            }
        }
        set({ config, isDirty });
    },
    resetConfig: () => {
        set({
            config: { ...get().originalConfig },
            isDirty: false,
            error: null,
        });
    },
    testConnection: async (service) => {
        const results = { ...get().testResults };
        results[service] = { loading: true, result: null };
        set({ testResults: results });
        try {
            // Backend returns either `{ ok:true, message }` or `{ ok:false, error }`.
            // Normalize to a single `{ ok, message }` shape for the UI.
            const raw = (await api.testConnection(service));
            const message = raw.ok
                ? (raw.message ?? 'Connected')
                : (raw.error ?? raw.message ?? 'Connection failed');
            const updated = { ...get().testResults };
            updated[service] = { loading: false, result: { ok: raw.ok, message } };
            set({ testResults: updated });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const updated = { ...get().testResults };
            updated[service] = { loading: false, result: { ok: false, message } };
            set({ testResults: updated });
        }
    },
    fetchNotificationConfig: async () => {
        set({ notificationLoading: true });
        try {
            const result = await api.getNotificationConfig();
            set({
                notificationConfig: result.config ?? {},
                notificationLoading: false,
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            set({ notificationLoading: false, error: message });
        }
    },
    saveNotificationConfig: async () => {
        set({ notificationSaving: true, error: null });
        try {
            await api.saveNotificationConfig(get().notificationConfig);
            set({ notificationSaving: false });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            set({ notificationSaving: false, error: message });
        }
    },
    toggleNotification: (gate, channel) => {
        const cfg = { ...get().notificationConfig };
        if (!cfg[gate])
            cfg[gate] = {};
        cfg[gate] = { ...cfg[gate], [channel]: !cfg[gate][channel] };
        set({ notificationConfig: cfg });
    },
    updateOAuthStatus: (provider, info) => {
        const statuses = { ...get().oauthStatuses, [provider]: info };
        set({ oauthStatuses: statuses });
    },
    removeOAuthStatus: (provider) => {
        const statuses = { ...get().oauthStatuses };
        delete statuses[provider];
        set({ oauthStatuses: statuses });
    },
}));
