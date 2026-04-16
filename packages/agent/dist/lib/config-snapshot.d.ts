/**
 * config-snapshot.ts -- Config Snapshot & Freeze + Fresh Config Reading
 *
 * Converted from lib/config-snapshot.js (zero functional changes).
 *
 * Solves problems #1-5:
 * - Captures ALL config at fetch_ticket into state._config_snapshot
 * - Classifies fields as FROZEN (identity/security) vs FRESH (tunable)
 * - getConfig(name) reads fresh for tunable fields, snapshot for frozen
 * - Compares live vs snapshot on each stage entry, logs drifts
 */
export {};
//# sourceMappingURL=config-snapshot.d.ts.map