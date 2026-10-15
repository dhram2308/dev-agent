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
  card: {
    position: 'fixed' as const,
    top: 'var(--sp-4)',
    right: 'var(--sp-4)',
    zIndex: 90,
    width: 320,
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--warning)',
    boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
    padding: 'var(--sp-3) var(--sp-4)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-2)',
    animation: 'slideFromRight 0.25s var(--ease-smooth)',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--sp-2)',
  },
  icon: {
    flexShrink: 0,
    marginTop: 1,
    color: 'var(--warning)',
  },
  textBlock: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--warning)',
    lineHeight: 1.4,
  },
  detail: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
    marginTop: 2,
  },
  dismissX: {
    flexShrink: 0,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-ghost)',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    padding: '0 2px',
    fontFamily: 'var(--font-sans)',
  },
  actions: {
    display: 'flex',
    gap: 'var(--sp-2)',
    justifyContent: 'flex-end',
    borderTop: '1px solid var(--border-subtle)',
    paddingTop: 'var(--sp-2)',
    marginTop: 'var(--sp-1)',
  },
  reAuthBtn: {
    padding: '4px 12px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--warning)',
    border: 'none',
    color: '#000',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    whiteSpace: 'nowrap' as const,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
  },
  dismissBtn: {
    padding: '4px 10px',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    border: '1px solid var(--border-default)',
    color: 'var(--text-tertiary)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  },
  spinner: {
    width: 10,
    height: 10,
    border: '2px solid rgba(0,0,0,0.3)',
    borderTopColor: '#000',
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
    <div style={styles.card} role="alertdialog" aria-live="polite" aria-label={`${providerLabel} re-authorization required`}>
      <div style={styles.header}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={styles.icon}>
          <path d="M8 2l.6 1.5a.85.85 0 00.5.5L10.5 4.6l-1.4.6a.85.85 0 00-.5.5L8 7.2 7.4 5.7a.85.85 0 00-.5-.5L5.5 4.6l1.4-.6a.85.85 0 00.5-.5L8 2z" />
          <circle cx="8" cy="11" r="3.5" />
          <path d="M8 9.5v1.8l1.2.8" />
        </svg>
        <div style={styles.textBlock}>
          <div style={styles.title}>{providerLabel} re-authorization required</div>
          <div style={styles.detail}>{authState.reason}</div>
        </div>
        <button
          type="button"
          style={styles.dismissX}
          onClick={() => setAuthState(null)}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ×
        </button>
      </div>

      <div style={styles.actions}>
        <button
          type="button"
          style={styles.dismissBtn}
          onClick={() => setAuthState(null)}
        >
          Later
        </button>
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
              Authorizing…
            </>
          ) : (
            `Re-authorize ${providerLabel}`
          )}
        </button>
      </div>
    </div>
  );
}
