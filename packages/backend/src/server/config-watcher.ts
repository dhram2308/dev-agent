// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Config Hot-Reload Watcher
//
// Periodically re-reads environment variables for config keys
// marked `hotReload: true` in CONFIG_SCHEMA. When any value
// changes, broadcasts a `configChanged` SSE event to all
// connected UI clients.
//
// Polling interval: 30 seconds (env vars have no filesystem
// watchers, so polling is the only option).
// ═══════════════════════════════════════════════════════════════

import { broadcast } from './sse';

// ── Lazy schema import ────────────────────────────────────────
// CONFIG_SCHEMA lives in the agent package; import it lazily
// so the backend doesn't hard-depend on it at module load time.

interface SchemaEntry {
  env: string;
  hotReload: boolean;
  sensitive?: boolean;
}

let _hotReloadKeys: Array<{ key: string; env: string; sensitive: boolean }> | null = null;

function getHotReloadKeys(): typeof _hotReloadKeys {
  if (_hotReloadKeys) return _hotReloadKeys;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CONFIG_SCHEMA } = require('@mi/agent/dist/lib/config-schema') as {
      CONFIG_SCHEMA: Record<string, SchemaEntry>;
    };
    _hotReloadKeys = Object.entries(CONFIG_SCHEMA)
      .filter(([, entry]) => entry.hotReload)
      .map(([key, entry]) => ({
        key,
        env: entry.env,
        sensitive: !!entry.sensitive,
      }));
  } catch {
    // Agent package not available — try direct path
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CONFIG_SCHEMA } = require('../../agent/dist/lib/config-schema') as {
        CONFIG_SCHEMA: Record<string, SchemaEntry>;
      };
      _hotReloadKeys = Object.entries(CONFIG_SCHEMA)
        .filter(([, entry]) => entry.hotReload)
        .map(([key, entry]) => ({
          key,
          env: entry.env,
          sensitive: !!entry.sensitive,
        }));
    } catch {
      console.warn('[ConfigWatcher] CONFIG_SCHEMA not available — hot-reload disabled');
      _hotReloadKeys = [];
    }
  }
  return _hotReloadKeys;
}

// ── Snapshot & diff ───────────────────────────────────────────

const _lastSnapshot: Record<string, string | undefined> = {};

function takeSnapshot(): Record<string, string | undefined> {
  const keys = getHotReloadKeys();
  if (!keys || keys.length === 0) return {};

  const snap: Record<string, string | undefined> = {};
  for (const { key, env } of keys) {
    snap[key] = process.env[env];
  }
  return snap;
}

function diffSnapshots(
  prev: Record<string, string | undefined>,
  curr: Record<string, string | undefined>,
): Record<string, string> | null {
  const keys = getHotReloadKeys();
  if (!keys || keys.length === 0) return null;

  const changes: Record<string, string> = {};
  let hasChanges = false;

  for (const { key, sensitive } of keys) {
    const oldVal = prev[key];
    const newVal = curr[key];
    if (oldVal !== newVal) {
      // Mask sensitive values
      changes[key] = sensitive
        ? (newVal ? `****${newVal.slice(-4)}` : '(unset)')
        : (newVal ?? '(unset)');
      hasChanges = true;
    }
  }

  return hasChanges ? changes : null;
}

// ── Watcher ──────────────────────────────────────────────────

let _watcherTimer: ReturnType<typeof setInterval> | null = null;

const POLL_INTERVAL_MS = 30_000; // 30 seconds

function checkForChanges(): void {
  const curr = takeSnapshot();
  const changes = diffSnapshots(_lastSnapshot, curr);

  if (changes) {
    console.log('[ConfigWatcher] Hot-reload config changed:', Object.keys(changes).join(', '));
    broadcast('configChanged', { changes });

    // Update snapshot
    Object.assign(_lastSnapshot, curr);
  }
}

/**
 * Start the config hot-reload watcher.
 * Call once during server startup.
 */
export function startConfigWatcher(): void {
  if (_watcherTimer) return; // Already running

  // Take initial snapshot
  const initial = takeSnapshot();
  Object.assign(_lastSnapshot, initial);

  _watcherTimer = setInterval(checkForChanges, POLL_INTERVAL_MS);
  _watcherTimer.unref(); // Don't prevent process exit

  const keys = getHotReloadKeys();
  console.log(`[ConfigWatcher] Watching ${keys?.length ?? 0} hot-reloadable config keys (${POLL_INTERVAL_MS / 1000}s interval)`);
}

/**
 * Stop the config watcher (for cleanup/testing).
 */
export function stopConfigWatcher(): void {
  if (_watcherTimer) {
    clearInterval(_watcherTimer);
    _watcherTimer = null;
  }
}
