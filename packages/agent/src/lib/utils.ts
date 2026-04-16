/**
 * utils.ts -- Utility functions for MI Dev Agent
 *
 * Converted from lib/utils.js (zero functional changes).
 */

import path from "path";
import { BINARY_EXTENSIONS, REFUSAL_PATTERNS } from "./constants";

// TODO: tighten type — these come from unconverted modules
const configModule = require("./config") as { MAX_PROMPT_TOKENS: number };
const loggingModule = require("./logging") as { logWarn: (msg: string) => void };
const redactionModule = require("./redaction") as { redactAll: (text: string) => string };

const { MAX_PROMPT_TOKENS } = configModule;
const { logWarn } = loggingModule;
const { redactAll } = redactionModule;

// ── Credential redaction (delegates to comprehensive redaction engine) ──

export function redactSecrets(text: string): string {
  return redactAll(text);
}

// ── D1: Prompt injection defense ──────────────────────────────────

export function sanitizeForPrompt(text: string | null | undefined): string {
  if (!text) return "";
  return "<user_content>" + String(text).replace(/<\/?(?:system|assistant|human|user_content)>/gi, "") + "</user_content>";
}

// ── L1: Binary content detection ──────────────────────────────────

export function isBinaryFile(filename: string | null | undefined): boolean {
  const ext = path.extname(filename || "").toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export function isBinaryContent(str: string | null | undefined): boolean {
  if (!str || typeof str !== "string") return false;
  const sample = str.substring(0, 512);
  return sample.includes("\0");
}

// ── H15: Validate Claude agent output ─────────────────────────────

export function validateClaudeOutput(output: string | null | undefined, agentName: string, minChars: number = 50): void {
  if (!output || typeof output !== "string" || output.trim().length < minChars) {
    throw new Error(`${agentName} returned empty or too-short output (${(output || "").length} chars, minimum ${minChars}). This usually means the prompt was too large or Claude hit a safety filter.`);
  }
}

// ── W8: Claude safety refusal detection (enhanced with confidence scoring) ──
// Delegates to lib/refusal-detection.js when available for 30+ patterns + confidence scoring.
// Falls back to basic REFUSAL_PATTERNS if the enhanced module is not present.

// TODO: tighten type — refusal-detection module is not yet converted
let _enhancedRefusalDetector: ((output: string, agentName: string) => void) | null = null;
try {
  _enhancedRefusalDetector = (require("./refusal-detection") as any).detectClaudeRefusalEnhanced;
} catch { /* enhanced module not available -- use basic patterns */ }

export function detectClaudeRefusal(output: string | null | undefined, agentName: string): void {
  if (!output) return;

  // Use enhanced detector if available (confidence scoring, 30+ patterns, false positive filtering)
  if (_enhancedRefusalDetector) {
    return _enhancedRefusalDetector(output, agentName);
  }

  // Fallback: basic pattern matching
  const first500 = output.substring(0, 500);
  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(first500)) {
      throw new Error(`${agentName} appears to have refused the request: "${first500.substring(0, 200)}...". Review the prompt for policy violations or overly sensitive content.`);
    }
  }
}

// ── W7: Claude empty output detection ─────────────────────────────

export function validateClaudeNotEmpty(output: string | null | undefined, agentName: string): void {
  if (!output || typeof output !== "string" || output.trim().length < 20) {
    throw new Error(`${agentName} returned empty or minimal output (${(output || "").length} chars). Claude CLI may have failed silently.`);
  }
}

// ── M4: MR description sanitization ──────────────────────────────

export function sanitizeMRText(text: string | null | undefined): string {
  if (!text) return "";
  return String(text)
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

// ── P1: Prompt size validation ────────────────────────────────────

export function validatePromptSize(prompt: string | unknown, agentName?: string): string | unknown {
  if (typeof prompt !== "string") return prompt;
  const estimatedTokens = Math.ceil(prompt.length / 4);
  if (estimatedTokens <= MAX_PROMPT_TOKENS) return prompt;

  logWarn(`${agentName || "Claude"}: prompt ~${estimatedTokens} tokens exceeds limit ${MAX_PROMPT_TOKENS} — truncating progressively`);

  let result = prompt;

  // Level 1: Truncate fetched URL content blocks to 10KB each
  result = result.replace(/(### https?:\/\/[^\n]*\n```\n)([\s\S]*?)(```)/g, (match: string, prefix: string, content: string, suffix: string) => {
    if (content.length > 10_000) {
      return prefix + content.substring(0, 10_000) + "\n[...truncated to 10KB...]\n" + suffix;
    }
    return match;
  });
  if (Math.ceil(result.length / 4) <= MAX_PROMPT_TOKENS) return result;

  // Level 1.5: Truncate connector document blocks to 8KB each
  const connectorIdx = result.indexOf("## Connector Documents");
  if (connectorIdx !== -1) {
    const connectorEnd = result.indexOf("\n## ", connectorIdx + 22);
    const endPos = connectorEnd !== -1 ? connectorEnd : result.length;
    const section = result.substring(connectorIdx, endPos);
    const truncatedSection = section.replace(/(### [^\n]+\n)([\s\S]*?)(?=### |\n## |$)/g, (match: string, header: string, content: string) => {
      if (content.length > 8000) {
        return header + content.substring(0, 8000) + "\n[...connector content truncated to 8KB...]\n\n";
      }
      return match;
    });
    result = result.substring(0, connectorIdx) + truncatedSection + result.substring(endPos);
  }
  if (Math.ceil(result.length / 4) <= MAX_PROMPT_TOKENS) return result;

  // Level 2: Truncate comments to newest 50
  // T2.14: Guard against indexOf returning -1 which would destroy the prompt
  const jiraCommentsIdx = result.indexOf("## Jira Comments");
  if (jiraCommentsIdx !== -1) {
    const commentHeaderRe = /### \[.+?\] \(\d{4}-\d{2}-\d{2}\):\n/g;
    const commentMatches = [...result.matchAll(commentHeaderRe)];
    if (commentMatches.length > 50) {
      const cutAt = commentMatches[commentMatches.length - 50].index!;
      const before = result.substring(0, jiraCommentsIdx);
      const commentsSection = result.substring(jiraCommentsIdx);
      const headerEnd = commentsSection.indexOf("\n") + 1;
      const keptComments = commentsSection.substring(0, headerEnd) +
        `[...${commentMatches.length - 50} older comments omitted...]\n\n` +
        result.substring(cutAt);
      result = before + keptComments;
    }
  }
  if (Math.ceil(result.length / 4) <= MAX_PROMPT_TOKENS) return result;

  // Level 3: Truncate linked issues to 10
  result = result.replace(/(## Linked Issues\n)([\s\S]*?)(\n## )/g, (match: string, header: string, content: string, next: string) => {
    const issues = content.split(/(?=### [A-Z]+-\d+)/);
    if (issues.length > 10) {
      return header + issues.slice(0, 10).join("") + `\n[...${issues.length - 10} linked issues omitted...]\n\n` + next;
    }
    return match;
  });
  if (Math.ceil(result.length / 4) <= MAX_PROMPT_TOKENS) return result;

  // Level 4: Truncate file contexts to 4000 chars each
  result = result.replace(/(── .+? ──\n)([\s\S]*?)(\n\n)/g, (match: string, header: string, content: string, end: string) => {
    if (content.length > 4000) {
      return header + content.substring(0, 4000) + "\n[...truncated to 4000 chars...]\n" + end;
    }
    return match;
  });
  if (Math.ceil(result.length / 4) <= MAX_PROMPT_TOKENS) return result;

  // Level 5: Hard truncation as last resort
  const maxChars = MAX_PROMPT_TOKENS * 4;
  logWarn(`${agentName || "Claude"}: hard-truncating prompt from ${result.length} to ${maxChars} chars`);
  result = result.substring(0, maxChars) + "\n\n[...PROMPT TRUNCATED — exceeded token limit...]";
  return result;
}

// ── P12: Warning accumulator ──────────────────────────────────────

interface WarningEntry {
  stage: string;
  message: string;
  timestamp: string;
}

interface StateWithWarnings {
  data?: {
    _warnings?: WarningEntry[];
    [key: string]: any; // TODO: tighten type
  };
  [key: string]: any; // TODO: tighten type
}

export function addWarning(state: StateWithWarnings | null | undefined, stage: string, message: string): void {
  if (!state || !state.data) return;
  if (!state.data._warnings) state.data._warnings = [];
  state.data._warnings.push({ stage, message, timestamp: new Date().toISOString() });
  if (state.data._warnings.length > 200) {
    state.data._warnings = state.data._warnings.slice(-200);
  }
}

// ── M3: Truncation with indicators ────────────────────────────────

export function truncateWithIndicator(content: string | null | undefined, maxLen: number): string | null | undefined {
  if (!content || content.length <= maxLen) return content;
  return content.substring(0, maxLen) + `\n[...truncated at ${maxLen} chars, full is ${content.length} chars...]`;
}

// ── Word-boundary matching for approval keywords ──────────────────

export function matchApprovalWord(text: string, word: string, negatives: string[] = []): boolean {
  const regex = new RegExp(`\\b${word}\\b`, "i");
  if (!regex.test(text)) return false;
  return !negatives.some((neg) => new RegExp(neg, "i").test(text));
}

// ── D13: Extract & validate JSON from Claude output ───────────────

export function extractJson(text: string): Record<string, any> {
  // 1. Try JSON.parse(text) first (whole string is valid JSON)
  try {
    const result = JSON.parse(text);
    if (result && typeof result === "object") return result;
  } catch { /* fall through */ }

  // 2. Try markdown-fenced JSON blocks
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (m) {
    try {
      const result = JSON.parse(m[1]);
      if (result && typeof result === "object") return result;
    } catch { /* fall through */ }
  }

  // 3. Brace matching with string-literal awareness
  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > start) {
      try {
        const result = JSON.parse(text.substring(start, end + 1));
        if (result && typeof result === "object") return result;
      } catch { /* fall through */ }
    }

    // Fallback: first { to last }
    const lastBrace = text.lastIndexOf("}");
    if (lastBrace > start) {
      try {
        const result = JSON.parse(text.substring(start, lastBrace + 1));
        if (result && typeof result === "object") return result;
      } catch { /* fall through */ }
    }
  }

  // 4. Try to repair truncated JSON
  const start2 = text.indexOf("{");
  if (start2 !== -1) {
    let candidate = text.substring(start2);
    candidate = candidate.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, "");
    const openBraces = (candidate.match(/{/g) || []).length;
    const closeBraces = (candidate.match(/}/g) || []).length;
    const openBrackets = (candidate.match(/\[/g) || []).length;
    const closeBrackets = (candidate.match(/]/g) || []).length;
    const bracketGap = Math.max(0, openBrackets - closeBrackets);
    const braceGap = Math.max(0, openBraces - closeBraces);
    candidate += "]".repeat(bracketGap);
    candidate += "}".repeat(braceGap);
    try {
      const result = JSON.parse(candidate);
      if (result && typeof result === "object") {
        const closingCount = bracketGap + braceGap;
        if (closingCount > 0) logWarn(`extractJson: repaired truncated JSON (closed ${closingCount} bracket(s)) — result may be incomplete`);
        return result;
      }
    } catch { /* fall through */ }
  }

  throw new Error("No JSON found in response");
}
