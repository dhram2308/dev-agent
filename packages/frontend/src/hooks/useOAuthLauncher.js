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
async function oauthFetch(path, init = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
    };
    const token = getApiToken();
    if (token)
        headers['X-Api-Token'] = token;
    const res = await fetch(path, { ...init, headers });
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
            const body = await res.json();
            if (body.error)
                msg = body.error;
        }
        catch { /* ignore */ }
        throw new Error(msg);
    }
    if (res.status === 204)
        return undefined;
    return res.json();
}
/**
 * Hook to launch OAuth consent flow and disconnect providers.
 *
 * - `launch(provider)` POSTs to `/api/oauth/{provider}/start`, gets back
 *   `{ authorizeUrl }`, and opens that URL in a new tab/popup.
 * - `disconnect(provider)` POSTs to `/api/oauth/{provider}/disconnect`.
 */
export function useOAuthLauncher() {
    const [launching, setLaunching] = useState(null);
    const [error, setError] = useState(null);
    const launch = useCallback(async (provider) => {
        setLaunching(provider);
        setError(null);
        try {
            const res = await oauthFetch(`/api/oauth/${encodeURIComponent(provider)}/start`, { method: 'POST' });
            if (res.authorizeUrl) {
                window.open(res.authorizeUrl, '_blank', 'noopener,noreferrer');
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
        }
        finally {
            setLaunching(null);
        }
    }, []);
    const disconnect = useCallback(async (provider) => {
        setError(null);
        try {
            await oauthFetch(`/api/oauth/${encodeURIComponent(provider)}/disconnect`, { method: 'POST' });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
        }
    }, []);
    return { launch, disconnect, launching, error };
}
