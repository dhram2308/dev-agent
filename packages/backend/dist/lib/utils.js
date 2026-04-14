"use strict";
// ===================================================================
// MI Dev Agent -- Backend Utilities (TypeScript port of lib/utils.js)
//
// All utility functions with strict TypeScript types.
// Mirrors the exact behavior of the original JavaScript module.
// ===================================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleep = sleep;
exports.sanitizeForPrompt = sanitizeForPrompt;
exports.isBinaryFile = isBinaryFile;
exports.isBinaryContent = isBinaryContent;
exports.validateClaudeOutput = validateClaudeOutput;
exports.detectClaudeRefusal = detectClaudeRefusal;
exports.setEnhancedRefusalDetector = setEnhancedRefusalDetector;
exports.validateClaudeNotEmpty = validateClaudeNotEmpty;
exports.sanitizeMRText = sanitizeMRText;
exports.validatePromptSize = validatePromptSize;
exports.addWarning = addWarning;
exports.truncateWithIndicator = truncateWithIndicator;
exports.matchApprovalWord = matchApprovalWord;
exports.extractJson = extractJson;
const path = __importStar(require("path"));
const constants_1 = require("@shared/constants");
const logger_1 = require("./logger");
// -- sleep --------------------------------------------------------
/** Returns a Promise that resolves after the given number of milliseconds. */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// -- D1: Prompt injection defense ---------------------------------
/**
 * Wraps user-supplied text in `<user_content>` tags and strips any
 * XML-like tags that could hijack the Claude system/assistant/human roles.
 */
function sanitizeForPrompt(text) {
    if (!text)
        return '';
    return '<user_content>' +
        String(text).replace(/<\/?(?:system|assistant|human|user_content)>/gi, '') +
        '</user_content>';
}
// -- L1: Binary content detection ---------------------------------
/** Returns true if the file extension indicates a binary format (image, font, archive, etc.). */
function isBinaryFile(filePath) {
    const ext = path.extname(filePath || '').toLowerCase();
    return constants_1.BINARY_EXTENSIONS.has(ext);
}
/**
 * Returns true if the content string appears to contain binary data.
 * Checks the first 512 characters for null bytes.
 */
function isBinaryContent(content) {
    if (!content || typeof content !== 'string')
        return false;
    const sample = content.substring(0, 512);
    return sample.includes('\0');
}
// -- H15: Validate Claude agent output ----------------------------
/**
 * Throws if Claude's output is empty or shorter than `minChars`.
 * This catches cases where the prompt was too large or Claude hit a safety filter.
 *
 * @param output - Raw Claude output string
 * @param agentName - Name of the calling agent (for error messages)
 * @param minChars - Minimum acceptable character count (default 50)
 */
function validateClaudeOutput(output, agentName, minChars = 50) {
    if (!output || typeof output !== 'string' || output.trim().length < minChars) {
        throw new Error(`${agentName} returned empty or too-short output (${(output || '').length} chars, minimum ${minChars}). ` +
            `This usually means the prompt was too large or Claude hit a safety filter.`);
    }
}
// -- W8: Claude safety refusal detection --------------------------
/**
 * Checks the first 500 chars of Claude's output against known refusal patterns.
 * Throws if a refusal is detected.
 *
 * Uses basic pattern matching (the enhanced confidence-scoring detector
 * can be injected via `setEnhancedRefusalDetector` for the full 30+ pattern set).
 *
 * @param output - Raw Claude output string
 * @param agentName - Name of the calling agent (for error messages)
 */
function detectClaudeRefusal(output, agentName) {
    if (!output)
        return;
    // Use enhanced detector if available
    if (_enhancedRefusalDetector) {
        _enhancedRefusalDetector(output, agentName);
        return;
    }
    // Fallback: basic pattern matching
    const first500 = output.substring(0, 500);
    for (const pattern of constants_1.REFUSAL_PATTERNS) {
        if (pattern.test(first500)) {
            throw new Error(`${agentName} appears to have refused the request: "${first500.substring(0, 200)}...". ` +
                `Review the prompt for policy violations or overly sensitive content.`);
        }
    }
}
let _enhancedRefusalDetector = null;
/**
 * Register an enhanced refusal detector (from refusal-detection module).
 * When set, `detectClaudeRefusal` delegates to it instead of basic patterns.
 */
function setEnhancedRefusalDetector(fn) {
    if (typeof fn === 'function')
        _enhancedRefusalDetector = fn;
}
// -- W7: Claude empty output detection ----------------------------
/**
 * Throws if Claude's output is empty or contains fewer than 20 characters.
 * Catches silent CLI failures.
 *
 * @param output - Raw Claude output string
 * @param agentName - Name of the calling agent (for error messages)
 */
function validateClaudeNotEmpty(output, agentName) {
    if (!output || typeof output !== 'string' || output.trim().length < 20) {
        throw new Error(`${agentName} returned empty or minimal output (${(output || '').length} chars). ` +
            `Claude CLI may have failed silently.`);
    }
}
// -- M4: MR description sanitization -----------------------------
/** Escapes backticks and dollar signs for safe use in MR descriptions / shell contexts. */
function sanitizeMRText(text) {
    if (!text)
        return '';
    return String(text)
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
}
// -- P1: Prompt size validation -----------------------------------
/**
 * Validates and progressively truncates a Claude prompt if it exceeds
 * the token limit (estimated at ~4 chars per token).
 *
 * Truncation levels (applied in order until under limit):
 *   1. URL content blocks to 10KB each
 *   2. Jira comments to newest 50
 *   3. Linked issues to 10
 *   4. File contexts to 4000 chars each
 *   5. Hard truncation as last resort
 *
 * @param prompt - The prompt string to validate
 * @param agentName - Agent name for warning messages
 * @param maxPromptTokens - Override the token limit (defaults to MAX_PROMPT_TOKENS_DEFAULT)
 * @returns The (possibly truncated) prompt string
 */
function validatePromptSize(prompt, agentName, maxPromptTokens = constants_1.MAX_PROMPT_TOKENS_DEFAULT) {
    if (typeof prompt !== 'string')
        return prompt;
    const estimatedTokens = Math.ceil(prompt.length / 4);
    if (estimatedTokens <= maxPromptTokens)
        return prompt;
    (0, logger_1.logWarn)(`${agentName || 'Claude'}: prompt ~${estimatedTokens} tokens exceeds limit ${maxPromptTokens} -- truncating progressively`);
    let result = prompt;
    // Level 1: Truncate fetched URL content blocks to 10KB each
    result = result.replace(/(### https?:\/\/[^\n]*\n```\n)([\s\S]*?)(```)/g, (_match, prefix, content, suffix) => {
        if (content.length > 10_000) {
            return prefix + content.substring(0, 10_000) + '\n[...truncated to 10KB...]\n' + suffix;
        }
        return _match;
    });
    if (Math.ceil(result.length / 4) <= maxPromptTokens)
        return result;
    // Level 2: Truncate comments to newest 50
    // T2.14: Guard against indexOf returning -1 which would destroy the prompt
    const jiraCommentsIdx = result.indexOf('## Jira Comments');
    if (jiraCommentsIdx !== -1) {
        const commentHeaderRe = /### \[.+?\] \(\d{4}-\d{2}-\d{2}\):\n/g;
        const commentMatches = [...result.matchAll(commentHeaderRe)];
        if (commentMatches.length > 50) {
            const cutMatch = commentMatches[commentMatches.length - 50];
            if (cutMatch.index !== undefined) {
                const cutAt = cutMatch.index;
                const before = result.substring(0, jiraCommentsIdx);
                const commentsSection = result.substring(jiraCommentsIdx);
                const headerEnd = commentsSection.indexOf('\n') + 1;
                const keptComments = commentsSection.substring(0, headerEnd) +
                    `[...${commentMatches.length - 50} older comments omitted...]\n\n` +
                    result.substring(cutAt);
                result = before + keptComments;
            }
        }
    }
    if (Math.ceil(result.length / 4) <= maxPromptTokens)
        return result;
    // Level 3: Truncate linked issues to 10
    result = result.replace(/(## Linked Issues\n)([\s\S]*?)(\n## )/g, (_match, header, content, next) => {
        const issues = content.split(/(?=### [A-Z]+-\d+)/);
        if (issues.length > 10) {
            return header + issues.slice(0, 10).join('') +
                `\n[...${issues.length - 10} linked issues omitted...]\n\n` + next;
        }
        return _match;
    });
    if (Math.ceil(result.length / 4) <= maxPromptTokens)
        return result;
    // Level 4: Truncate file contexts to 4000 chars each
    result = result.replace(/(── .+? ──\n)([\s\S]*?)(\n\n)/g, (_match, header, content, end) => {
        if (content.length > 4000) {
            return header + content.substring(0, 4000) + '\n[...truncated to 4000 chars...]\n' + end;
        }
        return _match;
    });
    if (Math.ceil(result.length / 4) <= maxPromptTokens)
        return result;
    // Level 5: Hard truncation as last resort
    const maxChars = maxPromptTokens * 4;
    (0, logger_1.logWarn)(`${agentName || 'Claude'}: hard-truncating prompt from ${result.length} to ${maxChars} chars`);
    result = result.substring(0, maxChars) + '\n\n[...PROMPT TRUNCATED -- exceeded token limit...]';
    return result;
}
// -- P12: Warning accumulator -------------------------------------
/**
 * Appends a warning to the pipeline state's `_warnings` array.
 * Caps at 200 entries (drops oldest).
 */
function addWarning(state, stage, message) {
    if (!state || !state.data)
        return;
    if (!state.data._warnings)
        state.data._warnings = [];
    const warnings = state.data._warnings;
    warnings.push({ stage, message, timestamp: new Date().toISOString() });
    if (warnings.length > 200) {
        state.data._warnings = warnings.slice(-200);
    }
}
// -- M3: Truncation with indicators -------------------------------
/**
 * Truncates content to `maxLen` characters with a human-readable indicator
 * showing both the truncation point and the original length.
 */
function truncateWithIndicator(content, maxLen) {
    if (!content || content.length <= maxLen)
        return content;
    return content.substring(0, maxLen) +
        `\n[...truncated at ${maxLen} chars, full is ${content.length} chars...]`;
}
// -- Word-boundary matching for approval keywords -----------------
/**
 * Checks if `word` appears as a whole word in `text`, excluding any
 * matches that also match one of the `negatives` patterns.
 * Used for detecting approval/rejection keywords in comments.
 */
function matchApprovalWord(text, word, negatives = []) {
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (!regex.test(text))
        return false;
    return !negatives.some((neg) => new RegExp(neg, 'i').test(text));
}
// -- D13: Extract & validate JSON from Claude output --------------
/**
 * Extracts a JSON object from Claude's text output.
 *
 * Tries in order:
 *   1. Parse the entire string as JSON
 *   2. Extract from markdown ```json``` fences
 *   3. Brace-matching with string-literal awareness
 *   4. First `{` to last `}` fallback
 *   5. Repair truncated JSON (close missing brackets/braces)
 *
 * @throws Error if no valid JSON object can be found
 */
function extractJson(text) {
    // 1. Try JSON.parse(text) first (whole string is valid JSON)
    try {
        const result = JSON.parse(text);
        if (result && typeof result === 'object')
            return result;
    }
    catch { /* fall through */ }
    // 2. Try markdown-fenced JSON blocks
    const m = text.match(/```json\s*([\s\S]*?)```/);
    if (m) {
        try {
            const result = JSON.parse(m[1]);
            if (result && typeof result === 'object')
                return result;
        }
        catch { /* fall through */ }
    }
    // 3. Brace matching with string-literal awareness
    const start = text.indexOf('{');
    if (start !== -1) {
        let depth = 0;
        let inString = false;
        let escape = false;
        let end = -1;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (escape) {
                escape = false;
                continue;
            }
            if (ch === '\\') {
                escape = true;
                continue;
            }
            if (ch === '"') {
                inString = !inString;
                continue;
            }
            if (inString)
                continue;
            if (ch === '{' || ch === '[')
                depth++;
            else if (ch === '}' || ch === ']') {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        if (end > start) {
            try {
                const result = JSON.parse(text.substring(start, end + 1));
                if (result && typeof result === 'object')
                    return result;
            }
            catch { /* fall through */ }
        }
        // Fallback: first { to last }
        const lastBrace = text.lastIndexOf('}');
        if (lastBrace > start) {
            try {
                const result = JSON.parse(text.substring(start, lastBrace + 1));
                if (result && typeof result === 'object')
                    return result;
            }
            catch { /* fall through */ }
        }
    }
    // 4. Try to repair truncated JSON
    const start2 = text.indexOf('{');
    if (start2 !== -1) {
        let candidate = text.substring(start2);
        // Strip trailing incomplete key-value pair
        candidate = candidate.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, '');
        const openBraces = (candidate.match(/{/g) || []).length;
        const closeBraces = (candidate.match(/}/g) || []).length;
        const openBrackets = (candidate.match(/\[/g) || []).length;
        const closeBrackets = (candidate.match(/]/g) || []).length;
        const bracketGap = Math.max(0, openBrackets - closeBrackets);
        const braceGap = Math.max(0, openBraces - closeBraces);
        candidate += ']'.repeat(bracketGap);
        candidate += '}'.repeat(braceGap);
        try {
            const result = JSON.parse(candidate);
            if (result && typeof result === 'object') {
                const closingCount = bracketGap + braceGap;
                if (closingCount > 0) {
                    (0, logger_1.logWarn)(`extractJson: repaired truncated JSON (closed ${closingCount} bracket(s)) -- result may be incomplete`);
                }
                return result;
            }
        }
        catch { /* fall through */ }
    }
    throw new Error('No JSON found in response');
}
//# sourceMappingURL=utils.js.map