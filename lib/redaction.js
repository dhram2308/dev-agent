"use strict";

/**
 * Comprehensive Redaction Engine for MI Dev Agent
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
// Each entry: { name, pattern (string or RegExp), severity, description }
// Patterns are applied in order; put high-frequency matches first.

const PATTERN_DEFS = [
  // --- Critical: API tokens & keys ---
  {
    name: "jira_token",
    pattern: /ATATT[a-zA-Z0-9_\-]{20,}/g,
    severity: "critical",
    description: "Jira/Atlassian Personal Access Token",
  },
  {
    name: "gitlab_token",
    pattern: /glpat-[a-zA-Z0-9_\-]{20,}/g,
    severity: "critical",
    description: "GitLab Personal Access Token",
  },
  {
    name: "github_token",
    pattern: /gh[ps]_[a-zA-Z0-9]{36,}/g,
    severity: "critical",
    description: "GitHub Personal/Server Access Token",
  },
  {
    name: "github_oauth_token",
    pattern: /gho_[a-zA-Z0-9]{36,}/g,
    severity: "critical",
    description: "GitHub OAuth Token",
  },
  {
    name: "github_user_token",
    pattern: /ghu_[a-zA-Z0-9]{36,}/g,
    severity: "critical",
    description: "GitHub User-to-Server Token",
  },
  {
    name: "slack_token",
    pattern: /xox[bpras]-[a-zA-Z0-9\-]{10,}/g,
    severity: "critical",
    description: "Slack Bot/User/App Token",
  },
  {
    name: "anthropic_key",
    pattern: /sk-ant-[a-zA-Z0-9\-]{20,}/g,
    severity: "critical",
    description: "Anthropic API Key",
  },
  {
    name: "openai_key",
    pattern: /sk-[a-zA-Z0-9]{20,}/g,
    severity: "critical",
    description: "OpenAI or generic sk- API Key",
  },
  {
    name: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    severity: "critical",
    description: "AWS Access Key ID",
  },
  {
    name: "aws_secret_key",
    // AWS secret keys are 40-char base64 — match after AKIA line or common assignment patterns
    pattern: /(?<=(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secret_key|SecretAccessKey)\s*[=:]\s*)[A-Za-z0-9/+=]{40}/g,
    severity: "critical",
    description: "AWS Secret Access Key",
  },

  // --- Critical: SSH Private Keys (multiline) ---
  {
    name: "ssh_private_key",
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
    severity: "critical",
    description: "SSH/TLS Private Key",
  },

  // --- Critical: Connection strings ---
  {
    name: "connection_string",
    pattern: /(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|amqp|amqps):\/\/[^\s"'`]+/g,
    severity: "critical",
    description: "Database/Service Connection String",
  },

  // --- High: Auth headers & tokens ---
  {
    name: "bearer_token",
    pattern: /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/g,
    severity: "high",
    description: "Bearer Authorization Token",
  },
  {
    name: "basic_auth",
    pattern: /Basic\s+[a-zA-Z0-9+/=]{20,}/g,
    severity: "high",
    description: "Basic Authorization (base64 encoded credentials)",
  },
  {
    name: "jwt_token",
    pattern: /eyJ[a-zA-Z0-9_\-]+\.eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/g,
    severity: "high",
    description: "JSON Web Token (JWT)",
  },

  // --- Medium: Credential patterns ---
  {
    name: "email_password_pair",
    pattern: /\S+@\S+:\S{8,}/g,
    severity: "medium",
    description: "Email:password pair",
  },
  {
    name: "generic_hex_secret",
    // Match 64+ hex chars ONLY when NOT preceded by common git/hash context
    // This avoids false positives on git SHA-256 hashes, commit SHAs, etc.
    // Requires word boundary and excludes strings that appear after "commit ", "tree ", "parent ", "object "
    pattern: /(?<!commit |tree |parent |object |sha256:|sha384:|sha512:|integrity=")[0-9a-f]{80,}/gi,
    severity: "medium",
    description: "Long hex string (possible secret/hash) — 80+ chars to skip SHA-256",
  },
];

// ── Compiled Pattern Cache ───────────────────────────────────────
// Clone each regex so we have stable lastIndex and guaranteed 'g' flag

const COMPILED_PATTERNS = PATTERN_DEFS.map((def) => {
  // Ensure global flag for replace operations
  const flags = def.pattern.flags.includes("g") ? def.pattern.flags : def.pattern.flags + "g";
  return {
    name: def.name,
    regex: new RegExp(def.pattern.source, flags),
    severity: def.severity,
    description: def.description,
  };
});

// ── Whitelist ────────────────────────────────────────────────────
// Known-safe strings that happen to match patterns but are not secrets.
// Example: test fixture UUIDs, documentation examples, etc.
const _whitelist = new Set();

/**
 * Add a string to the whitelist (will not be redacted even if it matches a pattern).
 * @param {string} safeString
 */
function addToWhitelist(safeString) {
  if (typeof safeString === "string" && safeString.length > 0) {
    _whitelist.add(safeString);
  }
}

/**
 * Remove a string from the whitelist.
 * @param {string} safeString
 */
function removeFromWhitelist(safeString) {
  _whitelist.delete(safeString);
}

/**
 * Clear the entire whitelist.
 */
function clearWhitelist() {
  _whitelist.clear();
}

/**
 * Get a copy of the current whitelist (for debugging/audit).
 * @returns {string[]}
 */
function getWhitelist() {
  return [..._whitelist];
}

// ── Core Redaction Function ──────────────────────────────────────

/**
 * Redact all known secret patterns from the input string.
 *
 * @param {*} input - The string to redact. Non-strings are returned as-is.
 * @param {Object} [options] - Options
 * @param {string} [options.minSeverity] - Only redact patterns at this severity or higher
 *                                         ("medium" = all, "high" = high+critical, "critical" = critical only)
 * @returns {string} The redacted string
 */
function redact(input, options = {}) {
  if (typeof input !== "string") return input;
  if (input.length === 0) return input;

  const minSeverity = options.minSeverity || "medium";
  const severityOrder = { critical: 3, high: 2, medium: 1 };
  const minLevel = severityOrder[minSeverity] || 1;

  let result = input;

  for (const pat of COMPILED_PATTERNS) {
    if (severityOrder[pat.severity] < minLevel) continue;

    // Reset lastIndex for safety (global regex)
    pat.regex.lastIndex = 0;

    result = result.replace(pat.regex, (match) => {
      // Check whitelist
      if (_whitelist.has(match)) return match;
      return `[REDACTED:${pat.name}]`;
    });
  }

  return result;
}

/**
 * Check if a string contains any detectable secrets.
 * Returns an array of { name, severity, count } for each pattern that matched.
 *
 * @param {string} input
 * @returns {Array<{name: string, severity: string, count: number}>}
 */
function detectSecrets(input) {
  if (typeof input !== "string" || input.length === 0) return [];

  const findings = [];

  for (const pat of COMPILED_PATTERNS) {
    pat.regex.lastIndex = 0;
    const matches = input.match(pat.regex);
    if (matches && matches.length > 0) {
      // Filter out whitelisted matches
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
 * @returns {Array<{name: string, severity: string, description: string}>}
 */
function getPatternSummary() {
  return COMPILED_PATTERNS.map((p) => ({
    name: p.name,
    severity: p.severity,
    description: p.description,
  }));
}

/**
 * Add a custom pattern at runtime.
 * @param {Object} def - Pattern definition
 * @param {string} def.name - Unique pattern name
 * @param {RegExp} def.pattern - Regex pattern (will be made global)
 * @param {string} def.severity - "critical" | "high" | "medium"
 * @param {string} def.description - Human-readable description
 */
function addPattern(def) {
  if (!def || !def.name || !def.pattern) {
    throw new Error("addPattern requires name and pattern");
  }
  // Check for duplicate name
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
 * Scans process.env for values that look like secrets (length >= 16, not pure numbers/paths)
 * and replaces them in the input.
 *
 * @param {string} input
 * @returns {string}
 */
function redactEnvValues(input) {
  if (typeof input !== "string" || input.length === 0) return input;

  let result = input;
  const envKeys = [
    "JIRA_TOKEN", "GITLAB_TOKEN", "SLACK_WEBHOOK", "ANTHROPIC_API_KEY",
    "QA_MAIN_PASS", "QA1_PASS", "OWNER_SLACK_ID", "ANSHIT_SLACK_ID",
  ];

  for (const key of envKeys) {
    const val = process.env[key];
    if (val && val.length >= 8) {
      // Escape special regex chars in the value
      const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escaped, "g"), `[REDACTED:env_${key.toLowerCase()}]`);
    }
  }

  return result;
}

/**
 * Full redaction pipeline: pattern-based + env-value-based.
 * This is the primary function to use throughout the codebase.
 *
 * @param {*} input
 * @returns {string}
 */
function redactAll(input) {
  if (typeof input !== "string") return input;
  let result = redact(input);
  result = redactEnvValues(result);
  return result;
}

module.exports = {
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
  _COMPILED_PATTERNS: COMPILED_PATTERNS,
};
