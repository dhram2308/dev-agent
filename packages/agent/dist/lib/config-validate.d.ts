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
declare const Severity: {
    FATAL: "FATAL";
    ERROR: "ERROR";
    WARN: "WARN";
    INFO: "INFO";
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
export interface HotReloadOptions {
    onWarning?: (msg: string) => void;
    onReloaded?: (keys: string[]) => void;
}
export interface HotReloadResult {
    reloaded: string[];
    skipped: string[];
    errors: string[];
}
export interface DbAdapter {
    get(key: string): Promise<string | undefined>;
    getAll(): Promise<Array<{
        key: string;
        value: string;
    }>>;
    set(key: string, value: string): Promise<void>;
}
export interface ConfigStoreOptions {
    envPath?: string;
    dbAdapter?: DbAdapter | null;
    onWarning?: (msg: string) => void;
    dbCacheTtlMs?: number;
}
export interface ReloadClassification {
    safe: Array<{
        key: string;
        env: string;
        group: string;
        description: string;
    }>;
    restart: Array<{
        key: string;
        env: string;
        group: string;
        description: string;
    }>;
}
export {};
//# sourceMappingURL=config-validate.d.ts.map