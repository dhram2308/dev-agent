/**
 * config-schema.ts -- Type-safe config schema for MI Dev Agent
 *
 * Converted from lib/config-schema.js (zero functional changes).
 *
 * Every config variable is defined here with:
 *   - env: environment variable name
 *   - type: string | int | bool | enum | url | path | port | float | giturl
 *   - default: default value (undefined = required)
 *   - required: whether the variable MUST be set
 *   - sensitive: whether the value should be redacted in logs
 *   - group: logical grouping (jira, gitlab, slack, qa, timeouts, etc.)
 *   - description: human-readable description
 *   - hotReload: whether safe to change at runtime without restart
 *   - riskLevel: SAFE | CAUTION | DANGEROUS -- for mid-pipeline change risk
 *   - validator: optional custom validator fn(value) => string|null (null = ok, string = error)
 *   - allowed: for enum types, the list of valid values
 *   - min/max: for int/port types, numeric bounds
 */

// ── Types ────────────────────────────────────────────────────────────

export type ConfigSchemaType = "string" | "int" | "float" | "bool" | "enum" | "url" | "giturl" | "port" | "path";
export type RiskLevel = "SAFE" | "CAUTION" | "DANGEROUS";

export interface ConfigSchemaEntry {
  env: string;
  type: ConfigSchemaType;
  default?: any;
  required?: boolean;
  sensitive?: boolean;
  group: string;
  description: string;
  hotReload: boolean;
  riskLevel: RiskLevel;
  validator?: (value: any) => string | null;
  allowed?: string[];
  min?: number;
  max?: number;
}

export interface ParseResult<T = any> {
  value: T;
  error: string | null;
}

export interface RequiredVarEntry extends ConfigSchemaEntry {
  key: string;
}

export interface SensitiveVarEntry {
  key: string;
  env: string;
}

export interface HotReloadableVarEntry extends ConfigSchemaEntry {
  key: string;
}

// ── Parsing Functions (fix all known bugs) ────────────────────────

/**
 * Parse boolean from env var value.
 * Accepts: true/false, 1/0, yes/no, on/off (case-insensitive).
 * Fixes bug #3: "1", "yes", "TRUE" all work correctly now.
 * Returns null for unrecognizable values (caller decides default).
 */
export function parseBoolean(val: unknown): boolean | null {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val === "boolean") return val;
  const s = String(val).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return null; // unrecognizable -- let caller decide
}

/**
 * Parse integer safely from env var value.
 * Fixes bug #2: parseInt("0") || default was treating 0 as falsy.
 * Returns the default ONLY when the value is genuinely missing/invalid.
 */
export function parseIntSafe(val: unknown, defaultVal: number): number {
  if (val === undefined || val === null || val === "") return defaultVal;
  const s = String(val).trim();
  if (s === "") return defaultVal;
  const parsed = parseInt(s, 10);
  if (Number.isNaN(parsed)) return defaultVal;
  return parsed;
}

/**
 * Parse float safely from env var value.
 */
export function parseFloatSafe(val: unknown, defaultVal: number): number {
  if (val === undefined || val === null || val === "") return defaultVal;
  const s = String(val).trim();
  if (s === "") return defaultVal;
  const parsed = parseFloat(s);
  if (Number.isNaN(parsed)) return defaultVal;
  return parsed;
}

/**
 * Parse and validate enum value.
 * Fixes bug #4: LOG_LEVEL=verbose was silently accepted.
 * Returns { value, error } so caller can report the violation.
 */
export function parseEnum(val: unknown, allowed: string[], defaultVal: string | undefined): ParseResult<string | undefined> {
  if (val === undefined || val === null || val === "") {
    return { value: defaultVal, error: null };
  }
  const s = String(val).trim().toLowerCase();
  const normalizedAllowed = allowed.map((a) => String(a).toLowerCase());
  const idx = normalizedAllowed.indexOf(s);
  if (idx === -1) {
    return {
      value: defaultVal,
      error: `Invalid value "${val}". Allowed: ${allowed.join(", ")}`,
    };
  }
  // Return the original-cased allowed value
  return { value: allowed[idx], error: null };
}

/**
 * Parse and validate URL.
 * Checks protocol, basic structure. Does not make HTTP requests.
 */
export function parseUrl(val: unknown): ParseResult<string | null> {
  if (!val || typeof val !== "string") return { value: null, error: "URL is empty" };
  const s = val.trim();
  // Allow http:// and https://
  if (!s.startsWith("http://") && !s.startsWith("https://")) {
    return { value: s, error: `URL must start with http:// or https://, got: "${s}"` };
  }
  try {
    new URL(s);
    return { value: s, error: null };
  } catch {
    return { value: s, error: `Malformed URL: "${s}"` };
  }
}

/**
 * Parse and validate a git clone URL.
 * Accepts git@host:path or https://host/path formats.
 */
export function parseGitUrl(val: unknown): ParseResult<string | null> {
  if (!val || typeof val !== "string") return { value: null, error: "Git URL is empty" };
  const s = val.trim();
  if (s.startsWith("git@") || s.startsWith("https://") || s.startsWith("http://")) {
    return { value: s, error: null };
  }
  return { value: s, error: `Git URL must start with git@, https://, or http://, got: "${s}"` };
}

/**
 * Parse and validate port number.
 * Fixes bug #10: validates range, ensures START <= END for ranges.
 */
export function parsePort(val: unknown, defaultVal: number): ParseResult<number> {
  const parsed = parseIntSafe(val, defaultVal);
  if (parsed < 0 || parsed > 65535) {
    return { value: defaultVal, error: `Port ${parsed} out of range (0-65535)` };
  }
  return { value: parsed, error: null };
}

/**
 * Parse a value according to its schema type.
 * Returns { value, error } for all types.
 */
export function parseByType(rawVal: unknown, schema: ConfigSchemaEntry): ParseResult {
  const { type, default: defaultVal, allowed, min, max, validator } = schema;
  let value: any;
  let error: string | null = null;

  switch (type) {
    case "string": {
      value = (rawVal !== undefined && rawVal !== null && rawVal !== "")
        ? String(rawVal).trim()
        : defaultVal;
      break;
    }

    case "int": {
      value = parseIntSafe(rawVal, defaultVal);
      if (min !== undefined && value < min) {
        error = `Value ${value} below minimum ${min}`;
        value = min;
      }
      if (max !== undefined && value > max) {
        error = `Value ${value} above maximum ${max}`;
        value = max;
      }
      break;
    }

    case "float": {
      value = parseFloatSafe(rawVal, defaultVal);
      if (min !== undefined && value < min) {
        error = `Value ${value} below minimum ${min}`;
        value = min;
      }
      if (max !== undefined && value > max) {
        error = `Value ${value} above maximum ${max}`;
        value = max;
      }
      break;
    }

    case "bool": {
      const parsed = parseBoolean(rawVal);
      if (parsed === null) {
        if (rawVal !== undefined && rawVal !== null && rawVal !== "") {
          error = `Invalid boolean: "${rawVal}". Use true/false/1/0/yes/no`;
        }
        value = (defaultVal !== undefined) ? defaultVal : false;
      } else {
        value = parsed;
      }
      break;
    }

    case "enum": {
      const result = parseEnum(rawVal, allowed || [], defaultVal);
      value = result.value;
      error = result.error;
      break;
    }

    case "url": {
      if (rawVal !== undefined && rawVal !== null && rawVal !== "") {
        const result = parseUrl(rawVal);
        value = result.value;
        error = result.error;
      } else {
        value = defaultVal || null;
      }
      break;
    }

    case "giturl": {
      if (rawVal !== undefined && rawVal !== null && rawVal !== "") {
        const result = parseGitUrl(rawVal);
        value = result.value;
        error = result.error;
      } else {
        value = defaultVal || null;
      }
      break;
    }

    case "port": {
      const result = parsePort(rawVal, defaultVal);
      value = result.value;
      error = result.error;
      break;
    }

    case "path": {
      value = (rawVal !== undefined && rawVal !== null && rawVal !== "")
        ? String(rawVal).trim()
        : defaultVal;
      break;
    }

    default: {
      value = rawVal !== undefined ? rawVal : defaultVal;
    }
  }

  // Run custom validator if provided
  if (!error && validator && value !== undefined && value !== null) {
    const customError = validator(value);
    if (customError) error = customError;
  }

  return { value, error };
}


// ── Full Config Schema ────────────────────────────────────────────
// Every config variable the agent uses, organized by group.

export const CONFIG_SCHEMA: Record<string, ConfigSchemaEntry> = {

  // ── Identity ───────────────────────────────────────────────────
  TICKET: {
    env: "TICKET",
    type: "string",
    required: true,
    sensitive: false,
    group: "identity",
    description: "Jira ticket key (e.g., AUT-8031)",
    hotReload: false,
    riskLevel: "DANGEROUS",
    validator: (v: string) => /^[A-Z]+-\d+$/.test(v) ? null : `Invalid ticket format: "${v}" -- expected "PROJ-123"`,
  },

  // ── Jira ───────────────────────────────────────────────────────
  JIRA_EMAIL: {
    env: "JIRA_EMAIL",
    type: "string",
    required: true,
    sensitive: false,
    group: "jira",
    description: "Jira account email for API auth",
    hotReload: false,
    riskLevel: "DANGEROUS",
    validator: (v: string) => v.includes("@") ? null : `Expected email address, got: "${v}"`,
  },
  JIRA_TOKEN: {
    env: "JIRA_TOKEN", type: "string", required: true, sensitive: true,
    group: "jira", description: "Jira API token (Atlassian personal access token)",
    hotReload: true, riskLevel: "CAUTION",
  },
  JIRA_BASE_URL: {
    env: "JIRA_BASE_URL", type: "url", default: "https://mastersindia-sols.atlassian.net",
    required: false, sensitive: false, group: "jira", description: "Jira instance base URL",
    hotReload: false, riskLevel: "DANGEROUS",
  },
  JIRA_COMMENTS_ENABLED: {
    env: "JIRA_COMMENTS_ENABLED", type: "bool", default: false,
    required: false, sensitive: false, group: "jira",
    description: "Whether to post comments to Jira tickets", hotReload: true, riskLevel: "SAFE",
  },
  OWNER_JIRA_ID: {
    env: "OWNER_JIRA_ID", type: "string", required: false, sensitive: false,
    group: "jira", description: "Jira account ID or email for owner (approver 1)",
    hotReload: false, riskLevel: "CAUTION",
  },
  QA_JIRA_ID: {
    env: "QA_JIRA_ID", type: "string", required: false, sensitive: false,
    group: "jira", description: "Jira account ID or email for QA (approver 2)",
    hotReload: false, riskLevel: "CAUTION",
  },
  ALLOW_ANY_APPROVER: {
    env: "ALLOW_ANY_APPROVER", type: "bool", default: false,
    required: false, sensitive: false, group: "jira",
    description: "Allow any Jira user to approve (when both approver IDs are empty)",
    hotReload: false, riskLevel: "DANGEROUS",
  },

  // ── GitLab ─────────────────────────────────────────────────────
  GITLAB_URL: {
    env: "GITLAB_URL", type: "url", default: "http://10.200.11.32",
    required: false, sensitive: false, group: "gitlab", description: "GitLab instance base URL",
    hotReload: false, riskLevel: "DANGEROUS",
  },
  GITLAB_TOKEN: {
    env: "GITLAB_TOKEN", type: "string", required: true, sensitive: true,
    group: "gitlab", description: "GitLab personal access token",
    hotReload: true, riskLevel: "CAUTION",
  },
  GITLAB_PROJECT_ID: {
    env: "GITLAB_PROJECT_ID", type: "int", required: true, sensitive: false,
    group: "gitlab", description: "GitLab project ID (numeric)",
    hotReload: false, riskLevel: "DANGEROUS", min: 1,
  },
  GITLAB_CLONE_URL: {
    env: "GITLAB_CLONE_URL", type: "giturl",
    default: "git@10.200.11.32:mastersindia/mi_frontend_apps.git",
    required: false, sensitive: false, group: "gitlab",
    description: "Git clone URL for local repo cache", hotReload: false, riskLevel: "DANGEROUS",
  },
  GITLAB_ASSIGNEE_ID: {
    env: "GITLAB_ASSIGNEE_ID", type: "int", default: 123,
    required: false, sensitive: false, group: "gitlab",
    description: "GitLab user ID for MR assignee", hotReload: true, riskLevel: "SAFE", min: 1,
  },
  GITLAB_AUTH_MODE: {
    env: "GITLAB_AUTH_MODE", type: "enum", default: "pat",
    allowed: ["oauth", "pat"], required: false, sensitive: false,
    group: "gitlab", description: "GitLab authentication mode (pat = Personal Access Token, oauth = OAuth2)",
    hotReload: false, riskLevel: "DANGEROUS",
  },

  // ── Slack ──────────────────────────────────────────────────────
  SLACK_WEBHOOK: {
    env: "SLACK_WEBHOOK", type: "url", required: false, sensitive: true,
    group: "slack", description: "Slack incoming webhook URL for notifications",
    hotReload: true, riskLevel: "SAFE",
  },
  OWNER_SLACK_ID: {
    env: "OWNER_SLACK_ID", type: "string", required: false, sensitive: false,
    group: "slack", description: "Slack user ID for owner mentions",
    hotReload: true, riskLevel: "SAFE",
  },
  QA_SLACK_ID: {
    env: "QA_SLACK_ID", type: "string", required: false, sensitive: false,
    group: "slack", description: "Slack user ID for QA mentions",
    hotReload: true, riskLevel: "SAFE",
  },

  // ── Git Author ─────────────────────────────────────────────────
  GIT_AUTHOR_NAME: {
    env: "GIT_AUTHOR_NAME", type: "string", default: "Yogendra",
    required: false, sensitive: false, group: "git", description: "Git commit author name",
    hotReload: true, riskLevel: "SAFE",
  },
  GIT_AUTHOR_EMAIL: {
    env: "GIT_AUTHOR_EMAIL", type: "string", default: "yogendrasingh@mastersindia.co",
    required: false, sensitive: false, group: "git", description: "Git commit author email",
    hotReload: true, riskLevel: "SAFE",
  },
  GIT_CLONE_DEPTH: {
    env: "GIT_CLONE_DEPTH", type: "int", default: 50,
    required: false, sensitive: false, group: "git",
    description: "Git clone depth for local repo cache",
    hotReload: false, riskLevel: "SAFE", min: 1, max: 10000,
  },
  MAX_COMMIT_FILE_SIZE: {
    env: "MAX_COMMIT_FILE_SIZE", type: "int", default: 512_000,
    required: false, sensitive: false, group: "git",
    description: "Maximum file size for a single commit action (bytes)",
    hotReload: true, riskLevel: "SAFE", min: 1024, max: 10_000_000,
  },

  // ── Google Drive Connector ───────────────────────────────────
  GDRIVE_ENABLED: {
    env: "GDRIVE_ENABLED", type: "bool", default: false,
    required: false, sensitive: false, group: "gdrive",
    description: "Enable Google Drive connector for fetching linked docs/sheets",
    hotReload: true, riskLevel: "SAFE",
  },
  GDRIVE_SERVICE_ACCOUNT_JSON: {
    env: "GDRIVE_SERVICE_ACCOUNT_JSON", type: "string",
    required: false, sensitive: true, group: "gdrive",
    description: "GCP Service Account JSON key (paste full JSON or base64-encoded)",
    hotReload: true, riskLevel: "CAUTION",
  },

  // ── Figma Connector ─────────────────────────────────────────
  FIGMA_ENABLED: {
    env: "FIGMA_ENABLED", type: "bool", default: false,
    required: false, sensitive: false, group: "figma",
    description: "Enable Figma connector for fetching linked design files",
    hotReload: true, riskLevel: "SAFE",
  },
  FIGMA_TOKEN: {
    env: "FIGMA_TOKEN", type: "string", required: false, sensitive: true,
    group: "figma", description: "Figma Personal Access Token (PAT) -- expires every 90 days",
    hotReload: true, riskLevel: "CAUTION",
  },
  FIGMA_VISION_ENABLED: {
    env: "FIGMA_VISION_ENABLED", type: "bool", default: false,
    required: false, sensitive: false, group: "figma",
    description: "Use Anthropic Vision to describe Figma frame screenshots (requires ANTHROPIC_API_KEY)",
    hotReload: true, riskLevel: "SAFE",
  },

  // ── Postman Connector ───────────────────────────────────────
  POSTMAN_ENABLED: {
    env: "POSTMAN_ENABLED", type: "bool", default: false,
    required: false, sensitive: false, group: "postman",
    description: "Enable Postman connector for fetching linked API collections",
    hotReload: true, riskLevel: "SAFE",
  },
  POSTMAN_API_KEY: {
    env: "POSTMAN_API_KEY", type: "string", required: false, sensitive: true,
    group: "postman", description: "Postman API key for fetching collections",
    hotReload: true, riskLevel: "CAUTION",
  },

  // ── QA Environments ────────────────────────────────────────────
  QA_URL: {
    env: "QA_URL", type: "url", default: "https://qa-enterprise.mastersindia-einv.com",
    required: false, sensitive: false, group: "qa", description: "QA Main environment URL",
    hotReload: false, riskLevel: "DANGEROUS",
  },
  QA1_URL: {
    env: "QA1_URL", type: "url", default: "https://qa1-enterprise.mastersindia-einv.com",
    required: false, sensitive: false, group: "qa", description: "QA1 environment URL",
    hotReload: false, riskLevel: "DANGEROUS",
  },
  QA_MAIN_USER: {
    env: "QA_MAIN_USER", type: "string", default: "prateekrai",
    required: false, sensitive: true, group: "qa", description: "QA Main login username",
    hotReload: true, riskLevel: "SAFE",
  },
  QA_MAIN_PASS: {
    env: "QA_MAIN_PASS", type: "string", default: "sandboxtwo",
    required: false, sensitive: true, group: "qa", description: "QA Main login password",
    hotReload: true, riskLevel: "SAFE",
  },
  QA1_USER: {
    env: "QA1_USER", type: "string", default: "aman",
    required: false, sensitive: true, group: "qa", description: "QA1 login username",
    hotReload: true, riskLevel: "SAFE",
  },
  QA1_PASS: {
    env: "QA1_PASS", type: "string", default: "entp",
    required: false, sensitive: true, group: "qa", description: "QA1 login password",
    hotReload: true, riskLevel: "SAFE",
  },
  QA_SMOKE_LEVEL: {
    env: "QA_SMOKE_LEVEL", type: "enum", default: "basic",
    allowed: ["basic", "full", "none"], required: false, sensitive: false,
    group: "qa", description: "QA smoke test level", hotReload: true, riskLevel: "SAFE",
  },
  SKIP_SMOKE_CHECK: {
    env: "SKIP_SMOKE_CHECK", type: "bool", default: false,
    required: false, sensitive: false, group: "qa", description: "Skip QA smoke check after deploy",
    hotReload: true, riskLevel: "CAUTION",
  },
  QA_HEALTH_TIMEOUT: {
    env: "QA_HEALTH_TIMEOUT", type: "int", default: 10_000,
    required: false, sensitive: false, group: "qa",
    description: "Timeout for QA health check (ms)", hotReload: true, riskLevel: "SAFE",
    min: 1000, max: 120_000,
  },
  VERIFY_LOGIN_EMAIL: {
    env: "VERIFY_LOGIN_EMAIL", type: "string", required: false, sensitive: true,
    group: "qa", description: "Browser verification login email (defaults to QA_MAIN_USER)",
    hotReload: true, riskLevel: "SAFE",
  },
  VERIFY_LOGIN_PASS: {
    env: "VERIFY_LOGIN_PASS", type: "string", required: false, sensitive: true,
    group: "qa", description: "Browser verification login password (defaults to QA_MAIN_PASS)",
    hotReload: true, riskLevel: "SAFE",
  },

  // ── Timeouts -- Agent CLI ───────────────────────────────────────
  CLAUDE_TIMEOUT: {
    env: "CLAUDE_TIMEOUT", type: "int", default: 180_000,
    required: false, sensitive: false, group: "timeouts",
    description: "Default Claude CLI call timeout (ms)", hotReload: true, riskLevel: "SAFE",
    min: 10_000, max: 1_800_000,
  },
  ANALYSIS_TIMEOUT: {
    env: "ANALYSIS_TIMEOUT", type: "int", default: 600_000,
    required: false, sensitive: false, group: "timeouts",
    description: "Analysis agent timeout (ms)", hotReload: true, riskLevel: "SAFE",
    min: 60_000, max: 3_600_000,
  },
  DEVELOPER_TIMEOUT: {
    env: "DEVELOPER_TIMEOUT", type: "int", default: 900_000,
    required: false, sensitive: false, group: "timeouts",
    description: "Developer agent timeout (ms)", hotReload: true, riskLevel: "SAFE",
    min: 60_000, max: 3_600_000,
  },
  REVIEWER_TIMEOUT: {
    env: "REVIEWER_TIMEOUT", type: "int", default: 600_000,
    required: false, sensitive: false, group: "timeouts",
    description: "Reviewer agent timeout (ms)", hotReload: true, riskLevel: "SAFE",
    min: 60_000, max: 3_600_000,
  },
  TEST_FIXER_TIMEOUT: {
    env: "TEST_FIXER_TIMEOUT", type: "int", default: 180_000,
    required: false, sensitive: false, group: "timeouts",
    description: "Test fixer agent timeout (ms)", hotReload: true, riskLevel: "SAFE",
    min: 30_000, max: 1_800_000,
  },

  // ── Timeouts -- Pipeline ────────────────────────────────────────
  MAX_APPROVAL_TIMEOUT: {
    env: "MAX_APPROVAL_TIMEOUT", type: "int", default: 28_800_000,
    required: false, sensitive: false, group: "timeouts",
    description: "Max wait for human approval (ms, default 8h)",
    hotReload: true, riskLevel: "SAFE", min: 60_000,
  },
  MAX_PIPELINE_DURATION: {
    env: "MAX_PIPELINE_DURATION", type: "int", default: 86_400_000,
    required: false, sensitive: false, group: "timeouts",
    description: "Max total pipeline duration before abort (ms, default 24h)",
    hotReload: true, riskLevel: "CAUTION", min: 3_600_000,
  },
  MAX_CONTINUE_WAIT: {
    env: "MAX_CONTINUE_WAIT", type: "int", default: 7_200_000,
    required: false, sensitive: false, group: "timeouts",
    description: "Max wait for continue signal at gates (ms, default 2h)",
    hotReload: true, riskLevel: "SAFE", min: 60_000,
  },
  MERGE_POLL_TIMEOUT: {
    env: "MERGE_POLL_TIMEOUT", type: "int", default: 1_800_000,
    required: false, sensitive: false, group: "timeouts",
    description: "Max wait for MR merge + pipeline (ms, default 30m)",
    hotReload: true, riskLevel: "SAFE", min: 60_000,
  },
  URL_FETCH_TIMEOUT: {
    env: "URL_FETCH_TIMEOUT", type: "int", default: 120_000,
    required: false, sensitive: false, group: "timeouts",
    description: "Timeout for fetching external URLs from tickets (ms)",
    hotReload: true, riskLevel: "SAFE", min: 5000, max: 600_000,
  },
  APPROVAL_REMINDER_1H: {
    env: "APPROVAL_REMINDER_1H", type: "int", default: 3_600_000,
    required: false, sensitive: false, group: "timeouts",
    description: "First approval reminder threshold (ms, default 1h)",
    hotReload: true, riskLevel: "SAFE", min: 60_000,
  },
  APPROVAL_REMINDER_4H: {
    env: "APPROVAL_REMINDER_4H", type: "int", default: 14_400_000,
    required: false, sensitive: false, group: "timeouts",
    description: "Second approval reminder threshold (ms, default 4h)",
    hotReload: true, riskLevel: "SAFE", min: 60_000,
  },

  // ── Limits ─────────────────────────────────────────────────────
  MAX_REJECTIONS: {
    env: "MAX_REJECTIONS", type: "int", default: 3,
    required: false, sensitive: false, group: "limits",
    description: "Max code review rejection cycles before halting",
    hotReload: true, riskLevel: "SAFE", min: 1, max: 20,
  },
  MAX_PLAN_REJECTIONS: {
    env: "MAX_PLAN_REJECTIONS", type: "int", default: 5,
    required: false, sensitive: false, group: "limits",
    description: "Max plan rejection iterations before halting",
    hotReload: true, riskLevel: "SAFE", min: 1, max: 20,
  },
  MAX_PROMPT_TOKENS: {
    env: "MAX_PROMPT_TOKENS", type: "int", default: 180_000,
    required: false, sensitive: false, group: "limits",
    description: "Max estimated tokens per Claude prompt",
    hotReload: true, riskLevel: "SAFE", min: 10_000, max: 500_000,
  },
  FETCH_CONCURRENCY: {
    env: "FETCH_CONCURRENCY", type: "int", default: 5,
    required: false, sensitive: false, group: "limits",
    description: "Max parallel HTTP fetches for ticket context",
    hotReload: true, riskLevel: "SAFE", min: 1, max: 20,
  },
  MAX_FREE_SOCKETS: {
    env: "MAX_FREE_SOCKETS", type: "int", default: 10,
    required: false, sensitive: false, group: "limits",
    description: "Max keep-alive free sockets per HTTP agent",
    hotReload: false, riskLevel: "SAFE", min: 1, max: 100,
  },
  MAX_CONCURRENT_AGENTS: {
    env: "MAX_CONCURRENT_AGENTS", type: "int", default: 3,
    required: false, sensitive: false, group: "limits",
    description: "Max number of agent processes running simultaneously",
    hotReload: false, riskLevel: "CAUTION", min: 1, max: 10,
  },

  // ── Build Verification ─────────────────────────────────────────
  RUN_BUILD_CHECK: {
    env: "RUN_BUILD_CHECK", type: "bool", default: true,
    required: false, sensitive: false, group: "build",
    description: "Run TSC + ESLint build checks on generated code",
    hotReload: true, riskLevel: "CAUTION",
  },
  BUILD_INSTALL_TIMEOUT: {
    env: "BUILD_INSTALL_TIMEOUT", type: "int", default: 180_000,
    required: false, sensitive: false, group: "build",
    description: "npm install timeout for build check (ms)",
    hotReload: true, riskLevel: "SAFE", min: 30_000, max: 600_000,
  },
  BUILD_TSC_TIMEOUT: {
    env: "BUILD_TSC_TIMEOUT", type: "int", default: 120_000,
    required: false, sensitive: false, group: "build",
    description: "TypeScript compiler timeout (ms)",
    hotReload: true, riskLevel: "SAFE", min: 10_000, max: 600_000,
  },
  BUILD_ESLINT_TIMEOUT: {
    env: "BUILD_ESLINT_TIMEOUT", type: "int", default: 60_000,
    required: false, sensitive: false, group: "build",
    description: "ESLint check timeout (ms)",
    hotReload: true, riskLevel: "SAFE", min: 10_000, max: 300_000,
  },

  // ── Runtime Testing ────────────────────────────────────────────
  RUN_RUNTIME_TESTS: {
    env: "RUN_RUNTIME_TESTS", type: "bool", default: true,
    required: false, sensitive: false, group: "testing",
    description: "Run unit + E2E tests on generated code",
    hotReload: true, riskLevel: "CAUTION",
  },
  UNIT_TESTS_TIMEOUT: {
    env: "UNIT_TESTS_TIMEOUT", type: "int", default: 180_000,
    required: false, sensitive: false, group: "testing",
    description: "Unit test suite timeout (ms)", hotReload: true, riskLevel: "SAFE",
    min: 10_000, max: 600_000,
  },
  E2E_TESTS_TIMEOUT: {
    env: "E2E_TESTS_TIMEOUT", type: "int", default: 300_000,
    required: false, sensitive: false, group: "testing",
    description: "E2E test suite timeout (ms)", hotReload: true, riskLevel: "SAFE",
    min: 30_000, max: 1_200_000,
  },
  VITE_PREVIEW_TIMEOUT: {
    env: "VITE_PREVIEW_TIMEOUT", type: "int", default: 30_000,
    required: false, sensitive: false, group: "testing",
    description: "Vite preview server startup timeout (ms)", hotReload: true, riskLevel: "SAFE",
    min: 5000, max: 120_000,
  },
  VITE_BUILD_TIMEOUT: {
    env: "VITE_BUILD_TIMEOUT", type: "int", default: 600_000,
    required: false, sensitive: false, group: "testing",
    description: "Vite build timeout (ms)", hotReload: true, riskLevel: "SAFE",
    min: 30_000, max: 1_800_000,
  },
  MAX_UNIT_TEST_RETRIES: {
    env: "MAX_UNIT_TEST_RETRIES", type: "int", default: 2,
    required: false, sensitive: false, group: "testing",
    description: "Max retries for failing unit tests", hotReload: true, riskLevel: "SAFE",
    min: 0, max: 10,
  },
  MAX_E2E_TEST_RETRIES: {
    env: "MAX_E2E_TEST_RETRIES", type: "int", default: 3,
    required: false, sensitive: false, group: "testing",
    description: "Max retries for failing E2E tests", hotReload: true, riskLevel: "SAFE",
    min: 0, max: 10,
  },
  CONSOLE_WARNING_THRESHOLD: {
    env: "CONSOLE_WARNING_THRESHOLD", type: "int", default: 5,
    required: false, sensitive: false, group: "testing",
    description: "Max browser console warnings before flagging", hotReload: true, riskLevel: "SAFE",
    min: 0, max: 100,
  },
  TEST_ARTIFACTS_DIR: {
    env: "TEST_ARTIFACTS_DIR", type: "path", default: ".test-artifacts",
    required: false, sensitive: false, group: "testing",
    description: "Directory for test screenshots/artifacts", hotReload: true, riskLevel: "SAFE",
  },
  PLAYWRIGHT_BROWSER: {
    env: "PLAYWRIGHT_BROWSER", type: "enum", default: "chromium",
    allowed: ["chromium", "firefox", "webkit"], required: false, sensitive: false,
    group: "testing", description: "Playwright browser engine for E2E tests",
    hotReload: false, riskLevel: "SAFE",
  },

  // ── Browser Verification ───────────────────────────────────────
  BROWSER_VERIFY: {
    env: "BROWSER_VERIFY", type: "bool", default: true,
    required: false, sensitive: false, group: "browser",
    description: "Enable browser-based verification of generated code",
    hotReload: true, riskLevel: "CAUTION",
  },
  MAX_VERIFY_RETRIES: {
    env: "MAX_VERIFY_RETRIES", type: "int", default: 3,
    required: false, sensitive: false, group: "browser",
    description: "Max browser verification retry attempts", hotReload: true, riskLevel: "SAFE",
    min: 0, max: 10,
  },
  NX_SERVE_TIMEOUT: {
    env: "NX_SERVE_TIMEOUT", type: "int", default: 120_000,
    required: false, sensitive: false, group: "browser",
    description: "NX dev server startup timeout (ms)", hotReload: true, riskLevel: "SAFE",
    min: 10_000, max: 600_000,
  },
  NX_SERVE_PORT_RANGE_START: {
    env: "NX_SERVE_PORT_RANGE_START", type: "port", default: 4200,
    required: false, sensitive: false, group: "browser",
    description: "Start of NX dev server port range", hotReload: false, riskLevel: "SAFE",
  },
  NX_SERVE_PORT_RANGE_END: {
    env: "NX_SERVE_PORT_RANGE_END", type: "port", default: 4299,
    required: false, sensitive: false, group: "browser",
    description: "End of NX dev server port range", hotReload: false, riskLevel: "SAFE",
  },
  VITE_PREVIEW_PORT_START: {
    env: "VITE_PREVIEW_PORT_START", type: "port", default: 4300,
    required: false, sensitive: false, group: "runtime_tests",
    description: "Start of Vite preview port range for browser smoke tests",
    hotReload: false, riskLevel: "SAFE",
  },
  VITE_PREVIEW_PORT_END: {
    env: "VITE_PREVIEW_PORT_END", type: "port", default: 4399,
    required: false, sensitive: false, group: "runtime_tests",
    description: "End of Vite preview port range for browser smoke tests",
    hotReload: false, riskLevel: "SAFE",
  },
  VERIFICATION_TIMEOUT: {
    env: "VERIFICATION_TIMEOUT", type: "int", default: 300_000,
    required: false, sensitive: false, group: "browser",
    description: "Total browser verification timeout (ms)", hotReload: true, riskLevel: "SAFE",
    min: 30_000, max: 1_200_000,
  },
  EVIDENCE_MAX_SIZE: {
    env: "EVIDENCE_MAX_SIZE", type: "int", default: 10_240,
    required: false, sensitive: false, group: "browser",
    description: "Max size for verification evidence (bytes)", hotReload: true, riskLevel: "SAFE",
    min: 1024, max: 1_000_000,
  },

  // ── Logging ────────────────────────────────────────────────────
  LOG_LEVEL: {
    env: "LOG_LEVEL", type: "enum", default: "info",
    allowed: ["trace", "debug", "info", "warn", "error"],
    required: false, sensitive: false, group: "logging",
    description: "Logging verbosity level", hotReload: true, riskLevel: "SAFE",
  },
  LOG_FORMAT: {
    env: "LOG_FORMAT", type: "enum", default: "text",
    allowed: ["text", "json"], required: false, sensitive: false,
    group: "logging", description: "Log output format (text for console, json for structured)",
    hotReload: true, riskLevel: "SAFE",
  },
  SAVE_DEBUG_OUTPUT: {
    env: "SAVE_DEBUG_OUTPUT", type: "bool", default: false,
    required: false, sensitive: false, group: "logging",
    description: "Save Claude prompt/output to .debug/ directory",
    hotReload: true, riskLevel: "SAFE",
  },

  // ── Server / UI ────────────────────────────────────────────────
  PORT: {
    env: "PORT", type: "port", default: 3000,
    required: false, sensitive: false, group: "server",
    description: "Web UI HTTP port", hotReload: false, riskLevel: "SAFE",
  },
  BIND_HOST: {
    env: "BIND_HOST", type: "string", default: "127.0.0.1",
    required: false, sensitive: false, group: "server",
    description: "Web UI bind address (127.0.0.1 or 0.0.0.0)",
    hotReload: false, riskLevel: "CAUTION",
    validator: (v: string) => {
      if (v === "127.0.0.1" || v === "0.0.0.0" || v === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(v)) return null;
      return `Invalid bind host: "${v}"`;
    },
  },
  ALLOW_STAGE_SKIP: {
    env: "ALLOW_STAGE_SKIP", type: "bool", default: false,
    required: false, sensitive: false, group: "server",
    description: "Allow skipping pipeline stages via UI (dangerous)",
    hotReload: false, riskLevel: "DANGEROUS",
  },

  // ── Claude CLI ─────────────────────────────────────────────────
  CLAUDE_MODEL: {
    env: "CLAUDE_MODEL", type: "string", required: false, sensitive: false,
    group: "claude", description: 'Override Claude model (e.g., claude-sonnet-4-5-20250514)',
    hotReload: true, riskLevel: "CAUTION",
  },
  ANTHROPIC_API_KEY: {
    env: "ANTHROPIC_API_KEY", type: "string", required: false, sensitive: true,
    group: "claude", description: "Anthropic API key for vision/direct API calls",
    hotReload: true, riskLevel: "CAUTION",
  },

  // ── Vite Env (for generated project) ───────────────────────────
  VITE_APP_API_URL: {
    env: "VITE_APP_API_URL", type: "url",
    default: "https://qa-enterprise.mastersindia-einv.com/api/v2.1/",
    required: false, sensitive: false, group: "vite",
    description: "Vite app API URL injected into .env for generated project",
    hotReload: true, riskLevel: "SAFE",
  },
  VITE_APP_QA: {
    env: "VITE_APP_QA", type: "url",
    default: "https://qa-enterprise.mastersindia-einv.com",
    required: false, sensitive: false, group: "vite",
    description: "Vite app QA base URL", hotReload: true, riskLevel: "SAFE",
  },
  VITE_PRODUCT_ID: {
    env: "VITE_PRODUCT_ID", type: "int", default: 2,
    required: false, sensitive: false, group: "vite",
    description: "Enterprise product ID for generated project",
    hotReload: true, riskLevel: "CAUTION", min: 1,
  },

  // ── Constants (hardcoded but documented in schema) ─────────────
  POLL_INTERVAL: {
    env: "POLL_INTERVAL", type: "int", default: 30_000,
    required: false, sensitive: false, group: "polling",
    description: "Jira approval polling interval (ms)", hotReload: true, riskLevel: "SAFE",
    min: 5000, max: 300_000,
  },
  CI_POLL: {
    env: "CI_POLL", type: "int", default: 60_000,
    required: false, sensitive: false, group: "polling",
    description: "CI pipeline polling interval (ms)", hotReload: true, riskLevel: "SAFE",
    min: 10_000, max: 300_000,
  },
  CI_TIMEOUT: {
    env: "CI_TIMEOUT", type: "int", default: 1_800_000,
    required: false, sensitive: false, group: "polling",
    description: "CI pipeline max wait time (ms, default 30m)", hotReload: true, riskLevel: "SAFE",
    min: 60_000, max: 7_200_000,
  },

  // ── Internal Limits (constants, but now configurable) ──────────
  MAX_TOTAL_COMMENTS: {
    env: "MAX_TOTAL_COMMENTS", type: "int", default: 100,
    required: false, sensitive: false, group: "limits",
    description: "Max Jira comments to fetch per ticket", hotReload: true, riskLevel: "SAFE",
    min: 10, max: 500,
  },
  MAX_TOTAL_ATTACHMENTS: {
    env: "MAX_TOTAL_ATTACHMENTS", type: "int", default: 20,
    required: false, sensitive: false, group: "limits",
    description: "Max attachments to process per ticket", hotReload: true, riskLevel: "SAFE",
    min: 1, max: 100,
  },
  MAX_TOTAL_URL_CONTENT: {
    env: "MAX_TOTAL_URL_CONTENT", type: "int", default: 500_000,
    required: false, sensitive: false, group: "limits",
    description: "Max total bytes of URL content to fetch", hotReload: true, riskLevel: "SAFE",
    min: 10_000, max: 5_000_000,
  },
  MAX_STATE_SIZE: {
    env: "MAX_STATE_SIZE", type: "int", default: 10_000_000,
    required: false, sensitive: false, group: "limits",
    description: "Max state file size before warning (bytes)", hotReload: true, riskLevel: "SAFE",
    min: 1_000_000, max: 100_000_000,
  },
};


// ── Schema query helpers ──────────────────────────────────────────

/** Get all schema entries for a given group */
export function getSchemaByGroup(group: string): Record<string, ConfigSchemaEntry> {
  const result: Record<string, ConfigSchemaEntry> = {};
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    if (schema.group === group) result[key] = schema;
  }
  return result;
}

/** Get all group names */
export function getGroups(): string[] {
  const groups = new Set<string>();
  for (const schema of Object.values(CONFIG_SCHEMA)) {
    groups.add(schema.group);
  }
  return [...groups];
}

/** Get all required config vars */
export function getRequiredVars(): RequiredVarEntry[] {
  return Object.entries(CONFIG_SCHEMA)
    .filter(([, s]) => s.required)
    .map(([key, s]) => ({ key, ...s }));
}

/** Get all sensitive config vars (for redaction) */
export function getSensitiveVars(): SensitiveVarEntry[] {
  return Object.entries(CONFIG_SCHEMA)
    .filter(([, s]) => s.sensitive)
    .map(([key, s]) => ({ key, env: s.env }));
}

/** Get all hot-reloadable vars */
export function getHotReloadableVars(): HotReloadableVarEntry[] {
  return Object.entries(CONFIG_SCHEMA)
    .filter(([, s]) => s.hotReload)
    .map(([key, s]) => ({ key, ...s }));
}
