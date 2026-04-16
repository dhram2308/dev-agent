// =====================================================================
// google-flow.test.ts -- Integration test for Google Drive OAuth flow
// =====================================================================
//
// Verifies the end-to-end OAuth 2.0 flow for Google Drive by stubbing
// Google's HTTP endpoints (token exchange, refresh, revoke) while
// exercising the real provider adapter, engine, and token manager.
//
// Covers:
//   1. Google provider registration + authorize URL construction
//   2. Token exchange via handleOAuthCallback with mocked token endpoint
//   3. TokenSet shape: accessToken, refreshToken, expiresAt, metadata.email
//   4. Token refresh flow with updated access token
//   5. Disconnect/revoke flow with mocked revoke endpoint
//   6. Edge cases: missing refresh_token on refresh, invalid id_token
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ClientRequest } from 'http';
import { EventEmitter } from 'events';

import type { TokenSet, CredentialStore, ProviderStatus } from '../../credentials/types';

// ── Test fixtures ───────────────────────────────────────────────────

const TEST_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
const TEST_CLIENT_SECRET = 'test-google-client-secret';
const TEST_REDIRECT_URI = 'http://127.0.0.1:3000/oauth/google/callback';

/**
 * Build a fake JWT id_token with the given payload.
 *
 * Uses the standard three-segment structure (header.payload.signature)
 * with a valid base64url-encoded payload. The header and signature are
 * stubs since the Google adapter decodes without verification.
 */
function fakeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .toString('base64url');
  const body = Buffer.from(JSON.stringify(payload))
    .toString('base64url');
  const signature = 'fake_signature';
  return `${header}.${body}.${signature}`;
}

/**
 * Build the JSON body that Google's token endpoint returns on a
 * successful authorization code exchange.
 */
function makeGoogleTokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'ya29.test-access-token-abc123',
    refresh_token: '1//test-refresh-token-xyz789',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'https://www.googleapis.com/auth/drive.file openid email',
    id_token: fakeIdToken({
      sub: '1234567890',
      email: 'testuser@gmail.com',
      email_verified: true,
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
    }),
    ...overrides,
  };
}

/**
 * Build the JSON body for a Google token refresh response.
 *
 * Google's refresh endpoint typically omits `refresh_token` when the
 * user has already granted offline access.
 */
function makeGoogleRefreshResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'ya29.refreshed-access-token-def456',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'https://www.googleapis.com/auth/drive.file openid email',
    ...overrides,
  };
}

// ── Mock: credential store ──────────────────────────────────────────

const storedCredentials = new Map<string, TokenSet>();

const mockStore: CredentialStore = {
  backendName: 'mock',
  get: vi.fn(async (provider: string) => storedCredentials.get(provider) ?? null),
  set: vi.fn(async (provider: string, tokenSet: TokenSet) => {
    storedCredentials.set(provider, tokenSet);
  }),
  delete: vi.fn(async (provider: string) => {
    storedCredentials.delete(provider);
  }),
  list: vi.fn(async (): Promise<ProviderStatus[]> => {
    const statuses: ProviderStatus[] = [];
    for (const [provider, ts] of storedCredentials) {
      statuses.push({
        provider,
        kind: ts.kind,
        status: 'CONNECTED',
        hasRefreshToken: !!ts.refreshToken,
        expiresAt: ts.expiresAt,
      });
    }
    return statuses;
  }),
};

vi.mock('../../credentials', () => ({
  getCredentialStore: vi.fn().mockImplementation(async () => mockStore),
}));

// ── Mock: http/https to intercept postForm ──────────────────────────
//
// The engine and token-manager both use native https.request (and
// http.request) to POST form data to token endpoints. We intercept
// these calls and return controlled JSON responses.

type RequestInterceptor = (
  url: string,
  body: string,
) => { status: number; body: Record<string, unknown> };

let requestInterceptor: RequestInterceptor | null = null;

/**
 * Create a mock https/http.request implementation that calls our
 * interceptor and feeds the response through the standard Node.js
 * IncomingMessage event pattern.
 */
function createMockRequest() {
  return vi.fn((_options: unknown, callback?: (res: IncomingMessage) => void) => {
    const req = new EventEmitter() as ClientRequest & EventEmitter;
    let requestBody = '';

    // Capture the written body.
    req.write = vi.fn((chunk: string | Buffer) => {
      requestBody += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      return true;
    });

    req.end = vi.fn(() => {
      // Reconstruct the URL from the options for the interceptor.
      const opts = _options as {
        hostname?: string;
        port?: number | string;
        path?: string;
        protocol?: string;
      };
      const protocol = 'https:';
      const host = opts.hostname ?? 'unknown';
      const port = opts.port && String(opts.port) !== '443' ? `:${opts.port}` : '';
      const urlPath = opts.path ?? '/';
      const fullUrl = `${protocol}//${host}${port}${urlPath}`;

      if (!requestInterceptor) {
        const err = new Error('No request interceptor configured for test');
        req.emit('error', err);
        return;
      }

      const intercepted = requestInterceptor(fullUrl, requestBody);
      const responseJson = JSON.stringify(intercepted.body);

      // Build a fake IncomingMessage.
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = intercepted.status;
      res.headers = {
        'content-type': 'application/json',
        date: new Date().toUTCString(),
      };

      // Invoke the callback with the response, then emit data + end.
      if (callback) {
        callback(res);
      }

      // Use setImmediate to mimic async data arrival.
      setImmediate(() => {
        res.emit('data', Buffer.from(responseJson, 'utf-8'));
        res.emit('end');
      });
    });

    req.setTimeout = vi.fn((_ms: number, _cb?: () => void) => req);
    req.destroy = vi.fn(() => req);

    return req;
  });
}

const mockHttpsRequest = createMockRequest();
const mockHttpRequest = createMockRequest();

vi.mock('https', () => ({
  request: (...args: unknown[]) => mockHttpsRequest(...args),
}));

vi.mock('http', () => ({
  request: (...args: unknown[]) => mockHttpRequest(...args),
}));

// ── Lazy imports (after mocks) ──────────────────────────────────────

let startOAuthFlow: typeof import('../engine').startOAuthFlow;
let handleOAuthCallback: typeof import('../engine').handleOAuthCallback;
let disconnectProvider: typeof import('../engine').disconnectProvider;
let registerProvider: typeof import('../provider').registerProvider;
let getProvider: typeof import('../provider').getProvider;

// ═══════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════

describe('Google Drive OAuth flow (integration)', () => {
  beforeEach(async () => {
    // Reset state between tests.
    storedCredentials.clear();
    requestInterceptor = null;
    vi.mocked(mockStore.get).mockClear();
    vi.mocked(mockStore.set).mockClear();
    vi.mocked(mockStore.delete).mockClear();
    vi.mocked(mockStore.list).mockClear();
    mockHttpsRequest.mockClear();

    // Set env vars for Google client credentials.
    process.env.OAUTH_GOOGLE_CLIENT_ID = TEST_CLIENT_ID;
    process.env.OAUTH_GOOGLE_CLIENT_SECRET = TEST_CLIENT_SECRET;

    // Import modules after mocks are set up.
    const providerMod = await import('../provider');
    registerProvider = providerMod.registerProvider;
    getProvider = providerMod.getProvider;

    // Import and register the Google adapter.
    // The google.ts module calls registerProvider() on import.
    await import('../providers/google');

    const engineMod = await import('../engine');
    startOAuthFlow = engineMod.startOAuthFlow;
    handleOAuthCallback = engineMod.handleOAuthCallback;
    disconnectProvider = engineMod.disconnectProvider;
  });

  afterEach(() => {
    delete process.env.OAUTH_GOOGLE_CLIENT_ID;
    delete process.env.OAUTH_GOOGLE_CLIENT_SECRET;
    requestInterceptor = null;
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. Provider registration and authorize URL
  // ─────────────────────────────────────────────────────────────────

  describe('provider registration and authorize URL', () => {
    it('registers the google provider adapter on import', () => {
      const adapter = getProvider('google');
      expect(adapter).toBeDefined();
      expect(adapter!.name).toBe('google');
      expect(adapter!.authorizeUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(adapter!.tokenUrl).toBe('https://oauth2.googleapis.com/token');
      expect(adapter!.revokeUrl).toBe('https://oauth2.googleapis.com/revoke');
    });

    it('builds an authorize URL with Google-specific params', async () => {
      const result = await startOAuthFlow('google', TEST_REDIRECT_URI);

      expect(result.state).toHaveLength(32);
      expect(result.authorizeUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth?');

      const url = new URL(result.authorizeUrl);

      // Standard OAuth params.
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('redirect_uri')).toBe(TEST_REDIRECT_URI);
      expect(url.searchParams.get('state')).toBe(result.state);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');

      // PKCE code_challenge must be present.
      const challenge = url.searchParams.get('code_challenge');
      expect(challenge).toBeTruthy();
      expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);

      // Google-specific extra params.
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('include_granted_scopes')).toBe('true');

      // Scopes must include drive.file, openid, and email.
      const scope = url.searchParams.get('scope')!;
      expect(scope).toContain('drive.file');
      expect(scope).toContain('openid');
      expect(scope).toContain('email');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. Token exchange via handleOAuthCallback
  // ─────────────────────────────────────────────────────────────────

  describe('token exchange (handleOAuthCallback)', () => {
    it('exchanges authorization code for tokens and persists the TokenSet', async () => {
      // Start the flow to get a valid state.
      const { state } = await startOAuthFlow('google', TEST_REDIRECT_URI);

      // Intercept the POST to Google's token endpoint.
      requestInterceptor = (url, body) => {
        expect(url).toContain('oauth2.googleapis.com/token');

        // Verify the exchange body includes required fields.
        expect(body).toContain('grant_type=authorization_code');
        expect(body).toContain('code=test_auth_code_42');
        expect(body).toContain('code_verifier=');
        expect(body).toContain(`redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}`);

        return {
          status: 200,
          body: makeGoogleTokenResponse(),
        };
      };

      const result = await handleOAuthCallback(
        'test_auth_code_42',
        state,
        TEST_REDIRECT_URI,
      );

      // Verify success.
      expect(result.success).toBe(true);
      expect(result.provider).toBe('google');
      expect(result.error).toBeUndefined();

      // Verify the TokenSet shape.
      const tokenSet = result.tokenSet!;
      expect(tokenSet.kind).toBe('oauth');
      expect(tokenSet.accessToken).toBe('ya29.test-access-token-abc123');
      expect(tokenSet.refreshToken).toBe('1//test-refresh-token-xyz789');
      expect(tokenSet.expiresAt).toBeTypeOf('number');
      expect(tokenSet.expiresAt!).toBeGreaterThan(Date.now());

      // Verify metadata extracted from id_token.
      expect(tokenSet.metadata).toBeDefined();
      expect(tokenSet.metadata!.email).toBe('testuser@gmail.com');
      expect(tokenSet.metadata!.accountId).toBe('1234567890');

      // Verify scopes.
      expect(tokenSet.scopes).toContain('https://www.googleapis.com/auth/drive.file');
      expect(tokenSet.scopes).toContain('openid');
      expect(tokenSet.scopes).toContain('email');

      // Verify the token was persisted to the credential store.
      expect(mockStore.set).toHaveBeenCalledWith('google', expect.objectContaining({
        accessToken: 'ya29.test-access-token-abc123',
        refreshToken: '1//test-refresh-token-xyz789',
      }));
    });

    it('returns an error when Google returns an HTTP error', async () => {
      const { state } = await startOAuthFlow('google', TEST_REDIRECT_URI);

      requestInterceptor = () => ({
        status: 400,
        body: {
          error: 'invalid_grant',
          error_description: 'The authorization code has expired.',
        },
      });

      const result = await handleOAuthCallback(
        'expired_code',
        state,
        TEST_REDIRECT_URI,
      );

      expect(result.success).toBe(false);
      expect(result.provider).toBe('google');
      expect(result.error).toContain('authorization code has expired');
    });

    it('handles an id_token with a malformed payload gracefully', async () => {
      const { state } = await startOAuthFlow('google', TEST_REDIRECT_URI);

      requestInterceptor = () => ({
        status: 200,
        body: makeGoogleTokenResponse({
          // Malformed id_token: second segment is not valid base64 JSON.
          id_token: 'header.not_valid_base64_json.signature',
        }),
      });

      const result = await handleOAuthCallback(
        'code_with_bad_jwt',
        state,
        TEST_REDIRECT_URI,
      );

      // Should still succeed -- id_token decoding is best-effort.
      expect(result.success).toBe(true);
      expect(result.tokenSet!.accessToken).toBe('ya29.test-access-token-abc123');
      // Metadata may be empty since id_token decoding failed.
      // No email or accountId should be present.
      expect(result.tokenSet!.metadata?.email).toBeUndefined();
    });

    it('handles a response without an id_token', async () => {
      const { state } = await startOAuthFlow('google', TEST_REDIRECT_URI);

      const responseWithoutIdToken = makeGoogleTokenResponse();
      delete responseWithoutIdToken.id_token;

      requestInterceptor = () => ({
        status: 200,
        body: responseWithoutIdToken,
      });

      const result = await handleOAuthCallback(
        'code_no_id_token',
        state,
        TEST_REDIRECT_URI,
      );

      expect(result.success).toBe(true);
      expect(result.tokenSet!.accessToken).toBe('ya29.test-access-token-abc123');
      expect(result.tokenSet!.refreshToken).toBe('1//test-refresh-token-xyz789');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. Token refresh flow
  // ─────────────────────────────────────────────────────────────────

  describe('token refresh flow', () => {
    let refreshFn: typeof import('../token-manager').refresh;

    beforeEach(async () => {
      const tokenManagerMod = await import('../token-manager');
      refreshFn = tokenManagerMod.refresh;

      // Seed the credential store with an existing (expired) Google token.
      const existingToken: TokenSet = {
        kind: 'oauth',
        accessToken: 'ya29.old-expired-access-token',
        refreshToken: '1//test-refresh-token-xyz789',
        expiresAt: Date.now() - 60_000, // expired 1 minute ago
        scopes: [
          'https://www.googleapis.com/auth/drive.file',
          'openid',
          'email',
        ],
        metadata: {
          email: 'testuser@gmail.com',
          accountId: '1234567890',
        },
      };
      storedCredentials.set('google', existingToken);
    });

    it('refreshes the token and preserves the existing refresh_token', async () => {
      // Google's refresh response omits refresh_token when offline access
      // was already granted.
      requestInterceptor = (url, body) => {
        expect(url).toContain('oauth2.googleapis.com/token');
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=1%2F%2Ftest-refresh-token-xyz789');

        return {
          status: 200,
          body: makeGoogleRefreshResponse(),
        };
      };

      const refreshed = await refreshFn('google');

      // New access token from the refresh response.
      expect(refreshed.accessToken).toBe('ya29.refreshed-access-token-def456');

      // The old refresh token must be preserved since the refresh
      // response did not include a new one.
      expect(refreshed.refreshToken).toBe('1//test-refresh-token-xyz789');

      // expiresAt should be in the future.
      expect(refreshed.expiresAt).toBeTypeOf('number');
      expect(refreshed.expiresAt!).toBeGreaterThan(Date.now());

      // Metadata should be preserved/merged.
      expect(refreshed.metadata?.email).toBe('testuser@gmail.com');
      expect(refreshed.metadata?._status).toBe('CONNECTED');

      // Verify the refreshed token was persisted.
      const stored = storedCredentials.get('google');
      expect(stored).toBeDefined();
      expect(stored!.accessToken).toBe('ya29.refreshed-access-token-def456');
    });

    it('updates the refresh_token when Google provides a new one', async () => {
      requestInterceptor = () => ({
        status: 200,
        body: makeGoogleRefreshResponse({
          refresh_token: '1//brand-new-refresh-token',
        }),
      });

      const refreshed = await refreshFn('google');

      expect(refreshed.refreshToken).toBe('1//brand-new-refresh-token');
      expect(storedCredentials.get('google')!.refreshToken).toBe('1//brand-new-refresh-token');
    });

    it('throws on terminal error (invalid_grant) and marks RE_AUTH_REQUIRED', async () => {
      requestInterceptor = () => ({
        status: 400,
        body: {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        },
      });

      await expect(refreshFn('google')).rejects.toThrow('invalid_grant');

      // The token manager should mark the provider as RE_AUTH_REQUIRED.
      const stored = storedCredentials.get('google');
      expect(stored).toBeDefined();
      expect(stored!.metadata?._status).toBe('RE_AUTH_REQUIRED');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Disconnect / revoke flow
  // ─────────────────────────────────────────────────────────────────

  describe('disconnect / revoke flow', () => {
    beforeEach(() => {
      // Seed the credential store with a connected Google token.
      const existingToken: TokenSet = {
        kind: 'oauth',
        accessToken: 'ya29.connected-access-token',
        refreshToken: '1//connected-refresh-token',
        expiresAt: Date.now() + 3_600_000,
        scopes: [
          'https://www.googleapis.com/auth/drive.file',
          'openid',
          'email',
        ],
        metadata: {
          email: 'testuser@gmail.com',
        },
      };
      storedCredentials.set('google', existingToken);
    });

    it('revokes the refresh token and deletes credentials from the store', async () => {
      let revokeUrl = '';
      let revokeBody = '';

      requestInterceptor = (url, body) => {
        revokeUrl = url;
        revokeBody = body;
        return {
          status: 200,
          body: {},
        };
      };

      await disconnectProvider('google');

      // Verify the revoke request was sent to Google's revoke endpoint.
      expect(revokeUrl).toContain('oauth2.googleapis.com/revoke');

      // Google's buildRevokeBody sends the refresh token (preferred over
      // access token) as a bare `token` parameter.
      expect(revokeBody).toContain('token=1%2F%2Fconnected-refresh-token');

      // Verify credentials were deleted from the store.
      expect(mockStore.delete).toHaveBeenCalledWith('google');
      expect(storedCredentials.has('google')).toBe(false);
    });

    it('deletes credentials even when revocation endpoint returns an error', async () => {
      requestInterceptor = () => ({
        status: 400,
        body: { error: 'invalid_token' },
      });

      // Should not throw -- revocation is best-effort.
      await expect(disconnectProvider('google')).resolves.toBeUndefined();

      // Credentials should still be deleted despite revocation failure.
      expect(mockStore.delete).toHaveBeenCalledWith('google');
      expect(storedCredentials.has('google')).toBe(false);
    });

    it('deletes credentials even when revocation endpoint is unreachable', async () => {
      // Simulate a network error by having the interceptor throw.
      requestInterceptor = () => {
        throw new Error('ECONNREFUSED');
      };

      await expect(disconnectProvider('google')).resolves.toBeUndefined();

      expect(mockStore.delete).toHaveBeenCalledWith('google');
      expect(storedCredentials.has('google')).toBe(false);
    });

    it('revokes the access token when no refresh token is available', async () => {
      // Replace with a token that has no refresh token.
      storedCredentials.set('google', {
        kind: 'oauth',
        accessToken: 'ya29.access-only-token',
        expiresAt: Date.now() + 3_600_000,
      });

      let revokeBody = '';

      requestInterceptor = (_url, body) => {
        revokeBody = body;
        return { status: 200, body: {} };
      };

      await disconnectProvider('google');

      // Should revoke the access token since no refresh token exists.
      expect(revokeBody).toContain('token=ya29.access-only-token');
      expect(mockStore.delete).toHaveBeenCalledWith('google');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. Google adapter - parseTokenResponse edge cases
  // ─────────────────────────────────────────────────────────────────

  describe('parseTokenResponse edge cases', () => {
    it('parses scopes from a space-separated string', () => {
      const adapter = getProvider('google')!;
      const partial = adapter.parseTokenResponse({
        access_token: 'ya29.test',
        scope: 'https://www.googleapis.com/auth/drive.file openid',
        expires_in: 3600,
      });

      expect(partial.scopes).toEqual([
        'https://www.googleapis.com/auth/drive.file',
        'openid',
      ]);
    });

    it('handles missing scope field', () => {
      const adapter = getProvider('google')!;
      const partial = adapter.parseTokenResponse({
        access_token: 'ya29.test',
        expires_in: 3600,
      });

      expect(partial.scopes).toBeUndefined();
    });

    it('computes expiresAt from expires_in', () => {
      const before = Date.now();
      const adapter = getProvider('google')!;
      const partial = adapter.parseTokenResponse({
        access_token: 'ya29.test',
        expires_in: 3600,
      });
      const after = Date.now();

      expect(partial.expiresAt).toBeTypeOf('number');
      // expiresAt should be approximately now + 3600s.
      expect(partial.expiresAt!).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(partial.expiresAt!).toBeLessThanOrEqual(after + 3600 * 1000);
    });

    it('extracts email and sub from id_token payload', () => {
      const adapter = getProvider('google')!;
      const partial = adapter.parseTokenResponse({
        access_token: 'ya29.test',
        id_token: fakeIdToken({
          sub: '999888777',
          email: 'admin@example.com',
        }),
      });

      expect(partial.metadata!.email).toBe('admin@example.com');
      expect(partial.metadata!.accountId).toBe('999888777');
    });

    it('builds correct refresh body with client_id and client_secret', () => {
      const adapter = getProvider('google')!;
      const body = adapter.buildRefreshBody('1//my-refresh-token');

      expect(body.grant_type).toBe('refresh_token');
      expect(body.refresh_token).toBe('1//my-refresh-token');
      expect(body.client_id).toBeTruthy();
    });

    it('builds correct revoke body with bare token parameter', () => {
      const adapter = getProvider('google')!;
      const body = adapter.buildRevokeBody!('ya29.token-to-revoke');

      expect(body).toEqual({ token: 'ya29.token-to-revoke' });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. Full round-trip: start -> callback -> refresh -> disconnect
  // ─────────────────────────────────────────────────────────────────

  describe('full round-trip lifecycle', () => {
    let refreshFn: typeof import('../token-manager').refresh;

    beforeEach(async () => {
      const tokenManagerMod = await import('../token-manager');
      refreshFn = tokenManagerMod.refresh;
    });

    it('completes the entire OAuth lifecycle: authorize -> exchange -> refresh -> revoke', async () => {
      // Step 1: Start the OAuth flow.
      const { state, authorizeUrl } = await startOAuthFlow('google', TEST_REDIRECT_URI);
      expect(authorizeUrl).toContain('accounts.google.com');
      expect(state).toBeTruthy();

      // Step 2: Exchange authorization code for tokens.
      requestInterceptor = () => ({
        status: 200,
        body: makeGoogleTokenResponse(),
      });

      const callbackResult = await handleOAuthCallback(
        'auth_code_lifecycle',
        state,
        TEST_REDIRECT_URI,
      );

      expect(callbackResult.success).toBe(true);
      expect(callbackResult.tokenSet!.accessToken).toBe('ya29.test-access-token-abc123');
      expect(callbackResult.tokenSet!.metadata!.email).toBe('testuser@gmail.com');

      // Verify the token was persisted.
      const persisted = storedCredentials.get('google');
      expect(persisted).toBeDefined();
      expect(persisted!.accessToken).toBe('ya29.test-access-token-abc123');

      // Step 3: Simulate token expiry and refresh.
      // Manually expire the stored token.
      storedCredentials.set('google', {
        ...persisted!,
        expiresAt: Date.now() - 60_000, // expired
      });

      requestInterceptor = () => ({
        status: 200,
        body: makeGoogleRefreshResponse(),
      });

      const refreshed = await refreshFn('google');
      expect(refreshed.accessToken).toBe('ya29.refreshed-access-token-def456');
      expect(refreshed.refreshToken).toBe('1//test-refresh-token-xyz789');

      // Step 4: Disconnect and revoke.
      let revokeRequested = false;
      requestInterceptor = () => {
        revokeRequested = true;
        return { status: 200, body: {} };
      };

      await disconnectProvider('google');

      expect(revokeRequested).toBe(true);
      expect(storedCredentials.has('google')).toBe(false);
    });
  });
});
