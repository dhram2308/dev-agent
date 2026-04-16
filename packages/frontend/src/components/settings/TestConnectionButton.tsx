// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Test Connection Button
// POSTs to /api/config/test with the service name and shows
// loading spinner, success/error feedback, and cooldown
// ═══════════════════════════════════════════════════════════════

import { useState, useCallback, useRef } from 'react';
import { useSettingsStore } from '../../store/settings';

// ── Props ───────────────────────────────────────────────────

interface TestConnectionButtonProps {
  service: string;
}

// ── Styles ──────────────────────────────────────────────────

const styles = {
  wrapper: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
  },
  button: {
    padding: 'var(--sp-2) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    transition: 'all 0.15s var(--ease-smooth)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    fontFamily: 'var(--font-sans)',
    whiteSpace: 'nowrap' as const,
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
    pointerEvents: 'none' as const,
  },
  spinner: {
    width: 14,
    height: 14,
    border: '2px solid var(--text-tertiary)',
    borderTopColor: 'transparent',
    borderRadius: '50%',
    animation: 'btnSpin 0.6s linear infinite',
    flexShrink: 0,
  },
  result: {
    fontSize: 12,
    fontWeight: 500,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
  },
  success: {
    color: 'var(--success)',
  },
  error: {
    color: 'var(--danger)',
    maxWidth: 200,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
} as const;

// ── Cooldown duration (ms) ──────────────────────────────────

const COOLDOWN_MS = 5000;

// ── Component ───────────────────────────────────────────────

export function TestConnectionButton({ service }: TestConnectionButtonProps): JSX.Element {
  const testConnection = useSettingsStore((s) => s.testConnection);
  const testResults = useSettingsStore((s) => s.testResults);
  const result = testResults[service];

  const [cooldown, setCooldown] = useState(false);
  const cooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTest = useCallback(async () => {
    if (cooldown || result?.loading) return;

    await testConnection(service);

    // Start cooldown
    setCooldown(true);
    if (cooldownRef.current) clearTimeout(cooldownRef.current);
    cooldownRef.current = setTimeout(() => {
      setCooldown(false);
    }, COOLDOWN_MS);
  }, [service, testConnection, cooldown, result?.loading]);

  const isLoading = result?.loading ?? false;
  const isDisabled = isLoading || cooldown;

  return (
    <div style={styles.wrapper}>
      <button
        type="button"
        style={{
          ...styles.button,
          ...(isDisabled ? styles.buttonDisabled : {}),
        }}
        onClick={handleTest}
        disabled={isDisabled}
        aria-label={`Test ${service} connection`}
      >
        {isLoading ? (
          <>
            <span style={styles.spinner} />
            Testing...
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M5 8l2 2 4-4" />
              <circle cx="8" cy="8" r="6" />
            </svg>
            {cooldown ? 'Cooldown...' : 'Test Connection'}
          </>
        )}
      </button>

      {result?.result && !isLoading && (
        <span
          style={{
            ...styles.result,
            ...(result.result.ok ? styles.success : styles.error),
          }}
          title={result.result.message}
        >
          {result.result.ok ? (
            <>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 8l3 3 5-6" />
              </svg>
              {result.result.message || 'Connected'}
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
              {result.result.message || 'Connection failed'}
            </>
          )}
        </span>
      )}
    </div>
  );
}
