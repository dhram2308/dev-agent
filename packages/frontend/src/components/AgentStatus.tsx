// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Agent Status Component
// Shows current stage, pipeline progress, timers, stuck indicator
// ═══════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from 'react';
import { usePipelineStore, useActiveTicketState, stageIndex } from '../store/pipeline';
import { STAGE_ORDER, STAGE_INFO } from '../types';
import { AgentActivityBar } from './AgentActivityBar';
import { ConfirmDialog } from './ConfirmDialog';
import { FORCE_OPEN_STAGE_EVENT } from './StageOverviewSection';
import { useToast } from '../contexts/ToastContext';

// ── Timer hook ─────────────────────────────────────────────────

export function useElapsedTime(startTime: number | null): string {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!startTime) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  if (!startTime) return '--:--';

  const elapsed = Math.max(0, Date.now() - startTime);
  const secs = Math.floor(elapsed / 1000) % 60;
  const mins = Math.floor(elapsed / 60000) % 60;
  const hours = Math.floor(elapsed / 3600000);

  if (hours > 0) {
    return `${hours}h ${mins.toString().padStart(2, '0')}m`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ── Styles ─────────────────────────────────────────────────────

const styles = {
  container: {
    background: 'var(--glass-bg)',
    backdropFilter: 'blur(var(--glass-blur))',
    WebkitBackdropFilter: 'blur(var(--glass-blur))',
    border: '1px solid var(--glass-border)',
    borderTop: 'none',
    borderRadius: '0 0 var(--radius-lg) var(--radius-lg)',
    padding: 'var(--sp-4)',
    paddingTop: 0,
    marginBottom: 'var(--sp-6)',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    marginBottom: 'var(--sp-4)',
    flexWrap: 'wrap' as const,
  },
  stageName: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  stageLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--text-tertiary)',
  },
  timer: {
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    color: 'var(--text-secondary)',
    marginLeft: 'auto',
  },
  timerLabel: {
    fontSize: 10,
    color: 'var(--text-tertiary)',
    marginRight: 4,
  },
  stopButton: {
    padding: 'var(--sp-2) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'var(--danger-muted)',
    color: 'var(--danger)',
    border: '1px solid rgba(239,68,68,0.2)',
    transition: 'all 0.2s',
    fontFamily: 'var(--font-sans)',
  },
  stoppedBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    padding: 'var(--sp-2) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    fontSize: 12,
    color: 'var(--text-tertiary)',
    fontWeight: 500,
  },
  restartBtn: {
    padding: 'var(--sp-2) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
    border: '1px solid var(--accent)',
    transition: 'all 0.2s',
    fontFamily: 'var(--font-sans)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
  },
  dropBtn: {
    padding: 'var(--sp-2) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--danger)',
    border: '1px solid rgba(239,68,68,0.3)',
    transition: 'all 0.2s',
    fontFamily: 'var(--font-sans)',
  },
  progressContainer: {
    display: 'flex',
    gap: 3,
    alignItems: 'stretch',
    marginBottom: 'var(--sp-4)',
  },
  progressSegment: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    transition: 'background 0.3s ease, box-shadow 0.3s ease',
  },
  stageGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
    gap: 'var(--sp-2)',
  },
  stagePill: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 4,
    padding: 'var(--sp-3) var(--sp-2)',
    borderRadius: 'var(--radius-md)',
    border: '1.5px solid var(--border-default)',
    background: 'var(--bg-surface)',
    cursor: 'pointer',
    transition: 'all 0.2s ease, transform 0.15s ease',
    fontSize: 11,
    textAlign: 'center' as const,
    fontFamily: 'var(--font-sans)',
    color: 'var(--text-primary)',
    position: 'relative' as const,
  },
  pillNum: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-secondary)',
  },
  pillLabel: {
    fontSize: 10,
    lineHeight: 1.3,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    maxWidth: '100%',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
} as const;

// ── Stage status computation ───────────────────────────────────

type StageStatus = 'pending' | 'current' | 'done' | 'failed';

function getStageStatus(
  stageIdx: number,
  currentIdx: number,
  isRunning: boolean,
  hasError: boolean,
): StageStatus {
  if (stageIdx < currentIdx) return 'done';
  if (stageIdx === currentIdx) {
    if (hasError) return 'failed';
    return isRunning ? 'current' : 'pending';
  }
  return 'pending';
}

function getSegmentStyle(status: StageStatus): React.CSSProperties {
  switch (status) {
    case 'done':
      return { background: 'var(--success)', boxShadow: '0 0 6px var(--success-glow)' };
    case 'current':
      return { background: 'var(--warning)', boxShadow: '0 0 6px var(--warning-muted)', animation: 'pulse 2s infinite' };
    case 'failed':
      return { background: 'var(--danger)', boxShadow: '0 0 6px var(--danger-glow)' };
    default:
      return { background: 'var(--gray-bg)' };
  }
}

function getPillStyle(status: StageStatus): React.CSSProperties {
  switch (status) {
    case 'done':
      return { borderColor: 'var(--success)', background: 'var(--success-muted)' };
    case 'current':
      return { borderColor: 'var(--warning)', background: 'var(--warning-muted)', animation: 'pulse 2s infinite' };
    case 'failed':
      return { borderColor: 'var(--danger)', background: 'var(--danger-muted)' };
    default:
      return { borderColor: 'var(--rail)' };
  }
}

function getDotColor(status: StageStatus): string {
  switch (status) {
    case 'done': return 'var(--success)';
    case 'current': return 'var(--warning)';
    case 'failed': return 'var(--danger)';
    default: return 'var(--text-ghost)';
  }
}

// ── Component ──────────────────────────────────────────────────

export function AgentStatus(): JSX.Element | null {
  const ticketState = useActiveTicketState();
  const stopAgent = usePipelineStore((s) => s.stopAgent);
  const startAgent = usePipelineStore((s) => s.startAgent);
  const deletePipeline = usePipelineStore((s) => s.deletePipeline);
  const activeTicket = usePipelineStore((s) => s.activeTicket);
  const { addToast } = useToast();

  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [actioning, setActioning] = useState(false);

  const stageElapsed = useElapsedTime(ticketState?.stageStartedAt ?? null);
  const pipelineElapsed = useElapsedTime(ticketState?.pipelineStartedAt ?? null);

  const handleStop = useCallback(async () => {
    if (!activeTicket) return;
    try {
      await stopAgent(activeTicket);
      addToast(`Agent stopped for ${activeTicket}`, 'warn');
    } catch {
      addToast('Failed to stop agent', 'error');
    }
  }, [activeTicket, stopAgent, addToast]);

  const handleRestart = useCallback(async () => {
    if (!activeTicket) return;
    setActioning(true);
    try {
      await startAgent(activeTicket, 'fresh');
      addToast(`${activeTicket} restarted from scratch`, 'success');
    } catch {
      addToast('Failed to restart — please try again', 'error');
    } finally {
      setActioning(false);
      setConfirmRestart(false);
    }
  }, [activeTicket, startAgent, addToast]);

  const handleDrop = useCallback(async () => {
    if (!activeTicket) return;
    setActioning(true);
    try {
      await deletePipeline(activeTicket);
      addToast(`${activeTicket} removed`, 'info');
    } catch {
      addToast('Failed to remove pipeline — please try again', 'error');
    } finally {
      setActioning(false);
      setConfirmDrop(false);
    }
  }, [activeTicket, deletePipeline, addToast]);

  if (!ticketState) return null;

  const currentStage = ticketState.stage;
  const currentIdx = stageIndex(currentStage);
  const isRunning = ticketState.isRunning;
  const hasError = ticketState.error !== null;

  // Progress percentage
  const progressPercent = Math.round(((currentIdx + (isRunning ? 0.5 : 0)) / STAGE_ORDER.length) * 100);

  return (
    <div style={styles.container}>
      {/* Fixed progress bar at top of page */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: 3,
        background: 'var(--bg-elevated)', zIndex: 1500, overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', width: `${progressPercent}%`,
          background: 'linear-gradient(90deg, var(--blue), var(--accent))',
          transition: 'width 0.6s ease',
        }} />
      </div>

      {/* Error banner */}
      {ticketState.error && (
        <div style={{
          padding: 'var(--sp-3) var(--sp-4)',
          borderRadius: 'var(--radius-md)',
          marginBottom: 'var(--sp-3)',
          background: 'var(--danger-muted)',
          border: '1px solid rgba(239,68,68,0.2)',
          color: 'var(--danger)',
          fontSize: 13,
          fontWeight: 500,
          animation: 'slideDown 0.3s ease-out',
        }} role="alert">
          {ticketState.error}
        </div>
      )}

      {/* Top bar: stage name + timers + stop/restart/drop buttons */}
      <div style={styles.topBar}>
        <div>
          <div style={styles.stageLabel}>
            Stage {currentIdx + 1} of {STAGE_ORDER.length}
          </div>
          <div style={styles.stageName}>
            {STAGE_INFO[currentIdx]?.label ?? currentStage}
          </div>
        </div>

        <div style={styles.timer}>
          <span style={styles.timerLabel}>Stage:</span>
          {stageElapsed}
          <span style={{ margin: '0 var(--sp-2)', color: 'var(--text-ghost)' }}>|</span>
          <span style={styles.timerLabel}>Total:</span>
          {pipelineElapsed}
        </div>

        {isRunning ? (
          <button style={styles.stopButton} onClick={() => void handleStop()} aria-label="Stop the running agent">
            Stop
          </button>
        ) : currentStage !== 'done' && (
          <div style={styles.stoppedBar}>
            <span>Stopped</span>
            <button
              style={styles.restartBtn}
              onClick={() => setConfirmRestart(true)}
              disabled={actioning}
              aria-label="Restart this ticket from scratch"
            >
              Restart
            </button>
            <button
              style={styles.dropBtn}
              onClick={() => setConfirmDrop(true)}
              disabled={actioning}
              aria-label="Remove this pipeline"
            >
              Drop
            </button>
          </div>
        )}
      </div>

      {/* Restart confirmation */}
      <ConfirmDialog
        open={confirmRestart}
        title={`Restart ${activeTicket}?`}
        message="This will delete all existing progress and start the pipeline from scratch. This cannot be undone."
        confirmText="Restart"
        cancelText="Cancel"
        onConfirm={() => void handleRestart()}
        onCancel={() => setConfirmRestart(false)}
        danger
      />

      {/* Drop confirmation */}
      <ConfirmDialog
        open={confirmDrop}
        title={`Drop ${activeTicket}?`}
        message="This permanently removes all pipeline state, logs, and history for this ticket. This cannot be undone."
        confirmText="Drop"
        cancelText="Cancel"
        onConfirm={() => void handleDrop()}
        onCancel={() => setConfirmDrop(false)}
        danger
      />

      {/* Segmented progress bar */}
      <div style={styles.progressContainer} role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Pipeline progress">
        {STAGE_ORDER.map((stage, idx) => {
          const status = getStageStatus(idx, currentIdx, isRunning, hasError && idx === currentIdx);
          return (
            <div
              key={stage}
              style={{ ...styles.progressSegment, ...getSegmentStyle(status) }}
              title={STAGE_INFO[idx]?.label ?? stage}
            />
          );
        })}
      </div>

      {/* Live agent activity (pulsing dot + one-line status) */}
      <AgentActivityBar />

      {/* Stage pills grid — clickable: each pill scrolls to its detail anchor */}
      <div style={styles.stageGrid} role="tablist" aria-label="Pipeline stages">
        {STAGE_INFO.map((info, idx) => {
          const status = getStageStatus(idx, currentIdx, isRunning, hasError && idx === currentIdx);
          const handleActivate = (): void => {
            const target = document.getElementById(`stage-section-${info.stage}`);
            if (target) {
              target.dispatchEvent(new CustomEvent(FORCE_OPEN_STAGE_EVENT));
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
              // Brief highlight pulse so the operator sees where they landed
              target.classList.add('mi-stage-highlight');
              window.setTimeout(() => target.classList.remove('mi-stage-highlight'), 1500);
            }
          };
          return (
            <div
              key={info.stage}
              style={{ ...styles.stagePill, ...getPillStyle(status), cursor: 'pointer' }}
              role="tab"
              aria-selected={idx === currentIdx}
              aria-controls={`stage-section-${info.stage}`}
              tabIndex={0}
              onClick={handleActivate}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleActivate();
                }
              }}
              title={`${info.label} — ${status} (click to view details)`}
            >
              <div style={{ ...styles.dot, background: getDotColor(status) }} />
              <div style={styles.pillNum}>{idx + 1}</div>
              <div style={styles.pillLabel}>{info.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
