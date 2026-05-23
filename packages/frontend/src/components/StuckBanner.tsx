// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Stuck Banner
//
// Shows a warning banner when the active ticket is genuinely stalled
// (no agent heartbeat / activity update for too long). Previously this
// component fired purely on stage age, which produced false positives
// during the legitimately-long `generate_code` stage (often 30-60 min
// of active work). Now it uses _lastActivity as the freshness signal
// and per-stage thresholds tuned to each stage's normal duration.
// ═══════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { useActiveTicketState } from '../store/pipeline';
import { STAGE_INFO, type StageName } from '../types';

// Per-stage "no activity" thresholds, calibrated against each stage's
// legitimate normal duration. The backend's stage-timeout budgets are
// the hard wall — these are the "operator should look at it" softer
// thresholds, set well below the backend timeouts so the banner
// triggers BEFORE the stage actually fails.
const STUCK_THRESHOLD_MS_PER_STAGE: Partial<Record<StageName, number>> = {
  fetch_ticket: 3 * 60 * 1000,
  explore_plan: 8 * 60 * 1000,       // 4 analysis agents + architect
  generate_code: 15 * 60 * 1000,     // long-running dev/review/fix loop
  gate_code_review: Number.POSITIVE_INFINITY,   // human gate — never stuck
  deploy_qa: 5 * 60 * 1000,
  test_qa: Number.POSITIVE_INFINITY,            // human gate
  gate_preprod_approval: Number.POSITIVE_INFINITY,
  create_preprod_mr: 3 * 60 * 1000,
  gate_dual_approval: Number.POSITIVE_INFINITY,
  deploy_prod: 10 * 60 * 1000,
};

// Fallback when stage isn't in the map.
const DEFAULT_STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const TICK_INTERVAL_MS = 30 * 1000; // re-evaluate every 30s

function getStuckThreshold(stage: StageName): number {
  const v = STUCK_THRESHOLD_MS_PER_STAGE[stage];
  return v !== undefined ? v : DEFAULT_STUCK_THRESHOLD_MS;
}

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

  // Prefer _lastActivity (updated every 30s by claude.ts's heartbeat
  // during active agent work, and by state writes elsewhere) over plain
  // stage age. An active agent will keep _lastActivity fresh; a frozen
  // pipeline will let it grow stale even mid-stage.
  const lastActivityIso = ticketState.state?.data?._lastActivity;
  const lastActivityMs = lastActivityIso
    ? Date.parse(lastActivityIso)
    : ticketState.stageStartedAt;
  const elapsedSinceActivity = Date.now() - (Number.isFinite(lastActivityMs) ? lastActivityMs : ticketState.stageStartedAt);

  const threshold = getStuckThreshold(ticketState.stage);
  if (elapsedSinceActivity < threshold) return null;

  const stageLabel = STAGE_INFO.find((s) => s.stage === ticketState.stage)?.label ?? ticketState.stage;
  const stageAge = Date.now() - ticketState.stageStartedAt;

  return (
    <div style={styles.banner} role="status" aria-live="polite">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={styles.icon}>
        <circle cx="9" cy="9" r="7.25" />
        <path d="M9 5v4l2.5 2.5" />
      </svg>
      <div style={styles.content}>
        <div style={styles.title}>Stage may be stuck</div>
        <div style={styles.detail}>
          <strong>{stageLabel}</strong> — {lastActivityIso ? `last activity ${formatDuration(elapsedSinceActivity)} ago` : `no activity in ${formatDuration(elapsedSinceActivity)}`}.
          Stage has been running for {formatDuration(stageAge)} total. Consider checking logs or resetting the stage.
        </div>
      </div>
    </div>
  );
}
