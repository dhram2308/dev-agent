/**
 * redaction.ts — Comprehensive Redaction Engine for MI Dev Agent
 *
 * Converted from lib/redaction.js (zero functional changes).
 *
 * Features:
 * - Named pattern registry with severity levels (critical/high/medium)
 * - All regexes compiled once at module load
 * - Replacement format: [REDACTED:{pattern_name}]
 * - Whitelist support for known-safe strings
 * - Performance: single pass per pattern, patterns ordered by likelihood
 * - Handles non-string input gracefully
 */

// ── Pattern Registry ─────────────────────────────────────────────

interface PatternDef {
  name: string;
  pattern: RegExp;
  severity: string;
  description: string;
}

interface CompiledPattern {
  name: string;
  regex: RegExp;
  severity: string;
  description: string;
}

const PATTERN_DEFS: PatternDef[] = [
  // --- Critical: API tokens & keys ---
  { name: "jira_token", pattern: /ATATT[a-zA-Z0-9_\-]{20,}/g, severity: "critical", description: "Jira/Atlassian Personal Access Token" },
  { name: "gitlab_token", pattern: /glpat-[a-zA-Z0-9_\-]{20,}/g, severity: "critical", description: "GitLab Personal Access Token" },
  { name: "github_token", pattern: /gh[ps]_[a-zA-Z0-9]{36,}/g, severity: "critical", description: "GitHub Personal/Server Access Token" },
  { name: "github_oauth_token", pattern: /gho_[a-zA-Z0-9]{36,}/g, severity: "critical", description: "GitHub OAuth Token" },
  { name: "github_user_token", pattern: /ghu_[a-zA-Z0-9]{36,}/g, severity: "critical", description: "GitHub User-to-Server Token" },
  { name: "slack_token", pattern: /xox[bpras]-[a-zA-Z0-9\-]{10,}/g, severity: "critical", description: "Slack Bot/User/App Token" },
  { name: "anthropic_key", pattern: /sk-ant-[a-zA-Z0-9\-]{20,}/g, severity: "critical", description: "Anthropic API Key" },
  { name: "openai_key", pattern: /sk-[a-zA-Z0-9]{20,}/g, severity: "critical", description: "OpenAI or generic sk- API Key" },
  { name: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/g, severity: "critical", description: "AWS Access Key ID" },
  { name: "aws_secret_key", pattern: /(?<=(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secret_key|SecretAccessKey)\s*[=:]\s*)[A-Za-z0-9/+=]{40}/g, severity: "critical", description: "AWS Secret Access Key" },
  // --- Critical: SSH Private Keys (multiline) ---
  { name: "ssh_private_key", pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, severity: "critical", description: "SSH/TLS Private Key" },
  // --- Critical: Connection strings ---
  { name: "connection_string", pattern: /(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|amqp|amqps):\/\/[^\s"'`]+/g, severity: "critical", description: "Database/Service Connection String" },
  // --- High: Auth headers & tokens ---
  { name: "bearer_token", pattern: /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/g, severity: "high", description: "Bearer Authorization Token" },
  { name: "basic_auth", pattern: /Basic\s+[a-zA-Z0-9+/=]{20,}/g, severity: "high", description: "Basic Authorization (base64 encoded credentials)" },
  { name: "jwt_token", pattern: /eyJ[a-zA-Z0-9_\-]+\.eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/g, severity: "high", description: "JSON Web Token (JWT)" },
  // --- Medium: Credential patterns ---
  { name: "email_password_pair", pattern: /\S+@\S+:\S{8,}/g, severity: "medium", description: "Email:password pair" },
  { name: "generic_hex_secret", pattern: /(?<!commit |tree |parent |object |sha256:|sha384:|sha512:|integrity=")[0-9a-f]{80,}/gi, severity: "medium", description: "Long hex string (possible secret/hash) — 80+ chars to skip SHA-256" },
];

// ── Compiled Pattern Cache ───────────────────────────────────────

const COMPILED_PATTERNS: CompiledPattern[] = PATTERN_DEFS.map((def) => {
  const flags = def.pattern.flags.includes("g") ? def.pattern.flags : def.pattern.flags + "g";
  return {
    name: def.name,
    regex: new RegExp(def.pattern.source, flags),
    severity: def.severity,
    description: def.description,
  };
});

// ── Whitelist ────────────────────────────────────────────────────
const _whitelist = new Set<string>();

/**
 * Add a string to the whitelist (will not be redacted even if it matches a pattern).
 */
function addToWhitelist(safeString: string): void {
  if (typeof safeString === "string" && safeString.length > 0) {
    _whitelist.add(safeString);
  }
}

/**
 * Remove a string from the whitelist.
 */
function removeFromWhitelist(safeString: string): void {
  _whitelist.delete(safeString);
}

/**
 * Clear the entire whitelist.
 */
function clearWhitelist(): void {
  _whitelist.clear();
}

/**
 * Get a copy of the current whitelist (for debugging/audit).
 */
function getWhitelist(): string[] {
  return [..._whitelist];
}

// ── Core Redaction Function ──────────────────────────────────────

interface RedactOptions {
  minSeverity?: string;
}

/**
 * Redact all known secret patterns from the input string.
 */
function redact(input: any, options: RedactOptions = {}): any {
  if (typeof input !== "string") return input;
  if (input.length === 0) return input;

  const minSeverity = options.minSeverity || "medium";
  const severityOrder: Record<string, number> = { critical: 3, high: 2, medium: 1 };
  const minLevel = severityOrder[minSeverity] || 1;

  let result = input;

  for (const pat of COMPILED_PATTERNS) {
    if ((severityOrder[pat.severity] || 0) < minLevel) continue;

    pat.regex.lastIndex = 0;

    result = result.replace(pat.regex, (match: string) => {
      if (_whitelist.has(match)) return match;
      return `[REDACTED:${pat.name}]`;
    });
  }

  return result;
}

interface SecretFinding {
  name: string;
  severity: string;
  count: number;
  description: string;
}

/**
 * Check if a string contains any detectable secrets.
 */
function detectSecrets(input: string): SecretFinding[] {
  if (typeof input !== "string" || input.length === 0) return [];

  const findings: SecretFinding[] = [];

  for (const pat of COMPILED_PATTERNS) {
    pat.regex.lastIndex = 0;
    const matches = input.match(pat.regex);
    if (matches && matches.length > 0) {
      const nonWhitelisted = matches.filter((m) => !_whitelist.has(m));
      if (nonWhitelisted.length > 0) {
        findings.push({
          name: pat.name,
          severity: pat.severity,
          count: nonWhitelisted.length,
          description: pat.description,
        });
      }
    }
  }

  return findings;
}

/**
 * Get a summary of all registered patterns (for diagnostics/startup logging).
 */
function getPatternSummary(): Array<{ name: string; severity: string; description: string }> {
  return COMPILED_PATTERNS.map((p) => ({
    name: p.name,
    severity: p.severity,
    description: p.description,
  }));
}

/**
 * Add a custom pattern at runtime.
 */
function addPattern(def: PatternDef): void {
  if (!def || !def.name || !def.pattern) {
    throw new Error("addPattern requires name and pattern");
  }
  if (COMPILED_PATTERNS.some((p) => p.name === def.name)) {
    throw new Error(`Pattern "${def.name}" already registered`);
  }
  const flags = def.pattern.flags.includes("g") ? def.pattern.flags : def.pattern.flags + "g";
  COMPILED_PATTERNS.push({
    name: def.name,
    regex: new RegExp(def.pattern.source, flags),
    severity: def.severity || "medium",
    description: def.description || "",
  });
}

/**
 * Redact environment variables from a string.
 */
function redactEnvValues(input: any): any {
  if (typeof input !== "string" || input.length === 0) return input;

  let result = input;
  const envKeys = [
    "JIRA_TOKEN", "GITLAB_TOKEN", "SLACK_WEBHOOK", "ANTHROPIC_API_KEY",
    "QA_MAIN_PASS", "QA1_PASS", "OWNER_SLACK_ID", "ANSHIT_SLACK_ID",
  ];

  for (const key of envKeys) {
    const val = process.env[key];
    if (val && val.length >= 8) {
      const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escaped, "g"), `[REDACTED:env_${key.toLowerCase()}]`);
    }
  }

  return result;
}

/**
 * Full redaction pipeline: pattern-based + env-value-based.
 */
function redactAll(input: any): any {
  if (typeof input !== "string") return input;
  let result = redact(input);
  result = redactEnvValues(result);
  return result;
}

export {
  redact,
  redactAll,
  detectSecrets,
  getPatternSummary,
  addPattern,
  addToWhitelist,
  removeFromWhitelist,
  clearWhitelist,
  getWhitelist,
  redactEnvValues,
  // Export for testing
  COMPILED_PATTERNS as _COMPILED_PATTERNS,
};
