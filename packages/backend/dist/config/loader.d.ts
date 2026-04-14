import type { AppConfig } from '@shared/types';
export interface EnvParseOptions {
    onWarning?: (msg: string) => void;
    allowDuplicates?: boolean;
}
export interface EnvLoadOptions {
    override?: boolean;
    onWarning?: (msg: string) => void;
}
/**
 * Parse .env file content into a key-value object.
 *
 * Supported formats:
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY='value with spaces'
 *   KEY="value with \"escaped\" quotes"
 *   KEY=value # inline comment
 *   KEY="value # not a comment because quoted"
 *   KEY=line1\
 *       line2\
 *       line3
 *   export KEY=value
 *   # Full-line comments
 *   (empty lines ignored)
 */
export declare function parseEnvContent(content: string, options?: EnvParseOptions): Record<string, string>;
/**
 * Load and parse a .env file from disk.
 *
 * @param envPath - Path to .env file (defaults to project root .env)
 * @param options - Loading options
 * @returns Parsed key-value pairs (not yet applied to process.env)
 */
export declare function loadEnvFile(envPath?: string, options?: EnvLoadOptions): Record<string, string>;
/**
 * Load .env file and apply to process.env.
 * Respects existing values (won't override unless override=true).
 *
 * @param envPath - Path to .env file
 * @param options - Loading options
 * @returns The parsed key-value pairs
 */
export declare function loadAndApplyEnv(envPath?: string, options?: EnvLoadOptions): Record<string, string>;
/**
 * Parse boolean from env var value.
 * Accepts: true/false, 1/0, yes/no, on/off (case-insensitive).
 * Returns null for unrecognizable values.
 */
export declare function parseBoolean(val: string | undefined | null): boolean | null;
/**
 * Parse integer safely from env var value.
 * Fixes the parseInt("0") || default bug -- returns 0 correctly.
 */
export declare function parseIntSafe(val: string | undefined | null, defaultVal: number): number;
/** Parse float safely from env var value. */
export declare function parseFloatSafe(val: string | undefined | null, defaultVal: number): number;
/**
 * Load the full application config from environment variables.
 *
 * Workflow:
 *   1. Reads .env file if exists (does not override existing process.env)
 *   2. Applies environment variables from process.env
 *   3. Returns typed AppConfig object
 *
 * @param envPath - Optional path to .env file
 * @returns Typed AppConfig
 */
export declare function loadConfig(envPath?: string): AppConfig;
/**
 * Additional config values that don't fit in the typed AppConfig but
 * are needed by the pipeline. Returns a flat record of all parsed values
 * following the same conventions as the original config.js exports.
 */
export interface ExtendedConfig {
    pollInterval: number;
    ciPoll: number;
    ciTimeout: number;
    jiraCommentsEnabled: boolean;
    anshitJiraId?: string;
    allowAnyApprover: boolean;
    anshitSlackId?: string;
    maxPlanRejections: number;
    maxPromptTokens: number;
    fetchConcurrency: number;
    maxTotalComments: number;
    maxTotalAttachments: number;
    maxTotalUrlContent: number;
    maxStateSize: number;
    maxVerifyRetries: number;
    maxUnitTestRetries: number;
    maxE2eTestRetries: number;
    consoleWarningThreshold: number;
    maxCommitFileSize: number;
    qaSmokeLevel: string;
    qaMainUser: string;
    qaMainPass: string;
    qa1User: string;
    qa1Pass: string;
    qaUrl: string;
    qa1Url: string;
    approvalReminder1h: number;
    approvalReminder4h: number;
    gitCloneDepth: number;
    gitlabCloneUrl: string;
    testArtifactsDir: string;
    playwrightBrowser: string;
    nxServePortRangeStart: number;
    nxServePortRangeEnd: number;
    vitePreviewPortStart: number;
    vitePreviewPortEnd: number;
    evidenceMaxSize: number;
    logLevel: string;
    logFormat: string;
    saveDebugOutput: boolean;
    port: number;
    bindHost: string;
    allowStageSkip: boolean;
    claudeModel?: string;
    anthropicApiKey?: string;
    viteAppApiUrl: string;
    viteAppQa: string;
    viteProductId: number;
    maxContinueWait: number;
}
/**
 * Load the extended config values that supplement AppConfig.
 * Should be called after loadConfig() has populated process.env.
 */
export declare function loadExtendedConfig(): ExtendedConfig;
