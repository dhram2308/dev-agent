// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Agent Swim Lanes
// One row per agent during stageGenerateCode showing phase, elapsed
// (ticking live), duration-proportional bar, and output size. Click a
// row to expand a drawer with prompt chars, timeout, and maxTurns.
// Returns null when the store has no entry for the active ticket.
// ═══════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { useActiveTicketState, usePipelineStore } from '../store/pipeline';
import {
  useAgentProgress,
  type ActiveAgent,
  type HistoryAgent,
} from '../store/agentProgress';

// ── Styles ─────────────────────────────────────────────────────

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-2)',
    padding: 'var(--sp-3) var(--sp-4)',
    marginBottom: 'var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--glass-bg, var(--bg-elevated))',
    border: '1px solid var(--glass-border, var(--border-default))',
    backdropFilter: 'blur(var(--glass-blur, 8px))',
    WebkitBackdropFilter: 'blur(var(--glass-blur, 8px))',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    letterSpacing: '0.03em',
    textTransform: 'uppercase' as const,
  },
  headerCount: {
    fontWeight: 500,
    color: 'var(--text-tertiary)',
    textTransform: 'none' as const,
    letterSpacing: 'normal',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '20px 1fr auto auto',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-2) var(--sp-2)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    transition: 'background 0.15s var(--ease-smooth, ease)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
  },
  rowHover: {
    background: 'var(--bg-elevated, rgba(255,255,255,0.04))',
  },
  icon: {
    width: 20,
    textAlign: 'center' as const,
    fontSize: 14,
    lineHeight: '20px',
  },
  iconRunning: {
    color: 'var(--blue)',
    animation: 'spin 1.4s linear infinite',
    display: 'inline-block',
  },
  iconComplete: { color: 'var(--success)' },
  iconFailed: { color: 'var(--danger)' },
  nameBlock: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    minWidth: 0,
  },
  nameRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 'var(--sp-2)',
    minWidth: 0,
  },
  name: {
    fontWeight: 600,
    color: 'var(--text-primary)',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  team: {
    fontSize: 10,
    color: 'var(--text-tertiary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  bar: {
    position: 'relative' as const,
    height: 4,
    borderRadius: 999,
    background: 'var(--border-default, rgba(255,255,255,0.08))',
    marginTop: 4,
    overflow: 'hidden' as const,
  },
  barFill: {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 999,
    transition: 'width 0.6s var(--ease-smooth, ease)',
  },
  duration: {
    color: 'var(--text-secondary)',
    fontVariantNumeric: 'tabular-nums' as const,
    whiteSpace: 'nowrap' as const,
  },
  meta: {
    color: 'var(--text-tertiary)',
    fontVariantNumeric: 'tabular-nums' as const,
    whiteSpace: 'nowrap' as const,
  },
  drawer: {
    gridColumn: '1 / -1',
    marginTop: 'var(--sp-2)',
    padding: 'var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated, rgba(0,0,0,0.2))',
    border: '1px solid var(--border-default)',
    fontSize: 11,
    color: 'var(--text-secondary)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-1)',
  },
  drawerField: {
    display: 'flex',
    gap: 'var(--sp-2)',
  },
  drawerLabel: {
    color: 'var(--text-tertiary)',
    minWidth: 96,
  },
  drawerValue: {
    color: 'var(--text-primary)',
    fontVariantNumeric: 'tabular-nums' as const,
  },
  errorText: {
    color: 'var(--danger)',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
  },
} as const;

// ── Helpers ────────────────────────────────────────────────────

function formatBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number | undefined, precise = false): string {
  const v = ms ?? 0;
  if (v < 1000) return `${Math.max(0, Math.round(v))}ms`;
  const s = v / 1000;
  if (s < 60) return precise ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

interface LaneRow {
  key: string;
  kind: 'active' | 'history';
  active?: ActiveAgent;
  history?: HistoryAgent;
}

// ── Component ──────────────────────────────────────────────────

export function AgentSwimLanes(): JSX.Element | null {
  const activeTicket = usePipelineStore((s) => s.activeTicket);
  const ticketState = useActiveTicketState();
  const entry = useAgentProgress(activeTicket);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const hasRunning = !!entry && entry.active.length > 0;

  // Client-side 1s ticker — only when at least one row is running.
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  const rows: LaneRow[] = useMemo(() => {
    if (!entry) return [];
    const active = [...entry.active]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map<LaneRow>((a) => ({
        key: `active:${a.name}:${a.startedAt}`,
        kind: 'active',
        active: a,
      }));
    const history = [...entry.history]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map<LaneRow>((h) => ({
        key: `history:${h.name}:${h.startedAt}`,
        kind: 'history',
        history: h,
      }));
    return [...active, ...history];
  }, [entry]);

  // Compute per-render max duration including live elapsed, used for bar width.
  const now = Date.now();
  const maxDuration = useMemo(() => {
    if (!entry) return 1;
    let max = 0;
    for (const a of entry.active) {
      max = Math.max(max, now - a.startedAt);
    }
    for (const h of entry.history) {
      max = Math.max(max, h.durationMs);
    }
    return max || 1;
    // intentional: recompute each render via `now` -> row re-renders drive this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, now]);

  if (!activeTicket) return null;
  if (ticketState?.stage !== 'generate_code') return null;
  if (!entry || rows.length === 0) return null;

  const runningCount = entry.active.length;
  const doneCount = entry.history.length;

  return (
    <div style={styles.container} role="region" aria-label="Agent swim lanes">
      <div style={styles.header}>
        <span>Agents</span>
        <span style={styles.headerCount}>
          {runningCount} running · {doneCount} done
        </span>
      </div>
      {rows.map((row) => (
        <LaneRowView
          key={row.key}
          row={row}
          maxDuration={maxDuration}
          now={now}
          expanded={openKey === row.key}
          onToggle={() =>
            setOpenKey((prev) => (prev === row.key ? null : row.key))
          }
        />
      ))}
    </div>
  );
}

interface LaneRowViewProps {
  row: LaneRow;
  maxDuration: number;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}

function LaneRowView({
  row,
  maxDuration,
  now,
  expanded,
  onToggle,
}: LaneRowViewProps): JSX.Element {
  const [hover, setHover] = useState(false);

  const isActive = row.kind === 'active';
  const a = row.active;
  const h = row.history;

  const name = isActive ? a!.name : h!.name;
  const team = isActive ? a!.team : h!.team;
  const duration = isActive ? now - a!.startedAt : h!.durationMs;
  const widthPct = Math.max(2, Math.min(100, (duration / maxDuration) * 100));

  const icon = isActive ? '⟳' : h!.phase === 'complete' ? '✓' : '✗';
  const iconStyle = isActive
    ? styles.iconRunning
    : h!.phase === 'complete'
      ? styles.iconComplete
      : styles.iconFailed;

  const barColor = isActive
    ? 'var(--blue)'
    : h!.phase === 'complete'
      ? 'var(--success)'
      : 'var(--danger)';

  const rowStyle = {
    ...styles.row,
    ...(hover ? styles.rowHover : {}),
  };

  const durationLabel = isActive
    ? `${formatDuration(duration)} (running)`
    : formatDuration(duration, true);

  const meta = !isActive
    ? h!.phase === 'failed'
      ? 'failed'
      : formatBytes(h!.outputChars)
    : '';

  const promptChars = isActive ? a!.promptChars : h!.promptChars;
  const timeoutMs = isActive ? a!.timeoutMs : h!.timeoutMs;
  const maxTurns = isActive ? a!.maxTurns : h!.maxTurns;
  const errorMessage = !isActive ? h!.errorMessage : undefined;

  return (
    <>
      <div
        style={rowStyle}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <span
          style={{ ...styles.icon, ...iconStyle }}
          aria-hidden="true"
        >
          {icon}
        </span>
        <div style={styles.nameBlock}>
          <div style={styles.nameRow}>
            <span style={styles.name}>{name}</span>
            <span style={styles.team}>{team}</span>
          </div>
          <div style={styles.bar} aria-hidden="true">
            <div
              style={{
                ...styles.barFill,
                width: `${widthPct}%`,
                background: barColor,
                opacity: isActive ? 0.7 : 0.9,
              }}
            />
          </div>
        </div>
        <span
          style={
            !isActive && h!.phase === 'failed'
              ? { ...styles.duration, color: 'var(--danger)' }
              : styles.duration
          }
        >
          {durationLabel}
        </span>
        <span style={styles.meta}>{meta}</span>
      </div>
      {expanded && (
        <div style={styles.drawer}>
          <div style={styles.drawerField}>
            <span style={styles.drawerLabel}>promptChars</span>
            <span style={styles.drawerValue}>
              {promptChars != null ? promptChars.toLocaleString() : '—'}
            </span>
          </div>
          <div style={styles.drawerField}>
            <span style={styles.drawerLabel}>timeoutMs</span>
            <span style={styles.drawerValue}>
              {timeoutMs != null ? timeoutMs.toLocaleString() : '—'}
            </span>
          </div>
          <div style={styles.drawerField}>
            <span style={styles.drawerLabel}>maxTurns</span>
            <span style={styles.drawerValue}>
              {maxTurns != null ? String(maxTurns) : '—'}
            </span>
          </div>
          {!isActive && h!.outputChars != null && (
            <div style={styles.drawerField}>
              <span style={styles.drawerLabel}>outputChars</span>
              <span style={styles.drawerValue}>
                {h!.outputChars.toLocaleString()} ({formatBytes(h!.outputChars)})
              </span>
            </div>
          )}
          {errorMessage && (
            <div style={styles.drawerField}>
              <span style={styles.drawerLabel}>error</span>
              <span style={{ ...styles.drawerValue, ...styles.errorText }}>
                {errorMessage}
              </span>
            </div>
          )}
          {!isActive && h!.phase === 'complete' && (
            <div style={{ ...styles.drawerField, color: 'var(--text-tertiary)' }}>
              <span style={styles.drawerLabel}>output</span>
              <span style={styles.drawerValue}>
                Not streamed to the UI — view the raw LogViewer for the full
                agent output.
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default AgentSwimLanes;
