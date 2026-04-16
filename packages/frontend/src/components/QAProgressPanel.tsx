// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — QA Progress Panel
// Visualises the two parallel QA streams (QA Main & QA1) as pill
// rows, one pill per module. Reads `state.data.qa_test` once the
// backend has written results. Shown while the pipeline is on the
// test-qa stage or any later stage (results remain visible).
// ═══════════════════════════════════════════════════════════════

import { useMemo } from 'react';
import { useActiveTicketState } from '../store/pipeline';
import type { StageName } from '../types';

// Legacy QA module list (must match packages/backend/.../test-qa.ts)
const QA_MAIN_MODULES = [
  { name: 'Dashboard', path: '/dashboard' },
  { name: 'GST Return', path: '/gst-return' },
  { name: 'Reports', path: '/reports' },
  { name: 'Configurations', path: '/configurations' },
  { name: 'Import', path: '/import' },
] as const;

const QA1_MODULES = [
  { name: 'IMS (Inventory)', path: '/ims' },
  { name: 'Reconcile', path: '/reconcile' },
] as const;

// Stages after which QA results are meaningful to show
const SHOW_AFTER_STAGES: StageName[] = [
  'test_qa',
  'gate_preprod_approval',
  'create_preprod_mr',
  'gate_dual_approval',
  'deploy_prod',
  'done',
];

interface QaTestResult {
  name: string;
  path: string;
  env: string;
  status: number;
  ok: boolean;
  error?: string;
  errorType?: 'ENV_DOWN' | 'TEST_FAIL';
}

type PillStatus = 'pass' | 'fail' | 'env_down' | 'pending';

const styles = {
  container: {
    marginBottom: 'var(--sp-4)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-surface)',
    padding: 'var(--sp-4)',
  },
  title: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 'var(--sp-3)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
  },
  streams: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 'var(--sp-4)',
  },
  stream: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-2)',
  },
  streamHeader: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: 'var(--text-tertiary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  streamSummary: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    fontWeight: 400,
    textTransform: 'none' as const,
    letterSpacing: 0,
  },
  pillRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    padding: '6px 10px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-subtle)',
    fontSize: 12,
  },
  pillDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  pillName: {
    flex: 1,
    color: 'var(--text-primary)',
    fontWeight: 500,
  },
  pillBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: 'var(--radius-full)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  pillError: {
    fontSize: 11,
    color: 'var(--danger)',
    marginLeft: 'var(--sp-2)',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    maxWidth: 180,
  },
} as const;

function statusColors(status: PillStatus): { dot: string; badgeBg: string; badgeFg: string; label: string } {
  switch (status) {
    case 'pass':
      return {
        dot: 'var(--success)',
        badgeBg: 'var(--success-muted)',
        badgeFg: 'var(--success)',
        label: 'Pass',
      };
    case 'fail':
      return {
        dot: 'var(--danger)',
        badgeBg: 'var(--danger-muted)',
        badgeFg: 'var(--danger)',
        label: 'Fail',
      };
    case 'env_down':
      return {
        dot: 'var(--warning)',
        badgeBg: 'var(--warning-muted)',
        badgeFg: 'var(--warning)',
        label: 'Env down',
      };
    default:
      return {
        dot: 'var(--text-ghost)',
        badgeBg: 'var(--bg-elevated)',
        badgeFg: 'var(--text-tertiary)',
        label: 'Pending',
      };
  }
}

function resolveStatus(
  moduleName: string,
  envName: string,
  results: QaTestResult[],
): PillStatus {
  const r = results.find((x) => x.name === moduleName && x.env === envName);
  if (!r) return 'pending';
  if (r.ok) return 'pass';
  if (r.errorType === 'ENV_DOWN') return 'env_down';
  return 'fail';
}

function StreamColumn({
  title,
  envName,
  modules,
  results,
}: {
  title: string;
  envName: string;
  modules: readonly { name: string; path: string }[];
  results: QaTestResult[];
}): JSX.Element {
  const passed = modules.filter(
    (m) => resolveStatus(m.name, envName, results) === 'pass',
  ).length;

  return (
    <div style={styles.stream}>
      <div style={styles.streamHeader}>
        <span>{title}</span>
        <span style={styles.streamSummary}>
          {passed}/{modules.length} passed
        </span>
      </div>
      {modules.map((m) => {
        const status = resolveStatus(m.name, envName, results);
        const colors = statusColors(status);
        const result = results.find((x) => x.name === m.name && x.env === envName);
        return (
          <div key={m.name} style={styles.pillRow}>
            <span style={{ ...styles.pillDot, background: colors.dot }} />
            <span style={styles.pillName}>{m.name}</span>
            <span
              style={{
                ...styles.pillBadge,
                background: colors.badgeBg,
                color: colors.badgeFg,
              }}
            >
              {colors.label}
            </span>
            {result && !result.ok && result.error && (
              <span style={styles.pillError} title={result.error}>
                {result.error}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function QAProgressPanel(): JSX.Element | null {
  const ticketState = useActiveTicketState();

  const shouldShow = useMemo(() => {
    if (!ticketState) return false;
    return SHOW_AFTER_STAGES.includes(ticketState.stage);
  }, [ticketState]);

  const results = useMemo<QaTestResult[]>(() => {
    const data = ticketState?.state?.data as Record<string, unknown> | undefined;
    const raw = data?.qa_test;
    if (Array.isArray(raw)) {
      return raw as QaTestResult[];
    }
    return [];
  }, [ticketState]);

  if (!shouldShow) return null;

  return (
    <div style={styles.container}>
      <div style={styles.title}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 2h4v2l3 6a2 2 0 01-1.8 3H4.8A2 2 0 013 9l3-6V2z" />
        </svg>
        QA Test Progress
      </div>
      <div style={styles.streams}>
        <StreamColumn
          title="QA Main"
          envName="QA Main"
          modules={QA_MAIN_MODULES}
          results={results}
        />
        <StreamColumn
          title="QA1"
          envName="QA1"
          modules={QA1_MODULES}
          results={results}
        />
      </div>
    </div>
  );
}
