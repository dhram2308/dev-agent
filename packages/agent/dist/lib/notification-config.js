"use strict";
/**
 * notification-config.ts -- Per-gate notification preferences
 *
 * Converted from lib/notification-config.js (zero functional changes).
 * Uses shared types from @mi/shared for NotificationConfig, NotificationConfigMap.
 *
 * Manages which notification channels (slack, jira, ui) and reminders
 * (reminder1h, reminder4h) are enabled for each pipeline gate.
 *
 * Persists to notification-config.json in the project root.
 * Atomic writes (tmp + rename) to prevent corruption.
 * Returns sensible defaults (all ON) when the file doesn't exist.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
// Resolve to project root regardless of whether this module loads from
// packages/agent/src/lib (tsx-native) or packages/agent/dist/lib (compiled).
// Both locations are exactly 4 directory levels below the workspace root.
const CONFIG_PATH = path_1.default.join(__dirname, "..", "..", "..", "..", "notification-config.json");
// ── Gates & Channels ────────────────────────────────────────────────
const GATES = [
    "fetch_ticket",
    "explore_plan",
    "gate_code_review",
    "deploy_qa",
    "test_qa",
    "gate_preprod_approval",
    "gate_dual_approval",
    "deploy_prod",
    "done",
];
const CHANNELS = ["slack", "jira", "ui", "reminder1h", "reminder4h"];
/** Returns a single gate's default config (all channels ON). */
function defaultGateConfig() {
    return Object.fromEntries(CHANNELS.map((ch) => [ch, true]));
}
/** Returns the full default config with every gate set to all-ON. */
function buildDefaults() {
    return Object.fromEntries(GATES.map((g) => [g, defaultGateConfig()]));
}
// ── Load / Save ─────────────────────────────────────────────────────
/**
 * Load notification config from disk.
 * Returns defaults if the file is missing or unreadable.
 * Merges saved data over defaults so new gates/channels get added automatically.
 */
function loadNotificationConfig() {
    const defaults = buildDefaults();
    try {
        const raw = fs_1.default.readFileSync(CONFIG_PATH, "utf8");
        const saved = JSON.parse(raw);
        // Merge: defaults as base, overlay saved values
        for (const gate of GATES) {
            if (saved[gate] && typeof saved[gate] === "object") {
                for (const ch of CHANNELS) {
                    if (typeof saved[gate][ch] === "boolean") {
                        defaults[gate][ch] = saved[gate][ch];
                    }
                }
            }
        }
    }
    catch {
        // File missing or corrupt — return defaults
    }
    return defaults;
}
/**
 * Save notification config to disk atomically (write .tmp then rename).
 */
function saveNotificationConfig(config) {
    const tmp = CONFIG_PATH + "." + crypto_1.default.randomBytes(4).toString("hex") + ".tmp";
    fs_1.default.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
    fs_1.default.renameSync(tmp, CONFIG_PATH);
}
// ── Helpers ─────────────────────────────────────────────────────────
/**
 * Get the config for a single gate (with defaults filled in).
 */
function getGateConfig(gate) {
    const config = loadNotificationConfig();
    return config[gate] || defaultGateConfig();
}
/**
 * Check whether a specific channel is enabled for a gate.
 */
function isChannelEnabled(gate, channel) {
    const gc = getGateConfig(gate);
    return typeof gc[channel] === "boolean" ? gc[channel] : true;
}
// ── Exports ─────────────────────────────────────────────────────────
module.exports = {
    GATES,
    CHANNELS,
    loadNotificationConfig,
    saveNotificationConfig,
    getGateConfig,
    isChannelEnabled,
};
//# sourceMappingURL=notification-config.js.map