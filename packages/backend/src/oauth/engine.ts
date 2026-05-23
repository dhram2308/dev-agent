// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- OAuth 2.0 Authorization Code + PKCE Engine
//
// Manages the full OAuth2 authorization code flow with PKCE:
//   1. startOAuthFlow()    -- build authorize URL, store PKCE state
//   2. handleOAuthCallback() -- exchange code for tokens
//   3. disconnectProvider()  -- revoke tokens + delete credentials
//
// In-memory pending flows are keyed by `state` with a 10-minute
// TTL. A background cleanup runs every 60 seconds.
//
// HTTP token exchange uses only Node.js built-in http/https.
// ═══════════════════════════════════════════════════════════════

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import * as querystring from 'querystring';
import type { ProviderAdapter } from './provider';
import { getProvider } from './provider';
import { generateVerifier, challengeFromVerifier, generateState } from './pkce';
import { getCredentialStore } from '../credentials';
import type { TokenSet } from '../credentials/types';
import { notifyTokenStored, clearProviderCache, PAT_PROVIDER_ENV_MAP } from './token-manager';

// ═══════════════════════════════════════════════════════════════
// Pending Flow Storage
// ═══════════════════════════════════════════════════════════════

interface PendingFlow {
  provider: string;
  codeVerifier: string;
  state: string;
  createdAt: number;
}

/** Pending authorization flows keyed by state parameter. */
const pendingFlows = new Map<string, PendingFlow>();

/** TTL for pending flows: 10 minutes. */
const FLOW_TTL_MS = 10 * 60 * 1000;

/** Cleanup expired pending flows every 60 seconds. */
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [state, flow] of pendingFlows) {
    if (now - flow.createdAt > FLOW_TTL_MS) {
      pendingFlows.delete(state);
    }
  }
}, 60_000);

// Allow the Node.js process to exit even if the timer is active.
cleanupTimer.unref();

// ═══════════════════════════════════════════════════════════════
// HTTP Helper -- form-encoded POST using native http/https
// ═══════════════════════════════════════════════════════════════

/**
 * POST a form-encoded body to the given URL and return the parsed
 * JSON response.
 *
 * Selects http or https based on the URL protocol. Follows no
 * redirects (token endpoints should never redirect).
 */
function postForm(
  url: string,
  body: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> {
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
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          reject(new Error(
            `Token endpoint returned non-JSON (HTTP ${res.statusCode ?? 0}): ${raw.slice(0, 200)}`,
          ));
          return;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: parsed,
        });
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Token endpoint request failed: ${err.message}`));
    });

    // 30-second timeout for token exchange.
    req.setTimeout(30_000, () => {
      req.destroy(new Error('Token endpoint request timed out after 30s'));
    });

    req.write(encoded);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

export interface StartResult {
  /** The full authorization URL to redirect the user to. */
  authorizeUrl: string;
  /** The state parameter (also stored in the pending flow). */
  state: string;
}

/**
 * Start an OAuth2 authorization code + PKCE flow.
 *
 * Generates PKCE code verifier/challenge and a CSRF state token,
 * stores them in memory, and returns the full authorization URL.
 *
 * @param providerName - Registered provider identifier.
 * @param redirectUri  - The callback URI registered with the provider.
 * @returns The authorize URL and state token.
 * @throws If the provider is not registered.
 */
export async function startOAuthFlow(
  providerName: string,
  redirectUri: string,
): Promise<StartResult> {
  const provider = getProvider(providerName);
  if (!provider) {
    throw new Error(`OAuth provider "${providerName}" is not registered`);
  }

  const codeVerifier = generateVerifier();
  const codeChallenge = challengeFromVerifier(codeVerifier);
  const state = generateState();

  // Store pending flow for callback validation.
  pendingFlows.set(state, {
    provider: providerName,
    codeVerifier,
    state,
    createdAt: Date.now(),
  });

  // Build the authorization URL.
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: provider.defaultScopes.join(' '),
  };

  // Merge provider-specific extra params (e.g. access_type=offline).
  if (provider.extraAuthorizeParams) {
    Object.assign(params, provider.extraAuthorizeParams);
  }

  const authorizeUrl =
    provider.authorizeUrl +
    (provider.authorizeUrl.includes('?') ? '&' : '?') +
    querystring.stringify(params);

  return { authorizeUrl, state };
}

export interface CallbackResult {
  /** Whether the token exchange succeeded. */
  success: boolean;
  /** The provider name from the pending flow. */
  provider: string;
  /** Error message on failure. */
  error?: string;
  /** The persisted token set on success. */
  tokenSet?: TokenSet;
}

/**
 * Handle the OAuth2 callback: validate state, exchange authorization
 * code for tokens, and persist the resulting TokenSet.
 *
 * @param code        - The authorization code from the callback.
 * @param state       - The state parameter from the callback.
 * @param redirectUri - The same redirect URI used in the initial request.
 * @returns Callback result with success status and token set.
 */
export async function handleOAuthCallback(
  code: string,
  state: string,
  redirectUri: string,
): Promise<CallbackResult> {
  // Validate and consume the pending flow.
  const flow = pendingFlows.get(state);
  if (!flow) {
    return {
      success: false,
      provider: 'unknown',
      error: 'Invalid or expired state parameter. The OAuth flow may have timed out.',
    };
  }

  // Remove the pending flow immediately to prevent replay.
  pendingFlows.delete(state);

  // Check TTL.
  if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
    return {
      success: false,
      provider: flow.provider,
      error: 'OAuth flow expired. Please try again.',
    };
  }

  const provider = getProvider(flow.provider);
  if (!provider) {
    return {
      success: false,
      provider: flow.provider,
      error: `Provider "${flow.provider}" is no longer registered.`,
    };
  }

  // Build the token exchange body.
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    code_verifier: flow.codeVerifier,
    redirect_uri: redirectUri,
  };
  const extraHeaders: Record<string, string> = {};

  if (provider.tokenAuthMode === 'basic') {
    // Figma requires client credentials via HTTP Basic auth.
    const creds = `${provider.clientId}:${provider.clientSecret ?? ''}`;
    extraHeaders.Authorization = `Basic ${Buffer.from(creds).toString('base64')}`;
  } else {
    body.client_id = provider.clientId;
    if (provider.clientSecret) {
      body.client_secret = provider.clientSecret;
    }
  }

  // Exchange code for tokens.
  let response: Awaited<ReturnType<typeof postForm>>;
  try {
    // eslint-disable-next-line no-console
    console.log(`[oauth:${flow.provider}] POST ${provider.tokenUrl}`, {
      bodyKeys: Object.keys(body),
      authMode: provider.tokenAuthMode ?? 'body',
      hasAuthHeader: !!extraHeaders.Authorization,
      clientIdLen: provider.clientId.length,
      clientSecretLen: (provider.clientSecret ?? '').length,
      redirectUri,
    });
    response = await postForm(provider.tokenUrl, body, extraHeaders);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      provider: flow.provider,
      error: `Token exchange request failed: ${msg}`,
    };
  }

  // Check for HTTP-level errors.
  if (response.status < 200 || response.status >= 300) {
    // eslint-disable-next-line no-console
    console.log(`[oauth:${flow.provider}] token exchange failed`, {
      status: response.status,
      body: response.body,
    });
    const errDesc =
      (response.body.error_description as string) ||
      (typeof response.body.error === 'string' ? (response.body.error as string) : null) ||
      (response.body.message as string) ||
      `HTTP ${response.status}`;
    // Include the full response body in the error message for diagnostics
    // (only visible during dev — the message is shown in the UI).
    const bodyDump = JSON.stringify(response.body).slice(0, 500);
    return {
      success: false,
      provider: flow.provider,
      error: `Token exchange failed [HTTP ${response.status}]: ${errDesc} | body=${bodyDump}`,
    };
  }

  // Parse the provider-specific token response.
  const partial = provider.parseTokenResponse(response.body);

  if (!partial.accessToken) {
    return {
      success: false,
      provider: flow.provider,
      error: 'Token response did not contain an access token.',
    };
  }

  // Compute expiresAt from expires_in if the provider didn't set it.
  if (!partial.expiresAt && typeof response.body.expires_in === 'number') {
    partial.expiresAt = Date.now() + (response.body.expires_in as number) * 1000;
  }

  // Build the final TokenSet.
  const tokenSet: TokenSet = {
    kind: 'oauth',
    accessToken: partial.accessToken,
    refreshToken: partial.refreshToken,
    expiresAt: partial.expiresAt,
    scopes: partial.scopes ?? provider.defaultScopes,
    metadata: partial.metadata,
  };

  // Persist to the credential store.
  try {
    const store = await getCredentialStore();
    await store.set(flow.provider, tokenSet);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      provider: flow.provider,
      error: `Token exchange succeeded but persistence failed: ${msg}`,
    };
  }

  // Sync the in-memory cache and reschedule the proactive refresh timer.
  // Without this, `getAccessToken` would keep serving any prior cached entry
  // (possibly marked RE_AUTH_REQUIRED) for this provider until the next
  // process restart, even though a fresh token now lives in the store.
  notifyTokenStored(flow.provider, tokenSet);

  return {
    success: true,
    provider: flow.provider,
    tokenSet,
  };
}

/**
 * Disconnect a provider: revoke tokens if supported, then delete
 * credentials from the store.
 *
 * @param providerName - The provider to disconnect.
 * @throws If deletion from the credential store fails.
 */
export async function disconnectProvider(providerName: string): Promise<void> {
  const provider = getProvider(providerName);
  const store = await getCredentialStore();
  const existing = await store.get(providerName);

  // Attempt token revocation if the provider supports it and we have tokens.
  if (provider?.revokeUrl && existing && provider.buildRevokeBody) {
    // Prefer revoking the refresh token; fall back to access token.
    const tokenToRevoke = existing.refreshToken ?? existing.accessToken;
    const revokeBody = provider.buildRevokeBody(tokenToRevoke);

    try {
      await postForm(provider.revokeUrl, revokeBody);
    } catch {
      // Revocation is best-effort. If the endpoint is unreachable or
      // returns an error, we still delete local credentials.
    }
  }

  // Capture kind before delete so we know whether to also clear an env-staged PAT.
  const wasPat = existing?.kind === 'pat';

  // Delete credentials from the store regardless of revocation outcome.
  await store.delete(providerName);

  // Drop the in-memory cache entry and cancel any pending refresh timer so
  // a disconnect → test sequence reflects the disconnected state immediately
  // rather than serving the just-deleted provider's last token from cache.
  clearProviderCache(providerName);

  // [pat-in-credential-store task 1.5] If the deleted entry was a PAT staged
  // into process.env at startup, clear it now so subsequent in-process callers
  // and freshly-spawned agents don't pick up a deleted credential.
  if (wasPat) {
    const envKey = PAT_PROVIDER_ENV_MAP[providerName];
    if (envKey) delete process.env[envKey];
  }
}
