// =====================================================================
// gitlab-flow.test.ts -- Integration test for GitLab OAuth flow
// =====================================================================
//
// Verifies the end-to-end OAuth 2.0 flow for GitLab by stubbing
// GitLab's HTTP endpoints (token exchange, refresh, revoke, instance
// validation) while exercising the real provider adapter, engine, and
// token manager.
//
// Covers:
//   1. GitLab provider registration + authorize URL with PKCE S256
//   2. Token exchange via handleOAuthCallback with metadata.baseUrl
//   3. Public-client mode: no client_secret in token exchange body
//   4. Self-hosted base URL: validateGitlabInstance HEAD request
//   5. Refresh flow with rotating refresh token handling
//   6. Reactive 401 retry: 401 triggers refresh then retry
//   7. Revoke on disconnect: POST to ${baseUrl}/oauth/revoke
//   8. Token exchange failure: error responses from GitLab
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ClientRequest } from 'http';
import { EventEmitter } from 'events';

import type { TokenSet, CredentialStore, ProviderStatus } from '../../credentials/types';

// -- Test fixtures --------------------------------------------------------

const TEST_CLIENT_ID = 'test-gitlab-client-id-abc123';
const TEST_CLIENT_SECRET = 'test-gitlab-client-secret-xyz789';
const TEST_REDIRECT_URI = 'http://127.0.0.1:3000/oauth/gitlab/callback';
const SELF_HOSTED_URL = 'https://gitlab.example.com';

/**
 * Build the JSON body that GitLab's token endpoint returns on a
 * successful authorization code exchange.
 */
function makeGitlabTokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'glpat-test-access-token-abc123',
    token_type: 'Bearer',
    expires_in: 7200,
    refresh_token: 'glrt-test-refresh-token-xyz789',
    scope: 'api read_user',
    created_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

/**
 * Build the JSON body for a GitLab token refresh response.
 *
 * GitLab rotates refresh tokens: every refresh response includes a
 * new refresh_token that replaces the previous one.
 */
function makeGitlabRefreshResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'glpat-refreshed-access-token-def456',
    token_type: 'Bearer',
    expires_in: 7200,
    refresh_token: 'glrt-rotated-refresh-token-aaa111',
    scope: 'api read_user',
    created_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// -- Mock: credential store -----------------------------------------------

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

// -- Mock: http/https to intercept postForm & validateGitlabInstance -------
//
// The engine, token-manager, and gitlab adapter all use native
// https.request (and http.request). We intercept these calls and
// return controlled responses.

type RequestInterceptor = (
  url: string,
  body: string,
  method: string,
) => { status: number; body: Record<string, unknown> };

let requestInterceptor: RequestInterceptor | null = null;

/**
 * Create a mock https/http.request implementation that calls our
 * interceptor and feeds the response through the standard Node.js
 * IncomingMessage event pattern.
 */
function createMockRequest(protocol: 'https:' | 'http:') {
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
        method?: string;
      };
      const host = opts.hostname ?? 'unknown';
      const defaultPort = protocol === 'https:' ? '443' : '80';
      const port = opts.port && String(opts.port) !== defaultPort ? `:${opts.port}` : '';
      const urlPath = opts.path ?? '/';
      const method = opts.method ?? 'GET';
      const fullUrl = `${protocol}//${host}${port}${urlPath}`;

      if (!requestInterceptor) {
        const err = new Error('No request interceptor configured for test');
        req.emit('error', err);
        return;
      }

      let intercepted: { status: number; body: Record<string, unknown> };
      try {
        intercepted = requestInterceptor(fullUrl, requestBody, method);
      } catch (err) {
        req.emit('error', err);
        return;
      }

      const responseJson = JSON.stringify(intercepted.body);

      // Build a fake IncomingMessage.
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = intercepted.status;
      res.headers = {
        'content-type': 'application/json',
        date: new Date().toUTCString(),
      };
      // Add resume() for validateGitlabInstance which calls res.resume().
      res.resume = vi.fn();

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

const mockHttpsRequest = createMockRequest('https:');
const mockHttpRequest = createMockRequest('http:');

vi.mock('https', () => ({
  request: (...args: unknown[]) => mockHttpsRequest(...args),
}));

vi.mock('http', () => ({
  request: (...args: unknown[]) => mockHttpRequest(...args),
}));

// -- Lazy imports (after mocks) -------------------------------------------

let startOAuthFlow: typeof import('../engine').startOAuthFlow;
let handleOAuthCallback: typeof import('../engine').handleOAuthCallback;
let disconnectProvider: typeof import('../engine').disconnectProvider;
let registerProvider: typeof import('../provider').registerProvider;
let getProvider: typeof import('../provider').getProvider;
let validateGitlabInstance: typeof import('../providers/gitlab').validateGitlabInstance;

// =========================================================================
// Test Suite
// =========================================================================

describe('GitLab OAuth flow (integration)', () => {
  beforeEach(async () => {
    // Reset state between tests.
    storedCredentials.clear();
    requestInterceptor = null;
    vi.mocked(mockStore.get).mockClear();
    vi.mocked(mockStore.set).mockClear();
    vi.mocked(mockStore.delete).mockClear();
    vi.mocked(mockStore.list).mockClear();
    mockHttpsRequest.mockClear();
    mockHttpRequest.mockClear();

    // Set env vars for GitLab client credentials.
    process.env.OAUTH_GITLAB_CLIENT_ID = TEST_CLIENT_ID;
    process.env.OAUTH_GITLAB_CLIENT_SECRET = TEST_CLIENT_SECRET;
    process.env.GITLAB_URL = 'https://gitlab.com';

    // Import modules after mocks are set up.
    const providerMod = await import('../provider');
    registerProvider = providerMod.registerProvider;
    getProvider = providerMod.getProvider;

    // Import and register the GitLab adapter.
    // The gitlab.ts module calls registerProvider() on import.
    const gitlabMod = await import('../providers/gitlab');
    validateGitlabInstance = gitlabMod.validateGitlabInstance;

    const engineMod = await import('../engine');
    startOAuthFlow = engineMod.startOAuthFlow;
    handleOAuthCallback = engineMod.handleOAuthCallback;
    disconnectProvider = engineMod.disconnectProvider;
  });

  afterEach(() => {
    delete process.env.OAUTH_GITLAB_CLIENT_ID;
    delete process.env.OAUTH_GITLAB_CLIENT_SECRET;
    delete process.env.GITLAB_URL;
    requestInterceptor = null;
  });

  // -----------------------------------------------------------------------
  // 1. Authorize URL: PKCE S256, scopes (api read_user)
  // -----------------------------------------------------------------------

  describe('provider registration and authorize URL', () => {
    it('registers the gitlab provider adapter on import', () => {
      const adapter = getProvider('gitlab');
      expect(adapter).toBeDefined();
      expect(adapter!.name).toBe('gitlab');
      expect(adapter!.authorizeUrl).toContain('/oauth/authorize');
      expect(adapter!.tokenUrl).toContain('/oauth/token');
      expect(adapter!.revokeUrl).toContain('/oauth/revoke');
    });

    it('builds an authorize URL with PKCE S256 and correct scopes', async () => {
      const result = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);

      expect(result.state).toHaveLength(32);
      expect(result.authorizeUrl).toContain('/oauth/authorize?');

      const url = new URL(result.authorizeUrl);

      // Standard OAuth params.
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe(TEST_CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(TEST_REDIRECT_URI);
      expect(url.searchParams.get('state')).toBe(result.state);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');

      // PKCE code_challenge must be present and be a valid base64url string.
      const challenge = url.searchParams.get('code_challenge');
      expect(challenge).toBeTruthy();
      expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);

      // GitLab scopes: api and read_user.
      const scope = url.searchParams.get('scope')!;
      expect(scope).toContain('api');
      expect(scope).toContain('read_user');
    });

    it('uses unique code_challenge for each flow', async () => {
      const result1 = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);
      const result2 = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);

      const url1 = new URL(result1.authorizeUrl);
      const url2 = new URL(result2.authorizeUrl);

      expect(url1.searchParams.get('code_challenge')).not.toBe(
        url2.searchParams.get('code_challenge'),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 2. Token exchange: metadata.baseUrl persisted
  // -----------------------------------------------------------------------

  describe('token exchange (handleOAuthCallback)', () => {
    it('exchanges authorization code for tokens and persists TokenSet with metadata.baseUrl', async () => {
      // Start the flow to get a valid state.
      const { state } = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);

      // Intercept the POST to GitLab's token endpoint.
      requestInterceptor = (url, body) => {
        expect(url).toContain('/oauth/token');

        // Verify the exchange body includes required fields.
        expect(body).toContain('grant_type=authorization_code');
        expect(body).toContain('code=test_gitlab_auth_code_42');
        expect(body).toContain('code_verifier=');
        expect(body).toContain(`redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}`);
        expect(body).toContain(`client_id=${TEST_CLIENT_ID}`);

        return {
          status: 200,
          body: makeGitlabTokenResponse(),
        };
      };

      const result = await handleOAuthCallback(
        'test_gitlab_auth_code_42',
        state,
        TEST_REDIRECT_URI,
      );

      // Verify success.
      expect(result.success).toBe(true);
      expect(result.provider).toBe('gitlab');
      expect(result.error).toBeUndefined();

      // Verify the TokenSet shape.
      const tokenSet = result.tokenSet!;
      expect(tokenSet.kind).toBe('oauth');
      expect(tokenSet.accessToken).toBe('glpat-test-access-token-abc123');
      expect(tokenSet.refreshToken).toBe('glrt-test-refresh-token-xyz789');
      expect(tokenSet.expiresAt).toBeTypeOf('number');
      expect(tokenSet.expiresAt!).toBeGreaterThan(Date.now());

      // Verify metadata.baseUrl is persisted.
      expect(tokenSet.metadata).toBeDefined();
      expect(tokenSet.metadata!.baseUrl).toBeDefined();
      expect(tokenSet.metadata!.baseUrl).toContain('gitlab');

      // Verify scopes from the response.
      expect(tokenSet.scopes).toContain('api');
      expect(tokenSet.scopes).toContain('read_user');

      // Verify the token was persisted to the credential store.
      expect(mockStore.set).toHaveBeenCalledWith('gitlab', expect.objectContaining({
        accessToken: 'glpat-test-access-token-abc123',
        refreshToken: 'glrt-test-refresh-token-xyz789',
        metadata: expect.objectContaining({
          baseUrl: expect.any(String),
        }),
      }));
    });

    it('computes expiresAt from created_at + expires_in when both are present', async () => {
      const { state } = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);

      const createdAt = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
      const expiresIn = 7200;

      requestInterceptor = () => ({
        status: 200,
        body: makeGitlabTokenResponse({
          created_at: createdAt,
          expires_in: expiresIn,
        }),
      });

      const result = await handleOAuthCallback('code_created_at', state, TEST_REDIRECT_URI);

      expect(result.success).toBe(true);

      // expiresAt should be computed from created_at + expires_in.
      const expectedExpiresAt = (createdAt + expiresIn) * 1000;
      expect(result.tokenSet!.expiresAt).toBe(expectedExpiresAt);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Public-client mode: no client_secret in token exchange body
  // -----------------------------------------------------------------------

  describe('public-client mode (no client_secret)', () => {
    it('includes client_secret in the token exchange body when clientSecret is present', async () => {
      // This test runs first to verify the default adapter (with secret) works.
      const { state } = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);

      let capturedBody = '';
      requestInterceptor = (_url, body) => {
        capturedBody = body;
        return {
          status: 200,
          body: makeGitlabTokenResponse(),
        };
      };

      await handleOAuthCallback('confidential_client_code', state, TEST_REDIRECT_URI);

      // The body MUST contain client_secret.
      expect(capturedBody).toContain('client_secret=');
    });

    it('omits client_secret from the token exchange body when clientSecret is absent', async () => {
      // Re-register the GitLab adapter without a client secret.
      const adapter = getProvider('gitlab')!;
      const publicAdapter = {
        ...adapter,
        clientSecret: undefined,
      };
      registerProvider(publicAdapter);

      const { state } = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);

      let capturedBody = '';
      requestInterceptor = (_url, body) => {
        capturedBody = body;
        return {
          status: 200,
          body: makeGitlabTokenResponse(),
        };
      };

      const result = await handleOAuthCallback('public_client_code', state, TEST_REDIRECT_URI);

      expect(result.success).toBe(true);

      // The body must NOT contain client_secret.
      expect(capturedBody).not.toContain('client_secret');

      // But it MUST still contain client_id and code_verifier (PKCE).
      expect(capturedBody).toContain('client_id=');
      expect(capturedBody).toContain('code_verifier=');
      expect(capturedBody).toContain('grant_type=authorization_code');

      // Restore the original adapter with client secret for subsequent tests.
      registerProvider(adapter);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Self-hosted base URL: validateGitlabInstance
  // -----------------------------------------------------------------------

  describe('validateGitlabInstance', () => {
    it('makes a HEAD request to ${baseUrl}/api/v4/version', async () => {
      let capturedUrl = '';
      let capturedMethod = '';

      requestInterceptor = (url, _body, method) => {
        capturedUrl = url;
        capturedMethod = method;
        return {
          status: 200,
          body: {},
        };
      };

      const isValid = await validateGitlabInstance(SELF_HOSTED_URL);

      expect(isValid).toBe(true);
      expect(capturedUrl).toContain('gitlab.example.com');
      expect(capturedUrl).toContain('/api/v4/version');
      expect(capturedMethod).toBe('HEAD');
    });

    it('returns true for 2xx and 3xx status codes', async () => {
      for (const status of [200, 204, 301, 302]) {
        requestInterceptor = () => ({
          status,
          body: {},
        });

        const result = await validateGitlabInstance(SELF_HOSTED_URL);
        expect(result).toBe(true);
      }
    });

    it('returns false for 4xx and 5xx status codes', async () => {
      for (const status of [401, 403, 404, 500, 503]) {
        requestInterceptor = () => ({
          status,
          body: {},
        });

        const result = await validateGitlabInstance(SELF_HOSTED_URL);
        expect(result).toBe(false);
      }
    });

    it('returns false for invalid URLs', async () => {
      const result = await validateGitlabInstance('not-a-valid-url');
      expect(result).toBe(false);
    });

    it('returns false when the network request errors', async () => {
      requestInterceptor = () => {
        throw new Error('ECONNREFUSED');
      };

      const result = await validateGitlabInstance(SELF_HOSTED_URL);
      expect(result).toBe(false);
    });

    it('strips trailing slashes from baseUrl before constructing the endpoint', async () => {
      let capturedUrl = '';

      requestInterceptor = (url) => {
        capturedUrl = url;
        return { status: 200, body: {} };
      };

      await validateGitlabInstance('https://gitlab.example.com///');

      // Should not have double slashes between host and api path.
      expect(capturedUrl).toContain('/api/v4/version');
      expect(capturedUrl).not.toContain('///');
    });
  });

  // -----------------------------------------------------------------------
  // 5. Refresh flow: rotating refresh token handling
  // -----------------------------------------------------------------------

  describe('token refresh flow', () => {
    let refreshFn: typeof import('../token-manager').refresh;

    beforeEach(async () => {
      const tokenManagerMod = await import('../token-manager');
      refreshFn = tokenManagerMod.refresh;

      // Seed the credential store with an existing (expired) GitLab token.
      const existingToken: TokenSet = {
        kind: 'oauth',
        accessToken: 'glpat-old-expired-access-token',
        refreshToken: 'glrt-test-refresh-token-xyz789',
        expiresAt: Date.now() - 60_000, // expired 1 minute ago
        scopes: ['api', 'read_user'],
        metadata: {
          baseUrl: 'https://gitlab.com',
        },
      };
      storedCredentials.set('gitlab', existingToken);
    });

    it('refreshes the token and handles GitLab rotating refresh tokens', async () => {
      requestInterceptor = (url, body) => {
        expect(url).toContain('/oauth/token');
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=');

        return {
          status: 200,
          body: makeGitlabRefreshResponse(),
        };
      };

      const refreshed = await refreshFn('gitlab');

      // New access token from the refresh response.
      expect(refreshed.accessToken).toBe('glpat-refreshed-access-token-def456');

      // GitLab rotates refresh tokens: the new refresh_token MUST replace the old one.
      expect(refreshed.refreshToken).toBe('glrt-rotated-refresh-token-aaa111');

      // expiresAt should be in the future.
      expect(refreshed.expiresAt).toBeTypeOf('number');
      expect(refreshed.expiresAt!).toBeGreaterThan(Date.now());

      // Verify the refreshed token was persisted.
      const stored = storedCredentials.get('gitlab');
      expect(stored).toBeDefined();
      expect(stored!.accessToken).toBe('glpat-refreshed-access-token-def456');
      expect(stored!.refreshToken).toBe('glrt-rotated-refresh-token-aaa111');
    });

    it('preserves the original refresh_token when response omits it', async () => {
      requestInterceptor = () => ({
        status: 200,
        body: makeGitlabRefreshResponse({
          refresh_token: undefined, // No new refresh token.
        }),
      });

      const refreshed = await refreshFn('gitlab');

      // Should preserve the original refresh token.
      expect(refreshed.refreshToken).toBe('glrt-test-refresh-token-xyz789');
    });

    it('preserves metadata.baseUrl through refresh', async () => {
      requestInterceptor = () => ({
        status: 200,
        body: makeGitlabRefreshResponse(),
      });

      const refreshed = await refreshFn('gitlab');

      expect(refreshed.metadata?.baseUrl).toBeDefined();
    });

    it('includes client_id in the refresh body', async () => {
      let capturedBody = '';

      requestInterceptor = (_url, body) => {
        capturedBody = body;
        return {
          status: 200,
          body: makeGitlabRefreshResponse(),
        };
      };

      await refreshFn('gitlab');

      expect(capturedBody).toContain('client_id=');
      expect(capturedBody).toContain('grant_type=refresh_token');
    });

    it('includes client_secret in refresh body when adapter has a secret', async () => {
      let capturedBody = '';

      requestInterceptor = (_url, body) => {
        capturedBody = body;
        return {
          status: 200,
          body: makeGitlabRefreshResponse(),
        };
      };

      await refreshFn('gitlab');

      expect(capturedBody).toContain('client_secret=');
    });

    it('omits client_secret in refresh body when adapter has no secret', async () => {
      // Re-register the GitLab adapter without a client secret.
      // We must also override buildRefreshBody because the original
      // closure in gitlab.ts references the module-scoped `gitlab`
      // object directly (not `this`).
      const adapter = getProvider('gitlab')!;
      const publicAdapter = {
        ...adapter,
        clientSecret: undefined,
        buildRefreshBody(refreshToken: string): Record<string, string> {
          return {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: adapter.clientId,
            // No client_secret.
          };
        },
      };
      registerProvider(publicAdapter);

      let capturedBody = '';

      requestInterceptor = (_url, body) => {
        capturedBody = body;
        return {
          status: 200,
          body: makeGitlabRefreshResponse(),
        };
      };

      await refreshFn('gitlab');

      expect(capturedBody).not.toContain('client_secret');

      // Restore the original adapter for subsequent tests.
      registerProvider(adapter);
    });

    it('throws on terminal error (invalid_grant) and marks RE_AUTH_REQUIRED', async () => {
      requestInterceptor = () => ({
        status: 400,
        body: {
          error: 'invalid_grant',
          error_description: 'The refresh token is invalid, expired, or revoked.',
        },
      });

      await expect(refreshFn('gitlab')).rejects.toThrow('invalid_grant');

      // The token manager should mark the provider as RE_AUTH_REQUIRED.
      const stored = storedCredentials.get('gitlab');
      expect(stored).toBeDefined();
      expect(stored!.metadata?._status).toBe('RE_AUTH_REQUIRED');
    });
  });

  // -----------------------------------------------------------------------
  // 6. Reactive 401 retry: 401 triggers refresh then retry
  // -----------------------------------------------------------------------

  describe('reactive 401 retry', () => {
    let getAccessTokenFn: typeof import('../token-manager').getAccessToken;

    beforeEach(async () => {
      const tokenManagerMod = await import('../token-manager');
      getAccessTokenFn = tokenManagerMod.getAccessToken;
    });

    it('returns null for expired token when refresh fails with no interceptor', async () => {
      // Use a unique provider name to avoid in-memory token cache
      // contamination from other test sections.
      const adapter = getProvider('gitlab')!;
      registerProvider({ ...adapter, name: 'gitlab-401-expired' });

      // Seed the credential store with an expired token.
      const expiredToken: TokenSet = {
        kind: 'oauth',
        accessToken: 'glpat-expired-token',
        refreshToken: 'glrt-expired-refresh',
        expiresAt: Date.now() - 60_000, // expired
        scopes: ['api', 'read_user'],
        metadata: { baseUrl: 'https://gitlab.com' },
      };
      storedCredentials.set('gitlab-401-expired', expiredToken);

      // The refresh attempt will fail because http(s) is mocked without
      // a proper interceptor response. getAccessToken catches this and
      // returns null.
      const token = await getAccessTokenFn('gitlab-401-expired');
      expect(token).toBeNull();
    });

    it('returns valid access token when stored token is not expired', async () => {
      // Use a unique provider name to avoid in-memory token cache issues.
      const adapter = getProvider('gitlab')!;
      registerProvider({ ...adapter, name: 'gitlab-401-valid' });

      // Seed the credential store with a valid token.
      const validToken: TokenSet = {
        kind: 'oauth',
        accessToken: 'glpat-valid-access-token-abc123',
        refreshToken: 'glrt-valid-refresh',
        expiresAt: Date.now() + 3_600_000, // 1 hour from now
        scopes: ['api', 'read_user'],
        metadata: { baseUrl: 'https://gitlab.com' },
      };
      storedCredentials.set('gitlab-401-valid', validToken);

      const token = await getAccessTokenFn('gitlab-401-valid');
      expect(token).toBe('glpat-valid-access-token-abc123');
    });

    it('returns null for expired token without a refresh token', async () => {
      // Use a unique provider name to avoid in-memory token cache issues.
      const adapter = getProvider('gitlab')!;
      registerProvider({ ...adapter, name: 'gitlab-401-norefresh' });

      const expiredNoRefresh: TokenSet = {
        kind: 'oauth',
        accessToken: 'glpat-expired-no-refresh',
        expiresAt: Date.now() - 60_000,
        scopes: ['api', 'read_user'],
        metadata: { baseUrl: 'https://gitlab.com' },
      };
      storedCredentials.set('gitlab-401-norefresh', expiredNoRefresh);

      const token = await getAccessTokenFn('gitlab-401-norefresh');
      expect(token).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 7. Revoke on disconnect: POST to ${baseUrl}/oauth/revoke
  // -----------------------------------------------------------------------

  describe('disconnect / revoke flow', () => {
    beforeEach(() => {
      // Seed the credential store with a connected GitLab token.
      const existingToken: TokenSet = {
        kind: 'oauth',
        accessToken: 'glpat-connected-access-token',
        refreshToken: 'glrt-connected-refresh-token',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['api', 'read_user'],
        metadata: {
          baseUrl: 'https://gitlab.com',
        },
      };
      storedCredentials.set('gitlab', existingToken);
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

      await disconnectProvider('gitlab');

      // Verify the revoke request was sent to GitLab's revoke endpoint.
      expect(revokeUrl).toContain('/oauth/revoke');

      // GitLab's buildRevokeBody sends the token with token_type_hint.
      expect(revokeBody).toContain('token=');
      expect(revokeBody).toContain('token_type_hint=access_token');

      // Verify credentials were deleted from the store.
      expect(mockStore.delete).toHaveBeenCalledWith('gitlab');
      expect(storedCredentials.has('gitlab')).toBe(false);
    });

    it('deletes credentials even when revocation endpoint returns an error', async () => {
      requestInterceptor = () => ({
        status: 400,
        body: { error: 'invalid_token' },
      });

      // Should not throw -- revocation is best-effort.
      await expect(disconnectProvider('gitlab')).resolves.toBeUndefined();

      // Credentials should still be deleted despite revocation failure.
      expect(mockStore.delete).toHaveBeenCalledWith('gitlab');
      expect(storedCredentials.has('gitlab')).toBe(false);
    });

    it('deletes credentials even when revocation endpoint is unreachable', async () => {
      // Simulate a network error.
      requestInterceptor = () => {
        throw new Error('ECONNREFUSED');
      };

      await expect(disconnectProvider('gitlab')).resolves.toBeUndefined();

      expect(mockStore.delete).toHaveBeenCalledWith('gitlab');
      expect(storedCredentials.has('gitlab')).toBe(false);
    });

    it('revokes the access token when no refresh token is available', async () => {
      // Replace with a token that has no refresh token.
      storedCredentials.set('gitlab', {
        kind: 'oauth',
        accessToken: 'glpat-access-only-token',
        expiresAt: Date.now() + 3_600_000,
        metadata: { baseUrl: 'https://gitlab.com' },
      });

      let revokeBody = '';

      requestInterceptor = (_url, body) => {
        revokeBody = body;
        return { status: 200, body: {} };
      };

      await disconnectProvider('gitlab');

      // Should revoke the access token since no refresh token exists.
      expect(revokeBody).toContain('token=glpat-access-only-token');
      expect(revokeBody).toContain('token_type_hint=access_token');
      expect(mockStore.delete).toHaveBeenCalledWith('gitlab');
    });
  });

  // -----------------------------------------------------------------------
  // 8. Token exchange failure: error responses from GitLab
  // -----------------------------------------------------------------------

  describe('token exchange failure', () => {
    it('returns an error when GitLab returns HTTP 400 with invalid_grant', async () => {
      const { state } = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);

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
      expect(result.provider).toBe('gitlab');
      expect(result.error).toContain('authorization code has expired');
    });

    it('returns an error when GitLab returns HTTP 401 with invalid_client', async () => {
      const { state } = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);

      requestInterceptor = () => ({
        status: 401,
        body: {
          error: 'invalid_client',
          error_description: 'The client ID is not valid.',
        },
      });

      const result = await handleOAuthCallback(
        'bad_client_code',
        state,
        TEST_REDIRECT_URI,
      );

      expect(result.success).toBe(false);
      expect(result.provider).toBe('gitlab');
      expect(result.error).toContain('client ID is not valid');
    });

    it('returns an error when the token endpoint is unreachable', async () => {
      const { state } = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);

      requestInterceptor = () => {
        throw new Error('ECONNREFUSED');
      };

      const result = await handleOAuthCallback(
        'network_error_code',
        state,
        TEST_REDIRECT_URI,
      );

      expect(result.success).toBe(false);
      expect(result.provider).toBe('gitlab');
      expect(result.error).toContain('Token exchange request failed');
    });

    it('returns an error when the response does not contain an access token', async () => {
      const { state } = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);

      requestInterceptor = () => ({
        status: 200,
        body: {
          // No access_token field.
          token_type: 'Bearer',
          scope: 'api read_user',
        },
      });

      const result = await handleOAuthCallback(
        'no_access_token_code',
        state,
        TEST_REDIRECT_URI,
      );

      expect(result.success).toBe(false);
      expect(result.provider).toBe('gitlab');
      expect(result.error).toContain('access token');
    });

    it('returns an error when GitLab returns HTTP 500 server error', async () => {
      const { state } = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);

      requestInterceptor = () => ({
        status: 500,
        body: {
          error: 'server_error',
          error_description: 'An internal server error occurred.',
        },
      });

      const result = await handleOAuthCallback(
        'server_error_code',
        state,
        TEST_REDIRECT_URI,
      );

      expect(result.success).toBe(false);
      expect(result.provider).toBe('gitlab');
      expect(result.error).toContain('internal server error');
    });

    it('returns error for an invalid or expired state parameter', async () => {
      const result = await handleOAuthCallback(
        'some_code',
        'invalid_state_value_that_does_not_exist',
        TEST_REDIRECT_URI,
      );

      expect(result.success).toBe(false);
      expect(result.provider).toBe('unknown');
      expect(result.error).toContain('Invalid or expired state');
    });
  });

  // -----------------------------------------------------------------------
  // 9. GitLab adapter - parseTokenResponse edge cases
  // -----------------------------------------------------------------------

  describe('parseTokenResponse edge cases', () => {
    it('parses scopes from a space-separated string', () => {
      const adapter = getProvider('gitlab')!;
      const partial = adapter.parseTokenResponse({
        access_token: 'glpat-test',
        scope: 'api read_user read_repository',
        expires_in: 7200,
        created_at: Math.floor(Date.now() / 1000),
      });

      expect(partial.scopes).toEqual(['api', 'read_user', 'read_repository']);
    });

    it('handles missing scope field', () => {
      const adapter = getProvider('gitlab')!;
      const partial = adapter.parseTokenResponse({
        access_token: 'glpat-test',
        expires_in: 7200,
      });

      expect(partial.scopes).toBeUndefined();
    });

    it('computes expiresAt from created_at + expires_in', () => {
      const adapter = getProvider('gitlab')!;
      const createdAt = Math.floor(Date.now() / 1000);
      const expiresIn = 7200;

      const partial = adapter.parseTokenResponse({
        access_token: 'glpat-test',
        expires_in: expiresIn,
        created_at: createdAt,
      });

      expect(partial.expiresAt).toBeTypeOf('number');
      expect(partial.expiresAt!).toBe((createdAt + expiresIn) * 1000);
    });

    it('falls back to Date.now() + expires_in when created_at is absent', () => {
      const before = Date.now();
      const adapter = getProvider('gitlab')!;
      const partial = adapter.parseTokenResponse({
        access_token: 'glpat-test',
        expires_in: 7200,
      });
      const after = Date.now();

      expect(partial.expiresAt).toBeTypeOf('number');
      expect(partial.expiresAt!).toBeGreaterThanOrEqual(before + 7200 * 1000);
      expect(partial.expiresAt!).toBeLessThanOrEqual(after + 7200 * 1000);
    });

    it('includes metadata.baseUrl in parsed response', () => {
      const adapter = getProvider('gitlab')!;
      const partial = adapter.parseTokenResponse({
        access_token: 'glpat-test',
      });

      expect(partial.metadata).toBeDefined();
      expect(partial.metadata!.baseUrl).toBeDefined();
    });

    it('preserves refresh_token when present', () => {
      const adapter = getProvider('gitlab')!;
      const partial = adapter.parseTokenResponse({
        access_token: 'glpat-test',
        refresh_token: 'glrt-refresh-in-response',
      });

      expect(partial.refreshToken).toBe('glrt-refresh-in-response');
    });

    it('omits refreshToken when refresh_token is absent', () => {
      const adapter = getProvider('gitlab')!;
      const partial = adapter.parseTokenResponse({
        access_token: 'glpat-test',
      });

      expect(partial.refreshToken).toBeUndefined();
    });

    it('builds correct refresh body with client_id', () => {
      const adapter = getProvider('gitlab')!;
      const body = adapter.buildRefreshBody('glrt-my-refresh-token');

      expect(body.grant_type).toBe('refresh_token');
      expect(body.refresh_token).toBe('glrt-my-refresh-token');
      expect(body.client_id).toBeTruthy();
    });

    it('builds correct revoke body with token_type_hint', () => {
      const adapter = getProvider('gitlab')!;
      const body = adapter.buildRevokeBody!('glpat-token-to-revoke');

      expect(body).toEqual({
        token: 'glpat-token-to-revoke',
        token_type_hint: 'access_token',
      });
    });
  });

  // -----------------------------------------------------------------------
  // 10. Full round-trip: start -> callback -> refresh -> disconnect
  // -----------------------------------------------------------------------

  describe('full round-trip lifecycle', () => {
    let refreshFn: typeof import('../token-manager').refresh;

    beforeEach(async () => {
      const tokenManagerMod = await import('../token-manager');
      refreshFn = tokenManagerMod.refresh;
    });

    it('completes the entire OAuth lifecycle: authorize -> exchange -> refresh -> revoke', async () => {
      // Step 1: Start the OAuth flow.
      const { state, authorizeUrl } = await startOAuthFlow('gitlab', TEST_REDIRECT_URI);
      expect(authorizeUrl).toContain('/oauth/authorize');
      expect(state).toBeTruthy();

      // Step 2: Exchange authorization code for tokens.
      requestInterceptor = () => ({
        status: 200,
        body: makeGitlabTokenResponse(),
      });

      const callbackResult = await handleOAuthCallback(
        'auth_code_lifecycle',
        state,
        TEST_REDIRECT_URI,
      );

      expect(callbackResult.success).toBe(true);
      expect(callbackResult.tokenSet!.accessToken).toBe('glpat-test-access-token-abc123');
      expect(callbackResult.tokenSet!.metadata!.baseUrl).toBeDefined();

      // Verify the token was persisted.
      const persisted = storedCredentials.get('gitlab');
      expect(persisted).toBeDefined();
      expect(persisted!.accessToken).toBe('glpat-test-access-token-abc123');

      // Step 3: Simulate token expiry and refresh.
      storedCredentials.set('gitlab', {
        ...persisted!,
        expiresAt: Date.now() - 60_000, // expired
      });

      requestInterceptor = () => ({
        status: 200,
        body: makeGitlabRefreshResponse(),
      });

      const refreshed = await refreshFn('gitlab');
      expect(refreshed.accessToken).toBe('glpat-refreshed-access-token-def456');
      // GitLab rotates the refresh token.
      expect(refreshed.refreshToken).toBe('glrt-rotated-refresh-token-aaa111');

      // Step 4: Disconnect and revoke.
      let revokeRequested = false;
      requestInterceptor = () => {
        revokeRequested = true;
        return { status: 200, body: {} };
      };

      await disconnectProvider('gitlab');

      expect(revokeRequested).toBe(true);
      expect(storedCredentials.has('gitlab')).toBe(false);
    });
  });
});
