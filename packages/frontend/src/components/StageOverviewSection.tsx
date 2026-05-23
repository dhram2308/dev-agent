// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Stage Overview Section
//
// One always-rendered section per pipeline stage. Provides the scroll
// target for the clickable stage pills in AgentStatus, and shows a
// compact summary of that stage's status + key state.data fields.
// Stages with dedicated detail panels (WriteCodeDetail, QAProgressPanel,
// GateApproval) render those AFTER this overview — this section is
// always visible, the detail panels add depth when relevant.
// ═══════════════════════════════════════════════════════════════

import { useMemo } from 'react';
import { useActiveTicketState } from '../store/pipeline';
import { stageIndex } from '../store/pipeline';
import { STAGE_INFO, type StageName } from '../types';

const styles = {
  section: {
    marginBottom: 'var(--sp-3)',
    padding: 'var(--sp-3) var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    fontSize: 13,
    transition: 'background 0.2s ease',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    marginBottom: 'var(--sp-2)',
  },
  num: {
    width: 22,
    height: 22,
    borderRadius: '50%',
    background: 'var(--bg-base)',
    color: 'var(--text-secondary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 600,
    flexShrink: 0,
  },
  label: {
    fontWeight: 600,
    color: 'var(--text-primary)',
    fontSize: 13,
  },
  statusBadge: {
    marginLeft: 'auto',
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 12,
    fontWeight: 500,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  body: {
    color: 'var(--text-secondary)',
    fontSize: 12,
    lineHeight: 1.55,
  },
  kvRow: {
    display: 'grid',
    gridTemplateColumns: '140px 1fr',
    gap: 'var(--sp-2)',
    padding: '3px 0',
    fontSize: 12,
  },
  kvKey: {
    color: 'var(--text-tertiary)',
    fontWeight: 500,
  },
  kvValue: {
    color: 'var(--text-primary)',
    wordBreak: 'break-word' as const,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
  },
  empty: {
    color: 'var(--text-ghost)',
    fontStyle: 'italic' as const,
    fontSize: 12,
  },
  link: {
    color: 'var(--blue)',
    textDecoration: 'none' as const,
  },
} as const;

type Status = 'completed' | 'current' | 'upcoming';

function statusColors(status: Status): React.CSSProperties {
  switch (status) {
    case 'completed': return { background: 'rgba(34,197,94,0.15)', color: 'var(--success)' };
    case 'current':   return { background: 'rgba(99,102,241,0.15)', color: 'var(--accent)' };
    case 'upcoming':  return { background: 'rgba(148,163,184,0.15)', color: 'var(--text-tertiary)' };
  }
}

function pickStageData(stage: StageName, data: Record<string, unknown>): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  const push = (key: string, raw: unknown): void => {
    if (raw === undefined || raw === null || raw === '') return;
    if (typeof raw === 'object') {
      rows.push({ key, value: JSON.stringify(raw).slice(0, 200) });
    } else {
      rows.push({ key, value: String(raw).slice(0, 200) });
    }
  };

  // Highlights relevant to each stage. Stages share an underlying
  // state.data so we just project the salient fields per stage.
  switch (stage) {
    case 'fetch_ticket': {
      const t = data.ticket as Record<string, unknown> | undefined;
      if (t) {
        push('summary', t.summary);
        push('issueType', t.issueType);
        push('priority', t.priority);
        if (typeof t.ac === 'string') push('AC chars', t.ac.length);
      }
      break;
    }
    case 'explore_plan': {
      const openspec = data.explore_openspec as Record<string, unknown> | undefined;
      if (openspec?.changeName) push('change', openspec.changeName);
      if (typeof data.explore_plan === 'string') push('plan chars', data.explore_plan.length);
      const suggestions = data._agent_suggestions as string[] | undefined;
      if (suggestions?.length) push('suggestions', `${suggestions.length} items`);
      const qa = data._qa_answers as unknown[] | undefined;
      if (qa?.length) push('QA answers', `${qa.length} resolved`);
      break;
    }
    case 'generate_code': {
      push('mode', data._codegen_mode);
      push('branch', data.code_branch);
      push('committed', data.code_committed);
      push('MR', data.code_mr_url);
      push('dev complete', data._dev_complete);
      push('reviewed', data._reviewed);
      push('build', data._build_tsc);
      push('unit tests', data._unit_tests_complete);
      push('AC verified', data._ac_verified);
      const rejections = data._codegen_rejections;
      if (typeof rejections === 'number' && rejections > 0) push('rejections', rejections);
      break;
    }
    case 'gate_code_review': {
      push('MR', data.code_mr_url);
      push('approved', data._ui_approve_gate);
      break;
    }
    case 'deploy_qa': {
      push('qa branch merged', data.qa_merged);
      push('CI status', data.qa_ci);
      break;
    }
    case 'test_qa': {
      const t = data.qa_test;
      if (Array.isArray(t)) push('modules tested', `${t.length}`);
      break;
    }
    case 'gate_preprod_approval': {
      push('approved', data._ui_approve_preprod);
      break;
    }
    case 'create_preprod_mr': {
      push('MR', data.preprod_mr_url);
      break;
    }
    case 'gate_dual_approval': {
      push('approved', data._ui_approve_dual);
      break;
    }
    case 'deploy_prod': {
      push('MR', data.prod_mr_url);
      break;
    }
    case 'done': {
      push('finished at', data._lastActivity);
      break;
    }
  }
  return rows;
}

interface Props {
  stage: StageName;
}

export function StageOverviewSection({ stage }: Props): JSX.Element | null {
  const ticketState = useActiveTicketState();
  const info = STAGE_INFO.find((s) => s.stage === stage);

  const { status, currentIdx, idx } = useMemo(() => {
    const myIdx = stageIndex(stage);
    if (!ticketState) return { status: 'upcoming' as Status, currentIdx: 0, idx: myIdx };
    const curIdx = stageIndex(ticketState.stage);
    if (ticketState.stage === 'done') return { status: 'completed' as Status, currentIdx: curIdx, idx: myIdx };
    if (myIdx < curIdx) return { status: 'completed' as Status, currentIdx: curIdx, idx: myIdx };
    if (myIdx === curIdx) return { status: 'current' as Status, currentIdx: curIdx, idx: myIdx };
    return { status: 'upcoming' as Status, currentIdx: curIdx, idx: myIdx };
  }, [ticketState, stage]);

  const rows = useMemo(() => {
    const data = (ticketState?.state?.data as Record<string, unknown>) || {};
    return pickStageData(stage, data);
  }, [ticketState, stage]);

  if (!info) return null;

  const isMrLink = (v: string): boolean => v.startsWith('http://') || v.startsWith('https://');

  return (
    <section
      id={`stage-section-${stage}`}
      style={styles.section}
      aria-label={`${info.label} overview`}
    >
      <div style={styles.header}>
        <div style={styles.num}>{idx + 1}</div>
        <div style={styles.label}>{info.label}</div>
        <div style={{ ...styles.statusBadge, ...statusColors(status) }}>{status}</div>
      </div>
      <div style={styles.body}>
        {rows.length === 0 ? (
          <span style={styles.empty}>
            {status === 'upcoming'
              ? 'Not yet started.'
              : status === 'current'
              ? 'In progress — details will appear as the stage runs.'
              : 'No data captured for this stage.'}
          </span>
        ) : (
          rows.map((r) => (
            <div key={r.key} style={styles.kvRow}>
              <span style={styles.kvKey}>{r.key}</span>
              {isMrLink(r.value) ? (
                <a href={r.value} target="_blank" rel="noopener noreferrer" style={{ ...styles.kvValue, ...styles.link }}>
                  {r.value}
                </a>
              ) : (
                <span style={styles.kvValue}>{r.value}</span>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function StageOverviewList(): JSX.Element {
  return (
    <div>
      {STAGE_INFO.map((info) => (
        <StageOverviewSection key={info.stage} stage={info.stage} />
      ))}
    </div>
  );
}
