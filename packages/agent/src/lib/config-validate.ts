/**
 * config-validate.ts -- Comprehensive config validation, snapshot, diff, hot-reload, migration
 *
 * Converted from lib/config-validate.js (zero functional changes).
 *
 * Provides:
 *   1. validateAllConfig() -- validates ALL 80+ vars against schema
 *   2. Config snapshots -- freeze config at pipeline start
 *   3. Config diff -- compare snapshots, categorize by risk
 *   4. Hot-reload -- update cfg in-place for safe vars
 *   5. Migration layer -- .env defaults + DB overrides
 */

import fs from "fs";
import path from "path";

import type { ConfigSchemaEntry, ParseResult } from "./config-schema";

const { CONFIG_SCHEMA, parseByType, getSensitiveVars } = require("./config-schema") as {
  CONFIG_SCHEMA: Record<string, ConfigSchemaEntry>;
  parseByType: (rawVal: unknown, schema: ConfigSchemaEntry) => ParseResult;
  getSensitiveVars: () => Array<{ key: string; env: string }>;
};

// -- Severity levels ---------------------------------------------------------

const Severity = {
  FATAL: "FATAL" as const,
  ERROR: "ERROR" as const,
  WARN:  "WARN" as const,
  INFO:  "INFO" as const,
};

export type SeverityLevel = typeof Severity[keyof typeof Severity];

export interface ValidationResult {
  field: string;
  severity: SeverityLevel;
  message: string;
  group: string;
}

export interface ValidateAllResult {
  valid: boolean;
  results: ValidationResult[];
  parsed: Record<string, any>;
}

// -- 1. Comprehensive Validation ---------------------------------------------

/**
 * Validate ALL config variables against the schema.
 * Returns structured results instead of calling process.exit().
 */
function validateAllConfig(env: Record<string, string | undefined> = process.env as any): ValidateAllResult {
  const results: ValidationResult[] = [];
  const parsed: Record<string, any> = {};

  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    const envName = schema.env;
    const rawVal = env[envName];

    // Check required
    if (schema.required && (rawVal === undefined || rawVal === null || rawVal === "")) {
      results.push({
        field: envName,
        severity: Severity.FATAL,
        message: `${envName} is required but missing or empty`,
        group: schema.group,
      });
      parsed[key] = undefined;
      continue;
    }

    // Parse the value
    const { value, error } = parseByType(rawVal, schema);
    parsed[key] = value;

    if (error) {
      const severity = schema.required ? Severity.FATAL : Severity.ERROR;
      results.push({
        field: envName,
        severity,
        message: `${envName}: ${error}`,
        group: schema.group,
      });
    }

    // Warn if using default for non-required vars that have no raw value
    if (!schema.required && (rawVal === undefined || rawVal === null || rawVal === "") && schema.default !== undefined) {
      // Only warn for sensitive or important vars, not every single timeout
      if (schema.sensitive || schema.group === "jira" || schema.group === "gitlab" || schema.group === "slack") {
        results.push({
          field: envName,
          severity: Severity.INFO,
          message: `${envName} not set -- using default${schema.sensitive ? " (sensitive)" : `: ${schema.default}`}`,
          group: schema.group,
        });
      }
    }
  }

  // -- Cross-field validations -----------------------------------------------

  // Port range validation (fixes bug #10)
  const portStart = parsed.NX_SERVE_PORT_RANGE_START;
  const portEnd = parsed.NX_SERVE_PORT_RANGE_END;
  if (portStart !== undefined && portEnd !== undefined && portStart > portEnd) {
    results.push({
      field: "NX_SERVE_PORT_RANGE_START/END",
      severity: Severity.ERROR,
      message: `Port range invalid: START (${portStart}) > END (${portEnd}). Swap the values.`,
      group: "browser",
    });
  }

  // Approval reminder ordering
  const rem1 = parsed.APPROVAL_REMINDER_1H;
  const rem4 = parsed.APPROVAL_REMINDER_4H;
  if (rem1 !== undefined && rem4 !== undefined && rem1 >= rem4) {
    results.push({
      field: "APPROVAL_REMINDER_1H/4H",
      severity: Severity.WARN,
      message: `First reminder (${rem1}ms) >= second reminder (${rem4}ms). First reminder should be shorter.`,
      group: "timeouts",
    });
  }

  // Approval timeout must be less than pipeline duration
  const approvalTimeout = parsed.MAX_APPROVAL_TIMEOUT;
  const pipelineDuration = parsed.MAX_PIPELINE_DURATION;
  if (approvalTimeout && pipelineDuration && approvalTimeout >= pipelineDuration) {
    results.push({
      field: "MAX_APPROVAL_TIMEOUT",
      severity: Severity.WARN,
      message: `Approval timeout (${approvalTimeout}ms) >= pipeline duration (${pipelineDuration}ms). Pipeline may timeout before approval.`,
      group: "timeouts",
    });
  }

  // Same approver warning
  const ownerJira = parsed.OWNER_JIRA_ID;
  const qaJira = parsed.QA_JIRA_ID;
  if (ownerJira && qaJira && ownerJira === qaJira) {
    results.push({
      field: "OWNER_JIRA_ID/QA_JIRA_ID",
      severity: Severity.WARN,
      message: "Both approver IDs are the same -- dual approval gate will be ineffective",
      group: "jira",
    });
  }

  // HTTP GitLab warning
  const gitlabUrl = parsed.GITLAB_URL;
  if (gitlabUrl && gitlabUrl.startsWith("http://")) {
    results.push({
      field: "GITLAB_URL",
      severity: Severity.WARN,
      message: "GitLab URL uses HTTP -- API tokens transmitted unencrypted. Use HTTPS for production.",
      group: "gitlab",
    });
  }

  // Empty approvers + ALLOW_ANY_APPROVER check
  if (!ownerJira && !qaJira && !parsed.ALLOW_ANY_APPROVER) {
    results.push({
      field: "OWNER_JIRA_ID/QA_JIRA_ID",
      severity: Severity.FATAL,
      message: "Both approver IDs empty and ALLOW_ANY_APPROVER is false. Set at least one approver or ALLOW_ANY_APPROVER=true.",
      group: "jira",
    });
  }

  // T2.9: QA credential validation -- require explicit configuration
  if (!env.QA_MAIN_USER || !env.QA_MAIN_PASS) {
    results.push({
      field: "QA_MAIN_USER/QA_MAIN_PASS",
      severity: Severity.WARN,
      message: "QA main credentials not configured -- QA testing stage will fail. Set QA_MAIN_USER and QA_MAIN_PASS.",
      group: "qa",
    });
  }
  if (!env.QA1_USER || !env.QA1_PASS) {
    results.push({
      field: "QA1_USER/QA1_PASS",
      severity: Severity.WARN,
      message: "QA1 credentials not configured -- QA1 testing will fail. Set QA1_USER and QA1_PASS.",
      group: "qa",
    });
  }

  const hasFatal = results.some((r) => r.severity === Severity.FATAL);
  return { valid: !hasFatal, results, parsed };
}


/**
 * Format validation results for console output.
 */
function formatValidationResults(results: ValidationResult[]): string {
  const lines: string[] = [];
  const icons: Record<string, string> = {
    [Severity.FATAL]: "\x1b[31mFATAL\x1b[0m",
    [Severity.ERROR]: "\x1b[31mERROR\x1b[0m",
    [Severity.WARN]:  "\x1b[33m WARN\x1b[0m",
    [Severity.INFO]:  "\x1b[36m INFO\x1b[0m",
  };

  // Group by severity for cleaner output
  const grouped: Record<string, ValidationResult[]> = {};
  for (const r of results) {
    if (!grouped[r.severity]) grouped[r.severity] = [];
    grouped[r.severity].push(r);
  }

  for (const sev of [Severity.FATAL, Severity.ERROR, Severity.WARN, Severity.INFO]) {
    const items = grouped[sev];
    if (!items || items.length === 0) continue;
    lines.push(`\n  ${icons[sev]} (${items.length}):`);
    for (const item of items) {
      lines.push(`    [${item.group}] ${item.field}: ${item.message}`);
    }
  }

  return lines.join("\n");
}


// -- 2. Config Snapshot ------------------------------------------------------

export interface ConfigSnapshotValue {
  value: any;
  hash?: string | null;
  redacted: boolean;
}

export interface ConfigSnapshot {
  _version: number;
  _createdAt: string;
  _schemaVersion: number;
  metadata: Record<string, any>;
  values: Record<string, ConfigSnapshotValue>;
}

/**
 * Capture a complete config snapshot at a point in time.
 * Includes all parsed values, metadata, and timestamp.
 * Sensitive values are redacted in the snapshot.
 */
function createConfigSnapshot(parsedConfig: Record<string, any>, metadata: Record<string, any> = {}): ConfigSnapshot {
  const sensitiveKeys = new Set(getSensitiveVars().map((v: { key: string }) => v.key));

  const values: Record<string, ConfigSnapshotValue> = {};
  for (const [key, value] of Object.entries(parsedConfig)) {
    if (sensitiveKeys.has(key)) {
      // Store hash for comparison, not the actual value
      values[key] = {
        value: "[REDACTED]",
        hash: value ? simpleHash(String(value)) : null,
        redacted: true,
      };
    } else {
      values[key] = { value, redacted: false };
    }
  }

  return {
    _version: 1,
    _createdAt: new Date().toISOString(),
    _schemaVersion: Object.keys(CONFIG_SCHEMA).length,
    metadata,
    values,
  };
}

/**
 * Simple hash for comparing sensitive values without storing them.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0; // Convert to 32-bit int
  }
  return hash.toString(16);
}

/**
 * Save config snapshot to state file for pipeline persistence.
 */
function saveConfigSnapshot(snapshot: ConfigSnapshot, stateDir: string, ticket: string): string {
  const snapshotPath = path.join(stateDir, `config-snapshot-${ticket}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  return snapshotPath;
}

/**
 * Load config snapshot from disk.
 */
function loadConfigSnapshot(stateDir: string, ticket: string): ConfigSnapshot | null {
  const snapshotPath = path.join(stateDir, `config-snapshot-${ticket}.json`);
  try {
    if (!fs.existsSync(snapshotPath)) return null;
    return JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  } catch {
    return null;
  }
}


// -- 3. Config Diff ----------------------------------------------------------

export interface ConfigChange {
  key: string;
  type: "ADDED" | "REMOVED" | "CHANGED";
  riskLevel: string;
  before: any;
  after: any;
  description: string;
}

export interface ConfigDiff {
  changes: ConfigChange[];
  safe: boolean;
  error?: string;
  summary?: {
    total: number;
    dangerous: number;
    caution: number;
    safe: number;
  };
}

/**
 * Compare two config snapshots and report changes.
 * Categorizes each change by risk level.
 */
function diffConfigSnapshots(before: ConfigSnapshot | null, after: ConfigSnapshot | null): ConfigDiff {
  if (!before || !after) {
    return { changes: [], safe: true, error: "Missing snapshot(s)" };
  }

  const changes: ConfigChange[] = [];

  // Check all keys in the union of both snapshots
  const allKeys = new Set([
    ...Object.keys(before.values || {}),
    ...Object.keys(after.values || {}),
  ]);

  for (const key of allKeys) {
    const bEntry = (before.values || {})[key];
    const aEntry = (after.values || {})[key];
    const schema = CONFIG_SCHEMA[key];
    const riskLevel = schema ? schema.riskLevel : "CAUTION";

    // Key was added
    if (!bEntry && aEntry) {
      changes.push({
        key,
        type: "ADDED",
        riskLevel,
        before: null,
        after: aEntry.redacted ? "[REDACTED]" : aEntry.value,
        description: `${key} was added${schema ? ` (${schema.description})` : ""}`,
      });
      continue;
    }

    // Key was removed
    if (bEntry && !aEntry) {
      changes.push({
        key,
        type: "REMOVED",
        riskLevel,
        before: bEntry.redacted ? "[REDACTED]" : bEntry.value,
        after: null,
        description: `${key} was removed${schema ? ` (${schema.description})` : ""}`,
      });
      continue;
    }

    // Compare values
    if (bEntry && aEntry) {
      let changed = false;
      if (bEntry.redacted || aEntry.redacted) {
        // Compare hashes for sensitive values
        changed = bEntry.hash !== aEntry.hash;
      } else {
        changed = !deepEqual(bEntry.value, aEntry.value);
      }

      if (changed) {
        changes.push({
          key,
          type: "CHANGED",
          riskLevel,
          before: bEntry.redacted ? "[REDACTED]" : bEntry.value,
          after: aEntry.redacted ? "[REDACTED]" : aEntry.value,
          description: `${key} changed${schema ? ` (${schema.description})` : ""}`,
        });
      }
    }
  }

  const hasDangerous = changes.some((c) => c.riskLevel === "DANGEROUS");
  return {
    changes,
    safe: !hasDangerous,
    summary: {
      total: changes.length,
      dangerous: changes.filter((c) => c.riskLevel === "DANGEROUS").length,
      caution: changes.filter((c) => c.riskLevel === "CAUTION").length,
      safe: changes.filter((c) => c.riskLevel === "SAFE").length,
    },
  };
}

/**
 * Deep equality check for config values.
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Format config diff for human-readable output.
 */
function formatConfigDiff(diff: ConfigDiff): string {
  if (!diff.changes || diff.changes.length === 0) {
    return "  No config changes detected.";
  }

  const lines: string[] = [`  Config changes (${diff.changes.length} total):`];
  const riskColors: Record<string, string> = {
    DANGEROUS: "\x1b[31m",
    CAUTION: "\x1b[33m",
    SAFE: "\x1b[32m",
  };
  const reset = "\x1b[0m";

  for (const c of diff.changes) {
    const color = riskColors[c.riskLevel] || "";
    const arrow = c.type === "ADDED" ? "+" : c.type === "REMOVED" ? "-" : "~";
    lines.push(`    ${arrow} ${color}[${c.riskLevel}]${reset} ${c.key}: ${c.before} -> ${c.after}`);
  }

  if (!diff.safe) {
    lines.push(`\n  \x1b[31mDANGEROUS changes detected! Pipeline may need restart.\x1b[0m`);
  }

  return lines.join("\n");
}


// -- 4. Hot-Reload Mechanism -------------------------------------------------

export interface HotReloadOptions {
  onWarning?: (msg: string) => void;
  onReloaded?: (keys: string[]) => void;
}

export interface HotReloadResult {
  reloaded: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Hot-reload configuration: re-parse .env and update the cfg object in-place.
 * ONLY updates values marked as hotReload: true in the schema.
 * Values marked hotReload: false require a restart.
 */
let _reloadLock = false;

function hotReloadConfig(cfg: any, topLevelExports: any, options: HotReloadOptions = {}): HotReloadResult {
  const { onWarning = () => {}, onReloaded = () => {} } = options;

  if (_reloadLock) {
    return { reloaded: [], skipped: [], errors: ["Reload already in progress"] };
  }

  _reloadLock = true;
  try {
    const { loadEnvFile } = require("./env-parser") as {
      loadEnvFile: (envPath: string | undefined, opts: { onWarning: (msg: string) => void }) => Record<string, string>;
    };
    const envFromFile = loadEnvFile(undefined, { onWarning });

    // Merge: file values provide base, process.env overrides
    const mergedEnv: Record<string, string | undefined> = { ...envFromFile };
    for (const [k, v] of Object.entries(process.env)) {
      mergedEnv[k] = v;
    }

    const reloaded: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
      if (!schema.hotReload) {
        if (envFromFile[schema.env] !== undefined) {
          skipped.push(schema.env);
        }
        continue;
      }

      const rawVal = mergedEnv[schema.env];
      const { value, error } = parseByType(rawVal, schema);

      if (error) {
        errors.push(`${schema.env}: ${error}`);
        continue;
      }

      // Update the appropriate location in cfg or top-level exports
      const updated = applyConfigValue(key, value, cfg, topLevelExports);
      if (updated) {
        reloaded.push(schema.env);
      }
    }

    onReloaded(reloaded);
    return { reloaded, skipped, errors };
  } finally {
    _reloadLock = false;
  }
}

/**
 * Apply a single parsed config value to the live config objects.
 * Maps schema keys to their locations in cfg and topLevelExports.
 *
 * @returns true if the value was changed
 */
function applyConfigValue(schemaKey: string, value: any, cfg: any, topLevelExports: any): boolean {
  // Map from schema key to cfg/export location
  const CFG_MAP: Record<string, (v: any) => void> = {
    // cfg.jira.*
    JIRA_TOKEN:              (v) => { cfg.jira.token = v; },
    JIRA_COMMENTS_ENABLED:   (v) => { topLevelExports.JIRA_COMMENTS = v; },

    // cfg.gitlab.*
    GITLAB_TOKEN:            (v) => { cfg.gitlab.token = v; },
    GITLAB_ASSIGNEE_ID:      (v) => { cfg.git.assigneeId = String(v); },

    // cfg.slack.*
    SLACK_WEBHOOK:           (v) => { cfg.slack.webhook = v; },
    OWNER_SLACK_ID:          (v) => { cfg.slack.ownerId = v; },
    QA_SLACK_ID:         (v) => { cfg.slack.qaId = v; },

    // cfg.git.*
    GIT_AUTHOR_NAME:         (v) => { cfg.git.authorName = v; },
    GIT_AUTHOR_EMAIL:        (v) => { cfg.git.authorEmail = v; },

    // cfg.qa.*
    QA_MAIN_USER:            (v) => { cfg.qa.main.user = v; },
    QA_MAIN_PASS:            (v) => { cfg.qa.main.pass = v; },
    QA1_USER:                (v) => { cfg.qa.qa1.user = v; },
    QA1_PASS:                (v) => { cfg.qa.qa1.pass = v; },

    // Top-level exported constants
    MAX_APPROVAL_TIMEOUT:    (v) => { topLevelExports.MAX_APPROVAL_TIMEOUT = v; },
    MAX_REJECTIONS:          (v) => { topLevelExports.MAX_REJECTIONS = v; },
    MAX_PIPELINE_DURATION:   (v) => { topLevelExports.MAX_PIPELINE_DURATION = v; },
    MAX_CONTINUE_WAIT:       (v) => { topLevelExports.MAX_CONTINUE_WAIT = v; },
    MAX_PLAN_REJECTIONS:     (v) => { topLevelExports.MAX_PLAN_REJECTIONS = v; },
    ANALYSIS_TIMEOUT:        (v) => { topLevelExports.ANALYSIS_TIMEOUT_MS = v; },
    DEVELOPER_TIMEOUT:       (v) => { topLevelExports.DEVELOPER_TIMEOUT_MS = v; },
    REVIEWER_TIMEOUT:        (v) => { topLevelExports.REVIEWER_TIMEOUT_MS = v; },
    TEST_FIXER_TIMEOUT:      (v) => { topLevelExports.TEST_FIXER_TIMEOUT_MS = v; },
    MAX_PROMPT_TOKENS:       (v) => { topLevelExports.MAX_PROMPT_TOKENS = v; },
    FETCH_CONCURRENCY:       (v) => { topLevelExports.FETCH_CONCURRENCY = v; },
    URL_FETCH_TIMEOUT:       (v) => { topLevelExports.URL_FETCH_TIMEOUT = v; },
    QA_SMOKE_LEVEL:          (v) => { topLevelExports.QA_SMOKE_LEVEL = v; },
    MERGE_POLL_TIMEOUT:      (v) => { topLevelExports.MERGE_POLL_TIMEOUT = v; },
    SKIP_SMOKE_CHECK:        (v) => { topLevelExports.SKIP_SMOKE_CHECK = v; },
    RUN_BUILD_CHECK:         (v) => { topLevelExports.RUN_BUILD_CHECK = v; },
    BUILD_INSTALL_TIMEOUT:   (v) => { topLevelExports.BUILD_INSTALL_TIMEOUT = v; },
    BUILD_TSC_TIMEOUT:       (v) => { topLevelExports.BUILD_TSC_TIMEOUT = v; },
    BUILD_ESLINT_TIMEOUT:    (v) => { topLevelExports.BUILD_ESLINT_TIMEOUT = v; },
    APPROVAL_REMINDER_1H:    (v) => { topLevelExports.APPROVAL_REMINDER_1H = v; },
    APPROVAL_REMINDER_4H:    (v) => { topLevelExports.APPROVAL_REMINDER_4H = v; },
    MAX_COMMIT_FILE_SIZE:    (v) => { topLevelExports.MAX_COMMIT_FILE_SIZE = v; },
    RUN_RUNTIME_TESTS:       (v) => { topLevelExports.RUN_RUNTIME_TESTS = v; },
    UNIT_TESTS_TIMEOUT:      (v) => { topLevelExports.UNIT_TESTS_TIMEOUT = v; },
    E2E_TESTS_TIMEOUT:       (v) => { topLevelExports.E2E_TESTS_TIMEOUT = v; },
    VITE_PREVIEW_TIMEOUT:    (v) => { topLevelExports.VITE_PREVIEW_TIMEOUT = v; },
    VITE_BUILD_TIMEOUT:      (v) => { topLevelExports.VITE_BUILD_TIMEOUT = v; },
    MAX_UNIT_TEST_RETRIES:   (v) => { topLevelExports.MAX_UNIT_TEST_RETRIES = v; },
    MAX_E2E_TEST_RETRIES:    (v) => { topLevelExports.MAX_E2E_TEST_RETRIES = v; },
    CONSOLE_WARNING_THRESHOLD: (v) => { topLevelExports.CONSOLE_WARNING_THRESHOLD = v; },
    TEST_ARTIFACTS_DIR:      (v) => { topLevelExports.TEST_ARTIFACTS_DIR = v; },
    BROWSER_VERIFY:          (v) => { topLevelExports.BROWSER_VERIFY = v; },
    MAX_VERIFY_RETRIES:      (v) => { topLevelExports.MAX_VERIFY_RETRIES = v; },
    NX_SERVE_TIMEOUT:        (v) => { topLevelExports.NX_SERVE_TIMEOUT = v; },
    VERIFICATION_TIMEOUT:    (v) => { topLevelExports.VERIFICATION_TIMEOUT = v; },
    EVIDENCE_MAX_SIZE:       (v) => { topLevelExports.EVIDENCE_MAX_SIZE = v; },
    QA_HEALTH_TIMEOUT:       (v) => { topLevelExports.QA_HEALTH_TIMEOUT = v; },
    LOG_LEVEL:               (v) => { topLevelExports.LOG_LEVEL = v; },
    LOG_FORMAT:              (v) => { topLevelExports.LOG_FORMAT = v; },
    SAVE_DEBUG_OUTPUT:       (v) => { topLevelExports.SAVE_DEBUG_OUTPUT = v; },
    POLL_INTERVAL:           (v) => { topLevelExports.POLL_INTERVAL = v; },
    CI_POLL:                 (v) => { topLevelExports.CI_POLL = v; },
    CI_TIMEOUT:              (v) => { topLevelExports.CI_TIMEOUT = v; },
    MAX_TOTAL_COMMENTS:      (v) => { topLevelExports.MAX_TOTAL_COMMENTS = v; },
    MAX_TOTAL_ATTACHMENTS:   (v) => { topLevelExports.MAX_TOTAL_ATTACHMENTS = v; },
    MAX_TOTAL_URL_CONTENT:   (v) => { topLevelExports.MAX_TOTAL_URL_CONTENT = v; },
    MAX_STATE_SIZE:          (v) => { topLevelExports.MAX_STATE_SIZE = v; },
  };

  const applier = CFG_MAP[schemaKey];
  if (applier) {
    applier(value);
    return true;
  }
  return false;
}


// -- 5. Config Store Layer (Migration: .env -> DB) ---------------------------

export interface DbAdapter {
  get(key: string): Promise<string | undefined>;
  getAll(): Promise<Array<{ key: string; value: string }>>;
  set(key: string, value: string): Promise<void>;
}

export interface ConfigStoreOptions {
  envPath?: string;
  dbAdapter?: DbAdapter | null;
  onWarning?: (msg: string) => void;
  dbCacheTtlMs?: number;
}

/**
 * ConfigStore -- Layered config provider with .env base + DB overrides.
 *
 * Merge strategy (highest priority wins):
 *   1. process.env (runtime overrides, e.g., from CI/CD)
 *   2. Database overrides (if DB is up)
 *   3. .env file defaults
 *   4. Schema defaults
 */
class ConfigStore {
  private _envPath: string;
  private _dbAdapter: DbAdapter | null;
  private _onWarning: (msg: string) => void;
  private _dbCacheTtlMs: number;
  private _envValues: Record<string, string>;
  private _dbValues: Record<string, string>;
  private _dbLastFetch: number;
  private _dbAvailable: boolean;

  constructor(options: ConfigStoreOptions = {}) {
    this._envPath = options.envPath || path.join(__dirname, "..", "..", "..", "..", ".env");
    this._dbAdapter = options.dbAdapter || null;
    this._onWarning = options.onWarning || (() => {});
    this._dbCacheTtlMs = options.dbCacheTtlMs || 60_000;

    // Caches
    this._envValues = {};
    this._dbValues = {};
    this._dbLastFetch = 0;
    this._dbAvailable = true;
  }

  /**
   * Load all config values from all sources, merged by priority.
   */
  async loadAll(): Promise<Record<string, string | undefined>> {
    // Layer 1: .env file
    const { loadEnvFile } = require("./env-parser") as {
      loadEnvFile: (envPath: string | undefined, opts: { onWarning: (msg: string) => void }) => Record<string, string>;
    };
    this._envValues = loadEnvFile(this._envPath, { onWarning: this._onWarning });

    // Layer 2: DB overrides (if adapter provided)
    if (this._dbAdapter) {
      await this._refreshDbCache();
    }

    // Merge: schema defaults < .env < DB < process.env
    const merged: Record<string, string | undefined> = {};
    for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
      const envName = schema.env;

      // Start with schema default
      let rawVal: string | undefined = schema.default !== undefined ? String(schema.default) : undefined;

      // Override with .env value
      if (this._envValues[envName] !== undefined) {
        rawVal = this._envValues[envName];
      }

      // Override with DB value (if available)
      if (this._dbValues[envName] !== undefined) {
        rawVal = this._dbValues[envName];
      }

      // Override with process.env (highest priority)
      if (process.env[envName] !== undefined && process.env[envName] !== "") {
        rawVal = process.env[envName];
      }

      merged[envName] = rawVal;
    }

    return merged;
  }

  /**
   * Refresh DB cache if TTL has expired.
   */
  private async _refreshDbCache(): Promise<void> {
    if (!this._dbAdapter) return;
    if (Date.now() - this._dbLastFetch < this._dbCacheTtlMs) return;

    try {
      const rows = await Promise.race([
        this._dbAdapter.getAll(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DB timeout")), 5000)),
      ]);

      this._dbValues = {};
      for (const row of rows) {
        this._dbValues[row.key] = row.value;
      }
      this._dbLastFetch = Date.now();
      this._dbAvailable = true;
    } catch (err: any) {
      if (this._dbAvailable) {
        this._onWarning(`Config DB unavailable: ${err.message} -- using .env + defaults`);
        this._dbAvailable = false;
      }
      // Keep stale cache -- better than no values
    }
  }

  /**
   * Get a single config value (from cache).
   */
  get(envName: string): string | undefined {
    // Priority: process.env > DB > .env > schema default
    if (process.env[envName] !== undefined && process.env[envName] !== "") {
      return process.env[envName];
    }
    if (this._dbValues[envName] !== undefined) {
      return this._dbValues[envName];
    }
    if (this._envValues[envName] !== undefined) {
      return this._envValues[envName];
    }
    // Find schema default
    for (const schema of Object.values(CONFIG_SCHEMA)) {
      if (schema.env === envName && schema.default !== undefined) {
        return String(schema.default);
      }
    }
    return undefined;
  }

  /**
   * Set a config override in the DB layer.
   */
  async set(envName: string, value: string): Promise<void> {
    if (!this._dbAdapter) {
      throw new Error("No DB adapter configured -- cannot persist config overrides");
    }
    await this._dbAdapter.set(envName, value);
    this._dbValues[envName] = value;
  }

  /**
   * Check if DB adapter is available.
   */
  isDbAvailable(): boolean {
    return this._dbAvailable && this._dbAdapter !== null;
  }
}


// -- 6. Safe vs Restart-Required Classification ------------------------------

export interface ReloadClassification {
  safe: Array<{ key: string; env: string; group: string; description: string }>;
  restart: Array<{ key: string; env: string; group: string; description: string }>;
}

/**
 * Return lists of config vars grouped by whether they can be hot-reloaded.
 */
function getReloadClassification(): ReloadClassification {
  const safe: ReloadClassification["safe"] = [];
  const restart: ReloadClassification["restart"] = [];

  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    const entry = { key, env: schema.env, group: schema.group, description: schema.description };
    if (schema.hotReload) {
      safe.push(entry);
    } else {
      restart.push(entry);
    }
  }

  return { safe, restart };
}


module.exports = {
  Severity,
  validateAllConfig,
  formatValidationResults,
  createConfigSnapshot,
  saveConfigSnapshot,
  loadConfigSnapshot,
  diffConfigSnapshots,
  formatConfigDiff,
  hotReloadConfig,
  ConfigStore,
  getReloadClassification,
};
