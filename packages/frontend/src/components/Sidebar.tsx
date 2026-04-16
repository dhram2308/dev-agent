// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Sidebar Component (Pipeline Dashboard)
// Grouped pipeline list with status indicators, gate badges,
// stage navigation, and add-ticket input
// ═══════════════════════════════════════════════════════════════

import { useState, useCallback } from 'react';
import {
  usePipelineStore,
  useGroupedPipelines,
  stageIndex,
} from '../store/pipeline';
import { useNavigationStore, type AppView } from '../store/navigation';
import { STAGE_INFO, type StageName, type PipelineSummary } from '../types';

// ── View navigation config ────────────────────────────────────

interface ViewNavItem {
  view: AppView;
  label: string;
  /** SVG path for the icon (16x16 viewBox) */
  iconPath: string;
}

const VIEW_NAV_ITEMS: ViewNavItem[] = [
  {
    view: 'dashboard',
    label: 'Dashboard',
    iconPath: 'M2 2h5v6H2V2zm7 0h5v4H9V2zM2 10h5v4H2v-4zm7-2h5v6H9V8z',
  },
  {
    view: 'settings',
    label: 'Settings',
    iconPath: 'M8 10a2 2 0 100-4 2 2 0 000 4zm6.32-1.9l1.12.65a.5.5 0 01.18.68l-1 1.73a.5.5 0 01-.68.18l-1.12-.65a4.97 4.97 0 01-1.32.76v1.3a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-1.3a4.97 4.97 0 01-1.32-.76l-1.12.65a.5.5 0 01-.68-.18l-1-1.73a.5.5 0 01.18-.68l1.12-.65a5.03 5.03 0 010-1.52L4.54 5.93a.5.5 0 01-.18-.68l1-1.73a.5.5 0 01.68-.18l1.12.65a4.97 4.97 0 011.32-.76V1.93a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1.3c.48.18.92.44 1.32.76l1.12-.65a.5.5 0 01.68.18l1 1.73a.5.5 0 01-.18.68l-1.12.65a5.03 5.03 0 010 1.52z',
  },
  {
    view: 'review',
    label: 'Review',
    iconPath: 'M8 1C4.13 1 1 4.13 1 8s3.13 7 7 7 7-3.13 7-7-3.13-7-7-7zm3.22 5.28l-3.5 3.5a.75.75 0 01-1.06 0l-1.5-1.5a.75.75 0 111.06-1.06L7.22 8.22l2.97-2.97a.75.75 0 111.06 1.06z',
  },
];

// ── Styles ─────────────────────────────────────────────────────

const styles = {
  sidebar: {
    width: 'var(--sidebar-w)',
    minWidth: 'var(--sidebar-w)',
    background: 'var(--bg-surface)',
    borderRight: '1px solid var(--border-subtle)',
    display: 'flex',
    flexDirection: 'column' as const,
    position: 'fixed' as const,
    top: 3,
    left: 0,
    bottom: 0,
    zIndex: 100,
    transition: 'width 0.3s var(--ease-smooth), min-width 0.3s var(--ease-smooth)',
    overflowY: 'auto' as const,
    overflowX: 'hidden' as const,
  },
  header: {
    padding: 'var(--sp-5) var(--sp-4)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    borderBottom: '1px solid var(--border-subtle)',
  },
  logo: {
    width: 32,
    height: 32,
    background: 'linear-gradient(135deg, var(--accent), var(--blue))',
    borderRadius: 'var(--radius-sm)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontSize: 16,
    flexShrink: 0,
  },
  headerText: {
    overflow: 'hidden' as const,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--text-primary)',
    letterSpacing: '-0.02em',
  },
  headerSub: {
    fontSize: 10,
    color: 'var(--text-tertiary)',
    marginTop: 1,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: 'var(--text-tertiary)',
    padding: 'var(--sp-4) var(--sp-4) var(--sp-2)',
  },
  groupTitle: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--text-tertiary)',
    padding: 'var(--sp-3) var(--sp-4) var(--sp-1)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
  },
  groupCount: {
    fontSize: 9,
    background: 'var(--bg-elevated)',
    borderRadius: 'var(--radius-full)',
    padding: '1px 5px',
    color: 'var(--text-tertiary)',
  },
  nav: {
    flex: 1,
    padding: 'var(--sp-2)',
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-2) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    transition: 'all 150ms var(--ease-smooth)',
    position: 'relative' as const,
    border: 'none',
    background: 'transparent',
    width: '100%',
    textAlign: 'left' as const,
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    color: 'var(--text-secondary)',
    borderLeft: '2px solid transparent',
    marginBottom: 1,
  },
  navItemActive: {
    borderLeftColor: 'var(--accent)',
    background: 'var(--accent-muted)',
    color: 'var(--text-primary)',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
    transition: 'all 0.3s var(--ease-smooth)',
  },
  label: {
    flex: 1,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
  },
  pipelineItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    padding: 'var(--sp-2) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    transition: 'all 150ms',
    border: 'none',
    background: 'transparent',
    width: '100%',
    textAlign: 'left' as const,
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--text-secondary)',
    position: 'relative' as const,
  },
  pipelineItemActive: {
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
    fontWeight: 600,
  },
  pipelineDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  pipelineMeta: {
    fontSize: 10,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-sans)',
    whiteSpace: 'nowrap' as const,
  },
  gateBadge: {
    fontSize: 9,
    background: 'var(--warning-muted)',
    color: 'var(--warning)',
    borderRadius: 'var(--radius-full)',
    padding: '1px 5px',
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
  },
  addTicketRow: {
    padding: 'var(--sp-2) var(--sp-3)',
    borderTop: '1px solid var(--border-subtle)',
  },
  addTicketInput: {
    width: '100%',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    padding: 'var(--sp-2)',
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  footer: {
    padding: 'var(--sp-3) var(--sp-4)',
    borderTop: '1px solid var(--border-subtle)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    flexWrap: 'wrap' as const,
  },
  connDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
  },
  footerText: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
  },
  viewNav: {
    padding: 'var(--sp-3) var(--sp-2)',
    borderBottom: '1px solid var(--border-subtle)',
  },
  viewNavItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-2) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    transition: 'all 150ms var(--ease-smooth)',
    border: 'none',
    background: 'transparent',
    width: '100%',
    textAlign: 'left' as const,
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    color: 'var(--text-secondary)',
    marginBottom: 1,
  },
  viewNavItemActive: {
    background: 'var(--accent-muted)',
    color: 'var(--text-primary)',
    fontWeight: 600,
  },
  viewNavIcon: {
    width: 16,
    height: 16,
    flexShrink: 0,
    opacity: 0.7,
  },
} as const;

// ── Pipeline status dot styles ──────────────────────────────────

function getPipelineDotStyle(status: string): React.CSSProperties {
  switch (status) {
    case 'running':
      return { background: 'var(--success)', animation: 'dotPulse 2s infinite ease-in-out', boxShadow: '0 0 6px var(--success-glow)' };
    case 'gate_waiting':
      return { background: 'var(--warning)', animation: 'dotPulse 1.5s infinite' };
    case 'paused':
      return { background: 'var(--text-tertiary)' };
    case 'done':
      return { background: 'var(--success)' };
    case 'expired':
      return { background: 'var(--danger)', opacity: 0.5 };
    default:
      return { background: 'var(--text-ghost)' };
  }
}

// ── Stage dot for pipeline view ──────────────────────────────────

function getDotStyle(
  stageIdx: number,
  currentIdx: number,
  isRunning: boolean,
): React.CSSProperties {
  if (stageIdx < currentIdx) {
    return { background: 'var(--success)', boxShadow: '0 0 6px var(--success-glow)' };
  }
  if (stageIdx === currentIdx && isRunning) {
    return { background: 'var(--warning)', animation: 'dotPulse 2s infinite ease-in-out' };
  }
  return { background: 'var(--text-ghost)' };
}

// ── Time ago helper ──────────────────────────────────────────────

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '';
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Group labels ─────────────────────────────────────────────────

const GROUP_CONFIG: Array<{ key: string; label: string }> = [
  { key: 'running', label: 'Active' },
  { key: 'gate_waiting', label: 'Awaiting Action' },
  { key: 'paused', label: 'Paused' },
  { key: 'done', label: 'Completed' },
  { key: 'expired', label: 'Expired' },
];

// ── Stage abbreviation ──────────────────────────────────────────

function stageAbbrev(stage: string): string {
  const info = STAGE_INFO.find(s => s.stage === stage);
  return info?.label ?? stage;
}

// ── Component ──────────────────────────────────────────────────

export function Sidebar(): JSX.Element {
  const activeTicket = usePipelineStore((s) => s.activeTicket);
  const tickets = usePipelineStore((s) => s.tickets);
  const setActiveTicket = usePipelineStore((s) => s.setActiveTicket);
  const startAgent = usePipelineStore((s) => s.startAgent);
  const sseConnected = usePipelineStore((s) => s.sseConnected);
  const grouped = useGroupedPipelines();
  const currentView = useNavigationStore((s) => s.currentView);
  const setView = useNavigationStore((s) => s.setView);

  const [addTicketValue, setAddTicketValue] = useState('');

  // Get the active ticket's state for stage navigation
  const activeTs = activeTicket ? tickets.get(activeTicket) : null;
  const currentStage = activeTs?.stage ?? 'fetch_ticket';
  const currentIdx = stageIndex(currentStage);
  const isRunning = activeTs?.isRunning ?? false;

  const handlePipelineClick = useCallback((ticket: string) => {
    setActiveTicket(ticket);
    const store = usePipelineStore.getState();
    // Ensure ticket exists in tickets map
    if (!store.tickets.has(ticket)) {
      store.addTicket(ticket);
    }
    // Immediately fetch full state from backend so stage, data, and
    // gate status populate without waiting for SSE or the 30s poll
    store.fetchTicketState(ticket);
  }, [setActiveTicket]);

  const handleAddTicket = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const value = addTicketValue.trim().toUpperCase();
    if (value && /^[A-Z]+-\d+$/.test(value)) {
      // Check if pipeline already exists
      const store = usePipelineStore.getState();
      const existing = store.pipelines.find(p => p.ticket === value);
      if (existing) {
        // Just select it — resume dialog will handle the rest
        handlePipelineClick(value);
      } else {
        startAgent(value, 'fresh');
      }
      setAddTicketValue('');
    }
  }, [addTicketValue, handlePipelineClick, startAgent]);

  const hasPipelines = Object.values(grouped).some(g => g.length > 0);

  return (
    <aside style={styles.sidebar}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.logo} aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5z" />
          </svg>
        </div>
        <div style={styles.headerText}>
          <div style={styles.headerTitle}>AI Dev Agent</div>
          <div style={styles.headerSub}>Pipeline Automation</div>
        </div>
      </div>

      {/* View Navigation */}
      <div style={styles.viewNav}>
        {VIEW_NAV_ITEMS.map((item) => {
          const isActive = currentView === item.view;
          return (
            <button
              key={item.view}
              style={{
                ...styles.viewNavItem,
                ...(isActive ? styles.viewNavItemActive : {}),
              }}
              onClick={() => setView(item.view)}
              aria-current={isActive ? 'page' : undefined}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                style={styles.viewNavIcon}
              >
                <path d={item.iconPath} />
              </svg>
              <span style={styles.label}>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Pipeline list */}
      {hasPipelines && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          {GROUP_CONFIG.map(({ key, label }) => {
            const items = grouped[key] || [];
            if (items.length === 0) return null;
            return (
              <div key={key}>
                <div style={styles.groupTitle}>
                  {label}
                  <span style={styles.groupCount}>{items.length}</span>
                </div>
                <div style={{ padding: '0 var(--sp-2)' }}>
                  {items.map((p: PipelineSummary) => {
                    const isActive = p.ticket === activeTicket;
                    return (
                      <button
                        key={p.ticket}
                        style={{
                          ...styles.pipelineItem,
                          ...(isActive ? styles.pipelineItemActive : {}),
                        }}
                        onClick={() => handlePipelineClick(p.ticket)}
                        title={`${p.ticket} - ${stageAbbrev(p.stage)} (${p.status})`}
                      >
                        <span
                          style={{
                            ...styles.pipelineDot,
                            ...getPipelineDotStyle(p.status),
                          }}
                        />
                        <span style={styles.label}>{p.ticket}</span>
                        {p.needsApproval && (
                          <span style={styles.gateBadge}>Needs approval</span>
                        )}
                        <span style={styles.pipelineMeta}>
                          {timeAgo(p.lastActivity)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!hasPipelines && (
        <div style={{ padding: 'var(--sp-5) var(--sp-4)', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
          No pipelines yet. Add a ticket below to start.
        </div>
      )}

      {/* Pipeline stages for active ticket */}
      {activeTicket && (
        <>
          <div style={styles.sectionTitle}>Pipeline Stages</div>
          <nav style={styles.nav} role="tablist" aria-label="Pipeline steps">
            {STAGE_INFO.map((info, idx) => {
              const isCurrentStage = idx === currentIdx;
              return (
                <button
                  key={info.stage}
                  style={{
                    ...styles.navItem,
                    ...(isCurrentStage ? styles.navItemActive : {}),
                  }}
                  role="tab"
                  aria-selected={isCurrentStage}
                  tabIndex={isCurrentStage ? 0 : -1}
                  title={`${info.label} (${info.who})`}
                >
                  <span style={{ ...styles.dot, ...getDotStyle(idx, currentIdx, isRunning) }} />
                  <span style={styles.label}>{info.label}</span>
                </button>
              );
            })}
          </nav>
        </>
      )}

      {/* Add Ticket input */}
      <div style={styles.addTicketRow}>
        <form onSubmit={handleAddTicket}>
          <input
            type="text"
            value={addTicketValue}
            onChange={(e) => setAddTicketValue(e.target.value)}
            placeholder="Add ticket (e.g. AUT-1234)"
            spellCheck={false}
            style={styles.addTicketInput}
            aria-label="Add ticket ID"
          />
        </form>
      </div>

      {/* Footer */}
      <div style={styles.footer}>
        <span
          style={{
            ...styles.connDot,
            background: sseConnected ? 'var(--success)' : 'var(--danger)',
            boxShadow: sseConnected
              ? '0 0 6px var(--success-glow)'
              : '0 0 6px var(--danger-glow)',
          }}
          aria-hidden="true"
        />
        <span style={styles.footerText}>
          {sseConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
    </aside>
  );
}
