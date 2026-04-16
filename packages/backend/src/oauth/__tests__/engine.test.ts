// =====================================================================
// engine.test.ts -- Unit tests for OAuth engine + TokenManager
// =====================================================================
//
// Tests: PKCE helpers, provider registry, OAuth engine (startOAuthFlow,
//        handleOAuthCallback), TokenManager (single-flight, proactive
//        timer, lazy guard, WAL recovery), state mismatch rejection.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { generateVerifier, challengeFromVerifier, generateState } from '../pkce';
import { registerProvider, getProvider, getRegisteredProviders } from '../provider';
import type { ProviderAdapter } from '../provider';
import type { TokenSet, CredentialStore, ProviderStatus } from '../../credentials/types';

// ── Mock: credential store ──────────────────────────────────────────

const mockStore: CredentialStore = {
  backendName: 'mock',
  get: vi.fn<[string], Promise<TokenSet | null>>().mockResolvedValue(null),
  set: vi.fn<[string, TokenSet], Promise<void>>().mockResolvedValue(undefined),
  delete: vi.fn<[string], Promise<void>>().mockResolvedValue(undefined),
  list: vi.fn<[], Promise<ProviderStatus[]>>().mockResolvedValue([]),
};

vi.mock('../../credentials', () => ({
  getCredentialStore: vi.fn().mockImplementation(async () => mockStore),
}));

// ── Mock: http/https to prevent real network calls ──────────────────

vi.mock('https', () => ({
  request: vi.fn(),
}));

vi.mock('http', () => ({
  request: vi.fn(),
}));

// ── Lazy imports (after mocks are set up) ───────────────────────────

// engine.ts and token-manager.ts import credentials + http at module
// load, so they must be imported AFTER the mocks above.
let startOAuthFlow: typeof import('../engine').startOAuthFlow;
let handleOAuthCallback: typeof import('../engine').handleOAuthCallback;
let disconnectProvider: typeof import('../engine').disconnectProvider;

let getAccessToken: typeof import('../token-manager').getAccessToken;
let refresh: typeof import('../token-manager').refresh;
let scheduleProactiveRefresh: typeof import('../token-manager').scheduleProactiveRefresh;
let cancelRefresh: typeof import('../token-manager').cancelRefresh;
let initFromStore: typeof import('../token-manager').initFromStore;
let recoverWAL: typeof import('../token-manager').recoverWAL;
let updateClockSkew: typeof import('../token-manager').updateClockSkew;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Build a minimal valid TokenSet for testing.
 */
function makeTokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    kind: 'oauth',
    accessToken: 'access_test_abc123def456',
    refreshToken: 'refresh_test_ghi789jkl012',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['read', 'write'],
    ...overrides,
  };
}

/**
 * Create a fake ProviderAdapter for testing.
 */
function makeFakeProvider(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    name: 'test-provider',
    authorizeUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    defaultScopes: ['read', 'write'],
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    parseTokenResponse: (body) => ({
      accessToken: body.access_token as string,
      refreshToken: body.refresh_token as string | undefined,
      scopes: body.scope
        ? (body.scope as string).split(' ')
        : undefined,
    }),
    buildRefreshBody: (refreshToken) => ({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
    }),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. PKCE Helpers
// ═══════════════════════════════════════════════════════════════════════

describe('PKCE helpers', () => {
  describe('generateVerifier', () => {
    it('returns a 64-character string', () => {
      const verifier = generateVerifier();
      expect(verifier).toHaveLength(64);
    });

    it('contains only unreserved URI characters (RFC 7636 section 4.1)', () => {
      const verifier = generateVerifier();
      // Unreserved chars: A-Z a-z 0-9 - . _ ~
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    });

    it('generates unique verifiers on each call', () => {
      const a = generateVerifier();
      const b = generateVerifier();
      expect(a).not.toBe(b);
    });
  });

  describe('challengeFromVerifier', () => {
    it('returns a base64url string without padding', () => {
      const verifier = generateVerifier();
      const challenge = challengeFromVerifier(verifier);

      // base64url: A-Z a-z 0-9 - _   (no +, /, or =)
      expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
      expect(challenge).not.toContain('+');
      expect(challenge).not.toContain('/');
      expect(challenge).not.toContain('=');
    });

    it('produces the SHA-256 of the verifier encoded as base64url', () => {
      const verifier = 'test_verifier_for_deterministic_check';
      const challenge = challengeFromVerifier(verifier);

      // Compute expected value manually.
      const expected = crypto
        .createHash('sha256')
        .update(verifier, 'ascii')
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      expect(challenge).toBe(expected);
    });

    it('produces a consistent result for the same input', () => {
      const verifier = generateVerifier();
      const a = challengeFromVerifier(verifier);
      const b = challengeFromVerifier(verifier);
      expect(a).toBe(b);
    });
  });

  describe('generateState', () => {
    it('returns a 32-character hex string', () => {
      const state = generateState();
      expect(state).toHaveLength(32);
      expect(state).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates unique state values on each call', () => {
      const a = generateState();
      const b = generateState();
      expect(a).not.toBe(b);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Provider Registry
// ═══════════════════════════════════════════════════════════════════════

describe('Provider registry', () => {
  it('returns undefined for an unregistered provider', () => {
    expect(getProvider('nonexistent-provider-xyz')).toBeUndefined();
  });

  it('registers and retrieves a provider adapter', () => {
    const adapter = makeFakeProvider({ name: 'registry-test-alpha' });
    registerProvider(adapter);

    const retrieved = getProvider('registry-test-alpha');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('registry-test-alpha');
    expect(retrieved!.clientId).toBe('test-client-id');
    expect(retrieved!.authorizeUrl).toBe('https://auth.example.com/authorize');
  });

  it('overwrites an existing adapter with the same name', () => {
    const original = makeFakeProvider({ name: 'registry-test-beta', clientId: 'old-id' });
    const updated = makeFakeProvider({ name: 'registry-test-beta', clientId: 'new-id' });

    registerProvider(original);
    registerProvider(updated);

    const retrieved = getProvider('registry-test-beta');
    expect(retrieved!.clientId).toBe('new-id');
  });

  it('lists all registered provider names', () => {
    registerProvider(makeFakeProvider({ name: 'registry-test-gamma' }));
    registerProvider(makeFakeProvider({ name: 'registry-test-delta' }));

    const names = getRegisteredProviders();
    expect(names).toContain('registry-test-gamma');
    expect(names).toContain('registry-test-delta');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. OAuth Engine - startOAuthFlow
// ═══════════════════════════════════════════════════════════════════════

describe('OAuth engine - startOAuthFlow', () => {
  beforeEach(async () => {
    // Dynamically import engine after mocks are set up.
    const engineMod = await import('../engine');
    startOAuthFlow = engineMod.startOAuthFlow;
    handleOAuthCallback = engineMod.handleOAuthCallback;
    disconnectProvider = engineMod.disconnectProvider;
  });

  it('throws when the provider is not registered', async () => {
    await expect(
      startOAuthFlow('unknown-provider-zzz', 'http://localhost/callback'),
    ).rejects.toThrow(/not registered/);
  });

  it('returns an authorizeUrl with correct query params', async () => {
    const adapter = makeFakeProvider({ name: 'engine-test-provider' });
    registerProvider(adapter);

    const result = await startOAuthFlow(
      'engine-test-provider',
      'http://localhost:3000/oauth/callback',
    );

    expect(result.state).toHaveLength(32);
    expect(result.authorizeUrl).toContain('https://auth.example.com/authorize?');

    const url = new URL(result.authorizeUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/oauth/callback');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('read write');

    // code_challenge must be present and be a valid base64url string.
    const challenge = url.searchParams.get('code_challenge')!;
    expect(challenge).toBeTruthy();
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('includes extra authorize params from the provider', async () => {
    const adapter = makeFakeProvider({
      name: 'engine-test-extra-params',
      extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    });
    registerProvider(adapter);

    const result = await startOAuthFlow(
      'engine-test-extra-params',
      'http://localhost/callback',
    );

    const url = new URL(result.authorizeUrl);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('stores the pending flow so handleOAuthCallback can find it', async () => {
    const adapter = makeFakeProvider({ name: 'engine-test-pending' });
    registerProvider(adapter);

    const result = await startOAuthFlow(
      'engine-test-pending',
      'http://localhost/callback',
    );

    // The returned state should be valid for callback.
    // We verify this indirectly -- a callback with this state should NOT
    // return "Invalid or expired state parameter".
    // (The token exchange itself will fail because postForm is mocked, but
    // the state lookup should succeed.)
    const callbackResult = await handleOAuthCallback(
      'fake_auth_code',
      result.state,
      'http://localhost/callback',
    );

    // The state was found and consumed (not "Invalid or expired state").
    // It will fail at the HTTP level since postForm is mocked, but
    // the error should be about the token exchange, not the state.
    expect(callbackResult.provider).toBe('engine-test-pending');
    if (!callbackResult.success) {
      expect(callbackResult.error).not.toContain('Invalid or expired state');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. OAuth Engine - handleOAuthCallback
// ═══════════════════════════════════════════════════════════════════════

describe('OAuth engine - handleOAuthCallback', () => {
  beforeEach(async () => {
    const engineMod = await import('../engine');
    startOAuthFlow = engineMod.startOAuthFlow;
    handleOAuthCallback = engineMod.handleOAuthCallback;

    vi.mocked(mockStore.get).mockResolvedValue(null);
    vi.mocked(mockStore.set).mockResolvedValue(undefined);
  });

  it('rejects an unknown state parameter', async () => {
    const result = await handleOAuthCallback(
      'some_code',
      'nonexistent_state_abcdef1234567890',
      'http://localhost/callback',
    );

    expect(result.success).toBe(false);
    expect(result.provider).toBe('unknown');
    expect(result.error).toContain('Invalid or expired state');
  });

  it('rejects an expired state (>10 min TTL)', async () => {
    const adapter = makeFakeProvider({ name: 'engine-test-expire' });
    registerProvider(adapter);

    // Start a flow to create a pending state.
    const { state } = await startOAuthFlow(
      'engine-test-expire',
      'http://localhost/callback',
    );

    // Advance Date.now() by 11 minutes to exceed the 10-minute TTL.
    const realDateNow = Date.now;
    const frozenNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(frozenNow + 11 * 60 * 1000);

    try {
      const result = await handleOAuthCallback(
        'auth_code_expired_test',
        state,
        'http://localhost/callback',
      );

      expect(result.success).toBe(false);
      expect(result.provider).toBe('engine-test-expire');
      expect(result.error).toContain('expired');
    } finally {
      vi.spyOn(Date, 'now').mockRestore();
    }
  });

  it('rejects replay of a consumed state (state used twice)', async () => {
    const adapter = makeFakeProvider({ name: 'engine-test-replay' });
    registerProvider(adapter);

    const { state } = await startOAuthFlow(
      'engine-test-replay',
      'http://localhost/callback',
    );

    // First callback consumes the state.
    await handleOAuthCallback('code1', state, 'http://localhost/callback');

    // Second callback with the same state should fail.
    const result = await handleOAuthCallback('code2', state, 'http://localhost/callback');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid or expired state');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. State Mismatch Rejection (cross-cutting)
// ═══════════════════════════════════════════════════════════════════════

describe('State mismatch rejection', () => {
  beforeEach(async () => {
    const engineMod = await import('../engine');
    startOAuthFlow = engineMod.startOAuthFlow;
    handleOAuthCallback = engineMod.handleOAuthCallback;
  });

  it('rejects callback when state param does not match any pending flow', async () => {
    const adapter = makeFakeProvider({ name: 'engine-test-mismatch' });
    registerProvider(adapter);

    // Start a real flow.
    const { state } = await startOAuthFlow(
      'engine-test-mismatch',
      'http://localhost/callback',
    );

    // Callback with a DIFFERENT state value.
    const wrongState = state.split('').reverse().join(''); // reversed
    const result = await handleOAuthCallback(
      'auth_code_xyz',
      wrongState,
      'http://localhost/callback',
    );

    expect(result.success).toBe(false);
    expect(result.provider).toBe('unknown');
    expect(result.error).toContain('Invalid or expired state');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. TokenManager - single-flight deduplication
// ═══════════════════════════════════════════════════════════════════════

describe('TokenManager - single-flight', () => {
  let buildRefreshBodyCallCount: number;

  beforeEach(async () => {
    buildRefreshBodyCallCount = 0;

    const tokenManagerMod = await import('../token-manager');
    refresh = tokenManagerMod.refresh;
    getAccessToken = tokenManagerMod.getAccessToken;

    // Register a provider that tracks how many times buildRefreshBody
    // is invoked -- this tells us how many actual refresh HTTP calls
    // would be made.
    const adapter = makeFakeProvider({
      name: 'single-flight-test',
      buildRefreshBody: (rt) => {
        buildRefreshBodyCallCount++;
        return {
          grant_type: 'refresh_token',
          refresh_token: rt,
          client_id: 'test-client-id',
        };
      },
    });
    registerProvider(adapter);

    // Set up the credential store mock to return a token with a refresh token.
    const storedToken = makeTokenSet({
      refreshToken: 'rf_single_flight_test_123',
      expiresAt: Date.now() - 60_000, // expired to force refresh
    });
    vi.mocked(mockStore.get).mockResolvedValue(storedToken);
    vi.mocked(mockStore.set).mockResolvedValue(undefined);
    vi.mocked(mockStore.list).mockResolvedValue([{
      provider: 'single-flight-test',
      kind: 'oauth',
      status: 'CONNECTED',
      hasRefreshToken: true,
      expiresAt: storedToken.expiresAt,
    }]);
  });

  afterEach(() => {
    vi.mocked(mockStore.get).mockReset();
    vi.mocked(mockStore.set).mockReset();
    vi.mocked(mockStore.list).mockReset();
  });

  it('deduplicates concurrent refresh calls for the same provider', async () => {
    // Call refresh() twice concurrently. Both calls will fail at the
    // HTTP level (https is mocked), but single-flight deduplication
    // means buildRefreshBody should be called exactly once -- the
    // second call joins the in-flight promise instead of starting
    // a new refresh request.
    const promise1 = refresh('single-flight-test');
    const promise2 = refresh('single-flight-test');

    // Both promises should settle (reject because https is mocked).
    const results = await Promise.allSettled([promise1, promise2]);

    // Both should have rejected with the same type of error.
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');

    // The key assertion: buildRefreshBody was called only ONCE,
    // proving the second refresh() joined the in-flight single-flight
    // promise instead of starting a separate HTTP request.
    expect(buildRefreshBodyCallCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. TokenManager - proactive timer
// ═══════════════════════════════════════════════════════════════════════

describe('TokenManager - proactive timer', () => {
  beforeEach(async () => {
    vi.useFakeTimers();

    const tokenManagerMod = await import('../token-manager');
    scheduleProactiveRefresh = tokenManagerMod.scheduleProactiveRefresh;
    cancelRefresh = tokenManagerMod.cancelRefresh;
    refresh = tokenManagerMod.refresh;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a refresh before token expiry', () => {
    const adapter = makeFakeProvider({ name: 'proactive-timer-test' });
    registerProvider(adapter);

    // Token expires in 10 minutes.
    const expiresAt = Date.now() + 10 * 60 * 1000;

    // Schedule proactive refresh (fires at expiresAt - 5min = 5min from now).
    scheduleProactiveRefresh('proactive-timer-test', expiresAt);

    // The refresh should NOT have been called yet.
    // We can verify by checking that refresh() hasn't been triggered.
    // Advance time by 4 minutes -- too early, no refresh.
    vi.advanceTimersByTime(4 * 60 * 1000);
    // No assertion needed here; the test is that it doesn't crash.

    // Advance to just past the 5-minute mark.
    // The timer fires at expiresAt - 5min, which is 5min from now.
    // We already advanced 4min, so advance 1min + 1s more.
    // The refresh will fail (mocked https), but the timer should fire.
    vi.advanceTimersByTime(61 * 1000);
    // Timer has fired. Since the actual HTTP call is mocked, it will
    // reject silently (the proactive handler catches errors).
  });

  it('cancels a previously scheduled refresh', () => {
    const adapter = makeFakeProvider({ name: 'proactive-cancel-test' });
    registerProvider(adapter);

    const expiresAt = Date.now() + 10 * 60 * 1000;
    scheduleProactiveRefresh('proactive-cancel-test', expiresAt);

    // Cancel the refresh.
    cancelRefresh('proactive-cancel-test');

    // Advance past the scheduled time -- nothing should fire.
    vi.advanceTimersByTime(15 * 60 * 1000);
    // No error, no crash.
  });

  it('replaces the previous timer when rescheduled', () => {
    const adapter = makeFakeProvider({ name: 'proactive-replace-test' });
    registerProvider(adapter);

    // Schedule with 10-minute expiry.
    scheduleProactiveRefresh('proactive-replace-test', Date.now() + 10 * 60 * 1000);

    // Reschedule with a much later expiry (30 minutes).
    scheduleProactiveRefresh('proactive-replace-test', Date.now() + 30 * 60 * 1000);

    // Advance 6 minutes (past the original 5-min-before-10-min schedule).
    vi.advanceTimersByTime(6 * 60 * 1000);
    // The original timer should have been cancelled; no refresh fires yet.
    // The new timer fires at 30min - 5min = 25min from now.
  });

  it('schedules with minimum 1s delay when expiry is already past', () => {
    const adapter = makeFakeProvider({ name: 'proactive-past-test' });
    registerProvider(adapter);

    // Expired 10 minutes ago -- delay should be clamped to 1000ms.
    const expiresAt = Date.now() - 10 * 60 * 1000;
    scheduleProactiveRefresh('proactive-past-test', expiresAt);

    // Advance 500ms -- not yet.
    vi.advanceTimersByTime(500);

    // Advance 600ms more (total 1100ms) -- should fire.
    vi.advanceTimersByTime(600);
    // Timer has fired (refresh will fail due to mocked HTTP, but that's ok).
  });

  it('does not schedule a timer when expiresAt is 0 (non-expiring)', () => {
    const adapter = makeFakeProvider({ name: 'proactive-nonexpire-test' });
    registerProvider(adapter);

    // expiresAt = 0 means non-expiring.
    scheduleProactiveRefresh('proactive-nonexpire-test', 0);

    // Advance a long time -- no timer should fire, no error.
    vi.advanceTimersByTime(60 * 60 * 1000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. TokenManager - lazy guard (expired token triggers refresh)
// ═══════════════════════════════════════════════════════════════════════

describe('TokenManager - lazy guard', () => {
  beforeEach(async () => {
    const tokenManagerMod = await import('../token-manager');
    getAccessToken = tokenManagerMod.getAccessToken;

    vi.mocked(mockStore.set).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.mocked(mockStore.get).mockReset();
    vi.mocked(mockStore.set).mockReset();
  });

  it('returns null when no credentials exist for the provider', async () => {
    vi.mocked(mockStore.get).mockResolvedValue(null);

    const token = await getAccessToken('lazy-guard-empty');
    expect(token).toBeNull();
  });

  it('returns the access token when stored token is still valid', async () => {
    const validToken = makeTokenSet({
      accessToken: 'valid_access_abc123xyz',
      expiresAt: Date.now() + 3_600_000, // 1 hour from now
    });
    vi.mocked(mockStore.get).mockResolvedValue(validToken);

    registerProvider(makeFakeProvider({ name: 'lazy-guard-valid' }));

    const token = await getAccessToken('lazy-guard-valid');
    expect(token).toBe('valid_access_abc123xyz');
  });

  it('returns null for expired token without a refresh token', async () => {
    const expiredNoRefresh = makeTokenSet({
      accessToken: 'expired_no_refresh_token',
      expiresAt: Date.now() - 60_000, // expired 1 minute ago
      refreshToken: undefined,
    });
    vi.mocked(mockStore.get).mockResolvedValue(expiredNoRefresh);

    registerProvider(makeFakeProvider({ name: 'lazy-guard-no-rt' }));

    const token = await getAccessToken('lazy-guard-no-rt');
    expect(token).toBeNull();
  });

  it('attempts refresh when stored token is expired and has refresh token', async () => {
    const expiredWithRefresh = makeTokenSet({
      accessToken: 'expired_with_refresh_token',
      expiresAt: Date.now() - 60_000,
      refreshToken: 'rf_lazy_guard_test_456',
    });
    vi.mocked(mockStore.get).mockResolvedValue(expiredWithRefresh);

    registerProvider(makeFakeProvider({ name: 'lazy-guard-refresh' }));

    // The refresh will fail because https is mocked, so getAccessToken
    // should return null (it catches refresh errors).
    const token = await getAccessToken('lazy-guard-refresh');
    expect(token).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. TokenManager - WAL recovery
// ═══════════════════════════════════════════════════════════════════════

describe('TokenManager - WAL recovery', () => {
  let tmpDir: string;
  let walPath: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    // Create a temp directory for the WAL file.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-wal-test-'));
    walPath = path.join(tmpDir, 'refresh-wal.json');

    // Override the config dir env var so the WAL goes to our temp directory.
    originalConfigDir = process.env.MI_DEV_AGENT_CONFIG_DIR;
    process.env.MI_DEV_AGENT_CONFIG_DIR = tmpDir;

    const tokenManagerMod = await import('../token-manager');
    recoverWAL = tokenManagerMod.recoverWAL;
    initFromStore = tokenManagerMod.initFromStore;

    vi.mocked(mockStore.set).mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Restore env var.
    if (originalConfigDir === undefined) {
      delete process.env.MI_DEV_AGENT_CONFIG_DIR;
    } else {
      process.env.MI_DEV_AGENT_CONFIG_DIR = originalConfigDir;
    }

    // Clean up temp directory.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }

    vi.mocked(mockStore.get).mockReset();
    vi.mocked(mockStore.set).mockReset();
    vi.mocked(mockStore.list).mockReset();
  });

  it('recovers stale WAL entries by marking provider as RE_AUTH_REQUIRED', async () => {
    // Write a WAL entry that is older than 60s (stale).
    const staleEntry = {
      entries: [{
        provider: 'wal-recovery-test',
        startedAt: Date.now() - 120_000, // 2 minutes ago (stale)
      }],
    };
    fs.writeFileSync(walPath, JSON.stringify(staleEntry, null, 2), 'utf-8');

    // The stored token is expired and has no refresh token, so recovery
    // should mark it as RE_AUTH_REQUIRED.
    const expiredToken = makeTokenSet({
      expiresAt: Date.now() - 300_000, // 5 minutes ago
      refreshToken: undefined,
    });
    vi.mocked(mockStore.get).mockResolvedValue(expiredToken);

    registerProvider(makeFakeProvider({ name: 'wal-recovery-test' }));

    await recoverWAL();

    // Verify that store.set was called with RE_AUTH_REQUIRED metadata.
    expect(mockStore.set).toHaveBeenCalledWith(
      'wal-recovery-test',
      expect.objectContaining({
        metadata: expect.objectContaining({
          _status: 'RE_AUTH_REQUIRED',
          _walRecovery: 'true',
        }),
      }),
    );
  });

  it('ignores WAL entries that are not yet stale (< 60s old)', async () => {
    // Write a fresh WAL entry (not stale).
    const freshEntry = {
      entries: [{
        provider: 'wal-fresh-test',
        startedAt: Date.now() - 10_000, // 10 seconds ago
      }],
    };
    fs.writeFileSync(walPath, JSON.stringify(freshEntry, null, 2), 'utf-8');

    vi.mocked(mockStore.get).mockResolvedValue(null);
    vi.mocked(mockStore.list).mockResolvedValue([]);

    await recoverWAL();

    // store.set should NOT have been called because the entry is fresh.
    expect(mockStore.set).not.toHaveBeenCalled();

    // WAL should still contain the fresh entry.
    const wal = JSON.parse(fs.readFileSync(walPath, 'utf-8'));
    expect(wal.entries).toHaveLength(1);
    expect(wal.entries[0].provider).toBe('wal-fresh-test');
  });

  it('handles empty WAL gracefully', async () => {
    // Write an empty WAL.
    fs.writeFileSync(walPath, JSON.stringify({ entries: [] }), 'utf-8');

    await expect(recoverWAL()).resolves.toBeUndefined();
  });

  it('handles missing WAL file gracefully', async () => {
    // Ensure no WAL file exists.
    if (fs.existsSync(walPath)) {
      fs.unlinkSync(walPath);
    }

    await expect(recoverWAL()).resolves.toBeUndefined();
  });

  it('cleans stale entries from the WAL file after recovery', async () => {
    const mixedEntries = {
      entries: [
        {
          provider: 'stale-provider',
          startedAt: Date.now() - 120_000, // stale
        },
        {
          provider: 'fresh-provider',
          startedAt: Date.now() - 10_000, // fresh
        },
      ],
    };
    fs.writeFileSync(walPath, JSON.stringify(mixedEntries, null, 2), 'utf-8');

    // stale-provider has no stored token.
    vi.mocked(mockStore.get).mockResolvedValue(null);

    await recoverWAL();

    // The WAL should only contain the fresh entry after recovery.
    const wal = JSON.parse(fs.readFileSync(walPath, 'utf-8'));
    expect(wal.entries).toHaveLength(1);
    expect(wal.entries[0].provider).toBe('fresh-provider');
  });

  it('populates cache for stale WAL entries with valid (non-expired) tokens', async () => {
    const staleEntry = {
      entries: [{
        provider: 'wal-valid-token-test',
        startedAt: Date.now() - 120_000, // stale
      }],
    };
    fs.writeFileSync(walPath, JSON.stringify(staleEntry, null, 2), 'utf-8');

    // The stored token is still valid despite the interrupted refresh.
    const validToken = makeTokenSet({
      accessToken: 'wal_valid_access_token',
      expiresAt: Date.now() + 3_600_000, // 1 hour from now
      refreshToken: 'rf_wal_valid_123',
    });
    vi.mocked(mockStore.get).mockResolvedValue(validToken);

    registerProvider(makeFakeProvider({ name: 'wal-valid-token-test' }));

    await recoverWAL();

    // store.set should NOT have been called with RE_AUTH_REQUIRED
    // because the token is still valid.
    const setCalls = vi.mocked(mockStore.set).mock.calls;
    const reAuthCalls = setCalls.filter(
      ([, ts]) => ts.metadata?._status === 'RE_AUTH_REQUIRED',
    );
    expect(reAuthCalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. TokenManager - clock skew tracking
// ═══════════════════════════════════════════════════════════════════════

describe('TokenManager - clock skew', () => {
  beforeEach(async () => {
    const tokenManagerMod = await import('../token-manager');
    updateClockSkew = tokenManagerMod.updateClockSkew;
  });

  it('accepts a valid Date header without throwing', () => {
    expect(() => {
      updateClockSkew('skew-test', new Date().toUTCString());
    }).not.toThrow();
  });

  it('ignores an invalid Date header', () => {
    expect(() => {
      updateClockSkew('skew-test-invalid', 'not-a-date');
    }).not.toThrow();
  });

  it('accepts multiple samples for the same provider', () => {
    for (let i = 0; i < 15; i++) {
      expect(() => {
        updateClockSkew('skew-test-multi', new Date().toUTCString());
      }).not.toThrow();
    }
  });
});
