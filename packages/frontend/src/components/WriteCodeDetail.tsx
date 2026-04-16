// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Write Code Detail Panel
// Three tabs (Developer, Test & Verify, Create MR) showing
// checkpoint data from state.data during and after generate_code.
// ═══════════════════════════════════════════════════════════════

import { useState, useMemo } from 'react';
import { useActiveTicketState } from '../store/pipeline';
import type { StageName } from '../types';

// Stages during/after which this panel is visible
const SHOW_STAGES: StageName[] = [
  'generate_code',
  'gate_code_review',
  'deploy_qa',
  'test_qa',
  'gate_preprod_approval',
  'create_preprod_mr',
  'gate_dual_approval',
  'deploy_prod',
  'done',
];

type TabKey = 'developer' | 'test_verify' | 'create_mr';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'developer', label: 'Developer' },
  { key: 'test_verify', label: 'Test & Verify' },
  { key: 'create_mr', label: 'Create MR' },
];

// ── Styles ─────────────────────────────────────────────────────

const styles = {
  container: {
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--glass-border)',
    background: 'var(--glass-bg)',
    backdropFilter: 'blur(var(--glass-blur))',
    WebkitBackdropFilter: 'blur(var(--glass-blur))',
    padding: 'var(--sp-5)',
    marginBottom: 'var(--sp-6)',
    animation: 'fadeIn 0.3s ease-out',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    marginBottom: 'var(--sp-4)',
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  tabBar: {
    display: 'flex',
    gap: 0,
    borderBottom: '2px solid var(--border-default)',
    marginBottom: 'var(--sp-4)',
  },
  tab: {
    padding: '8px 18px',
    borderRadius: '8px 8px 0 0',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid transparent',
    borderBottom: 'none',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    transition: 'all 0.15s',
    fontFamily: 'var(--font-sans)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
  },
  tabActive: {
    borderColor: 'var(--border-default)',
    borderBottom: '2px solid var(--bg-surface)',
    marginBottom: -2,
    background: 'var(--bg-surface)',
    color: 'var(--accent)',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  content: {
    minHeight: 60,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    padding: '6px 10px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-subtle)',
    fontSize: 12,
    marginBottom: 'var(--sp-2)',
  },
  rowDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  rowLabel: {
    flex: 1,
    color: 'var(--text-primary)',
    fontWeight: 500,
  },
  rowBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: 'var(--radius-full)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  summary: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
    padding: 'var(--sp-3)',
    background: 'var(--bg-elevated)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-subtle)',
    marginTop: 'var(--sp-2)',
    maxHeight: 200,
    overflowY: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
    fontFamily: 'var(--font-mono)',
  },
  link: {
    color: 'var(--accent)',
    textDecoration: 'underline',
    cursor: 'pointer',
    fontSize: 12,
  },
  empty: {
    textAlign: 'center' as const,
    color: 'var(--text-ghost)',
    fontSize: 12,
    padding: 'var(--sp-4)',
    fontStyle: 'italic',
  },
} as const;

// ── Helpers ────────────────────────────────────────────────────

type CheckStatus = 'done' | 'in_progress' | 'fail' | 'pending';

function statusDotColor(s: CheckStatus): string {
  switch (s) {
    case 'done': return 'var(--success)';
    case 'in_progress': return 'var(--warning)';
    case 'fail': return 'var(--danger)';
    default: return 'var(--text-ghost)';
  }
}

function statusBadge(s: CheckStatus): { bg: string; fg: string; label: string } {
  switch (s) {
    case 'done': return { bg: 'var(--success-muted)', fg: 'var(--success)', label: 'Done' };
    case 'in_progress': return { bg: 'var(--warning-muted)', fg: 'var(--warning)', label: 'Running' };
    case 'fail': return { bg: 'var(--danger-muted)', fg: 'var(--danger)', label: 'Failed' };
    default: return { bg: 'var(--bg-elevated)', fg: 'var(--text-tertiary)', label: 'Pending' };
  }
}

function StatusRow({ label, status, extra }: { label: string; status: CheckStatus; extra?: string }): JSX.Element {
  const badge = statusBadge(status);
  return (
    <div style={styles.row}>
      <span style={{ ...styles.rowDot, background: statusDotColor(status) }} />
      <span style={styles.rowLabel}>{label}</span>
      {extra && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginRight: 4 }}>{extra}</span>}
      <span style={{ ...styles.rowBadge, background: badge.bg, color: badge.fg }}>{badge.label}</span>
    </div>
  );
}

// ── Tab status derivation ─────────────────────────────────────

function deriveTabStatus(tab: TabKey, data: Record<string, unknown>, isGenerating: boolean): CheckStatus {
  switch (tab) {
    case 'developer': {
      if (data._dev_failed) return 'fail';
      if (data._dev_complete) return 'done';
      if (isGenerating) return 'in_progress';
      return 'pending';
    }
    case 'test_verify': {
      if (!data._dev_complete) return 'pending';
      const allDone = data._reviewed && (data._build_tsc !== false) && data._ac_verified;
      if (allDone) return 'done';
      if (data._reviewed || data._build_tsc !== undefined || data._unit_tests_complete) return 'in_progress';
      if (isGenerating && data._dev_complete) return 'in_progress';
      return 'pending';
    }
    case 'create_mr': {
      if (data.code_mr_url) return 'done';
      if (data.code_committed || data.code_branch) return 'in_progress';
      return 'pending';
    }
  }
}

// ── Tab content renderers ─────────────────────────────────────

function DeveloperTab({ data }: { data: Record<string, unknown> }): JSX.Element {
  const devStatus: CheckStatus = data._dev_failed ? 'fail' : data._dev_complete ? 'done' : 'pending';
  const complexity = data._complexity as string | undefined;

  return (
    <div>
      <StatusRow label="Code Generation" status={devStatus} extra={complexity ? `(${complexity})` : undefined} />
      {data._dev_summary ? (
        <div style={styles.summary}>{String(data._dev_summary)}</div>
      ) : null}
    </div>
  );
}

function TestVerifyTab({ data }: { data: Record<string, unknown> }): JSX.Element {
  const reviewStatus: CheckStatus = data._reviewed ? 'done' : 'pending';
  const securityStatus: CheckStatus = data._fixed !== undefined ? (data._fixed ? 'done' : 'fail') : 'pending';
  const tscVal = data._build_tsc;
  const tscStatus: CheckStatus =
    tscVal === true || tscVal === 'PASS' ? 'done' : tscVal === false || tscVal === 'FAIL' ? 'fail' : 'pending';
  const eslintVal = data._build_eslint;
  const eslintStatus: CheckStatus =
    eslintVal === true || eslintVal === 'PASS' ? 'done' : eslintVal === false || eslintVal === 'FAIL' ? 'fail' : 'pending';
  const unitVal = data._unit_tests_complete;
  const unitStatus: CheckStatus = unitVal && unitVal !== 'SKIP' ? 'done' : unitVal === 'SKIP' ? 'done' : 'pending';
  const unitCount = data._unit_tests_count as string | number | undefined;
  const acStatus: CheckStatus = data._ac_verified ? 'done' : 'pending';
  const acGaps = data._ac_known_gaps as string[] | undefined;
  const browserStatus: CheckStatus = data._browser_verified ? 'done' : 'pending';

  return (
    <div>
      <StatusRow label="Code Review" status={reviewStatus} />
      <StatusRow label="Security Fix" status={securityStatus} />
      <StatusRow label="Build (TSC)" status={tscStatus} />
      <StatusRow label="ESLint" status={eslintStatus} />
      <StatusRow label="Unit Tests" status={unitStatus} extra={unitVal === 'SKIP' ? 'skipped' : unitCount != null ? `${unitCount}` : undefined} />
      <StatusRow label="AC Verification" status={acStatus} />
      {acGaps && acGaps.length > 0 && (
        <div style={{ ...styles.summary, maxHeight: 100 }}>
          Known gaps: {acGaps.join(', ')}
        </div>
      )}
      <StatusRow label="Browser Verify" status={browserStatus} />
    </div>
  );
}

function CreateMRTab({ data }: { data: Record<string, unknown> }): JSX.Element {
  const branchStatus: CheckStatus = data.code_branch ? 'done' : 'pending';
  const commitStatus: CheckStatus = data.code_committed ? 'done' : 'pending';
  const conflictStatus: CheckStatus = data._conflict_check_done ? 'done' : 'pending';
  const mrStatus: CheckStatus = data.code_mr_url ? 'done' : 'pending';
  const slackStatus: CheckStatus = data.code_slack_sent ? 'done' : 'pending';

  const branch = data.code_branch as string | undefined;
  const sha = data._last_commit_sha as string | undefined;
  const mrUrl = data.code_mr_url as string | undefined;
  const mrIid = data.code_mr_iid as string | number | undefined;

  return (
    <div>
      <StatusRow label="Branch" status={branchStatus} extra={branch || undefined} />
      <StatusRow label="Committed" status={commitStatus} extra={sha ? sha.slice(0, 8) : undefined} />
      <StatusRow label="Conflict Check" status={conflictStatus} />
      <StatusRow label="Merge Request" status={mrStatus} extra={mrIid ? `!${mrIid}` : undefined} />
      {mrUrl && (
        <div style={{ padding: '4px 10px', marginBottom: 'var(--sp-2)' }}>
          <a href={String(mrUrl)} target="_blank" rel="noopener noreferrer" style={styles.link}>
            Open MR in GitLab
          </a>
        </div>
      )}
      <StatusRow label="Slack Notification" status={slackStatus} />
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────

export function WriteCodeDetail(): JSX.Element | null {
  const ticketState = useActiveTicketState();
  const [activeTab, setActiveTab] = useState<TabKey>('developer');

  const shouldShow = useMemo(() => {
    if (!ticketState) return false;
    // Show if we're on or past generate_code stage
    if (SHOW_STAGES.includes(ticketState.stage)) return true;
    // Also show if state data has any generate_code checkpoint fields
    // (covers edge cases where stage is stale but data is populated)
    const d = ticketState.state?.data;
    if (d && (d._dev_complete || d.code_branch || d.code_mr_url)) return true;
    return false;
  }, [ticketState]);

  const data = useMemo<Record<string, unknown>>(() => {
    return (ticketState?.state?.data as Record<string, unknown>) ?? {};
  }, [ticketState]);

  if (!shouldShow) return null;

  const isGenerating = ticketState?.stage === 'generate_code' && ticketState.isRunning;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 7 8 3 12 7" />
          <polyline points="4 13 8 9 12 13" />
        </svg>
        <span style={styles.title}>Write Code</span>
      </div>

      {/* Tab bar */}
      <div style={styles.tabBar}>
        {TABS.map(({ key, label }) => {
          const tabStatus = deriveTabStatus(key, data, !!isGenerating);
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              style={{
                ...styles.tab,
                ...(isActive ? styles.tabActive : {}),
              }}
              onClick={() => setActiveTab(key)}
            >
              <span style={{ ...styles.dot, background: statusDotColor(tabStatus) }} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={styles.content}>
        {activeTab === 'developer' && <DeveloperTab data={data} />}
        {activeTab === 'test_verify' && <TestVerifyTab data={data} />}
        {activeTab === 'create_mr' && <CreateMRTab data={data} />}
      </div>
    </div>
  );
}
