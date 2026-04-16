"use strict";
/**
 * env-parser.ts -- Robust .env file parser for MI Dev Agent
 *
 * Converted from lib/env-parser.js (zero functional changes).
 *
 * Fixes all known bugs:
 *   #5: Strips surrounding quotes (single and double)
 *   #6: Strips inline comments (respects quoted values)
 *   #7: Supports multiline values (backslash continuation + heredoc-style)
 *   - Handles Windows \r\n line endings
 *   - Skips empty lines and comments
 *   - Warns on duplicate keys
 *   - Does NOT override existing process.env unless told to
 */
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
exports.parseEnvContent = parseEnvContent;
exports.loadEnvFile = loadEnvFile;
exports.loadAndApplyEnv = loadAndApplyEnv;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Parse .env file content into a key-value object.
 */
function parseEnvContent(content, options = {}) {
    const { onWarning = () => { }, allowDuplicates = false } = options;
    const result = {};
    const seenKeys = new Map(); // key -> line number (for duplicate detection)
    // Normalize Windows line endings
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    let i = 0;
    while (i < lines.length) {
        const lineNum = i + 1;
        const line = lines[i];
        // Skip empty lines and full-line comments
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) {
            i++;
            continue;
        }
        // Skip export prefix: `export KEY=value`
        let workLine = line;
        if (/^\s*export\s+/.test(workLine)) {
            workLine = workLine.replace(/^\s*export\s+/, "");
        }
        // Match KEY=VALUE pattern -- key must start with letter or underscore
        const keyMatch = workLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)/);
        if (!keyMatch) {
            // Not a valid line -- could be continuation of previous or just garbage
            if (trimmed.length > 0) {
                onWarning(`Line ${lineNum}: Unrecognized format, skipping: "${trimmed.substring(0, 60)}"`);
            }
            i++;
            continue;
        }
        const key = keyMatch[1];
        const rawValue = keyMatch[2];
        // ── Handle quoted values ─────────────────────────────────────
        let value;
        if (rawValue.startsWith('"')) {
            // Double-quoted value -- may span multiple lines
            const parsed = parseDoubleQuoted(rawValue, lines, i, onWarning);
            value = parsed.value;
            i = parsed.nextLine;
        }
        else if (rawValue.startsWith("'")) {
            // Single-quoted value -- literal, no escape processing
            const parsed = parseSingleQuoted(rawValue, lines, i, onWarning);
            value = parsed.value;
            i = parsed.nextLine;
        }
        else {
            // Unquoted value -- handle inline comments and backslash continuation
            const parsed = parseUnquoted(rawValue, lines, i);
            value = parsed.value;
            i = parsed.nextLine;
        }
        // ── Duplicate detection ──────────────────────────────────────
        if (seenKeys.has(key)) {
            if (!allowDuplicates) {
                onWarning(`Line ${lineNum}: Duplicate key "${key}" (first seen at line ${seenKeys.get(key)}). Using latest value.`);
            }
        }
        seenKeys.set(key, lineNum);
        result[key] = value;
    }
    return result;
}
/**
 * Parse a double-quoted value, handling:
 *   - Escaped characters: \n, \t, \\, \"
 *   - Multi-line strings (value continues until closing ")
 */
function parseDoubleQuoted(rawValue, lines, lineIndex, onWarning) {
    // Remove opening quote
    let content = rawValue.substring(1);
    let result = "";
    let currentLine = lineIndex;
    while (true) {
        let j = 0;
        while (j < content.length) {
            const ch = content[j];
            if (ch === "\\") {
                // Escape sequence
                if (j + 1 < content.length) {
                    const next = content[j + 1];
                    switch (next) {
                        case "n":
                            result += "\n";
                            break;
                        case "t":
                            result += "\t";
                            break;
                        case "r":
                            result += "\r";
                            break;
                        case "\\":
                            result += "\\";
                            break;
                        case '"':
                            result += '"';
                            break;
                        case "$":
                            result += "$";
                            break;
                        default:
                            result += "\\" + next;
                            break;
                    }
                    j += 2;
                }
                else {
                    // Backslash at end of line within quotes -- line continuation
                    result += "\n";
                    j++;
                }
                continue;
            }
            if (ch === '"') {
                // Closing quote found -- any text after is treated as comment
                return { value: result, nextLine: currentLine + 1 };
            }
            result += ch;
            j++;
        }
        // No closing quote on this line -- continue to next line
        currentLine++;
        if (currentLine >= lines.length) {
            onWarning(`Unterminated double-quoted string starting at line ${lineIndex + 1}`);
            return { value: result, nextLine: currentLine };
        }
        result += "\n";
        content = lines[currentLine];
    }
}
/**
 * Parse a single-quoted value.
 * Single quotes are literal -- no escape processing.
 * Multi-line support (continues until closing ').
 */
function parseSingleQuoted(rawValue, lines, lineIndex, onWarning) {
    let content = rawValue.substring(1);
    let result = "";
    let currentLine = lineIndex;
    while (true) {
        const closeIdx = content.indexOf("'");
        if (closeIdx !== -1) {
            result += content.substring(0, closeIdx);
            return { value: result, nextLine: currentLine + 1 };
        }
        result += content;
        currentLine++;
        if (currentLine >= lines.length) {
            onWarning(`Unterminated single-quoted string starting at line ${lineIndex + 1}`);
            return { value: result, nextLine: currentLine };
        }
        result += "\n";
        content = lines[currentLine];
    }
}
/**
 * Parse an unquoted value:
 *   - Strip inline comments (# preceded by whitespace)
 *   - Handle backslash line continuation
 *   - Trim whitespace
 */
function parseUnquoted(rawValue, lines, lineIndex) {
    let value = rawValue;
    let currentLine = lineIndex;
    // Handle backslash continuation
    while (value.endsWith("\\")) {
        value = value.slice(0, -1); // Remove trailing backslash
        currentLine++;
        if (currentLine >= lines.length)
            break;
        value += lines[currentLine].trim();
    }
    // Strip inline comments: look for # preceded by whitespace
    // But be careful not to strip # inside the value if it's at the start
    const commentMatch = value.match(/\s+#(?:\s|$)/);
    if (commentMatch && commentMatch.index !== undefined) {
        value = value.substring(0, commentMatch.index);
    }
    return { value: value.trim(), nextLine: currentLine + 1 };
}
/**
 * Load and parse a .env file from disk.
 *
 * @param envPath - Path to .env file (defaults to project root .env)
 * @param options - Load options
 * @returns Parsed key-value pairs (not yet applied to process.env)
 */
function loadEnvFile(envPath, options = {}) {
    const { onWarning = () => { } } = options;
    if (!envPath) {
        envPath = path.join(__dirname, "..", "..", "..", "..", ".env");
    }
    try {
        if (!fs.existsSync(envPath))
            return {};
        const content = fs.readFileSync(envPath, "utf8");
        const parsed = parseEnvContent(content, { onWarning });
        return parsed;
    }
    catch (e) {
        onWarning(`.env load failed: ${e.message}`);
        return {};
    }
}
/**
 * Load .env file and apply to process.env.
 * Respects existing values (won't override unless override=true).
 *
 * @param envPath - Path to .env file
 * @param options - Load options
 * @returns The parsed key-value pairs
 */
function loadAndApplyEnv(envPath, options = {}) {
    const { override = false, onWarning = () => { } } = options;
    const parsed = loadEnvFile(envPath, { onWarning });
    for (const [key, value] of Object.entries(parsed)) {
        if (override || !process.env[key]) {
            process.env[key] = value;
        }
    }
    return parsed;
}
//# sourceMappingURL=env-parser.js.map