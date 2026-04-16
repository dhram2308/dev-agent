// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Display Settings Component
// Theme toggle (light/dark), diff view mode, and cache clear
// Embedded in the Settings page header area
// ═══════════════════════════════════════════════════════════════

import { useState, useCallback } from 'react';
import { useTheme } from '../../hooks/useTheme';

// ── Styles ──────────────────────────────────────────────────

const styles = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-3) var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-tertiary)',
    marginRight: 'var(--sp-2)',
  },
  toggleGroup: {
    display: 'inline-flex',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-default)',
    overflow: 'hidden',
  },
  toggleBtn: {
    padding: 'var(--sp-1) var(--sp-3)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-secondary)',
    transition: 'all 0.15s',
    fontFamily: 'var(--font-sans)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
  },
  toggleBtnActive: {
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
    fontWeight: 600,
  },
  separator: {
    width: 1,
    height: 20,
    background: 'var(--border-default)',
    margin: '0 var(--sp-1)',
    flexShrink: 0,
  },
  clearBtn: {
    padding: 'var(--sp-1) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    border: '1px solid var(--border-default)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    transition: 'all 0.15s',
    fontFamily: 'var(--font-sans)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
  },
  successMsg: {
    fontSize: 11,
    color: 'var(--success)',
    fontWeight: 500,
  },
} as const;

// ── Diff mode helpers ───────────────────────────────────────

function getDiffMode(): 'split' | 'unified' {
  try {
    return (localStorage.getItem('mi-agent-diff-mode') as 'split' | 'unified') ?? 'split';
  } catch {
    return 'split';
  }
}

function setDiffMode(mode: 'split' | 'unified'): void {
  try {
    localStorage.setItem('mi-agent-diff-mode', mode);
  } catch {
    // Storage unavailable
  }
}

// ── Component ───────────────────────────────────────────────

export function DisplaySettings(): JSX.Element {
  const { theme, setTheme } = useTheme();
  const [diffMode, setDiffModeState] = useState<'split' | 'unified'>(getDiffMode);
  const [cleared, setCleared] = useState(false);

  const handleThemeChange = useCallback((t: 'dark' | 'light') => {
    setTheme(t);
  }, [setTheme]);

  const handleDiffModeChange = useCallback((m: 'split' | 'unified') => {
    setDiffMode(m);
    setDiffModeState(m);
  }, []);

  const handleClearCache = useCallback(() => {
    try {
      // Clear non-essential localStorage keys (preserve auth token and theme)
      const keep = ['mi-agent-theme', 'mi-agent-diff-mode'];
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && !keep.includes(key)) {
          keys.push(key);
        }
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch {
      // Storage unavailable
    }
    setCleared(true);
    setTimeout(() => setCleared(false), 2000);
  }, []);

  return (
    <div style={styles.container}>
      {/* Theme Toggle */}
      <span style={styles.sectionLabel}>Theme</span>
      <div style={styles.toggleGroup}>
        <button
          type="button"
          style={{
            ...styles.toggleBtn,
            ...(theme === 'dark' ? styles.toggleBtnActive : {}),
          }}
          onClick={() => handleThemeChange('dark')}
          aria-pressed={theme === 'dark'}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M13.5 9.5a6 6 0 11-7-7 4.5 4.5 0 007 7z" />
          </svg>
          Dark
        </button>
        <button
          type="button"
          style={{
            ...styles.toggleBtn,
            ...(theme === 'light' ? styles.toggleBtnActive : {}),
          }}
          onClick={() => handleThemeChange('light')}
          aria-pressed={theme === 'light'}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3" />
          </svg>
          Light
        </button>
      </div>

      <span style={styles.separator} />

      {/* Diff Mode */}
      <span style={styles.sectionLabel}>Diff View</span>
      <div style={styles.toggleGroup}>
        <button
          type="button"
          style={{
            ...styles.toggleBtn,
            ...(diffMode === 'split' ? styles.toggleBtnActive : {}),
          }}
          onClick={() => handleDiffModeChange('split')}
          aria-pressed={diffMode === 'split'}
        >
          Split
        </button>
        <button
          type="button"
          style={{
            ...styles.toggleBtn,
            ...(diffMode === 'unified' ? styles.toggleBtnActive : {}),
          }}
          onClick={() => handleDiffModeChange('unified')}
          aria-pressed={diffMode === 'unified'}
        >
          Unified
        </button>
      </div>

      <span style={styles.separator} />

      {/* Clear Cache */}
      <button
        type="button"
        style={styles.clearBtn}
        onClick={handleClearCache}
        aria-label="Clear application cache"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10" />
        </svg>
        Clear Cache
      </button>
      {cleared && <span style={styles.successMsg}>Cleared</span>}
    </div>
  );
}
