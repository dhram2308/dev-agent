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
import { logInfo, logWarn } from '../lib/logger';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

/** Buffer before expiry to consider a token "about to expire". */
const EXPIRY_BUFFER_MS = 30_000;

/** How far before expiry to proactively refresh (5 minutes). */
const PROACTIVE_REFRESH_LEAD_MS = 5 * 60 * 1000;

/**
 * Map of providers that have a `kind: 'pat'` credential to the env var the
 * agent's connector libs read at runtime. Single source of truth so the
 * route handler, init-from-store loop, and disconnect path all stay in sync.
 * Extending: add a row here when wiring a new provider's PAT to the keychain.
 * See `pat-in-credential-store` change (task 1.1).
 */
export const PAT_PROVIDER_ENV_MAP: Readonly<Record<string, string>> = Object.freeze({
  figma: 'FIGMA_TOKEN',
  postman: 'POSTMAN_API_KEY',
});

/**
 * Maximum delay accepted by Node.js `setTimeout`. The runtime silently coerces
 * any value larger than 2^31 − 1 ms (~24.85 days) to `1`, so a naive
 * `setTimeout(fn, 90 * 24 * 3600 * 1000)` fires immediately and (with our
 * proactive-refresh design) immediately again, looping until the provider
 * rejects with `invalid_grant`. Clamp to a value safely below the limit and
 * re-schedule from inside the wakeup callback when the real target is further
 * out. See `oauth-connectors` task 11.12.
 */
const MAX_SAFE_TIMEOUT_MS = 2_000_000_000; // ~23.1 days; well below 2^31 − 1.

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

/**
 * Trigger source for a refresh attempt. Used for diagnostic logging and
 * the refresh-history ring buffer. See `oauth-connectors` task 11.12.
 */
export type RefreshTrigger =
  | 'lazy-stale'       // getAccessToken found a cached-but-stale token
  | 'expired-stored'   // getAccessToken found an expired token in the store
  | 'proactive-timer'  // scheduleProactiveRefresh fired its setTimeout
  | 'wal-recovery'     // recoverWAL retried an interrupted refresh on startup
  | 'exit-78'          // agent-process detected EXIT_AUTH_REFRESH and respawned
  | 'manual'           // an explicit external caller (e.g. debug endpoint)
  | 'unknown';         // caller did not specify (back-compat / external SDKs)

/** Refresh-history ring buffer for diagnostic introspection. */
export interface RefreshHistoryEntry {
  provider: string;
  trigger: RefreshTrigger;
  startedAt: number;       // ms epoch
  durationMs: number;
  outcome: 'success' | 'terminal' | 'transient' | 'no-refresh-token';
  errorCode?: string;      // OAuth error short code, e.g. 'invalid_grant'
  errorDesc?: string;      // OAuth error_description or thrown message
  responseSnippet?: string; // First 500 chars of the provider's response body
  cachedExpiresAtBefore?: number; // expiresAt of the cached entry at refresh time
}

const REFRESH_HISTORY_CAP = 20;
const refreshHistory: RefreshHistoryEntry[] = [];

function pushRefreshHistory(entry: RefreshHistoryEntry): void {
  refreshHistory.push(entry);
  if (refreshHistory.length > REFRESH_HISTORY_CAP) refreshHistory.shift();
}

/** Read the in-memory refresh-history ring buffer (capped at 20). */
export function getRefreshHistory(): RefreshHistoryEntry[] {
  return refreshHistory.slice();
}

/** Format a millisecond duration as a humane string ("5.0s", "2.3h", "89.9d"). */
function humanizeMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

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
  extraHeaders?: Record<string, string>,
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
        ...extraHeaders,
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
 * Accounts for expiry buffer, estimated clock skew, and provider-rejection
 * metadata: a token marked `_status: 'RE_AUTH_REQUIRED'` or `'REVOKED'`
 * is treated as invalid even if its nominal expiry is still in the future.
 * Without this guard, a token whose refresh failed with a terminal error
 * (e.g. `invalid_grant`) would still be served from cache to consumers
 * because its `expiresAt` was untouched.
 */
function isCacheValid(provider: string): boolean {
  const cached = tokenCache.get(provider);
  if (!cached) return false;
  const status = cached.tokenSet.metadata?._status;
  if (status === 'RE_AUTH_REQUIRED' || status === 'REVOKED') return false;
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

  const targetDelay = Math.max(expiresAt - PROACTIVE_REFRESH_LEAD_MS - Date.now(), 1000);

  // [oauth-connectors task 11.12] Log the wall-clock time the timer will fire.
  logInfo(
    `[token-manager] Proactive refresh scheduled: provider=${provider} ` +
    `fireAt=${new Date(Date.now() + targetDelay).toISOString()} (in ${humanizeMs(targetDelay)}) ` +
    `expiresAt=${new Date(expiresAt).toISOString()}`,
  );

  // [oauth-connectors task 11.12] If the real delay is beyond Node's setTimeout
  // limit (2^31 − 1 ms, ~24.85 days), naive `setTimeout(fn, delay)` silently
  // coerces to 1 ms and the timer fires immediately. For long-lived tokens
  // (Figma: 90 days, GitLab refresh tokens: indefinite) this caused an immediate
  // refresh loop that rotated through Figma's refresh-token chain in seconds
  // until `invalid_grant`. Chain a wakeup that re-schedules once we're inside
  // the safe window.
  if (targetDelay > MAX_SAFE_TIMEOUT_MS) {
    const wakeup = setTimeout(() => {
      refreshTimers.delete(provider);
      // Re-evaluate using the original `expiresAt` — Date.now() has advanced,
      // so the next `targetDelay` will be ~MAX_SAFE_TIMEOUT_MS smaller.
      scheduleProactiveRefresh(provider, expiresAt);
    }, MAX_SAFE_TIMEOUT_MS);
    wakeup.unref();
    refreshTimers.set(provider, wakeup);
    return;
  }

  const timer = setTimeout(async () => {
    refreshTimers.delete(provider);
    try {
      await refresh(provider, 'proactive-timer');
    } catch (err) {
      // Log but don't crash. The next getAccessToken call will
      // trigger a blocking refresh if needed.
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`[token-manager] Proactive refresh failed for ${provider}: ${msg}`);
    }
  }, targetDelay);

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

/**
 * Notify the token manager that a fresh TokenSet was just persisted to the
 * credential store (e.g. after a successful OAuth callback). Updates the
 * in-memory cache and (re)schedules the proactive refresh timer so the cache
 * stays in sync with the store. Without this call, a freshly-OAuth'd token
 * sits in the store but `getAccessToken` keeps serving the prior cached
 * (possibly RE_AUTH_REQUIRED) entry until the next process restart.
 *
 * Idempotent and side-effect-free if the provider has no expiry.
 */
export function notifyTokenStored(provider: string, tokenSet: TokenSet): void {
  updateCache(provider, tokenSet);
  if (tokenSet.expiresAt) {
    scheduleProactiveRefresh(provider, tokenSet.expiresAt);
  } else {
    cancelRefresh(provider);
  }
}

/**
 * Drop the in-memory cache entry and any scheduled refresh timer for a
 * provider. Call this after `store.delete(provider)` so the cache reflects
 * the disconnected state immediately. Without this call, a `disconnect →
 * test` sequence still serves the deleted provider's last token from cache
 * until the next process restart.
 */
export function clearProviderCache(provider: string): void {
  cancelRefresh(provider);
  tokenCache.delete(provider);
}

// ═══════════════════════════════════════════════════════════════
// Core Token Operations
// ═══════════════════════════════════════════════════════════════

/**
 * Synchronous variant of `getAccessToken` for hot paths where awaiting an
 * async refresh would add unbounded latency (e.g., child-process spawn time).
 *
 * Returns the cached access token only if it is still safely valid (outside
 * the 30s pre-expiry guard, accounting for clock skew). Never refreshes,
 * never reads the credential store, never blocks. Cache must already be
 * warmed via `initFromStore()` for this to return non-null.
 *
 * Callers must tolerate `null` and rely on the exit-78 protocol if the
 * captured token expires mid-pipeline.
 */
export function getAccessTokenSync(provider: string): string | null {
  if (!isCacheValid(provider)) return null;
  return tokenCache.get(provider)!.tokenSet.accessToken;
}

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
      const refreshed = await refresh(provider, 'lazy-stale');
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
      const refreshed = await refresh(provider, 'expired-stored');
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
export async function refresh(
  provider: string,
  trigger: RefreshTrigger = 'unknown',
): Promise<TokenSet> {
  // 1. Join existing single-flight if one is in progress.
  // Note: existing in-flight refresh keeps its original trigger; the new
  // caller's trigger is intentionally dropped to avoid spurious history rows.
  const existing = singleFlightMap.get(provider);
  if (existing) return existing;

  // Create the refresh promise and store it for deduplication.
  const refreshPromise = performRefresh(provider, trigger);
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
 *
 * Records every outcome in the refresh-history ring buffer (success | terminal
 * | transient | no-refresh-token) and emits a structured log line at entry
 * (`[token-manager] refresh start: ...`) so we can attribute each refresh to
 * its trigger source. See `oauth-connectors` task 11.12.
 */
async function performRefresh(
  providerName: string,
  trigger: RefreshTrigger,
): Promise<TokenSet> {
  const startedAt = Date.now();
  const cachedExpiresAtBefore = tokenCache.get(providerName)?.expiresAt;

  logInfo(
    `[token-manager] refresh start: provider=${providerName} trigger=${trigger} ` +
    `cachedExpiresAt=${cachedExpiresAtBefore ? new Date(cachedExpiresAtBefore).toISOString() : 'none'} ` +
    `now=${new Date(startedAt).toISOString()}`,
  );

  const finishedTransient = (errorDesc: string, responseSnippet?: string): void => {
    pushRefreshHistory({
      provider: providerName, trigger, startedAt,
      durationMs: Date.now() - startedAt, outcome: 'transient',
      errorDesc, responseSnippet, cachedExpiresAtBefore,
    });
  };

  const adapter = getProvider(providerName);
  if (!adapter) {
    finishedTransient(`Provider "${providerName}" is not registered`);
    throw new Error(`Provider "${providerName}" is not registered`);
  }

  const store = await getCredentialStore();
  const current = await store.get(providerName);
  if (!current?.refreshToken) {
    pushRefreshHistory({
      provider: providerName, trigger, startedAt,
      durationMs: Date.now() - startedAt, outcome: 'no-refresh-token',
      cachedExpiresAtBefore,
    });
    throw new Error(`No refresh token available for provider "${providerName}"`);
  }

  const refreshUrl = adapter.refreshUrl ?? adapter.tokenUrl;

  // 2. Write WAL entry before the network call.
  addWALEntry(providerName);

  let response: PostFormResult;
  try {
    // 3. POST to refreshUrl.
    const body = adapter.buildRefreshBody(current.refreshToken);
    const extraHeaders: Record<string, string> = {};
    if (adapter.tokenAuthMode === 'basic') {
      // Strip credentials from body and send via HTTP Basic auth (Figma).
      delete body.client_id;
      delete body.client_secret;
      const creds = `${adapter.clientId}:${adapter.clientSecret ?? ''}`;
      extraHeaders.Authorization = `Basic ${Buffer.from(creds).toString('base64')}`;
    }
    response = await postForm(refreshUrl, body, extraHeaders);
  } catch (err) {
    // Network failure -- leave WAL entry for recovery.
    finishedTransient(err instanceof Error ? err.message : String(err));
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
    const responseSnippet = JSON.stringify(response.body).slice(0, 500);

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

      logWarn(
        `[token-manager] refresh terminal: provider=${providerName} trigger=${trigger} ` +
        `errorCode=${errorCode} errorDesc=${errorDesc ?? '<none>'} ` +
        `cachedExpiresAt=${cachedExpiresAtBefore ? new Date(cachedExpiresAtBefore).toISOString() : 'none'} ` +
        `httpStatus=${response.status} body=${responseSnippet}`,
      );
      pushRefreshHistory({
        provider: providerName, trigger, startedAt,
        durationMs: Date.now() - startedAt, outcome: 'terminal',
        errorCode, errorDesc, responseSnippet, cachedExpiresAtBefore,
      });

      throw new Error(errorCode);
    }

    finishedTransient(errorDesc || errorCode || `HTTP ${response.status}`, responseSnippet);
    throw new Error(
      `Token refresh failed for ${providerName}: ${errorDesc || errorCode || `HTTP ${response.status}`}`,
    );
  }

  // 4. Parse the response and persist atomically.
  const partial = adapter.parseTokenResponse(response.body);

  if (!partial.accessToken) {
    finishedTransient(`Token refresh for ${providerName} returned no access token`);
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

  logInfo(
    `[token-manager] refresh success: provider=${providerName} trigger=${trigger} ` +
    `durationMs=${Date.now() - startedAt} ` +
    `newExpiresAt=${newTokenSet.expiresAt ? new Date(newTokenSet.expiresAt).toISOString() : 'none'}`,
  );
  pushRefreshHistory({
    provider: providerName, trigger, startedAt,
    durationMs: Date.now() - startedAt, outcome: 'success',
    cachedExpiresAtBefore,
  });

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
    if (status.kind === 'oauth') {
      const tokenSet = await store.get(status.provider);
      if (!tokenSet) continue;

      // Populate cache.
      updateCache(status.provider, tokenSet);

      // Schedule proactive refresh.
      if (tokenSet.expiresAt) {
        scheduleProactiveRefresh(status.provider, tokenSet.expiresAt);
      }
    } else if (status.kind === 'pat') {
      // [pat-in-credential-store task 1.2] Stage stored PATs into process.env
      // so connector libs (figma.ts, postman.ts) and any in-process callers see
      // them without a `.env` file. Spawned agent children inherit these via
      // the `{ ...process.env, ...loadEnv() }` merge in agent-process.ts.
      const envKey = PAT_PROVIDER_ENV_MAP[status.provider];
      if (!envKey) continue; // Provider has a PAT but no env-key mapping — ignore.

      const tokenSet = await store.get(status.provider);
      if (!tokenSet?.accessToken) continue;

      process.env[envKey] = tokenSet.accessToken;
      logInfo(`[token-manager] Staged PAT into env: provider=${status.provider} envKey=${envKey}`);
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
        await refresh(entry.provider, 'wal-recovery');
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
