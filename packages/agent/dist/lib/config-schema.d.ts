/**
 * config-schema.ts -- Type-safe config schema for MI Dev Agent
 *
 * Converted from lib/config-schema.js (zero functional changes).
 *
 * Every config variable is defined here with:
 *   - env: environment variable name
 *   - type: string | int | bool | enum | url | path | port | float | giturl
 *   - default: default value (undefined = required)
 *   - required: whether the variable MUST be set
 *   - sensitive: whether the value should be redacted in logs
 *   - group: logical grouping (jira, gitlab, slack, qa, timeouts, etc.)
 *   - description: human-readable description
 *   - hotReload: whether safe to change at runtime without restart
 *   - riskLevel: SAFE | CAUTION | DANGEROUS -- for mid-pipeline change risk
 *   - validator: optional custom validator fn(value) => string|null (null = ok, string = error)
 *   - allowed: for enum types, the list of valid values
 *   - min/max: for int/port types, numeric bounds
 */
export type ConfigSchemaType = "string" | "int" | "float" | "bool" | "enum" | "url" | "giturl" | "port" | "path";
export type RiskLevel = "SAFE" | "CAUTION" | "DANGEROUS";
export interface ConfigSchemaEntry {
    env: string;
    type: ConfigSchemaType;
    default?: any;
    required?: boolean;
    sensitive?: boolean;
    group: string;
    description: string;
    hotReload: boolean;
    riskLevel: RiskLevel;
    validator?: (value: any) => string | null;
    allowed?: string[];
    min?: number;
    max?: number;
}
export interface ParseResult<T = any> {
    value: T;
    error: string | null;
}
export interface RequiredVarEntry extends ConfigSchemaEntry {
    key: string;
}
export interface SensitiveVarEntry {
    key: string;
    env: string;
}
export interface HotReloadableVarEntry extends ConfigSchemaEntry {
    key: string;
}
/**
 * Parse boolean from env var value.
 * Accepts: true/false, 1/0, yes/no, on/off (case-insensitive).
 * Fixes bug #3: "1", "yes", "TRUE" all work correctly now.
 * Returns null for unrecognizable values (caller decides default).
 */
export declare function parseBoolean(val: unknown): boolean | null;
/**
 * Parse integer safely from env var value.
 * Fixes bug #2: parseInt("0") || default was treating 0 as falsy.
 * Returns the default ONLY when the value is genuinely missing/invalid.
 */
export declare function parseIntSafe(val: unknown, defaultVal: number): number;
/**
 * Parse float safely from env var value.
 */
export declare function parseFloatSafe(val: unknown, defaultVal: number): number;
/**
 * Parse and validate enum value.
 * Fixes bug #4: LOG_LEVEL=verbose was silently accepted.
 * Returns { value, error } so caller can report the violation.
 */
export declare function parseEnum(val: unknown, allowed: string[], defaultVal: string | undefined): ParseResult<string | undefined>;
/**
 * Parse and validate URL.
 * Checks protocol, basic structure. Does not make HTTP requests.
 */
export declare function parseUrl(val: unknown): ParseResult<string | null>;
/**
 * Parse and validate a git clone URL.
 * Accepts git@host:path or https://host/path formats.
 */
export declare function parseGitUrl(val: unknown): ParseResult<string | null>;
/**
 * Parse and validate port number.
 * Fixes bug #10: validates range, ensures START <= END for ranges.
 */
export declare function parsePort(val: unknown, defaultVal: number): ParseResult<number>;
/**
 * Parse a value according to its schema type.
 * Returns { value, error } for all types.
 */
export declare function parseByType(rawVal: unknown, schema: ConfigSchemaEntry): ParseResult;
export declare const CONFIG_SCHEMA: Record<string, ConfigSchemaEntry>;
/** Get all schema entries for a given group */
export declare function getSchemaByGroup(group: string): Record<string, ConfigSchemaEntry>;
/** Get all group names */
export declare function getGroups(): string[];
/** Get all required config vars */
export declare function getRequiredVars(): RequiredVarEntry[];
/** Get all sensitive config vars (for redaction) */
export declare function getSensitiveVars(): SensitiveVarEntry[];
/** Get all hot-reloadable vars */
export declare function getHotReloadableVars(): HotReloadableVarEntry[];
//# sourceMappingURL=config-schema.d.ts.map