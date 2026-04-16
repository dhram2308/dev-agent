// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- GitLab OAuth 2.0 Provider Adapter
//
// GitLab-specific OAuth quirks:
//   - All endpoints are relative to the instance base URL,
//     defaulting to https://gitlab.com for SaaS.
//   - Supports PKCE, so client_secret is optional for public
//     clients.
//   - Revocation follows RFC 7009 with `token_type_hint`.
//   - The `baseUrl` is persisted in token metadata so downstream
//     API calls know which GitLab instance to target.
//
// Exports `validateGitlabInstance(baseUrl)` for the settings UI
// to verify a custom GitLab URL before starting an OAuth flow.
//
// Registers itself on import via registerProvider().
// ═══════════════════════════════════════════════════════════════

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import type { ProviderAdapter } from '../provider';
import { registerProvider } from '../provider';
import type { TokenSet } from '../../credentials/types';

// ── Instance Base URL ───────────────────────────────────────────

const GITLAB_BASE_URL = (
  process.env.GITLAB_URL || 'https://gitlab.com'
).replace(/\/+$/, ''); // Strip trailing slashes.

// ── Adapter ─────────────────────────────────────────────────────

const gitlab: ProviderAdapter = {
  name: 'gitlab',

  authorizeUrl: `${GITLAB_BASE_URL}/oauth/authorize`,
  tokenUrl: `${GITLAB_BASE_URL}/oauth/token`,
  revokeUrl: `${GITLAB_BASE_URL}/oauth/revoke`,

  defaultScopes: ['api', 'read_user'],

  get clientId() { return process.env.OAUTH_GITLAB_CLIENT_ID || ''; },
  get clientSecret() { return process.env.OAUTH_GITLAB_CLIENT_SECRET || undefined; },

  /**
   * Parse GitLab's token endpoint response into a partial TokenSet.
   *
   * GitLab returns standard OAuth2 fields:
   *   { access_token, token_type, expires_in, refresh_token, scope, created_at }
   *
   * We persist `baseUrl` in metadata so downstream API calls
   * know which GitLab instance these credentials target.
   */
  parseTokenResponse(body: Record<string, unknown>): Partial<TokenSet> {
    const partial: Partial<TokenSet> = {
      accessToken: body.access_token as string,
      metadata: {
        baseUrl: GITLAB_BASE_URL,
      },
    };

    if (body.refresh_token) {
      partial.refreshToken = body.refresh_token as string;
    }

    // GitLab returns `expires_in` (seconds) and `created_at` (epoch seconds).
    if (typeof body.expires_in === 'number') {
      if (typeof body.created_at === 'number') {
        // Prefer created_at + expires_in for accuracy.
        partial.expiresAt = ((body.created_at as number) + (body.expires_in as number)) * 1000;
      } else {
        partial.expiresAt = Date.now() + (body.expires_in as number) * 1000;
      }
    }

    // GitLab returns scope as a space-separated string.
    if (typeof body.scope === 'string') {
      partial.scopes = (body.scope as string).split(' ').filter(Boolean);
    }

    return partial;
  },

  /**
   * Build the form body for a GitLab refresh token request.
   */
  buildRefreshBody(refreshToken: string): Record<string, string> {
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: gitlab.clientId,
    };
    if (gitlab.clientSecret) {
      body.client_secret = gitlab.clientSecret;
    }
    return body;
  },

  /**
   * Build the form body for GitLab token revocation (RFC 7009).
   */
  buildRevokeBody(token: string): Record<string, string> {
    return {
      token,
      token_type_hint: 'access_token',
    };
  },
};

// ── Self-registration ───────────────────────────────────────────

registerProvider(gitlab);

// ── Exported Helper ─────────────────────────────────────────────

/**
 * Validate that a GitLab instance URL is reachable by sending
 * a HEAD request to its `/api/v4/version` endpoint.
 *
 * Returns `true` if the server responds with any 2xx/3xx status,
 * `false` on network error, timeout, or 4xx/5xx.
 *
 * @param baseUrl - The GitLab instance URL (e.g. `https://gitlab.example.com`).
 * @returns Whether the instance appears to be a valid GitLab server.
 */
export function validateGitlabInstance(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(`${baseUrl.replace(/\/+$/, '')}/api/v4/version`);
    } catch {
      resolve(false);
      return;
    }

    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        method: 'HEAD',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          Accept: 'application/json',
        },
      },
      (res) => {
        // Consume response to free the socket.
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 400);
      },
    );

    // 10-second timeout.
    req.setTimeout(10_000, () => {
      req.destroy();
      resolve(false);
    });

    req.on('error', () => {
      resolve(false);
    });

    req.end();
  });
}
