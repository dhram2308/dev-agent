// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Connector Card Component
// Card with connector info, status badge, and test button
// Extended with OAuth status pill, connect/disconnect/re-auth
// buttons, expiry countdown, account identity, and PAT fallback
// ═══════════════════════════════════════════════════════════════

import { useState, useEffect } from 'react';
import type { ConnectorStatus, TestConnectionResult } from '../../store/settings';

// ── OAuth status types ──────────────────────────────────────

export type OAuthStatus =
  | 'CONNECTED'
  | 'REFRESHING'
  | 'RE_AUTH_REQUIRED'
  | 'REVOKED'
  | 'NOT_CONNECTED'
  | 'PAT';

export interface OAuthInfo {
  oauthStatus: OAuthStatus;
  expiresAt?: number | null;
  metadata?: { email?: string; [key: string]: unknown };
}

// ── Props ───────────────────────────────────────────────────

interface ConnectorCardProps {
  name: string;
  icon: string;
  description: string;
  status: ConnectorStatus;
  onTest?: () => void;
  onConfigure?: () => void;
  testResult?: { loading: boolean; result: TestConnectionResult | null };
  /** Whether this provider supports OAuth (Figma, Google Drive) */
  supportsOAuth?: boolean;
  /** OAuth connection info (only relevant when supportsOAuth is true) */
  oauthInfo?: OAuthInfo;
  /** Called when the user clicks [Connect] (OAuth flow) */
  onOAuthConnect?: () => void;
  /** Called when the user clicks [Disconnect] (OAuth revoke) */
  onOAuthDisconnect?: () => void;
  /** Whether the OAuth launch is in progress */
  oauthLaunching?: boolean;
  /** Inline children for PAT fallback (token input + test button) */
  patFallbackContent?: React.ReactNode;
}

// ── Styles ──────────────────────────────────────────────────

const styles = {
  card: {
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-surface)',
    padding: 'var(--sp-5)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-3)',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  },
  cardHover: {
    borderColor: 'var(--border-strong)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 'var(--radius-sm)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-subtle)',
    flexShrink: 0,
  },
  name: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text-primary)',
    flex: 1,
  },
  badge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 'var(--radius-full)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap' as const,
  },
  badgeConnected: {
    background: 'var(--success-muted)',
    color: 'var(--success)',
  },
  badgeDisconnected: {
    background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
  },
  badgeComingSoon: {
    background: 'var(--blue-muted)',
    color: 'var(--blue)',
  },
  description: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
    flex: 1,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    marginTop: 'auto',
  },
  testBtn: {
    padding: 'var(--sp-2) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    transition: 'all 0.15s',
    fontFamily: 'var(--font-sans)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
  },
  configLink: {
    padding: 'var(--sp-2) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    color: 'var(--accent)',
    transition: 'color 0.15s',
    fontFamily: 'var(--font-sans)',
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
    pointerEvents: 'none' as const,
  },
  spinner: {
    width: 12,
    height: 12,
    border: '2px solid var(--text-tertiary)',
    borderTopColor: 'transparent',
    borderRadius: '50%',
    animation: 'btnSpin 0.6s linear infinite',
    flexShrink: 0,
  },
  statusRow: {
    marginTop: 'var(--sp-2)',
    paddingTop: 'var(--sp-2)',
    borderTop: '1px solid var(--border-subtle)',
    fontSize: 12,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--sp-1)',
    lineHeight: 1.4,
    wordBreak: 'break-word' as const,
  },
  statusSuccess: {
    color: 'var(--success)',
  },
  statusError: {
    color: 'var(--danger)',
  },
  // OAuth-specific styles
  oauthSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-2)',
    paddingTop: 'var(--sp-2)',
    borderTop: '1px solid var(--border-subtle)',
  },
  oauthRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    flexWrap: 'wrap' as const,
  },
  oauthBtn: {
    padding: 'var(--sp-1) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    transition: 'all 0.15s',
    fontFamily: 'var(--font-sans)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
  },
  oauthBtnPrimary: {
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
    border: '1px solid var(--accent)',
  },
  oauthBtnDanger: {
    background: 'var(--danger-muted)',
    color: 'var(--danger)',
    border: '1px solid rgba(239,68,68,0.2)',
  },
  oauthBtnWarning: {
    background: 'var(--warning-muted)',
    color: 'var(--warning)',
    border: '1px solid rgba(234,179,8,0.2)',
  },
  expiryText: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
  },
  accountText: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
  },
  patDisclosure: {
    paddingTop: 'var(--sp-2)',
    borderTop: '1px solid var(--border-subtle)',
  },
  patToggle: {
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    transition: 'color 0.15s',
  },
  patContent: {
    marginTop: 'var(--sp-2)',
  },
} as const;

// ── Connector Icon SVGs ─────────────────────────────────────

function ConnectorIcon({ icon }: { icon: string }): JSX.Element {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'var(--text-secondary)',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (icon) {
    case 'drive':
      return (
        <svg {...common}>
          <path d="M7 3l6 10H3l6-10z" />
          <path d="M13 3l4 7H7" />
          <path d="M3 13h10l4 4H7" />
        </svg>
      );
    case 'figma':
      return (
        <svg {...common}>
          <rect x="6" y="2" width="4" height="5" rx="2" />
          <rect x="10" y="2" width="4" height="5" rx="2" />
          <rect x="6" y="7" width="4" height="5" rx="2" />
          <circle cx="12" cy="9.5" r="2" />
          <rect x="6" y="12" width="4" height="5" rx="2" />
        </svg>
      );
    case 'postman':
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="7" />
          <path d="M7 10l2 2 4-4" />
        </svg>
      );
    case 'jira':
      return (
        <svg {...common}>
          <path d="M10 2l4 4-4 4-4-4 4-4z" />
          <path d="M10 10l4 4-4 4-4-4 4-4z" />
        </svg>
      );
    case 'gitlab':
      return (
        <svg {...common}>
          <path d="M10 17L3 9l2-5 2 5h6l2-5 2 5-7 8z" />
        </svg>
      );
    case 'slack':
      return (
        <svg {...common}>
          <rect x="3" y="7" width="5" height="2" rx="1" />
          <rect x="12" y="11" width="5" height="2" rx="1" />
          <rect x="7" y="3" width="2" height="5" rx="1" />
          <rect x="11" y="12" width="2" height="5" rx="1" />
          <rect x="7" y="11" width="6" height="2" rx="1" />
          <rect x="7" y="7" width="2" height="6" rx="1" />
        </svg>
      );
    case 'claude':
    case 'anthropic':
      return (
        <svg {...common}>
          <path d="M10 3l3 7 4 1-3 3 1 4-5-3-5 3 1-4-3-3 4-1 3-7z" />
        </svg>
      );
    case 'confluence':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="14" height="4" rx="1" />
          <rect x="5" y="9" width="10" height="4" rx="1" />
          <rect x="7" y="14" width="6" height="3" rx="1" />
        </svg>
      );
    case 'notion':
      return (
        <svg {...common}>
          <path d="M4 3h9l3 3v11H4V3z" />
          <path d="M13 3v3h3" />
          <path d="M7 9h6M7 12h6M7 15h4" />
        </svg>
      );
    case 'browser':
      return (
        <svg {...common}>
          <rect x="2" y="4" width="16" height="12" rx="2" />
          <path d="M2 8h16" />
          <circle cx="5" cy="6" r="0.6" fill="currentColor" />
          <circle cx="7" cy="6" r="0.6" fill="currentColor" />
          <circle cx="9" cy="6" r="0.6" fill="currentColor" />
        </svg>
      );
    case 'email':
      return (
        <svg {...common}>
          <rect x="2" y="4" width="16" height="12" rx="2" />
          <path d="M2 6l8 6 8-6" />
        </svg>
      );
    default:
      return (
        <svg {...common} strokeLinejoin="miter">
          <rect x="3" y="3" width="14" height="14" rx="3" />
          <path d="M7 10h6M10 7v6" />
        </svg>
      );
  }
}

// ── Status badge text (original) ────────────────────────────

function statusLabel(status: ConnectorStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'disconnected':
      return 'Disconnected';
    case 'coming_soon':
      return 'Coming Soon';
  }
}

function statusBadgeStyle(status: ConnectorStatus): React.CSSProperties {
  switch (status) {
    case 'connected':
      return styles.badgeConnected;
    case 'disconnected':
      return styles.badgeDisconnected;
    case 'coming_soon':
      return styles.badgeComingSoon;
  }
}

// ── OAuth Status Pill ───────────────────────────────────────

const OAUTH_PILL_MAP: Record<OAuthStatus, { label: string; bg: string; color: string }> = {
  CONNECTED: {
    label: 'Connected',
    bg: 'var(--success-muted)',
    color: 'var(--success)',
  },
  REFRESHING: {
    label: 'Refreshing\u2026',
    bg: 'var(--blue-muted)',
    color: 'var(--blue)',
  },
  RE_AUTH_REQUIRED: {
    label: 'Re-auth required',
    bg: 'var(--warning-muted)',
    color: 'var(--warning)',
  },
  REVOKED: {
    label: 'Revoked',
    bg: 'var(--danger-muted)',
    color: 'var(--danger)',
  },
  NOT_CONNECTED: {
    label: 'Not connected',
    bg: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
  },
  PAT: {
    label: 'Connected via PAT',
    bg: 'var(--success-muted)',
    color: 'var(--success)',
  },
};

function StatusPill({ oauthStatus }: { oauthStatus: OAuthStatus }): JSX.Element {
  const pill = OAUTH_PILL_MAP[oauthStatus];
  return (
    <span
      style={{
        ...styles.badge,
        background: pill.bg,
        color: pill.color,
      }}
    >
      {pill.label}
    </span>
  );
}

// ── Expiry countdown hook ───────────────────────────────────

function useExpiryCountdown(expiresAt?: number | null): string | null {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (!expiresAt) return null;
  const diff = expiresAt - now;
  if (diff <= 0) return null;

  const mins = Math.ceil(diff / 60_000);
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return `Refreshes in ${hrs}h ${rem}m`;
  }
  return `Refreshes in ${mins} min`;
}

// ── Component ───────────────────────────────────────────────

export function ConnectorCard({
  name,
  icon,
  description,
  status,
  onTest,
  onConfigure,
  testResult,
  supportsOAuth = false,
  oauthInfo,
  onOAuthConnect,
  onOAuthDisconnect,
  oauthLaunching = false,
  patFallbackContent,
}: ConnectorCardProps): JSX.Element {
  const isComingSoon = status === 'coming_soon';
  const isTesting = testResult?.loading ?? false;
  const result = testResult?.result ?? null;

  // PAT fallback disclosure state (for OAuth-capable providers)
  const [patExpanded, setPatExpanded] = useState(false);

  // Expiry countdown
  const expiryText = useExpiryCountdown(oauthInfo?.expiresAt);

  // Derive OAuth display state
  const oauthStatus = oauthInfo?.oauthStatus ?? 'NOT_CONNECTED';
  const isOAuthConnected = oauthStatus === 'CONNECTED' || oauthStatus === 'REFRESHING';
  const needsReAuth = oauthStatus === 'RE_AUTH_REQUIRED' || oauthStatus === 'REVOKED';
  const showOAuthConnect = supportsOAuth && !isOAuthConnected && !needsReAuth && oauthStatus !== 'PAT';
  const accountEmail = oauthInfo?.metadata?.email;

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.iconWrap}>
          <ConnectorIcon icon={icon} />
        </div>
        <span style={styles.name}>{name}</span>
        {/* Show OAuth StatusPill when OAuth is supported, otherwise fall back to original badge */}
        {supportsOAuth && oauthInfo ? (
          <StatusPill oauthStatus={oauthStatus} />
        ) : (
          <span style={{ ...styles.badge, ...statusBadgeStyle(status) }}>
            {statusLabel(status)}
          </span>
        )}
      </div>

      <div style={styles.description}>{description}</div>

      {/* Account identity (email) */}
      {supportsOAuth && accountEmail && (
        <div style={styles.accountText}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="8" cy="5" r="3" />
            <path d="M2 14c0-3 2.5-5 6-5s6 2 6 5" />
          </svg>
          {accountEmail}
        </div>
      )}

      {/* Expiry countdown */}
      {supportsOAuth && expiryText && (
        <div style={styles.expiryText}>{expiryText}</div>
      )}

      {/* OAuth action buttons */}
      {supportsOAuth && !isComingSoon && (
        <div style={styles.oauthSection}>
          <div style={styles.oauthRow}>
            {/* [Connect] button */}
            {showOAuthConnect && onOAuthConnect && (
              <button
                type="button"
                style={{
                  ...styles.oauthBtn,
                  ...styles.oauthBtnPrimary,
                  ...(oauthLaunching ? styles.btnDisabled : {}),
                }}
                onClick={onOAuthConnect}
                disabled={oauthLaunching}
                aria-label={`Connect ${name} via OAuth`}
              >
                {oauthLaunching ? (
                  <>
                    <span style={styles.spinner} />
                    Connecting...
                  </>
                ) : (
                  'Connect'
                )}
              </button>
            )}

            {/* [Disconnect] button */}
            {isOAuthConnected && onOAuthDisconnect && (
              <button
                type="button"
                style={{ ...styles.oauthBtn, ...styles.oauthBtnDanger }}
                onClick={onOAuthDisconnect}
                aria-label={`Disconnect ${name}`}
              >
                Disconnect
              </button>
            )}

            {/* Figma manual revoke note (Figma has no revocation endpoint) */}
            {icon === 'figma' && isOAuthConnected && (
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: 4 }}>
                To fully revoke, visit{' '}
                <a
                  href="https://www.figma.com/settings"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#60a5fa', textDecoration: 'underline' }}
                >
                  Figma Settings &rarr; Connected apps
                </a>
              </div>
            )}

            {/* [Re-auth] button */}
            {needsReAuth && onOAuthConnect && (
              <button
                type="button"
                style={{
                  ...styles.oauthBtn,
                  ...styles.oauthBtnWarning,
                  ...(oauthLaunching ? styles.btnDisabled : {}),
                }}
                onClick={onOAuthConnect}
                disabled={oauthLaunching}
                aria-label={`Re-authorize ${name}`}
              >
                {oauthLaunching ? (
                  <>
                    <span style={styles.spinner} />
                    Re-authorizing...
                  </>
                ) : (
                  'Re-authorize'
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Original footer (Test + Configure buttons) — only for non-OAuth or PAT mode */}
      <div style={styles.footer}>
        {!isComingSoon && onTest && (
          <button
            type="button"
            style={{
              ...styles.testBtn,
              ...(isTesting ? styles.btnDisabled : {}),
            }}
            onClick={onTest}
            disabled={isTesting}
            aria-label={`Test ${name} connection`}
          >
            {isTesting ? (
              <>
                <span style={styles.spinner} />
                Testing…
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M5 8l2 2 4-4" />
                  <circle cx="8" cy="8" r="6" />
                </svg>
                Test
              </>
            )}
          </button>
        )}
        {!isComingSoon && (
          <button
            type="button"
            style={{
              ...styles.configLink,
              ...(onConfigure ? {} : styles.btnDisabled),
            }}
            onClick={onConfigure}
            disabled={!onConfigure}
            aria-label={`Configure ${name}`}
          >
            Configure
          </button>
        )}
      </div>

      {/* Test result row */}
      {!isTesting && result && (
        <div
          style={{
            ...styles.statusRow,
            ...(result.ok ? styles.statusSuccess : styles.statusError),
          }}
          role="status"
          aria-live="polite"
        >
          {result.ok ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 2 }}>
              <path d="M4 8l3 3 5-6" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 2 }}>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          )}
          <span>{result.message || (result.ok ? 'Connected' : 'Connection failed')}</span>
        </div>
      )}

      {/* PAT fallback disclosure (for OAuth-capable providers) */}
      {supportsOAuth && patFallbackContent && (
        <div style={styles.patDisclosure}>
          <button
            type="button"
            style={styles.patToggle}
            onClick={() => setPatExpanded((v) => !v)}
            aria-expanded={patExpanded}
          >
            {patExpanded ? 'Hide API token \u25B4' : 'Use API token instead \u25BE'}
          </button>
          {patExpanded && (
            <div style={styles.patContent}>
              {patFallbackContent}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
