// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Sub-Stage Progress
// Five-pill strip (develop → review → fix → test → push) driven by
// checkpoint fields in `state.data`. Only visible during generate_code.
// ═══════════════════════════════════════════════════════════════

import { useActiveTicketState } from '../store/pipeline';

type SubStage = 'develop' | 'review' | 'fix' | 'test' | 'push';
const ORDER: readonly SubStage[] = ['develop', 'review', 'fix', 'test', 'push'] as const;
const LABELS: Record<SubStage, string> = {
  develop: 'Developer',
  review: 'Review',
  fix: 'Fix',
  test: 'Test & Verify',
  push: 'Push Code',
};

const styles = {
  container: {
    display: 'flex',
    gap: 'var(--sp-2)',
    marginBottom: 'var(--sp-3)',
    alignItems: 'center',
  },
  label: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--text-tertiary)',
    marginRight: 'var(--sp-2)',
  },
  pill: {
    padding: '4px 10px',
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 600,
    border: '1px solid var(--border-default)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
    transition: 'all 0.2s ease',
  },
  pillCurrent: {
    borderColor: 'var(--warning)',
    background: 'var(--warning-muted)',
    color: 'var(--warning)',
    animation: 'pulse 2s infinite',
  },
  pillDone: {
    borderColor: 'var(--success)',
    background: 'var(--success-muted)',
    color: 'var(--success)',
  },
  sep: {
    width: 8,
    height: 1,
    background: 'var(--border-default)',
  },
} as const;

/**
 * Derive current sub-stage from checkpoint fields in state data.
 * Falls back to explicit `_sub_stage` if set.
 */
function deriveSubStage(data: Record<string, unknown>): SubStage {
  // Explicit _sub_stage takes priority if it matches new naming
  const explicit = data._sub_stage;
  if (explicit && ORDER.includes(explicit as SubStage)) return explicit as SubStage;

  // Derive from checkpoint flags
  if (!data._dev_complete) return 'develop';
  if (!data._reviewed) return 'review';
  if (data._codegen_rejections && !data._fixed) return 'fix';
  if (!data._unit_tests_complete && !data._browser_verified) return 'test';
  return 'push';
}

export function SubStageProgress(): JSX.Element | null {
  const ticketState = useActiveTicketState();
  if (!ticketState) return null;
  if (ticketState.stage !== 'generate_code') return null;

  const data = ticketState.state?.data;
  if (!data) return null;

  const current = deriveSubStage(data as Record<string, unknown>);
  const currentIdx = ORDER.indexOf(current);

  return (
    <div style={styles.container} role="status" aria-label="Code generation sub-stage">
      <span style={styles.label}>Code gen</span>
      {ORDER.map((key, idx) => {
        const pillStyle =
          idx < currentIdx
            ? { ...styles.pill, ...styles.pillDone }
            : idx === currentIdx
              ? { ...styles.pill, ...styles.pillCurrent }
              : styles.pill;
        return (
          <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            <span style={pillStyle}>{LABELS[key]}</span>
            {idx < ORDER.length - 1 && <span style={styles.sep} aria-hidden="true" />}
          </span>
        );
      })}
    </div>
  );
}
