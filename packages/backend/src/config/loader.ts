// =====================================================================
// MI Dev Agent -- Config Loader
// =====================================================================
// Port of lib/config.js + lib/env-parser.js + lib/config-schema.js
// to TypeScript.
//
// Zero-dependency .env parsing: reads file, splits lines, handles
// quotes, comments, multiline, Windows \r\n, export prefix, duplicates.
//
// Exports a typed loadConfig() that returns an AppConfig object.
// =====================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig } from '@shared/types';

// =====================================================================
// 1. Env Parser (port of lib/env-parser.js)
// =====================================================================

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
export function parseEnvContent(
  content: string,
  options: EnvParseOptions = {},
): Record<string, string> {
  const { onWarning = () => {}, allowDuplicates = false } = options;
  const result: Record<string, string> = {};
  const seenKeys = new Map<string, number>(); // key -> line number

  // Normalize Windows line endings
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  let i = 0;
  while (i < lines.length) {
    const lineNum = i + 1;
    const line = lines[i];

    // Skip empty lines and full-line comments
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      i++;
      continue;
    }

    // Skip export prefix: `export KEY=value`
    let workLine = line;
    if (/^\s*export\s+/.test(workLine)) {
      workLine = workLine.replace(/^\s*export\s+/, '');
    }

    // Match KEY=VALUE pattern -- key must start with letter or underscore
    const keyMatch = workLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)/);
    if (!keyMatch) {
      if (trimmed.length > 0) {
        onWarning(`Line ${lineNum}: Unrecognized format, skipping: "${trimmed.substring(0, 60)}"`);
      }
      i++;
      continue;
    }

    const key = keyMatch[1];
    const rawValue = keyMatch[2];

    // -- Handle quoted values -------------------------------------------
    let value: string;
    if (rawValue.startsWith('"')) {
      // Double-quoted value -- may span multiple lines
      const parsed = parseDoubleQuoted(rawValue, lines, i, onWarning);
      value = parsed.value;
      i = parsed.nextLine;
    } else if (rawValue.startsWith("'")) {
      // Single-quoted value -- literal, no escape processing
      const parsed = parseSingleQuoted(rawValue, lines, i, onWarning);
      value = parsed.value;
      i = parsed.nextLine;
    } else {
      // Unquoted value -- handle inline comments and backslash continuation
      const parsed = parseUnquoted(rawValue, lines, i);
      value = parsed.value;
      i = parsed.nextLine;
    }

    // -- Duplicate detection --------------------------------------------
    if (seenKeys.has(key)) {
      if (!allowDuplicates) {
        onWarning(
          `Line ${lineNum}: Duplicate key "${key}" (first seen at line ${seenKeys.get(key)}). Using latest value.`,
        );
      }
    }
    seenKeys.set(key, lineNum);
    result[key] = value;
  }

  return result;
}

/** Parse a double-quoted value, handling escaped characters and multiline. */
function parseDoubleQuoted(
  rawValue: string,
  lines: string[],
  lineIndex: number,
  onWarning: (msg: string) => void,
): { value: string; nextLine: number } {
  // Remove opening quote
  let content = rawValue.substring(1);
  let result = '';
  let currentLine = lineIndex;

  while (true) {
    let j = 0;
    while (j < content.length) {
      const ch = content[j];
      if (ch === '\\') {
        // Escape sequence
        if (j + 1 < content.length) {
          const next = content[j + 1];
          switch (next) {
            case 'n':  result += '\n'; break;
            case 't':  result += '\t'; break;
            case 'r':  result += '\r'; break;
            case '\\': result += '\\'; break;
            case '"':  result += '"';  break;
            case '$':  result += '$';  break;
            default:   result += '\\' + next; break;
          }
          j += 2;
        } else {
          // Backslash at end of line within quotes -- line continuation
          result += '\n';
          j++;
        }
        continue;
      }
      if (ch === '"') {
        // Closing quote found -- any text after is treated as comment
        return { value: result, nextLine: currentLine + 1 };
      }
      result += ch;
      j++;
    }

    // No closing quote on this line -- continue to next line
    currentLine++;
    if (currentLine >= lines.length) {
      onWarning(`Unterminated double-quoted string starting at line ${lineIndex + 1}`);
      return { value: result, nextLine: currentLine };
    }
    result += '\n';
    content = lines[currentLine];
  }
}

/** Parse a single-quoted value. No escape processing. Multiline support. */
function parseSingleQuoted(
  rawValue: string,
  lines: string[],
  lineIndex: number,
  onWarning: (msg: string) => void,
): { value: string; nextLine: number } {
  let content = rawValue.substring(1);
  let result = '';
  let currentLine = lineIndex;

  while (true) {
    const closeIdx = content.indexOf("'");
    if (closeIdx !== -1) {
      result += content.substring(0, closeIdx);
      return { value: result, nextLine: currentLine + 1 };
    }
    result += content;

    currentLine++;
    if (currentLine >= lines.length) {
      onWarning(`Unterminated single-quoted string starting at line ${lineIndex + 1}`);
      return { value: result, nextLine: currentLine };
    }
    result += '\n';
    content = lines[currentLine];
  }
}

/** Parse an unquoted value: strip inline comments, handle backslash continuation. */
function parseUnquoted(
  rawValue: string,
  lines: string[],
  lineIndex: number,
): { value: string; nextLine: number } {
  let value = rawValue;
  let currentLine = lineIndex;

  // Handle backslash continuation
  while (value.endsWith('\\')) {
    value = value.slice(0, -1); // Remove trailing backslash
    currentLine++;
    if (currentLine >= lines.length) break;
    value += lines[currentLine].trim();
  }

  // Strip inline comments: look for # preceded by whitespace
  const commentMatch = value.match(/\s+#(?:\s|$)/);
  if (commentMatch && commentMatch.index !== undefined) {
    value = value.substring(0, commentMatch.index);
  }

  return { value: value.trim(), nextLine: currentLine + 1 };
}

/**
 * Load and parse a .env file from disk.
 *
 * @param envPath - Path to .env file (defaults to project root .env)
 * @param options - Loading options
 * @returns Parsed key-value pairs (not yet applied to process.env)
 */
export function loadEnvFile(
  envPath?: string,
  options: EnvLoadOptions = {},
): Record<string, string> {
  const { onWarning = () => {} } = options;

  if (!envPath) {
    // Default: walk up to project root
    envPath = path.resolve(process.cwd(), '.env');
  }

  try {
    if (!fs.existsSync(envPath)) return {};
    const content = fs.readFileSync(envPath, 'utf8');
    const parsed = parseEnvContent(content, { onWarning });
    return parsed;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    onWarning(`.env load failed: ${msg}`);
    return {};
  }
}

/**
 * Load .env file and apply to process.env.
 * Respects existing values (won't override unless override=true).
 *
 * @param envPath - Path to .env file
 * @param options - Loading options
 * @returns The parsed key-value pairs
 */
export function loadAndApplyEnv(
  envPath?: string,
  options: EnvLoadOptions = {},
): Record<string, string> {
  const { override = false, onWarning = () => {} } = options;
  const parsed = loadEnvFile(envPath, { onWarning });

  for (const [key, value] of Object.entries(parsed)) {
    if (override || !process.env[key]) {
      process.env[key] = value;
    }
  }

  return parsed;
}

// =====================================================================
// 2. Type-safe Parsing (port of lib/config-schema.js parsing functions)
// =====================================================================

/**
 * Parse boolean from env var value.
 * Accepts: true/false, 1/0, yes/no, on/off (case-insensitive).
 * Returns null for unrecognizable values.
 */
export function parseBoolean(val: string | undefined | null): boolean | null {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'boolean') return val;
  const s = String(val).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return null;
}

/**
 * Parse integer safely from env var value.
 * Fixes the parseInt("0") || default bug -- returns 0 correctly.
 */
export function parseIntSafe(val: string | undefined | null, defaultVal: number): number {
  if (val === undefined || val === null || val === '') return defaultVal;
  const s = String(val).trim();
  if (s === '') return defaultVal;
  const parsed = parseInt(s, 10);
  if (Number.isNaN(parsed)) return defaultVal;
  return parsed;
}

/** Parse float safely from env var value. */
export function parseFloatSafe(val: string | undefined | null, defaultVal: number): number {
  if (val === undefined || val === null || val === '') return defaultVal;
  const s = String(val).trim();
  if (s === '') return defaultVal;
  const parsed = parseFloat(s);
  if (Number.isNaN(parsed)) return defaultVal;
  return parsed;
}

// =====================================================================
// 3. Config Loader (port of lib/config.js)
// =====================================================================

/**
 * Read a string env var with a fallback default.
 */
function envStr(env: Record<string, string | undefined>, key: string, defaultVal: string): string {
  const v = env[key];
  if (v !== undefined && v !== null && v !== '') return v.trim();
  return defaultVal;
}

/**
 * Read a numeric env var with a fallback default.
 */
function envInt(env: Record<string, string | undefined>, key: string, defaultVal: number): number {
  return parseIntSafe(env[key], defaultVal);
}

/**
 * Read a boolean env var with a fallback default.
 */
function envBool(env: Record<string, string | undefined>, key: string, defaultVal: boolean): boolean {
  const parsed = parseBoolean(env[key]);
  return parsed !== null ? parsed : defaultVal;
}

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
export function loadConfig(envPath?: string): AppConfig {
  // Step 1: Load .env file into process.env (without overriding)
  const warnings: string[] = [];
  loadAndApplyEnv(envPath, {
    override: false,
    onWarning: (msg) => warnings.push(msg),
  });

  const env = process.env as Record<string, string | undefined>;

  // Step 2: Build typed config from env vars
  const ticket = envStr(env, 'TICKET', '').toUpperCase();

  const config: AppConfig = {
    ticket,

    jira: {
      base: envStr(env, 'JIRA_BASE_URL', 'https://mastersindia-sols.atlassian.net'),
      token: envStr(env, 'JIRA_TOKEN', ''),
      email: envStr(env, 'JIRA_EMAIL', ''),
    },

    gitlab: {
      base: envStr(env, 'GITLAB_URL', 'http://10.200.11.32'),
      token: envStr(env, 'GITLAB_TOKEN', ''),
      projectId: envInt(env, 'GITLAB_PROJECT_ID', 0),
    },

    slack: {
      token: env['SLACK_WEBHOOK'] || undefined,
      channel: undefined, // Not used in current config
      ownerSlackId: env['OWNER_SLACK_ID'] || undefined,
    },

    branches: {
      source: 'enterprise-ts',
      qa: 'enterprise-qa',
      preprod: 'enterprise-pre-pro',
      prod: 'enterprise-master',
    },

    owner: {
      jiraId: env['OWNER_JIRA_ID'] || undefined,
      gitlabId: envInt(env, 'GITLAB_ASSIGNEE_ID', 123),
      name: envStr(env, 'GIT_AUTHOR_NAME', 'Yogendra'),
      email: envStr(env, 'GIT_AUTHOR_EMAIL', 'yogendrasingh@mastersindia.co'),
    },

    timeouts: {
      maxPipelineDuration: envInt(env, 'MAX_PIPELINE_DURATION', 86_400_000),
      claudeTimeout: envInt(env, 'CLAUDE_TIMEOUT', 180_000),
      stageTimeouts: {
        analysis: envInt(env, 'ANALYSIS_TIMEOUT', 600_000),
        developer: envInt(env, 'DEVELOPER_TIMEOUT', 900_000),
        reviewer: envInt(env, 'REVIEWER_TIMEOUT', 600_000),
        testFixer: envInt(env, 'TEST_FIXER_TIMEOUT', 180_000),
        approval: envInt(env, 'MAX_APPROVAL_TIMEOUT', 28_800_000),
        ci: envInt(env, 'CI_TIMEOUT', 1_800_000),
        mergePoll: envInt(env, 'MERGE_POLL_TIMEOUT', 1_800_000),
        urlFetch: envInt(env, 'URL_FETCH_TIMEOUT', 120_000),
        buildInstall: envInt(env, 'BUILD_INSTALL_TIMEOUT', 180_000),
        buildTsc: envInt(env, 'BUILD_TSC_TIMEOUT', 120_000),
        buildEslint: envInt(env, 'BUILD_ESLINT_TIMEOUT', 60_000),
        unitTests: envInt(env, 'UNIT_TESTS_TIMEOUT', 180_000),
        e2eTests: envInt(env, 'E2E_TESTS_TIMEOUT', 300_000),
        vitePreview: envInt(env, 'VITE_PREVIEW_TIMEOUT', 30_000),
        viteBuild: envInt(env, 'VITE_BUILD_TIMEOUT', 600_000),
        verification: envInt(env, 'VERIFICATION_TIMEOUT', 300_000),
        nxServe: envInt(env, 'NX_SERVE_TIMEOUT', 120_000),
        qaHealth: envInt(env, 'QA_HEALTH_TIMEOUT', 10_000),
      },
    },

    flags: {
      runBuildCheck: envBool(env, 'RUN_BUILD_CHECK', true),
      runRuntimeTests: envBool(env, 'RUN_RUNTIME_TESTS', true),
      browserVerify: envBool(env, 'BROWSER_VERIFY', true),
      runACVerification: envBool(env, 'SKIP_SMOKE_CHECK', false) === false, // inverted: skip=true means verify=false
    },

    limits: {
      maxRejections: envInt(env, 'MAX_REJECTIONS', 3),
      maxConcurrentAgents: envInt(env, 'MAX_CONCURRENT_AGENTS', 3),
    },
  };

  return config;
}

/**
 * Additional config values that don't fit in the typed AppConfig but
 * are needed by the pipeline. Returns a flat record of all parsed values
 * following the same conventions as the original config.js exports.
 */
export interface ExtendedConfig {
  // Polling
  pollInterval: number;
  ciPoll: number;
  ciTimeout: number;

  // Jira
  jiraCommentsEnabled: boolean;
  anshitJiraId?: string;
  allowAnyApprover: boolean;

  // Slack
  anshitSlackId?: string;

  // Limits
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

  // QA
  qaSmokeLevel: string;
  qaMainUser: string;
  qaMainPass: string;
  qa1User: string;
  qa1Pass: string;
  qaUrl: string;
  qa1Url: string;

  // Build
  approvalReminder1h: number;
  approvalReminder4h: number;

  // Git
  gitCloneDepth: number;
  gitlabCloneUrl: string;

  // Testing
  testArtifactsDir: string;
  playwrightBrowser: string;

  // Browser verification
  nxServePortRangeStart: number;
  nxServePortRangeEnd: number;
  vitePreviewPortStart: number;
  vitePreviewPortEnd: number;
  evidenceMaxSize: number;

  // Logging
  logLevel: string;
  logFormat: string;
  saveDebugOutput: boolean;

  // Server
  port: number;
  bindHost: string;
  allowStageSkip: boolean;

  // Claude
  claudeModel?: string;
  anthropicApiKey?: string;

  // Vite
  viteAppApiUrl: string;
  viteAppQa: string;
  viteProductId: number;

  // Max continue wait
  maxContinueWait: number;
}

/**
 * Load the extended config values that supplement AppConfig.
 * Should be called after loadConfig() has populated process.env.
 */
export function loadExtendedConfig(): ExtendedConfig {
  const env = process.env as Record<string, string | undefined>;

  return {
    pollInterval: envInt(env, 'POLL_INTERVAL', 30_000),
    ciPoll: envInt(env, 'CI_POLL', 60_000),
    ciTimeout: envInt(env, 'CI_TIMEOUT', 1_800_000),
    jiraCommentsEnabled: envBool(env, 'JIRA_COMMENTS_ENABLED', true),
    anshitJiraId: env['ANSHIT_JIRA_ID'] || undefined,
    allowAnyApprover: envBool(env, 'ALLOW_ANY_APPROVER', false),
    anshitSlackId: env['ANSHIT_SLACK_ID'] || undefined,
    maxPlanRejections: envInt(env, 'MAX_PLAN_REJECTIONS', 5),
    maxPromptTokens: envInt(env, 'MAX_PROMPT_TOKENS', 180_000),
    fetchConcurrency: envInt(env, 'FETCH_CONCURRENCY', 5),
    maxTotalComments: envInt(env, 'MAX_TOTAL_COMMENTS', 100),
    maxTotalAttachments: envInt(env, 'MAX_TOTAL_ATTACHMENTS', 20),
    maxTotalUrlContent: envInt(env, 'MAX_TOTAL_URL_CONTENT', 500_000),
    maxStateSize: envInt(env, 'MAX_STATE_SIZE', 10_000_000),
    maxVerifyRetries: envInt(env, 'MAX_VERIFY_RETRIES', 3),
    maxUnitTestRetries: envInt(env, 'MAX_UNIT_TEST_RETRIES', 2),
    maxE2eTestRetries: envInt(env, 'MAX_E2E_TEST_RETRIES', 3),
    consoleWarningThreshold: envInt(env, 'CONSOLE_WARNING_THRESHOLD', 5),
    maxCommitFileSize: envInt(env, 'MAX_COMMIT_FILE_SIZE', 512_000),
    qaSmokeLevel: envStr(env, 'QA_SMOKE_LEVEL', 'basic'),
    qaMainUser: envStr(env, 'QA_MAIN_USER', 'prateekrai'),
    qaMainPass: envStr(env, 'QA_MAIN_PASS', 'sandboxtwo'),
    qa1User: envStr(env, 'QA1_USER', 'aman'),
    qa1Pass: envStr(env, 'QA1_PASS', 'entp'),
    qaUrl: envStr(env, 'QA_URL', 'https://qa-enterprise.mastersindia-einv.com'),
    qa1Url: envStr(env, 'QA1_URL', 'https://qa1-enterprise.mastersindia-einv.com'),
    approvalReminder1h: envInt(env, 'APPROVAL_REMINDER_1H', 3_600_000),
    approvalReminder4h: envInt(env, 'APPROVAL_REMINDER_4H', 14_400_000),
    gitCloneDepth: envInt(env, 'GIT_CLONE_DEPTH', 50),
    gitlabCloneUrl: envStr(env, 'GITLAB_CLONE_URL', 'git@10.200.11.32:mastersindia/mi_frontend_apps.git'),
    testArtifactsDir: envStr(env, 'TEST_ARTIFACTS_DIR', '.test-artifacts'),
    playwrightBrowser: envStr(env, 'PLAYWRIGHT_BROWSER', 'chromium'),
    nxServePortRangeStart: envInt(env, 'NX_SERVE_PORT_RANGE_START', 4200),
    nxServePortRangeEnd: envInt(env, 'NX_SERVE_PORT_RANGE_END', 4299),
    vitePreviewPortStart: envInt(env, 'VITE_PREVIEW_PORT_START', 4300),
    vitePreviewPortEnd: envInt(env, 'VITE_PREVIEW_PORT_END', 4399),
    evidenceMaxSize: envInt(env, 'EVIDENCE_MAX_SIZE', 10_240),
    logLevel: envStr(env, 'LOG_LEVEL', 'info'),
    logFormat: envStr(env, 'LOG_FORMAT', 'text'),
    saveDebugOutput: envBool(env, 'SAVE_DEBUG_OUTPUT', false),
    port: envInt(env, 'PORT', 3000),
    bindHost: envStr(env, 'BIND_HOST', '127.0.0.1'),
    allowStageSkip: envBool(env, 'ALLOW_STAGE_SKIP', false),
    claudeModel: env['CLAUDE_MODEL'] || undefined,
    anthropicApiKey: env['ANTHROPIC_API_KEY'] || undefined,
    viteAppApiUrl: envStr(env, 'VITE_APP_API_URL', 'https://qa-enterprise.mastersindia-einv.com/api/v2.1/'),
    viteAppQa: envStr(env, 'VITE_APP_QA', 'https://qa-enterprise.mastersindia-einv.com'),
    viteProductId: envInt(env, 'VITE_PRODUCT_ID', 2),
    maxContinueWait: envInt(env, 'MAX_CONTINUE_WAIT', 7_200_000),
  };
}
