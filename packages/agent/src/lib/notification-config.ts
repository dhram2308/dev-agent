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

import fs from "fs";
import path from "path";
import crypto from "crypto";

import type {
  NotificationConfig,
  NotificationConfigMap,
} from '@mi/shared';

// Resolve to project root regardless of whether this module loads from
// packages/agent/src/lib (tsx-native) or packages/agent/dist/lib (compiled).
// Both locations are exactly 4 directory levels below the workspace root.
const CONFIG_PATH: string = path.join(__dirname, "..", "..", "..", "..", "notification-config.json");

// ── Gates & Channels ────────────────────────────────────────────────

const GATES: readonly string[] = [
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

const CHANNELS: readonly string[] = ["slack", "jira", "ui", "reminder1h", "reminder4h"];

/** Returns a single gate's default config (all channels ON). */
function defaultGateConfig(): NotificationConfig {
  return Object.fromEntries(CHANNELS.map((ch) => [ch, true])) as unknown as NotificationConfig;
}

/** Returns the full default config with every gate set to all-ON. */
function buildDefaults(): NotificationConfigMap {
  return Object.fromEntries(GATES.map((g) => [g, defaultGateConfig()]));
}

// ── Load / Save ─────────────────────────────────────────────────────

/**
 * Load notification config from disk.
 * Returns defaults if the file is missing or unreadable.
 * Merges saved data over defaults so new gates/channels get added automatically.
 */
function loadNotificationConfig(): NotificationConfigMap {
  const defaults = buildDefaults();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const saved = JSON.parse(raw) as Record<string, Record<string, boolean>>;
    // Merge: defaults as base, overlay saved values
    for (const gate of GATES) {
      if (saved[gate] && typeof saved[gate] === "object") {
        for (const ch of CHANNELS) {
          if (typeof saved[gate][ch] === "boolean") {
            (defaults[gate] as any)[ch] = saved[gate][ch];
          }
        }
      }
    }
  } catch {
    // File missing or corrupt — return defaults
  }
  return defaults;
}

/**
 * Save notification config to disk atomically (write .tmp then rename).
 */
function saveNotificationConfig(config: NotificationConfigMap): void {
  const tmp = CONFIG_PATH + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Get the config for a single gate (with defaults filled in).
 */
function getGateConfig(gate: string): NotificationConfig {
  const config = loadNotificationConfig();
  return config[gate] || defaultGateConfig();
}

/**
 * Check whether a specific channel is enabled for a gate.
 */
function isChannelEnabled(gate: string, channel: string): boolean {
  const gc = getGateConfig(gate) as any;
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
