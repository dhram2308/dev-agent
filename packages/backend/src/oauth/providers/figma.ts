// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Figma OAuth 2.0 Provider Adapter
//
// Figma-specific OAuth quirks:
//   - Token exchange and refresh use DIFFERENT endpoints:
//       token:   POST https://api.figma.com/v1/oauth/token
//       refresh: POST https://api.figma.com/v1/oauth/refresh
//   - The refresh endpoint does NOT use `grant_type` — it expects
//     only `client_id`, `client_secret`, and `refresh_token`.
//   - Figma has NO token revocation endpoint.
//   - Client secret is REQUIRED (Figma does not support PKCE-only).
//   - Access tokens expire after ~90 days (7776000 seconds).
//
// Exports `prewarmFigmaTls()` for the OAuth routes to call before
// starting a Figma flow, reducing perceived latency on first
// API call after auth completes.
//
// Registers itself on import via registerProvider().
// ═══════════════════════════════════════════════════════════════

import * as https from 'https';
import type { ProviderAdapter } from '../provider';
import { registerProvider } from '../provider';
import type { TokenSet } from '../../credentials/types';

// ── TLS Pre-warm ────────────────────────────────────────────────

/**
 * Module-level keep-alive connection to api.figma.com.
 *
 * Opened by prewarmFigmaTls() and auto-closed after 2 minutes.
 * This eliminates the TLS handshake cost on the first token
 * exchange or API call after the user completes the Figma OAuth flow.
 */
let _prewarmSocket: ReturnType<typeof https.request> | null = null;
let _prewarmTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Open a keep-alive HTTPS connection to api.figma.com:443.
 *
 * The connection is stored as a module-level variable and
 * automatically destroyed after 2 minutes. Safe to call
 * multiple times — subsequent calls are no-ops while a
 * connection is already warm.
 */
export function prewarmFigmaTls(): void {
  // Already warm — skip.
  if (_prewarmSocket) return;

  try {
    const req = https.request({
      hostname: 'api.figma.com',
      port: 443,
      path: '/',
      method: 'HEAD',
      headers: { Connection: 'keep-alive' },
      // Don't wait forever — 10s connect timeout.
      timeout: 10_000,
    });

    req.on('response', (res) => {
      // Consume response data to free the socket for reuse.
      res.resume();
    });

    req.on('error', () => {
      // Pre-warm is best-effort — silently ignore failures.
      _prewarmSocket = null;
    });

    req.on('timeout', () => {
      req.destroy();
      _prewarmSocket = null;
    });

    req.end();
    _prewarmSocket = req;

    // Auto-close after 2 minutes.
    if (_prewarmTimer) clearTimeout(_prewarmTimer);
    _prewarmTimer = setTimeout(() => {
      if (_prewarmSocket) {
        _prewarmSocket.destroy();
        _prewarmSocket = null;
      }
      _prewarmTimer = null;
    }, 2 * 60 * 1000);
    _prewarmTimer.unref(); // Don't prevent process exit.
  } catch {
    // Pre-warm is best-effort — silently ignore failures.
    _prewarmSocket = null;
  }
}

// ── Adapter ─────────────────────────────────────────────────────

const figma: ProviderAdapter = {
  name: 'figma',

  authorizeUrl: 'https://www.figma.com/oauth',
  tokenUrl: 'https://api.figma.com/v1/oauth/token',
  refreshUrl: 'https://api.figma.com/v1/oauth/refresh',
  // Figma has no revocation endpoint.
  revokeUrl: undefined,

  defaultScopes: [
    'file_content:read',
    'file_comments:read',
    'current_user:read',
  ],

  clientId: process.env.OAUTH_FIGMA_CLIENT_ID || '',
  clientSecret: process.env.OAUTH_FIGMA_CLIENT_SECRET || '',

  /**
   * Parse Figma's token endpoint response into a partial TokenSet.
   *
   * Figma returns:
   *   { access_token, refresh_token, expires_in, user_id }
   */
  parseTokenResponse(body: Record<string, unknown>): Partial<TokenSet> {
    const partial: Partial<TokenSet> = {
      accessToken: body.access_token as string,
      metadata: {},
    };

    if (body.refresh_token) {
      partial.refreshToken = body.refresh_token as string;
    }

    // expires_in is in seconds — typically 7776000 (90 days).
    if (typeof body.expires_in === 'number') {
      partial.expiresAt = Date.now() + (body.expires_in as number) * 1000;
    }

    // Figma includes user_id in the token response.
    if (body.user_id) {
      partial.metadata!.accountId = String(body.user_id);
    }

    return partial;
  },

  /**
   * Build the form body for a Figma refresh token request.
   *
   * Figma's refresh endpoint does NOT use `grant_type` — it expects
   * only `client_id`, `client_secret`, and `refresh_token`.
   */
  buildRefreshBody(refreshToken: string): Record<string, string> {
    return {
      client_id: figma.clientId,
      client_secret: figma.clientSecret || '',
      refresh_token: refreshToken,
    };
  },

  // No buildRevokeBody — Figma has no revocation endpoint.
};

// ── Self-registration ───────────────────────────────────────────

registerProvider(figma);
