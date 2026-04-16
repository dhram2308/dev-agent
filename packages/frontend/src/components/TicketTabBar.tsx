// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Multi-ticket Tab Bar
// Horizontal pill row above the dashboard showing every ticket the
// user has opened this session. Lets you switch activeTicket with
// one click, or close a tab to remove it from the in-memory
// tickets map (on-disk pipeline stays untouched).
// ═══════════════════════════════════════════════════════════════

import { useMemo } from 'react';
import { usePipelineStore } from '../store/pipeline';
import type { PipelineTicketState } from '../types';

const styles = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
    padding: 'var(--sp-2) var(--sp-4)',
    borderBottom: '1px solid var(--border-subtle)',
    background: 'var(--bg-surface)',
    overflowX: 'auto' as const,
  },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    padding: '4px 10px',
    borderRadius: 'var(--radius-full)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    transition: 'all 150ms var(--ease-smooth)',
  },
  tabActive: {
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
    border: '1px solid var(--accent)',
    fontWeight: 600,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
  },
  close: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
  },
  closeHover: {
    background: 'var(--danger-muted)',
    color: 'var(--danger)',
  },
} as const;

function getDotStyle(t: PipelineTicketState): React.CSSProperties {
  if (t.isRunning) {
    return { background: 'var(--success)', animation: 'dotPulse 2s infinite ease-in-out' };
  }
  if (t.gateWaiting) {
    return { background: 'var(--warning)' };
  }
  if (t.error) {
    return { background: 'var(--danger)' };
  }
  return { background: 'var(--text-ghost)' };
}

export function TicketTabBar(): JSX.Element | null {
  const tickets = usePipelineStore((s) => s.tickets);
  const activeTicket = usePipelineStore((s) => s.activeTicket);
  const setActiveTicket = usePipelineStore((s) => s.setActiveTicket);
  const removeTicket = usePipelineStore((s) => s.removeTicket);

  // Convert Map → sorted array (alphabetical for stable ordering)
  const entries = useMemo(
    () => Array.from(tickets.entries()).sort(([a], [b]) => a.localeCompare(b)),
    [tickets],
  );

  // Hide the bar unless the user has 2+ tickets open — single-ticket view is simpler
  if (entries.length < 2) return null;

  const handleClose = (ticket: string, e: React.MouseEvent): void => {
    e.stopPropagation();
    removeTicket(ticket);
    // If we closed the active tab, fall back to the first remaining ticket
    if (ticket === activeTicket) {
      const remaining = entries.filter(([t]) => t !== ticket);
      setActiveTicket(remaining.length > 0 ? remaining[0][0] : null);
    }
  };

  return (
    <div style={styles.bar} role="tablist" aria-label="Open tickets">
      {entries.map(([ticket, state]) => {
        const isActive = ticket === activeTicket;
        return (
          <button
            key={ticket}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => setActiveTicket(ticket)}
            style={{
              ...styles.tab,
              ...(isActive ? styles.tabActive : {}),
            }}
            title={`${ticket} — ${state.stage}`}
          >
            <span style={{ ...styles.dot, ...getDotStyle(state) }} aria-hidden="true" />
            <span>{ticket}</span>
            <span
              style={styles.close}
              onClick={(e) => handleClose(ticket, e)}
              role="button"
              aria-label={`Close ${ticket} tab`}
              tabIndex={0}
            >
              ×
            </span>
          </button>
        );
      })}
    </div>
  );
}
