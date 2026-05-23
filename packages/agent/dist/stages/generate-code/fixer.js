"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseVerdict = parseVerdict;
const { logWarn } = require("../../lib/logging");
/**
 * F1: Parse VERDICT from structured agent output (fallback to legacy keyword check).
 * Shared by both local and legacy code paths.
 */
function parseVerdict(output, legacyPassWord) {
    // H7: Anchor `(PASS|FAIL)` with a word boundary so tokens like
    // `PASS_WITH_CONCERNS` are NOT read as PASS. When multiple VERDICT lines
    // appear (e.g. the agent walks through reasoning before concluding),
    // prefer the LAST one as the authoritative verdict.
    const verdictMatches = [...output.matchAll(/VERDICT:\s*(PASS|FAIL)\b/gi)];
    if (verdictMatches.length > 0) {
        const last = verdictMatches[verdictMatches.length - 1];
        return last[1].toUpperCase() === "PASS";
    }
    // T2.7: Check for negation before legacy word match to prevent "not secure" → PASS
    const negationPattern = new RegExp(`\\b(not|no|isn't|isn\\'t|un|in)\\s*${legacyPassWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (negationPattern.test(output)) {
        logWarn(`Legacy word "${legacyPassWord}" found but negated — treating as FAIL`);
        return false;
    }
    const wordPattern = new RegExp(`\\b${legacyPassWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (wordPattern.test(output))
        return true;
    logWarn(`No VERDICT found in agent output and no "${legacyPassWord}" keyword — treating as FAIL`);
    return false;
}
//# sourceMappingURL=fixer.js.map