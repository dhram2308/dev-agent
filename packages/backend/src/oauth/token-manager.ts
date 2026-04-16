// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Token Manager (Refresh Daemon)
//
// Manages token lifecycle for all OAuth providers:
//   - In-memory token cache with proactive refresh scheduling
//   - Single-flight deduplication for concurrent refresh requests
//   - Write-ahead log (WAL) for crash recovery
//   - Per-provider clock skew tracking
//
// Uses only Node.js built-in modules (crypto, https, http, fs, path).
// ═══════════════════════════════════════════════════════════════

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { URL } from 'url';
import * as querystring from 'querystring';
import { getProvider } from './provider';
import { getCredentialStore } from '../credentials';
import type { TokenSet } from '../credentials/types';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

/** Buffer before expiry to consider a token "about to expire". */
const EXPIRY_BUFFER_MS = 30_000;

/** How far before expiry to proactively refresh (5 minutes). */
const PROACTIVE_REFRESH_LEAD_MS = 5 * 60 * 1000;

/** Maximum entries in the per-provider clock skew rolling window. */
const CLOCK_SKEW_WINDOW_SIZE = 10;

/** WAL entries older than this are considered stale (60 seconds). */
const WAL_STALE_THRESHOLD_MS = 60_000;

/** Terminal OAuth errors that indicate re-authentication is required. */
const TERMINAL_ERRORS = new Set([
  'invalid_grant',
  'unauthorized_client',
  'invalid_client',
]);

// ═══════════════════════════════════════════════════════════════
// Internal State
// ═══════════════════════════════════════════════════════════════

/** Single-flight map: deduplicates concurrent refresh requests. */
const singleFlightMap = new Map<string, Promise<TokenSet>>();

/** In-memory token cache. */
const tokenCache = new Map<string, { tokenSet: TokenSet; expiresAt: number }>();

/** Proactive refresh timers. */
const refreshTimers = new Map<string, NodeJS.Timeout>();

/** Per-provider clock skew samples (rolling window). */
const clockSkew = new Map<string, number[]>();

// ═══════════════════════════════════════════════════════════════
// WAL (Write-Ahead Log) Helpers
// ═══════════════════════════════════════════════════════════════

interface WALEntry {
  provider: string;
  startedAt: number;
}

interface WALFile {
  entries: WALEntry[];
}

/**
 * Resolve the WAL file path.
 * Uses `~/.config/mi-dev-agent/refresh-wal.json`.
 */
function getWALPath(): string {
  const configDir = process.env.MI_DEV_AGENT_CONFIG_DIR
    || path.join(os.homedir(), '.config', 'mi-dev-agent');
  return path.join(configDir, 'refresh-wal.json');
}

/**
 * Ensure the directory for the WAL file exists.
 */
function ensureWALDir(): void {
  const walPath = getWALPath();
  const dir = path.dirname(walPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read the current WAL file.
 * Returns an empty entries array if the file doesn't exist or is corrupt.
 */
function readWAL(): WALFile {
  try {
    const raw = fs.readFileSync(getWALPath(), 'utf-8');
    const parsed = JSON.parse(raw) as WALFile;
    if (Array.isArray(parsed.entries)) {
      return parsed;
    }
    return { entries: [] };
  } catch {
    return { entries: [] };
  }
}

/**
 * Write the WAL file atomically (write to temp, rename).
 */
function writeWAL(wal: WALFile): void {
  ensureWALDir();
  const walPath = getWALPath();
  const tmpPath = walPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(wal, null, 2), 'utf-8');
  fs.renameSync(tmpPath, walPath);
}

/**
 * Add a WAL entry before starting a refresh.
 */
function addWALEntry(provider: string): void {
  const wal = readWAL();
  // Remove any existing entry for this provider (shouldn't happen, but be safe).
  wal.entries = wal.entries.filter((e) => e.provider !== provider);
  wal.entries.push({ provider, startedAt: Date.now() });
  writeWAL(wal);
}

/**
 * Remove a WAL entry after a successful refresh.
 */
function removeWALEntry(provider: string): void {
  const wal = readWAL();
  wal.entries = wal.entries.filter((e) => e.provider !== provider);
  writeWAL(wal);
}

// ═══════════════════════════════════════════════════════════════
// HTTP Helper -- form-encoded POST using native http/https
// ═══════════════════════════════════════════════════════════════

interface PostFormResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/**
 * POST a form-encoded body to the given URL and return the parsed
 * JSON response. Selects http/https based on URL protocol.
 */
function postForm(
  url: string,
  body: Record<string, string>,
): Promise<PostFormResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const encoded = querystring.stringify(body);

    const options: https.RequestOptions = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(encoded),
        Accept: 'application/json',
      },
    };

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsedBody: Record<string, unknown>;
        try {
          parsedBody = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          reject(new Error(
            `Token endpoint returned non-JSON (HTTP ${res.statusCode ?? 0}): ${raw.slice(0, 200)}`,
          ));
          return;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: parsedBody,
        });
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Token refresh request failed: ${err.message}`));
    });

    req.setTimeout(30_000, () => {
      req.destroy(new Error('Token refresh request timed out after 30s'));
    });

    req.write(encoded);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// Clock Skew Tracking
// ═══════════════════════════════════════════════════════════════

/**
 * Update clock skew estimate for a provider based on the server's
 * `Date` header from a token response.
 *
 * Maintains a rolling window of the last 10 samples and uses
 * the average to adjust expiry calculations.
 *
 * @param provider        - Provider name.
 * @param serverDateHeader - The `Date` header value from the server response.
 */
export function updateClockSkew(provider: string, serverDateHeader: string): void {
  const serverTime = new Date(serverDateHeader).getTime();
  if (isNaN(serverTime)) return;

  const delta = serverTime - Date.now();
  let samples = clockSkew.get(provider);
  if (!samples) {
    samples = [];
    clockSkew.set(provider, samples);
  }

  samples.push(delta);

  // Keep only the last N samples.
  if (samples.length > CLOCK_SKEW_WINDOW_SIZE) {
    samples.splice(0, samples.length - CLOCK_SKEW_WINDOW_SIZE);
  }
}

/**
 * Get the average clock skew for a provider in milliseconds.
 * Returns 0 if no samples are available.
 */
function getClockSkewAvg(provider: string): number {
  const samples = clockSkew.get(provider);
  if (!samples || samples.length === 0) return 0;
  const sum = samples.reduce((a, b) => a + b, 0);
  return Math.round(sum / samples.length);
}

// ═══════════════════════════════════════════════════════════════
// Token Cache Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Check whether a cached token is still valid.
 * Accounts for expiry buffer and estimated clock skew.
 */
function isCacheValid(provider: string): boolean {
  const cached = tokenCache.get(provider);
  if (!cached) return false;
  if (!cached.expiresAt) return true; // Non-expiring token.
  const skew = getClockSkewAvg(provider);
  return cached.expiresAt - EXPIRY_BUFFER_MS > Date.now() + skew;
}

/**
 * Update the in-memory cache for a provider.
 */
function updateCache(provider: string, tokenSet: TokenSet): void {
  tokenCache.set(provider, {
    tokenSet,
    expiresAt: tokenSet.expiresAt ?? 0,
  });
}

// ═══════════════════════════════════════════════════════════════
// Proactive Refresh Scheduling
// ═══════════════════════════════════════════════════════════════

/**
 * Schedule a proactive refresh for a provider.
 *
 * Fires at `expiresAt - 5min`. If that time has already passed,
 * schedules immediately (1 second delay to avoid tight loops).
 *
 * @param provider  - Provider name.
 * @param expiresAt - Token expiry timestamp (ms epoch).
 */
export function scheduleProactiveRefresh(provider: string, expiresAt: number): void {
  // Cancel any existing timer.
  cancelRefresh(provider);

  if (!expiresAt) return; // Non-expiring token; nothing to schedule.

  const delay = Math.max(expiresAt - PROACTIVE_REFRESH_LEAD_MS - Date.now(), 1000);

  const timer = setTimeout(async () => {
    refreshTimers.delete(provider);
    try {
      await refresh(provider);
    } catch (err) {
      // Log but don't crash. The next getAccessToken call will
      // trigger a blocking refresh if needed.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[token-manager] Proactive refresh failed for ${provider}: ${msg}`);
    }
  }, delay);

  // Allow process exit even with pending timers.
  timer.unref();
  refreshTimers.set(provider, timer);
}

/**
 * Cancel a scheduled proactive refresh for a provider.
 *
 * @param provider - Provider name.
 */
export function cancelRefresh(provider: string): void {
  const timer = refreshTimers.get(provider);
  if (timer) {
    clearTimeout(timer);
    refreshTimers.delete(provider);
  }
}

// ═══════════════════════════════════════════════════════════════
// Core Token Operations
// ═══════════════════════════════════════════════════════════════

/**
 * Get a valid access token for a provider.
 *
 * Resolution order:
 *   1. Return from cache if valid (not within 30s of expiry).
 *   2. If within 30s of expiry, block on a refresh (single-flight).
 *   3. If no cached token, read from the CredentialStore.
 *   4. If the stored token is expired, attempt refresh.
 *
 * @param provider - Provider name.
 * @returns The access token string, or `null` if no credentials exist.
 */
export async function getAccessToken(provider: string): Promise<string | null> {
  // 1. Check cache, return if valid.
  if (isCacheValid(provider)) {
    return tokenCache.get(provider)!.tokenSet.accessToken;
  }

  // 2. Check if cache exists but is about to expire -- refresh.
  const cached = tokenCache.get(provider);
  if (cached) {
    try {
      const refreshed = await refresh(provider);
      return refreshed.accessToken;
    } catch (err) {
      // If refresh fails with a terminal error, return null.
      const msg = err instanceof Error ? err.message : '';
      if (TERMINAL_ERRORS.has(msg)) return null;
      throw err;
    }
  }

  // 3. Read from CredentialStore.
  const store = await getCredentialStore();
  const stored = await store.get(provider);
  if (!stored) return null;

  // Populate cache.
  updateCache(provider, stored);

  // Schedule proactive refresh if applicable.
  if (stored.expiresAt) {
    scheduleProactiveRefresh(provider, stored.expiresAt);
  }

  // If the stored token is still valid, return it.
  if (isCacheValid(provider)) {
    return stored.accessToken;
  }

  // 4. Stored token is expired; attempt refresh.
  if (stored.refreshToken) {
    try {
      const refreshed = await refresh(provider);
      return refreshed.accessToken;
    } catch {
      return null;
    }
  }

  // No refresh token and expired -- nothing we can do.
  return null;
}

/**
 * Refresh tokens for a provider.
 *
 * Uses single-flight deduplication: concurrent callers for the same
 * provider share the same in-flight Promise.
 *
 * Flow:
 *   1. Join existing single-flight if one is in progress.
 *   2. Write WAL entry before calling the token endpoint.
 *   3. POST to refreshUrl with refresh_token grant.
 *   4. Persist atomically, clear WAL.
 *   5. Update cache, reschedule proactive timer.
 *
 * @param provider - Provider name.
 * @returns The refreshed TokenSet.
 * @throws On terminal errors (e.g. `invalid_grant`) or network failures.
 */
export async function refresh(provider: string): Promise<TokenSet> {
  // 1. Join existing single-flight if one is in progress.
  const existing = singleFlightMap.get(provider);
  if (existing) return existing;

  // Create the refresh promise and store it for deduplication.
  const refreshPromise = performRefresh(provider);
  singleFlightMap.set(provider, refreshPromise);

  try {
    const result = await refreshPromise;
    return result;
  } finally {
    // Always clean up the single-flight entry.
    singleFlightMap.delete(provider);
  }
}

/**
 * Internal: perform the actual token refresh.
 */
async function performRefresh(providerName: string): Promise<TokenSet> {
  const adapter = getProvider(providerName);
  if (!adapter) {
    throw new Error(`Provider "${providerName}" is not registered`);
  }

  const store = await getCredentialStore();
  const current = await store.get(providerName);
  if (!current?.refreshToken) {
    throw new Error(`No refresh token available for provider "${providerName}"`);
  }

  const refreshUrl = adapter.refreshUrl ?? adapter.tokenUrl;

  // 2. Write WAL entry before the network call.
  addWALEntry(providerName);

  let response: PostFormResult;
  try {
    // 3. POST to refreshUrl.
    const body = adapter.buildRefreshBody(current.refreshToken);
    response = await postForm(refreshUrl, body);
  } catch (err) {
    // Network failure -- leave WAL entry for recovery.
    throw err;
  }

  // Update clock skew from server Date header.
  if (response.headers.date) {
    updateClockSkew(providerName, response.headers.date);
  }

  // Check for terminal errors.
  if (response.status >= 400) {
    const errorCode = response.body.error as string | undefined;
    const errorDesc = response.body.error_description as string | undefined;

    // Clean up WAL on terminal errors (no point retrying).
    if (errorCode && TERMINAL_ERRORS.has(errorCode)) {
      removeWALEntry(providerName);
      cancelRefresh(providerName);
      tokenCache.delete(providerName);

      // Mark as RE_AUTH_REQUIRED in the store by updating with a sentinel.
      // The credential store's list() will reflect this via metadata.
      try {
        const updated: TokenSet = {
          ...current,
          metadata: {
            ...current.metadata,
            _status: 'RE_AUTH_REQUIRED',
            _errorAt: String(Date.now()),
          },
        };
        await store.set(providerName, updated);
      } catch {
        // Best effort.
      }

      throw new Error(errorCode);
    }

    throw new Error(
      `Token refresh failed for ${providerName}: ${errorDesc || errorCode || `HTTP ${response.status}`}`,
    );
  }

  // 4. Parse the response and persist atomically.
  const partial = adapter.parseTokenResponse(response.body);

  if (!partial.accessToken) {
    throw new Error(`Token refresh for ${providerName} returned no access token`);
  }

  // Compute expiresAt from expires_in if not set by the adapter.
  if (!partial.expiresAt && typeof response.body.expires_in === 'number') {
    partial.expiresAt = Date.now() + (response.body.expires_in as number) * 1000;
  }

  const newTokenSet: TokenSet = {
    kind: 'oauth',
    accessToken: partial.accessToken,
    // Some providers don't return a new refresh token on every refresh;
    // keep the old one if the new response doesn't include one.
    refreshToken: partial.refreshToken ?? current.refreshToken,
    expiresAt: partial.expiresAt,
    scopes: partial.scopes ?? current.scopes,
    metadata: {
      ...current.metadata,
      ...partial.metadata,
      // Clear any previous error status.
      _status: 'CONNECTED',
    },
  };

  // Persist to store.
  await store.set(providerName, newTokenSet);

  // Clear WAL entry on success.
  removeWALEntry(providerName);

  // 5. Update cache and reschedule proactive timer.
  updateCache(providerName, newTokenSet);
  if (newTokenSet.expiresAt) {
    scheduleProactiveRefresh(providerName, newTokenSet.expiresAt);
  }

  return newTokenSet;
}

// ═══════════════════════════════════════════════════════════════
// Startup / Recovery
// ═══════════════════════════════════════════════════════════════

/**
 * Initialize the token manager from the credential store.
 *
 * Call this once during application startup. It:
 *   1. Reads all providers from the CredentialStore.
 *   2. Populates the in-memory cache.
 *   3. Schedules proactive refresh timers.
 *   4. Checks the WAL for interrupted refreshes.
 */
export async function initFromStore(): Promise<void> {
  const store = await getCredentialStore();
  const statuses = await store.list();

  for (const status of statuses) {
    if (status.kind !== 'oauth') continue;

    const tokenSet = await store.get(status.provider);
    if (!tokenSet) continue;

    // Populate cache.
    updateCache(status.provider, tokenSet);

    // Schedule proactive refresh.
    if (tokenSet.expiresAt) {
      scheduleProactiveRefresh(status.provider, tokenSet.expiresAt);
    }
  }

  // Recover any interrupted refreshes.
  await recoverWAL();
}

/**
 * Recover from interrupted refresh operations.
 *
 * Reads the WAL file and for entries older than 60 seconds:
 *   - Attempts to verify the stored token is still valid.
 *   - If invalid (e.g. half-written), marks the provider as
 *     RE_AUTH_REQUIRED so the UI can prompt the user.
 */
export async function recoverWAL(): Promise<void> {
  const wal = readWAL();
  if (wal.entries.length === 0) return;

  const now = Date.now();
  const store = await getCredentialStore();
  const staleEntries = wal.entries.filter((e) => now - e.startedAt > WAL_STALE_THRESHOLD_MS);

  for (const entry of staleEntries) {
    const tokenSet = await store.get(entry.provider);

    if (!tokenSet) {
      // No token stored at all -- just clean up WAL.
      continue;
    }

    // Check if the token is expired or missing.
    const isExpired = tokenSet.expiresAt ? tokenSet.expiresAt < now : false;

    if (isExpired && tokenSet.refreshToken) {
      // Attempt a refresh to recover.
      try {
        await refresh(entry.provider);
        continue; // Success -- WAL entry cleaned by refresh().
      } catch {
        // Refresh failed -- fall through to mark RE_AUTH_REQUIRED.
      }
    } else if (!isExpired) {
      // Token is still valid despite the interrupted refresh.
      // Populate cache and move on.
      updateCache(entry.provider, tokenSet);
      if (tokenSet.expiresAt) {
        scheduleProactiveRefresh(entry.provider, tokenSet.expiresAt);
      }
      continue;
    }

    // Mark RE_AUTH_REQUIRED.
    try {
      const updated: TokenSet = {
        ...tokenSet,
        metadata: {
          ...tokenSet.metadata,
          _status: 'RE_AUTH_REQUIRED',
          _errorAt: String(now),
          _walRecovery: 'true',
        },
      };
      await store.set(entry.provider, updated);
    } catch {
      // Best effort.
    }

    // Clear cache for this provider.
    tokenCache.delete(entry.provider);
    cancelRefresh(entry.provider);
  }

  // Remove all stale entries from WAL.
  const remaining = wal.entries.filter((e) => now - e.startedAt <= WAL_STALE_THRESHOLD_MS);
  writeWAL({ entries: remaining });
}
