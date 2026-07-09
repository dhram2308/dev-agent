// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Automation Status Strip
// Compact Dashboard summary of the current auto-approve posture
// (Settings → Automation tab) plus a warning when the active
// ticket is sitting at a gate whose policy needs Playground
// validation that doesn't exist yet.
// ═══════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { useSettingsStore } from '../store/settings';
import { useActiveTicketState, usePipelineStore } from '../store/pipeline';
import { AUTOMATION_GATES, getGatePolicy } from '../lib/automation';
import { getPlaygroundRuns } from '../lib/api';
import { useNavigationStore } from '../store/navigation';

const styles = {
  strip: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-2) var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    marginBottom: 'var(--sp-4)',
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  configureLink: {
    marginLeft: 'auto',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--accent)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  },
  warningChip: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 'var(--radius-full)',
    background: 'var(--warning-muted)',
    color: 'var(--warning)',
    fontWeight: 600,
  },
} as const;

export function AutomationStatusStrip(): JSX.Element | null {
  const config = useSettingsStore((s) => s.config);
  const fetchConfig = useSettingsStore((s) => s.fetchConfig);
  const ticketState = useActiveTicketState();
  const activeTicket = usePipelineStore((s) => s.activeTicket);
  const setView = useNavigationStore((s) => s.setView);
  const [needsValidation, setNeedsValidation] = useState(false);

  useEffect(() => {
    if (Object.keys(useSettingsStore.getState().config).length === 0) {
      fetchConfig();
    }
  }, [fetchConfig]);

  const gateWaiting = ticketState?.gateWaiting;

  useEffect(() => {
    setNeedsValidation(false);
    if (!activeTicket || !gateWaiting) return;
    if (getGatePolicy(config, gateWaiting) !== 'playground_validated') return;
    let cancelled = false;
    getPlaygroundRuns(activeTicket, gateWaiting)
      .then((res) => {
        if (cancelled || !res.ok) return;
        const hasValidated = res.runs.some((r) => r.status === 'completed');
        setNeedsValidation(!hasValidated);
      })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
    // config is read for its current value, not a dep — re-running on every
    // config mutation (e.g. an unrelated Settings edit elsewhere) would be
    // wasteful; gate/ticket changes already cause a fresh check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTicket, gateWaiting]);

  if (Object.keys(config).length === 0) return null;

  const policies = AUTOMATION_GATES.map((g) => getGatePolicy(config, g));
  const autoCount = policies.filter((p) => p !== 'manual').length;

  return (
    <div style={styles.strip} role="status">
      <span>
        Automation: {autoCount}/{policies.length} gate{policies.length === 1 ? '' : 's'} auto-approve
        {autoCount === 0 ? ' — fully manual' : ''}
      </span>
      {needsValidation && (
        <span style={styles.warningChip}>
          Current gate needs Playground validation
        </span>
      )}
      <button type="button" style={styles.configureLink} onClick={() => setView('settings')}>
        Configure →
      </button>
    </div>
  );
}
