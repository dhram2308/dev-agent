"use strict";
// =====================================================================
// MI Dev Agent -- Fixer Agent Utilities (TypeScript port)
// =====================================================================
// Shared utility for parsing VERDICT from structured agent output.
// Used by both local and legacy code paths.
//
// Ported from: stages/generate-code/fixer.js
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseVerdict = parseVerdict;
const logger_1 = require("../lib/logger");
/**
 * Parse VERDICT from structured agent output (fallback to legacy keyword check).
 *
 * Checks for structured "VERDICT: PASS|FAIL" first, then falls back to
 * legacy keyword matching with negation detection.
 *
 * @param output - Agent output text
 * @param legacyPassWord - Legacy keyword to check if no VERDICT found (e.g., "lgtm", "secure")
 * @returns true if passed
 */
function parseVerdict(output, legacyPassWord) {
    const verdictMatch = output.match(/VERDICT:\s*(PASS|FAIL)/i);
    if (verdictMatch)
        return verdictMatch[1].toUpperCase() === 'PASS';
    // T2.7: Check for negation before legacy word match to prevent "not secure" -> PASS
    const escapedWord = legacyPassWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const negationPattern = new RegExp(`\\b(not|no|isn't|isn\\'t|un|in)\\s*${escapedWord}\\b`, 'i');
    if (negationPattern.test(output)) {
        (0, logger_1.logWarn)(`Legacy word "${legacyPassWord}" found but negated -- treating as FAIL`);
        return false;
    }
    const wordPattern = new RegExp(`\\b${escapedWord}\\b`, 'i');
    if (wordPattern.test(output))
        return true;
    (0, logger_1.logWarn)(`No VERDICT found in agent output and no "${legacyPassWord}" keyword -- treating as FAIL`);
    return false;
}
//# sourceMappingURL=fixer.js.map