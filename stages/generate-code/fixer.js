"use strict";

const { logWarn } = require("../../lib/logging");

/**
 * F1: Parse VERDICT from structured agent output (fallback to legacy keyword check).
 * Shared by both local and legacy code paths.
 *
 * @param {string} output - Agent output text
 * @param {string} legacyPassWord - Legacy keyword to check if no VERDICT found (e.g., "lgtm", "secure")
 * @returns {boolean} true if passed
 */
function parseVerdict(output, legacyPassWord) {
  const verdictMatch = output.match(/VERDICT:\s*(PASS|FAIL)/i);
  if (verdictMatch) return verdictMatch[1].toUpperCase() === "PASS";
  // T2.7: Check for negation before legacy word match to prevent "not secure" → PASS
  const negationPattern = new RegExp(`\\b(not|no|isn't|isn\\'t|un|in)\\s*${legacyPassWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (negationPattern.test(output)) {
    logWarn(`Legacy word "${legacyPassWord}" found but negated — treating as FAIL`);
    return false;
  }
  const wordPattern = new RegExp(`\\b${legacyPassWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (wordPattern.test(output)) return true;
  logWarn(`No VERDICT found in agent output and no "${legacyPassWord}" keyword — treating as FAIL`);
  return false;
}

module.exports = { parseVerdict };
