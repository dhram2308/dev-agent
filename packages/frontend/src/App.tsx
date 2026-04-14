// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Main App Component
// Sidebar layout with pipeline dashboard, resume dialog,
// gate notifications, and multi-ticket support
// ═══════════════════════════════════════════════════════════════

import { useEffect, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { TicketForm } from './components/TicketForm';
import { AgentStatus } from './components/AgentStatus';
import { LogViewer } from './components/LogViewer';
import { GateApproval } from './components/GateApproval';
import { ResumeDialog } from './components/ResumeDialog';
import { GateNotificationBar } from './components/GateNotificationBar';
import { PipelineDetail } from './components/PipelineDetail';
import { usePipelineStore, useActiveTicketState } from './store/pipeline';
import { useSSEConnection } from './hooks/useSSEConnection';
import { setApiToken } from './lib/api';
import type { PipelineSummary } from './types';

// ── Styles ─────────────────────────────────────────────────────

const styles = {
  appLayout: {
    display: 'flex',
    minHeight: '100vh',
    position: 'relative' as const,
    zIndex: 1,
  },
  mainContent: {
    flex: 1,
    marginLeft: 'var(--sidebar-w)',
    minHeight: '100vh',
    transition: 'margin-left 0.3s var(--ease-smooth)',
    position: 'relative' as const,
    zIndex: 1,
  },
  topbar: {
    position: 'sticky' as const,
    top: 3,
    zIndex: 50,
    background: 'var(--glass-bg)',
    backdropFilter: 'blur(var(--glass-blur))',
    WebkitBackdropFilter: 'blur(var(--glass-blur))',
    borderBottom: '1px solid var(--glass-border)',
    padding: 'var(--sp-3) var(--sp-5)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
  },
  topbarSearch: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--sp-2) var(--sp-3)',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  },
  topbarInput: {
    flex: 1,
    border: 'none',
    background: 'transparent',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    outline: 'none',
  },
  topbarStatus: {
    padding: 'var(--sp-1) var(--sp-3)',
    borderRadius: 'var(--radius-full)',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    whiteSpace: 'nowrap' as const,
  },
  topbarBtn: {
    padding: 'var(--sp-2) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    transition: 'all 0.2s var(--ease-smooth)',
    whiteSpace: 'nowrap' as const,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
    fontFamily: 'var(--font-sans)',
  },
  mainPanels: {
    padding: 'var(--sp-5)',
    maxWidth: 1200,
  },
} as const;

// ── Initialize API token ───────────────────────────────────────

function initApiToken(): void {
  const globalToken = (window as unknown as Record<string, unknown>).__API_TOKEN__ as string | undefined;
  if (globalToken) {
    setApiToken(globalToken);
    return;
  }
  const envToken = import.meta.env.VITE_API_TOKEN as string | undefined;
  if (envToken) {
    setApiToken(envToken);
    return;
  }
  const metaToken = document.querySelector('meta[name="api-token"]')?.getAttribute('content');
  if (metaToken) {
    setApiToken(metaToken);
  }
}

// ── App Component ──────────────────────────────────────────────

export function App(): JSX.Element {
  const activeTicket = usePipelineStore((s) => s.activeTicket);
  const ticketState = useActiveTicketState();
  const pipelines = usePipelineStore((s) => s.pipelines);
  const startAgent = usePipelineStore((s) => s.startAgent);
  const stopAgent = usePipelineStore((s) => s.stopAgent);
  const resetAgent = usePipelineStore((s) => s.resetAgent);

  // Initialize token on mount
  useEffect(() => {
    initApiToken();
  }, []);

  // Connect to SSE
  useSSEConnection();

  // Find the active pipeline summary from the dashboard list
  const activePipeline: PipelineSummary | undefined = activeTicket
    ? pipelines.find((p: PipelineSummary) => p.ticket === activeTicket)
    : undefined;

  // Determine what to show in the main panel
  const isRunning = ticketState?.isRunning ?? activePipeline?.running ?? false;
  const hasActiveTicket = activeTicket !== null;
  const showResumeDialog = hasActiveTicket && activePipeline && !isRunning &&
    (activePipeline.status === 'paused' || activePipeline.status === 'expired' ||
     activePipeline.status === 'done' || activePipeline.status === 'gate_waiting');
  const showLiveView = hasActiveTicket && (isRunning || ticketState !== null) && !showResumeDialog;

  // Topbar quick-start handler
  const handleTopbarSubmit = useCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem('ticket') as HTMLInputElement | null;
    const value = input?.value?.trim().toUpperCase();
    if (value && /^[A-Z]+-\d+$/i.test(value)) {
      startAgent(value);
      if (input) input.value = '';
    }
  }, [startAgent]);

  return (
    <div style={styles.appLayout}>
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <main style={styles.mainContent}>
        {/* Topbar */}
        <div style={styles.topbar}>
          <form
            onSubmit={handleTopbarSubmit}
            style={styles.topbarSearch}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="7" cy="7" r="4" />
              <path d="M10 10l3.5 3.5" />
            </svg>
            <input
              name="ticket"
              type="text"
              placeholder="Enter ticket ID..."
              spellCheck={false}
              style={styles.topbarInput}
              aria-label="Jira ticket ID"
            />
          </form>

          <div
            style={{
              ...styles.topbarStatus,
              ...(isRunning
                ? { background: 'var(--success-muted)', color: 'var(--success)', animation: 'pulse 2s infinite' }
                : { background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }
              ),
            }}
            role="status"
          >
            {isRunning ? 'Running' : 'Idle'}
          </div>

          {isRunning && activeTicket && (
            <button
              style={{
                ...styles.topbarBtn,
                background: 'var(--danger-muted)',
                color: 'var(--danger)',
                border: '1px solid rgba(239,68,68,0.2)',
              }}
              onClick={() => stopAgent(activeTicket)}
              aria-label="Stop the running agent"
            >
              Stop
            </button>
          )}

          {hasActiveTicket && !isRunning && (
            <button
              style={{
                ...styles.topbarBtn,
                background: 'var(--bg-elevated)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-default)',
              }}
              onClick={() => resetAgent(activeTicket ?? undefined)}
              aria-label="Reset agent state"
            >
              Reset
            </button>
          )}
        </div>

        {/* Gate Notification Bar */}
        <GateNotificationBar />

        {/* Main panels */}
        <div style={styles.mainPanels}>
          {!hasActiveTicket ? (
            /* Empty state: show ticket form */
            <TicketForm />
          ) : showResumeDialog && activePipeline ? (
            /* Paused/expired/done pipeline: show resume dialog */
            <ResumeDialog pipeline={activePipeline} />
          ) : showLiveView ? (
            /* Active ticket: show pipeline detail + status + gate + logs */
            <>
              {activePipeline && <PipelineDetail pipeline={activePipeline} />}
              <AgentStatus />
              <GateApproval />
              <LogViewer />
            </>
          ) : (
            /* Fallback: show ticket form */
            <TicketForm />
          )}
        </div>
      </main>
    </div>
  );
}
