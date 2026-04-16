// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Stuck Banner
// Shows a warning banner when the active ticket has been on the
// same stage for longer than STUCK_THRESHOLD_MS (10 minutes) while
// still marked running. The store's useIsStuck selector only
// recomputes when state changes, so we tick a local timer to
// keep it honest during long quiet periods.
// ═══════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { useActiveTicketState } from '../store/pipeline';
import { STAGE_INFO } from '../types';

const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const TICK_INTERVAL_MS = 30 * 1000; // re-evaluate every 30s

const styles = {
  banner: {
    marginBottom: 'var(--sp-4)',
    padding: 'var(--sp-3) var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--warning-muted)',
    border: '1px solid var(--warning)',
    color: 'var(--warning)',
    fontSize: 13,
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
  },
  icon: {
    flexShrink: 0,
  },
  content: {
    flex: 1,
  },
  title: {
    fontWeight: 700,
    marginBottom: 2,
  },
  detail: {
    fontSize: 12,
    opacity: 0.85,
  },
} as const;

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem}m`;
}

export function StuckBanner(): JSX.Element | null {
  const ticketState = useActiveTicketState();
  const [, tick] = useState(0);

  // Force re-render on a 30s cadence so the "stuck" calculation stays live
  // while the server is quiet.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  if (!ticketState) return null;
  if (!ticketState.isRunning) return null;
  if (!ticketState.stageStartedAt) return null;

  const elapsed = Date.now() - ticketState.stageStartedAt;
  if (elapsed < STUCK_THRESHOLD_MS) return null;

  const stageLabel = STAGE_INFO.find((s) => s.stage === ticketState.stage)?.label ?? ticketState.stage;

  return (
    <div style={styles.banner} role="status" aria-live="polite">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={styles.icon}>
        <circle cx="9" cy="9" r="7.25" />
        <path d="M9 5v4l2.5 2.5" />
      </svg>
      <div style={styles.content}>
        <div style={styles.title}>Stage may be stuck</div>
        <div style={styles.detail}>
          <strong>{stageLabel}</strong> has been running for {formatDuration(elapsed)} without progress. Consider checking logs or resetting the stage.
        </div>
      </div>
    </div>
  );
}
