// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Auth Required Banner
// Listens for SSE 'authRequired' events and shows a persistent
// amber banner with provider name, reason, and a re-authorize
// button. Auto-dismisses when 'connectorConnected' fires for
// the same provider.
// ═══════════════════════════════════════════════════════════════

import { useEffect, useState, useCallback } from 'react';
import { useOAuthLauncher } from '../hooks/useOAuthLauncher';

// ── Types ───────────────────────────────────────────────────

interface AuthRequiredState {
  provider: string;
  reason: string;
}

// ── Custom event detail shapes ──────────────────────────────

export interface AuthRequiredEventDetail {
  provider: string;
  reason?: string;
}

export interface ConnectorConnectedEventDetail {
  provider: string;
}

// ── Styles ──────────────────────────────────────────────────

const styles = {
  banner: {
    position: 'sticky' as const,
    top: 0,
    zIndex: 70,
    padding: 'var(--sp-3) var(--sp-4)',
    background: 'var(--warning-muted)',
    borderBottom: '1px solid var(--warning)',
    color: 'var(--warning)',
    fontSize: 13,
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
  },
  icon: {
    flexShrink: 0,
  },
  text: {
    flex: 1,
  },
  title: {
    fontWeight: 700,
  },
  detail: {
    fontSize: 12,
    opacity: 0.85,
  },
  reAuthBtn: {
    padding: '2px 10px',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    border: '1px solid var(--warning)',
    color: 'var(--warning)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    whiteSpace: 'nowrap' as const,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
  },
  dismiss: {
    padding: '2px 10px',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    border: '1px solid var(--warning)',
    color: 'var(--warning)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  },
  spinner: {
    width: 10,
    height: 10,
    border: '2px solid var(--warning)',
    borderTopColor: 'transparent',
    borderRadius: '50%',
    animation: 'btnSpin 0.6s linear infinite',
    flexShrink: 0,
  },
} as const;

// ── Component ───────────────────────────────────────────────

export function AuthRequiredBanner(): JSX.Element | null {
  const [authState, setAuthState] = useState<AuthRequiredState | null>(null);
  const { launch, launching } = useOAuthLauncher();

  // Listen for authRequired custom events (dispatched by SSE handler)
  useEffect(() => {
    function onAuthRequired(e: Event): void {
      const detail = (e as CustomEvent<AuthRequiredEventDetail>).detail;
      if (!detail.provider) return;
      setAuthState({
        provider: detail.provider,
        reason: detail.reason ?? 'Authorization expired or revoked',
      });
    }
    window.addEventListener('mi:auth-required', onAuthRequired);
    return () => {
      window.removeEventListener('mi:auth-required', onAuthRequired);
    };
  }, []);

  // Listen for connectorConnected custom events to auto-dismiss
  useEffect(() => {
    function onConnected(e: Event): void {
      const detail = (e as CustomEvent<ConnectorConnectedEventDetail>).detail;
      if (authState && detail.provider === authState.provider) {
        setAuthState(null);
      }
    }
    window.addEventListener('mi:connector-connected', onConnected);
    return () => {
      window.removeEventListener('mi:connector-connected', onConnected);
    };
  }, [authState]);

  if (!authState) return null;

  const providerLabel = authState.provider.charAt(0).toUpperCase() + authState.provider.slice(1);
  const isLaunching = launching === authState.provider;

  return (
    <div style={styles.banner} role="status" aria-live="polite">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={styles.icon}>
        <path d="M9 2l.7 1.8a1 1 0 00.6.6L12 5l-1.8.7a1 1 0 00-.6.6L9 8l-.7-1.8a1 1 0 00-.6-.6L6 5l1.8-.7a1 1 0 00.6-.6L9 2z" />
        <circle cx="9" cy="12" r="4" />
        <path d="M9 10v2.5l1.5 1" />
      </svg>
      <div style={styles.text}>
        <span style={styles.title}>{providerLabel} re-authorization required.</span>{' '}
        <span style={styles.detail}>{authState.reason}</span>
      </div>
      <button
        type="button"
        style={styles.reAuthBtn}
        onClick={() => launch(authState.provider)}
        disabled={isLaunching}
        aria-label={`Re-authorize ${providerLabel}`}
      >
        {isLaunching ? (
          <>
            <span style={styles.spinner} />
            Authorizing...
          </>
        ) : (
          `Re-authorize ${providerLabel}`
        )}
      </button>
      <button
        type="button"
        style={styles.dismiss}
        onClick={() => setAuthState(null)}
        aria-label="Dismiss auth required banner"
      >
        Dismiss
      </button>
    </div>
  );
}
