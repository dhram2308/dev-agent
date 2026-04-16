// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Write Code Detail Panel
// Seven tabs mapping 1:1 to every generate_code sub-step,
// showing all 75 checkpoint fields from state.data.
// Visible from generate_code through done.
// ═══════════════════════════════════════════════════════════════

import { useState, useMemo, useCallback } from 'react';
import { useActiveTicketState } from '../store/pipeline';
import type { StageName } from '../types';

// ── Visibility ────────────────────────────────────────────────

const SHOW_STAGES: StageName[] = [
  'generate_code', 'gate_code_review', 'deploy_qa', 'test_qa',
  'gate_preprod_approval', 'create_preprod_mr', 'gate_dual_approval',
  'deploy_prod', 'done',
];

// ── Tab definitions ───────────────────────────────────────────

type TabKey = 'developer' | 'review' | 'build' | 'runtime' | 'browser' | 'ac' | 'mr';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'developer', label: 'Developer' },
  { key: 'review', label: 'Review' },
  { key: 'build', label: 'Build' },
  { key: 'runtime', label: 'Tests' },
  { key: 'browser', label: 'Browser' },
  { key: 'ac', label: 'AC' },
  { key: 'mr', label: 'Create MR' },
];

// ── Styles ────────────────────────────────────────────────────

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
  modeBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 'var(--radius-full)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  tabBar: {
    display: 'flex',
    gap: 0,
    borderBottom: '2px solid var(--border-default)',
    marginBottom: 'var(--sp-4)',
    overflowX: 'auto' as const,
    scrollbarWidth: 'none' as const,
  },
  tab: {
    padding: '6px 14px',
    borderRadius: '8px 8px 0 0',
    fontSize: 11,
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
    gap: 6,
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  tabActive: {
    borderColor: 'var(--border-default)',
    borderBottom: '2px solid var(--bg-surface)',
    marginBottom: -2,
    background: 'var(--bg-surface)',
    color: 'var(--accent)',
  },
  dot: {
    width: 7,
    height: 7,
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
    padding: '5px 10px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-subtle)',
    fontSize: 12,
    marginBottom: 'var(--sp-1)',
  },
  rowDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
  },
  rowLabel: {
    flex: 1,
    color: 'var(--text-primary)',
    fontWeight: 500,
  },
  rowExtra: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
    marginRight: 4,
    maxWidth: 200,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  rowBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: 'var(--radius-full)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    flexShrink: 0,
  },
  collapsible: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
    padding: 'var(--sp-3)',
    background: 'var(--bg-elevated)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-subtle)',
    marginTop: 2,
    marginBottom: 'var(--sp-2)',
    maxHeight: 180,
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
  sectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--text-ghost)',
    padding: '6px 0 2px 0',
  },
} as const;

// ── Status helpers ────────────────────────────────────────────

type CS = 'done' | 'in_progress' | 'fail' | 'skip' | 'pending';

function dotColor(s: CS): string {
  switch (s) {
    case 'done': return 'var(--success)';
    case 'in_progress': return 'var(--warning)';
    case 'fail': return 'var(--danger)';
    case 'skip': return 'var(--blue)';
    default: return 'var(--text-ghost)';
  }
}

function badgeStyle(s: CS): { bg: string; fg: string; label: string } {
  switch (s) {
    case 'done': return { bg: 'var(--success-muted)', fg: 'var(--success)', label: 'Done' };
    case 'in_progress': return { bg: 'var(--warning-muted)', fg: 'var(--warning)', label: 'Running' };
    case 'fail': return { bg: 'var(--danger-muted)', fg: 'var(--danger)', label: 'Failed' };
    case 'skip': return { bg: 'rgba(59,130,246,0.1)', fg: 'var(--blue)', label: 'Skip' };
    default: return { bg: 'var(--bg-elevated)', fg: 'var(--text-tertiary)', label: 'Pending' };
  }
}

/** Map backend string values to status */
function strStatus(val: unknown): CS {
  if (val === true || val === 'PASS') return 'done';
  if (val === false || val === 'FAIL') return 'fail';
  if (val === 'SKIP') return 'skip';
  if (val === 'INCONCLUSIVE') return 'done'; // treated as complete with caveat
  return 'pending';
}

function boolStatus(val: unknown, failField?: unknown): CS {
  if (failField) return 'fail';
  if (val) return 'done';
  return 'pending';
}

/** Parse _unit_tests_count or _e2e_tests_count JSON string */
function parseTestCount(val: unknown): { total: number; passed: number; failed: number; flaky: number } | null {
  if (!val) return null;
  try {
    const parsed = typeof val === 'string' ? JSON.parse(val) : val;
    if (typeof parsed === 'object' && parsed !== null && 'total' in parsed) {
      return parsed as { total: number; passed: number; failed: number; flaky: number };
    }
  } catch { /* ignore */ }
  return null;
}

function testCountExtra(counts: { total: number; passed: number; failed: number; flaky: number } | null): string | undefined {
  if (!counts) return undefined;
  const parts: string[] = [];
  if (counts.passed > 0) parts.push(`${counts.passed} passed`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.flaky > 0) parts.push(`${counts.flaky} flaky`);
  if (parts.length === 0) return `${counts.total} total`;
  return parts.join(', ');
}

// ── StatusRow ─────────────────────────────────────────────────

function Row({ label, status, extra }: { label: string; status: CS; extra?: string }): JSX.Element {
  const b = badgeStyle(status);
  return (
    <div style={styles.row}>
      <span style={{ ...styles.rowDot, background: dotColor(status) }} />
      <span style={styles.rowLabel}>{label}</span>
      {extra ? <span style={styles.rowExtra} title={extra}>{extra}</span> : null}
      <span style={{ ...styles.rowBadge, background: b.bg, color: b.fg }}>{b.label}</span>
    </div>
  );
}

function Collapsible({ text, maxH }: { text: string; maxH?: number }): JSX.Element {
  return <div style={{ ...styles.collapsible, ...(maxH ? { maxHeight: maxH } : {}) }}>{text}</div>;
}

// ── Tab status derivation ─────────────────────────────────────

function deriveTabStatus(tab: TabKey, d: Record<string, unknown>, isGen: boolean): CS {
  switch (tab) {
    case 'developer':
      if (d._dev_failed) return 'fail';
      if (d._dev_complete) return 'done';
      return isGen ? 'in_progress' : 'pending';
    case 'review':
      if (!d._dev_complete) return 'pending';
      if (d._reviewed && d._fixed) return 'done';
      if (d._reviewed || d._reviewer_result) return 'in_progress';
      return isGen && d._dev_complete ? 'in_progress' : 'pending';
    case 'build':
      if (!d._dev_complete) return 'pending';
      if (d._build_checked) return (d._build_tsc === 'FAIL' || d._build_eslint === 'FAIL') ? 'fail' : 'done';
      if (d._build_tsc !== undefined) return 'in_progress';
      return 'pending';
    case 'runtime': {
      if (!d._dev_complete) return 'pending';
      const viteFailed = d._vite_build_done === 'FAIL' || d._vite_build_done === false;
      const unitDone = d._unit_tests_complete !== undefined;
      const e2eDone = d._e2e_tests_complete !== undefined;
      if (unitDone || e2eDone) {
        const unitFail = d._unit_tests_complete === 'FAIL';
        const e2eFail = d._e2e_tests_complete === 'FAIL';
        if (unitFail || e2eFail || viteFailed) return 'fail';
        return 'done';
      }
      if (viteFailed) return 'fail';
      if (d._env_bootstrapped || d._vite_build_done) return 'in_progress';
      return 'pending';
    }
    case 'browser':
      if (!d._dev_complete) return 'pending';
      if (d._browser_verified === 'PASS') return 'done';
      if (d._browser_verified === 'SKIP') return 'skip';
      if (d._verify_attempt || d._login_complete) return 'in_progress';
      return 'pending';
    case 'ac':
      if (!d._dev_complete) return 'pending';
      if (d._ac_verified) return d._ac_known_gaps ? 'fail' : 'done';
      if (d._ac_retry_count !== undefined) return 'in_progress';
      return 'pending';
    case 'mr':
      if (d.code_mr_url) return 'done';
      if (d.code_committed || d.code_branch) return 'in_progress';
      return 'pending';
  }
}

// ── Tab content: Developer ────────────────────────────────────

function DeveloperTab({ d }: { d: Record<string, unknown> }): JSX.Element {
  const devStatus: CS = d._dev_failed ? 'fail' : d._dev_complete ? 'done' : 'pending';
  const mode = d._codegen_mode as string | undefined;
  const rejections = d._codegen_rejections as number | undefined;

  // Detect parallel groups
  const groupKeys = Object.keys(d).filter(k => k.startsWith('_dev_group_'));
  const hadParallel = groupKeys.length > 0;
  const hadRetry = !!d._dev_retry_result;
  const feedback = d.feedback as string | undefined;

  return (
    <div>
      {mode ? <Row label="Codegen Mode" status="done" extra={mode} /> : null}
      <Row label="Code Generation" status={devStatus}
        extra={hadParallel ? `${groupKeys.length} parallel groups` : hadRetry ? 'retried' : undefined} />
      {rejections != null && rejections > 0 ? (
        <Row label="Rejections" status="fail" extra={`${rejections} rejection(s)`} />
      ) : null}
      {d._dev_failed ? (
        <div style={{ ...styles.collapsible, color: 'var(--danger)', maxHeight: 60, fontFamily: 'var(--font-sans)' }}>
          Code generation produced zero file changes after retry. Manual intervention required — check Slack for details.
        </div>
      ) : null}
      {feedback ? (
        <>
          <div style={styles.sectionLabel}>Pending Feedback</div>
          <Collapsible text={feedback} maxH={100} />
        </>
      ) : null}
      {d._dev_summary ? (
        <>
          <div style={styles.sectionLabel}>Developer Summary</div>
          <Collapsible text={String(d._dev_summary)} />
        </>
      ) : null}
    </div>
  );
}

// ── Tab content: Review & Security ────────────────────────────

function ReviewTab({ d }: { d: Record<string, unknown> }): JSX.Element {
  const reviewStatus: CS = d._reviewed ? 'done' : 'pending';
  const securityStatus: CS = d._security_result ? 'done' : 'pending';
  const fixerNeeded = !!d._fixer_result;
  const fixedStatus: CS = d._fixed ? 'done' : fixerNeeded ? 'in_progress' : 'pending';

  return (
    <div>
      <Row label="Code Review" status={reviewStatus} />
      <Row label="Security Audit" status={securityStatus} />
      <Row label="Fixer" status={fixedStatus}
        extra={d._fixed ? (fixerNeeded ? 'issues fixed' : 'no issues') : undefined} />
      {d._fixer_result ? (
        <>
          <div style={styles.sectionLabel}>Fixer Result</div>
          <Collapsible text={String(d._fixer_result)} />
        </>
      ) : null}
      {d._reviewer_result ? (
        <>
          <div style={styles.sectionLabel}>Review Result</div>
          <Collapsible text={String(d._reviewer_result)} />
        </>
      ) : null}
      {d._security_result ? (
        <>
          <div style={styles.sectionLabel}>Security Result</div>
          <Collapsible text={String(d._security_result)} />
        </>
      ) : null}
    </div>
  );
}

// ── Tab content: Build Check ──────────────────────────────────

function BuildTab({ d }: { d: Record<string, unknown> }): JSX.Element {
  const tscStatus: CS = strStatus(d._build_tsc);
  const eslintStatus: CS = strStatus(d._build_eslint);
  const fixAttempted = !!d._build_fix_attempted;
  const buildChecked = !!d._build_checked;

  return (
    <div>
      <Row label="TypeScript (tsc)" status={tscStatus} extra={d._build_tsc ? String(d._build_tsc) : undefined} />
      <Row label="ESLint" status={eslintStatus} extra={d._build_eslint ? String(d._build_eslint) : undefined} />
      {fixAttempted ? (
        <Row label="Build Fixer Agent" status={d._build_fix_result ? 'done' : 'in_progress'} extra="auto-fix attempted" />
      ) : null}
      <Row label="Build Check Complete" status={buildChecked ? 'done' : 'pending'} />
      {d._build_fix_result ? (
        <>
          <div style={styles.sectionLabel}>Build Fix Result</div>
          <Collapsible text={String(d._build_fix_result)} maxH={120} />
        </>
      ) : null}
    </div>
  );
}

// ── Tab content: Runtime Tests ────────────────────────────────

function RuntimeTab({ d }: { d: Record<string, unknown> }): JSX.Element {
  // Env bootstrap
  const envStatus: CS = d._env_bootstrap_failed ? 'fail' : boolStatus(d._env_bootstrapped);
  const envSkipped = d._env_bootstrapped === 'SKIP';

  // Playwright
  const pwFailed = !!d._playwright_install_failed;

  // Vite build
  const viteStatus: CS = strStatus(d._vite_build_done);

  // Unit tests
  const unitStatus: CS = strStatus(d._unit_tests_complete);
  const unitCounts = parseTestCount(d._unit_tests_count);

  // E2E browser smoke
  const e2eStatus: CS = strStatus(d._e2e_tests_complete);
  const e2eCounts = parseTestCount(d._e2e_tests_count);
  const consoleErrors = Array.isArray(d._e2e_console_errors) ? d._e2e_console_errors : null;

  return (
    <div>
      <div style={styles.sectionLabel}>Environment</div>
      <Row label="Env Bootstrap" status={envSkipped ? 'skip' : envStatus} extra={envSkipped ? 'skipped' : undefined} />
      {pwFailed ? <Row label="Playwright Install" status="fail" /> : null}
      <Row label="Vite Build" status={viteStatus}
        extra={d._vite_build_done ? String(d._vite_build_done) : undefined} />

      <div style={styles.sectionLabel}>Unit Tests</div>
      <Row label="Unit Tests" status={unitStatus}
        extra={testCountExtra(unitCounts) || (d._unit_tests_complete ? String(d._unit_tests_complete) : undefined)} />

      <div style={styles.sectionLabel}>E2E Browser Smoke</div>
      <Row label="Browser Smoke Tests" status={e2eStatus}
        extra={testCountExtra(e2eCounts) || (d._e2e_tests_complete ? String(d._e2e_tests_complete) : undefined)} />
      {consoleErrors && consoleErrors.length > 0 ? (
        <Row label="Console Errors" status="fail" extra={`${consoleErrors.length} error(s)`} />
      ) : null}
    </div>
  );
}

// ── Tab content: Browser Verify ───────────────────────────────

function BrowserTab({ d }: { d: Record<string, unknown> }): JSX.Element {
  const serverReady = !!d._dev_server_ready;
  const envSetup = !!d._env_setup_complete;
  const browserAvail = !!d._browser_verify_available;
  const loginStatus: CS = d._login_complete === true ? 'done'
    : d._login_complete === false ? 'fail'
    : d._login_complete === 'SKIP' ? 'skip' : 'pending';

  const routes = d._routes_detected;
  const routeCount = Array.isArray(routes) ? routes.length : null;

  const attempt = d._verify_attempt as number | undefined;
  const verdict: CS = d._browser_verified === 'PASS' ? 'done'
    : d._browser_verified === 'SKIP' ? 'skip' : 'pending';
  const skipReason = d._browser_verify_skip_reason as string | undefined;

  const evidence = d._verify_evidence as Record<string, unknown> | undefined;
  const knownGaps = d._verify_known_gaps as string[] | undefined;

  return (
    <div>
      <div style={styles.sectionLabel}>Infrastructure</div>
      <Row label="Dev Server" status={serverReady ? 'done' : 'pending'}
        extra={d._nx_serve_port ? `port ${d._nx_serve_port}` : undefined} />
      <Row label="Env Setup" status={envSetup ? 'done' : 'pending'} />
      <Row label="Browser Available" status={browserAvail ? 'done' : 'pending'} />

      <div style={styles.sectionLabel}>Verification</div>
      <Row label="Login" status={loginStatus} />
      <Row label="Routes Detected" status={routeCount != null ? 'done' : routes === 'SKIP' ? 'skip' : 'pending'}
        extra={routeCount != null ? `${routeCount} route(s)` : undefined} />
      {attempt != null ? <Row label="Attempt" status="done" extra={`#${attempt}`} /> : null}
      <Row label="Browser Verified" status={verdict}
        extra={skipReason || (d._browser_verified ? String(d._browser_verified) : undefined)} />

      {evidence ? (
        <>
          <div style={styles.sectionLabel}>Evidence Health</div>
          {evidence.allRoutesLoaded !== undefined ? (
            <Row label="All Routes Loaded" status={evidence.allRoutesLoaded ? 'done' : 'fail'} />
          ) : null}
          {evidence.networkHealthy !== undefined ? (
            <Row label="Network Healthy" status={evidence.networkHealthy ? 'done' : 'fail'} />
          ) : null}
          {evidence.authFailures !== undefined ? (
            <Row label="Auth Failures" status={evidence.authFailures ? 'fail' : 'done'}
              extra={evidence.authFailures ? String(evidence.authFailures) : '0'} />
          ) : null}
          {evidence.highSeverityErrors !== undefined ? (
            <Row label="High Severity Errors" status={evidence.highSeverityErrors ? 'fail' : 'done'}
              extra={String(evidence.highSeverityErrors ?? 0)} />
          ) : null}
        </>
      ) : null}

      {knownGaps && knownGaps.length > 0 ? (
        <>
          <div style={styles.sectionLabel}>Known Gaps</div>
          <Collapsible text={knownGaps.join('\n')} maxH={100} />
        </>
      ) : null}
    </div>
  );
}

// ── Tab content: AC Verification ──────────────────────────────

function ACTab({ d }: { d: Record<string, unknown> }): JSX.Element {
  const acStatus: CS = d._ac_verified ? (d._ac_known_gaps ? 'fail' : 'done') : 'pending';
  const retryCount = d._ac_retry_count as number | undefined;
  const report = d._ac_verification as string | undefined;
  const gaps = d._ac_known_gaps;

  // _ac_known_gaps can be a newline-separated string
  const gapText = typeof gaps === 'string' ? gaps
    : Array.isArray(gaps) ? gaps.join('\n')
    : null;

  return (
    <div>
      <Row label="AC Verified" status={acStatus} />
      {retryCount != null ? (
        <Row label="Fix Retries" status={retryCount > 0 ? 'in_progress' : 'done'} extra={`${retryCount}/2`} />
      ) : null}
      {gapText ? (
        <>
          <div style={styles.sectionLabel}>Known Gaps</div>
          <Collapsible text={gapText} maxH={120} />
        </>
      ) : null}
      {report && report !== 'Skipped -- no acceptance criteria' ? (
        <>
          <div style={styles.sectionLabel}>AC Report</div>
          <Collapsible text={report} />
        </>
      ) : null}
      {report === 'Skipped -- no acceptance criteria' ? (
        <Row label="AC Report" status="skip" extra="no acceptance criteria" />
      ) : null}
    </div>
  );
}

// ── Tab content: Create MR ────────────────────────────────────

function MRTab({ d }: { d: Record<string, unknown> }): JSX.Element {
  const branch = d.code_branch as string | undefined;
  const sourceBranch = d.code_source_branch as string | undefined;
  const sha = d._last_commit_sha as string | undefined;
  const mrUrl = d.code_mr_url as string | undefined;
  const mrIid = d.code_mr_iid as string | number | undefined;

  return (
    <div>
      <Row label="Branch" status={boolStatus(d.code_branch)} extra={branch || undefined} />
      {sourceBranch ? <Row label="Source Branch" status="done" extra={sourceBranch} /> : null}
      <Row label="Committed" status={boolStatus(d.code_committed)} extra={sha ? sha.slice(0, 8) : undefined} />
      <Row label="Conflict Check" status={boolStatus(d._conflict_check_done)} />
      <Row label="Divergence Check" status={boolStatus(d._divergence_checked)} />
      <Row label="Merge Request" status={mrUrl ? 'done' : 'pending'} extra={mrIid ? `!${mrIid}` : undefined} />
      {mrUrl ? (
        <div style={{ padding: '4px 10px', marginBottom: 'var(--sp-1)' }}>
          <a href={String(mrUrl)} target="_blank" rel="noopener noreferrer" style={styles.link}>
            Open MR in GitLab
          </a>
        </div>
      ) : null}
      <Row label="Slack Notification" status={boolStatus(d.code_slack_sent)} />
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────

export function WriteCodeDetail(): JSX.Element | null {
  const ticketState = useActiveTicketState();
  const [activeTab, setActiveTab] = useState<TabKey>('developer');

  const shouldShow = useMemo(() => {
    if (!ticketState) return false;
    if (SHOW_STAGES.includes(ticketState.stage)) return true;
    const dd = ticketState.state?.data;
    if (dd && (dd._dev_complete || dd.code_branch || dd.code_mr_url)) return true;
    return false;
  }, [ticketState]);

  const d = useMemo<Record<string, unknown>>(() => {
    return (ticketState?.state?.data as Record<string, unknown>) ?? {};
  }, [ticketState]);

  const handleTabClick = useCallback((key: TabKey) => setActiveTab(key), []);

  if (!shouldShow) return null;

  const isGen = !!(ticketState?.stage === 'generate_code' && ticketState.isRunning);
  const mode = d._codegen_mode as string | undefined;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 7 8 3 12 7" />
          <polyline points="4 13 8 9 12 13" />
        </svg>
        <span style={styles.title}>Write Code</span>
        {mode ? <span style={styles.modeBadge}>{mode}</span> : null}
      </div>

      {/* Tab bar */}
      <div style={styles.tabBar}>
        {TABS.map(({ key, label }) => {
          const ts = deriveTabStatus(key, d, isGen);
          return (
            <button
              key={key}
              style={{ ...styles.tab, ...(activeTab === key ? styles.tabActive : {}) }}
              onClick={() => handleTabClick(key)}
            >
              <span style={{ ...styles.dot, background: dotColor(ts) }} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={styles.content}>
        {activeTab === 'developer' && <DeveloperTab d={d} />}
        {activeTab === 'review' && <ReviewTab d={d} />}
        {activeTab === 'build' && <BuildTab d={d} />}
        {activeTab === 'runtime' && <RuntimeTab d={d} />}
        {activeTab === 'browser' && <BrowserTab d={d} />}
        {activeTab === 'ac' && <ACTab d={d} />}
        {activeTab === 'mr' && <MRTab d={d} />}
      </div>
    </div>
  );
}
