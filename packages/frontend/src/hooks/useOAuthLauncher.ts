// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — OAuth Launcher Hook
// Opens OAuth consent popup for supported providers (Figma,
// Google Drive) and handles disconnect. Uses the shared api
// module for all HTTP calls.
// ═══════════════════════════════════════════════════════════════

import { useState, useCallback } from 'react';

// Inline apiFetch using the same pattern as lib/api.ts
// We import the token getter rather than the typed wrappers because
// the OAuth endpoints are not covered by the existing typed API.
import { getApiToken } from '../lib/api';

async function oauthFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> || {}),
  };
  const token = getApiToken();
  if (token) headers['X-Api-Token'] = token;

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Return type for the useOAuthLauncher hook */
export interface UseOAuthLauncherResult {
  /** Start the OAuth flow for a provider (opens popup) */
  launch: (provider: string) => Promise<void>;
  /** Disconnect / revoke the OAuth token for a provider */
  disconnect: (provider: string) => Promise<void>;
  /** Provider currently launching (null if idle) */
  launching: string | null;
  /** Last error message (null if none) */
  error: string | null;
}

/**
 * Hook to launch OAuth consent flow and disconnect providers.
 *
 * - `launch(provider)` POSTs to `/api/oauth/{provider}/start`, gets back
 *   `{ authorizeUrl }`, and opens that URL in a new tab/popup.
 * - `disconnect(provider)` POSTs to `/api/oauth/{provider}/disconnect`.
 */
export function useOAuthLauncher(): UseOAuthLauncherResult {
  const [launching, setLaunching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const launch = useCallback(async (provider: string) => {
    setLaunching(provider);
    setError(null);
    try {
      const res = await oauthFetch<{ authorizeUrl?: string }>(
        `/api/oauth/${encodeURIComponent(provider)}/start`,
        { method: 'POST' },
      );
      if (res.authorizeUrl) {
        window.open(res.authorizeUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLaunching(null);
    }
  }, []);

  const disconnect = useCallback(async (provider: string) => {
    setError(null);
    try {
      await oauthFetch(
        `/api/oauth/${encodeURIComponent(provider)}/disconnect`,
        { method: 'POST' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }, []);

  return { launch, disconnect, launching, error };
}
