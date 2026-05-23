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

import path from "path";
import { ALLOWED_MR_TARGETS } from "./constants";

// TODO: tighten type — these come from unconverted modules
const { loadAndApplyEnv } = require("./env-parser") as {
  loadAndApplyEnv: (envPath: string | undefined, opts: { override: boolean; onWarning: (msg: string) => void }) => void;
};
const { CONFIG_SCHEMA, parseByType } = require("./config-schema") as {
  CONFIG_SCHEMA: Record<string, ConfigSchemaEntry>;
  parseByType: (rawVal: string | undefined, schema: ConfigSchemaEntry) => { value: any; error?: string };
};
const {
  validateAllConfig,
  formatValidationResults: _formatValidationResults,
  createConfigSnapshot: createValidateSnapshot,
  hotReloadConfig,
} = require("./config-validate") as {
  validateAllConfig: (env: NodeJS.ProcessEnv) => { valid: boolean; results: ValidationResult[]; parsed: Record<string, any> };
  formatValidationResults: (results: ValidationResult[]) => string;
  createConfigSnapshot: (parsed: Record<string, any>, metadata: Record<string, any>) => ConfigSnapshot;
  hotReloadConfig: (cfg: CfgObject, topLevelExports: Record<string, any>, options: ReloadOptions) => ReloadResult;
};

// ── Internal Types ──────────────────────────────────────────────

interface ConfigSchemaEntry {
  env: string;
  type: string;
  default?: any;
  required?: boolean;
  sensitive?: boolean;
  group?: string;
  hotReload?: boolean;
  riskLevel?: string;
  description?: string;
  [key: string]: any; // TODO: tighten type
}

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
    qaId: string | undefined;
  };
  ids: {
    owner: string | undefined;
    qa: string | undefined;
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

// ── Load .env (backward-compat wrapper) ───────────────────────────
// Uses env-parser.js instead of the old buggy line-by-line parser.
// Strips quotes, handles comments, supports multiline, warns on dupes.

const _warnings: string[] = [];

function loadEnv(): void {
  loadAndApplyEnv(undefined, {
    override: false,
    onWarning: (msg: string) => _warnings.push(msg),
  });
}

// Load on require (same behavior as original)
loadEnv();

// ── Parse ALL config vars through the schema ──────────────────────
// This fixes:
//   Bug #2: parseInt("0") || default  -> parseIntSafe returns 0 correctly
//   Bug #3: boolean "1"/"yes"/"TRUE"  -> parseBoolean handles all cases
//   Bug #4: enum "verbose"            -> parseEnum rejects invalid values
//   Bug #5: quoted env values         -> env-parser strips quotes
//   Bug #6: inline comments           -> env-parser strips them

function _parseAll(): { parsed: Record<string, any>; errors: Array<{ key: string; env: string; error: string }> } {
  const parsed: Record<string, any> = {};
  const errors: Array<{ key: string; env: string; error: string }> = [];

  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    const rawVal = process.env[schema.env];
    const { value, error } = parseByType(rawVal, schema);
    parsed[key] = value;
    if (error) {
      errors.push({ key, env: schema.env, error });
    }
  }

  return { parsed, errors };
}

const { parsed: _parsed, errors: _parseErrors } = _parseAll();

// ── Core identifiers ──────────────────────────────────────────────
// TICKET is required — validate immediately (same as original behavior).

export const TICKET: string = _parsed.TICKET || (process.env.TICKET || "").trim().toUpperCase() || "";
export const STATE_FILE: string = TICKET ? path.join(__dirname, "..", "..", `state-${TICKET}.json`) : "";

// ── Polling & timeout constants ───────────────────────────────────
// All parsed through schema with type-safe parseInt (no parseInt(0) bug).

export let POLL_INTERVAL: number            = _parsed.POLL_INTERVAL;
export let CI_POLL: number                  = _parsed.CI_POLL;
export let CI_TIMEOUT: number               = _parsed.CI_TIMEOUT;
export let JIRA_COMMENTS: boolean           = _parsed.JIRA_COMMENTS_ENABLED;
export let MAX_APPROVAL_TIMEOUT: number     = _parsed.MAX_APPROVAL_TIMEOUT;
export let MAX_REJECTIONS: number           = _parsed.MAX_REJECTIONS;
export let MAX_PIPELINE_DURATION: number    = _parsed.MAX_PIPELINE_DURATION;
export let MAX_CONTINUE_WAIT: number        = _parsed.MAX_CONTINUE_WAIT;
export let MAX_PLAN_REJECTIONS: number      = _parsed.MAX_PLAN_REJECTIONS;

// ── Named timeouts for each agent ─────────────────────────────────

export let ANALYSIS_TIMEOUT_MS: number      = _parsed.ANALYSIS_TIMEOUT;
export let DEVELOPER_TIMEOUT_MS: number     = _parsed.DEVELOPER_TIMEOUT;
export let DEVELOPER_MAX_TURNS: number      = _parsed.DEVELOPER_MAX_TURNS;
export let REVIEWER_MAX_TURNS: number       = _parsed.REVIEWER_MAX_TURNS;
export let FIXER_MAX_TURNS: number          = _parsed.FIXER_MAX_TURNS;
export let BUILD_FIXER_MAX_TURNS: number    = _parsed.BUILD_FIXER_MAX_TURNS;
export let REVIEWER_TIMEOUT_MS: number      = _parsed.REVIEWER_TIMEOUT;
// M23: Security audits do deeper grep/read work than reviewer pattern checks
// and deserve their own budget. Falls back to REVIEWER_TIMEOUT to preserve
// existing behavior when SECURITY_TIMEOUT isn't set in the env.
export let SECURITY_TIMEOUT_MS: number      = (_parsed as any).SECURITY_TIMEOUT || _parsed.REVIEWER_TIMEOUT;
export let TEST_FIXER_TIMEOUT_MS: number    = _parsed.TEST_FIXER_TIMEOUT;

// ── Complexity-aware timeout multiplier ───────────────────────────

// TODO: tighten type — state has a complex shape
export function applyComplexityTimeout(baseTimeout: number, state: any): number {
  const multiplier = state?.data?.ticket?.complexity?.timeoutMultiplier;
  if (!multiplier || multiplier === 1) return baseTimeout;
  return Math.round(baseTimeout * multiplier);
}

// ── Prompt size validation ────────────────────────────────────────

export let MAX_PROMPT_TOKENS: number        = _parsed.MAX_PROMPT_TOKENS;

// ── Parallel fetching ─────────────────────────────────────────────

export let FETCH_CONCURRENCY: number        = _parsed.FETCH_CONCURRENCY;
export let URL_FETCH_TIMEOUT: number        = _parsed.URL_FETCH_TIMEOUT;

// ── Total context accumulation caps ───────────────────────────────

export let MAX_TOTAL_COMMENTS: number       = _parsed.MAX_TOTAL_COMMENTS;
export let MAX_TOTAL_ATTACHMENTS: number    = _parsed.MAX_TOTAL_ATTACHMENTS;
export let MAX_TOTAL_URL_CONTENT: number    = _parsed.MAX_TOTAL_URL_CONTENT;
export let MAX_STATE_SIZE: number           = _parsed.MAX_STATE_SIZE;

// ── QA & merge controls ──────────────────────────────────────────

export let QA_SMOKE_LEVEL: string           = _parsed.QA_SMOKE_LEVEL;
export let MERGE_POLL_TIMEOUT: number       = _parsed.MERGE_POLL_TIMEOUT;
export let SKIP_SMOKE_CHECK: boolean        = _parsed.SKIP_SMOKE_CHECK;

// ── Build verification ───────────────────────────────────────────

export let RUN_BUILD_CHECK: boolean         = _parsed.RUN_BUILD_CHECK;
export let BUILD_INSTALL_TIMEOUT: number    = _parsed.BUILD_INSTALL_TIMEOUT;
export let BUILD_TSC_TIMEOUT: number        = _parsed.BUILD_TSC_TIMEOUT;
export let BUILD_ESLINT_TIMEOUT: number     = _parsed.BUILD_ESLINT_TIMEOUT;

// ── Approval escalation ─────────────────────────────────────────

export let APPROVAL_REMINDER_1H: number     = _parsed.APPROVAL_REMINDER_1H;
export let APPROVAL_REMINDER_4H: number     = _parsed.APPROVAL_REMINDER_4H;

// ── Git controls ────────────────────────────────────────────────

export const GIT_CLONE_DEPTH: number        = _parsed.GIT_CLONE_DEPTH;
export let MAX_COMMIT_FILE_SIZE: number     = _parsed.MAX_COMMIT_FILE_SIZE;

// ── Runtime Testing Pipeline ────────────────────────────────────

export let RUN_RUNTIME_TESTS: boolean       = _parsed.RUN_RUNTIME_TESTS;
export let UNIT_TESTS_TIMEOUT: number       = _parsed.UNIT_TESTS_TIMEOUT;
export let E2E_TESTS_TIMEOUT: number        = _parsed.E2E_TESTS_TIMEOUT;
export let VITE_PREVIEW_TIMEOUT: number     = _parsed.VITE_PREVIEW_TIMEOUT;
export let VITE_BUILD_TIMEOUT: number       = _parsed.VITE_BUILD_TIMEOUT;
export let MAX_UNIT_TEST_RETRIES: number    = _parsed.MAX_UNIT_TEST_RETRIES;
export let MAX_E2E_TEST_RETRIES: number     = _parsed.MAX_E2E_TEST_RETRIES;
export let CONSOLE_WARNING_THRESHOLD: number = _parsed.CONSOLE_WARNING_THRESHOLD;
export let TEST_ARTIFACTS_DIR: string       = _parsed.TEST_ARTIFACTS_DIR;
export const PLAYWRIGHT_BROWSER: string     = _parsed.PLAYWRIGHT_BROWSER;

// ── Browser Verification Pipeline ───────────────────────────────

export let BROWSER_VERIFY: boolean          = _parsed.BROWSER_VERIFY;
export let MAX_VERIFY_RETRIES: number       = _parsed.MAX_VERIFY_RETRIES;
export let NX_SERVE_TIMEOUT: number         = _parsed.NX_SERVE_TIMEOUT;
export const NX_SERVE_PORT_RANGE_START: number = _parsed.NX_SERVE_PORT_RANGE_START;
export const NX_SERVE_PORT_RANGE_END: number   = _parsed.NX_SERVE_PORT_RANGE_END;
export const VITE_PREVIEW_PORT_START: number   = _parsed.VITE_PREVIEW_PORT_START;
export const VITE_PREVIEW_PORT_END: number     = _parsed.VITE_PREVIEW_PORT_END;
export let VERIFICATION_TIMEOUT: number     = _parsed.VERIFICATION_TIMEOUT;
export let EVIDENCE_MAX_SIZE: number        = _parsed.EVIDENCE_MAX_SIZE;
export let QA_HEALTH_TIMEOUT: number        = _parsed.QA_HEALTH_TIMEOUT;

// ── Logging configuration ───────────────────────────────────────

export let LOG_LEVEL: string                = _parsed.LOG_LEVEL;
export let SAVE_DEBUG_OUTPUT: boolean       = _parsed.SAVE_DEBUG_OUTPUT;
export let LOG_FORMAT: string               = _parsed.LOG_FORMAT;

// ── V9: Monotonic clock ─────────────────────────────────────────

export function monotonicMs(): number { return Number(process.hrtime.bigint() / 1_000_000n); }

// ── S5: MR target validation ────────────────────────────────────

export function validateMRTarget(targetBranch: string): void {
  if (!ALLOWED_MR_TARGETS.includes(targetBranch)) {
    throw new Error(`S5: Invalid MR target branch: "${targetBranch}". Allowed: ${ALLOWED_MR_TARGETS.join(", ")}`);
  }
}

// ── Master configuration object ─────────────────────────────────
// EXACT same shape as original — all consumer paths unchanged.

export const cfg: CfgObject = {
  jira: {
    base:  _parsed.JIRA_BASE_URL || "https://mastersindia-sols.atlassian.net",
    email: _parsed.JIRA_EMAIL,
    token: _parsed.JIRA_TOKEN,
    get auth() { return Buffer.from(`${this.email}:${this.token}`).toString("base64"); },
  },
  gitlab: {
    base:      _parsed.GITLAB_URL || "http://10.200.11.32",
    token:     _parsed.GITLAB_TOKEN,
    projectId: _parsed.GITLAB_PROJECT_ID !== undefined ? String(_parsed.GITLAB_PROJECT_ID) : undefined,
    cloneUrl:  _parsed.GITLAB_CLONE_URL || "git@10.200.11.32:mastersindia/mi_frontend_apps.git",
    authMode:  (_parsed.GITLAB_AUTH_MODE as 'oauth' | 'pat') || "pat",
  },
  slack: {
    webhook:  _parsed.SLACK_WEBHOOK,
    ownerId:  _parsed.OWNER_SLACK_ID,
    qaId: _parsed.QA_SLACK_ID,
  },
  ids: {
    owner:  _parsed.OWNER_JIRA_ID,
    qa: _parsed.QA_JIRA_ID,
  },
  urls: {
    qa:      _parsed.QA_URL || "https://qa-enterprise.mastersindia-einv.com",
    qa1:     _parsed.QA1_URL || "https://qa1-enterprise.mastersindia-einv.com",
    preProd: "https://pre-gst.mastersindia.co",
    prod:    "https://gst.mastersindia.co",
  },
  qa: {
    main: {
      url:  _parsed.QA_URL || "https://qa-enterprise.mastersindia-einv.com",
      user: _parsed.QA_MAIN_USER || "",
      pass: _parsed.QA_MAIN_PASS || "",
      modules: [
        { name: "Dashboard",      path: "/dashboard" },
        { name: "GST Return",     path: "/gst-return" },
        { name: "Reports",        path: "/reports" },
        { name: "Configurations", path: "/config" },
        { name: "Import",         path: "/import" },
      ],
    },
    qa1: {
      url:  _parsed.QA1_URL || "https://qa1-enterprise.mastersindia-einv.com",
      user: _parsed.QA1_USER || "",
      pass: _parsed.QA1_PASS || "",
      modules: [
        { name: "IMS (Inventory)", path: "/ims" },
        { name: "Reconcile",       path: "/reconcile" },
      ],
    },
  },
  branch: {
    ts:      "enterprise-ts",
    qa:      "enterprise-qa",
    preProd: "enterprise-pre-pro",
    prod:    "enterprise-master",
  },
  git: {
    authorName:  _parsed.GIT_AUTHOR_NAME || "Yogendra",
    authorEmail: _parsed.GIT_AUTHOR_EMAIL || "yogendrasingh@mastersindia.co",
    assigneeId:  _parsed.GITLAB_ASSIGNEE_ID !== undefined ? String(_parsed.GITLAB_ASSIGNEE_ID) : "123",
  },
  // Flag: local repo mode (set by main after ensureLocalRepo succeeds)
  localRepo: false,
};

// ── Comprehensive validation (replaces old 4-var check) ──────────
// Returns structured errors instead of calling process.exit().

/**
 * validateConfig() — backward-compatible wrapper.
 *
 * When called with (logErr, logInfo, logWarn) — original behavior:
 *   logs errors and calls process.exit(1) on fatal errors.
 *
 * When called with no arguments — new behavior:
 *   returns { valid, results, parsed } for programmatic use.
 */
export function validateConfig(
  logErr?: (msg: string) => void,
  logInfo?: (msg: string) => void,
  logWarn?: (msg: string) => void,
): { valid: boolean; results: ValidationResult[]; parsed: Record<string, any> } | void {
  const { valid, results, parsed } = validateAllConfig(process.env);

  // No-argument call: return structured results (new API)
  if (!logErr) {
    return { valid, results, parsed };
  }

  // With arguments: original behavior — log and exit
  const fatals = results.filter((r) => r.severity === "FATAL");
  const errors = results.filter((r) => r.severity === "ERROR");
  const warns  = results.filter((r) => r.severity === "WARN");

  if (fatals.length > 0 || errors.length > 0) {
    for (const f of fatals) logErr(f.message);
    for (const e of errors) logErr(e.message);
    logInfo!("Run ./start.sh first, or export these env vars.");
    process.exit(1);
  }

  for (const w of warns) {
    if (logWarn) logWarn(w.message);
  }
}

// ── Hot-reload: mutate cfg in-place ──────────────────────────────
// Re-reads .env, re-parses all vars through schema, updates cfg and
// top-level exports for hot-reloadable vars only.

export function reloadConfig(options: ReloadOptions = {}): ReloadResult {
  // TODO: tighten type — module.exports equivalent in TS is complex
  const topLevelExports = module.exports as Record<string, any>;
  return hotReloadConfig(cfg, topLevelExports, options);
}

// ── Config snapshot using config-validate.js ─────────────────────

export function getConfigSnapshot(metadata: Record<string, any> = {}): ConfigSnapshot {
  const { parsed } = validateAllConfig(process.env);
  return createValidateSnapshot(parsed, metadata);
}
