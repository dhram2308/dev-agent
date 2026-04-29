// ===================================================================
// MI Dev Agent -- Plan Tabs Component
// Tabs: Proposal, Design, Specs, Tasks (and any other plan keys)
// Renders markdown content with basic formatting
// ===================================================================

import { useMemo, useState } from 'react';

import { Markdown } from '../Markdown';

// -- Types ----------------------------------------------------------

interface PlanTabsProps {
  plan: Record<string, string>;
}

// -- Styles ---------------------------------------------------------

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 0,
  },
  tabBar: {
    display: 'flex',
    gap: 0,
    borderBottom: '2px solid var(--border-default)',
    paddingBottom: 0,
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
    textTransform: 'capitalize' as const,
  },
  tabActive: {
    borderColor: 'var(--border-default)',
    borderBottom: '2px solid var(--bg-surface)',
    marginBottom: -2,
    background: 'var(--bg-surface)',
    color: 'var(--accent)',
  },
  content: {
    background: 'var(--bg-surface)',
    borderRadius: '0 var(--radius-md) var(--radius-md) var(--radius-md)',
    padding: 'var(--sp-5)',
    border: '1px solid var(--border-subtle)',
    borderTop: 'none',
    minHeight: 200,
    maxHeight: 600,
    overflowY: 'auto' as const,
  },
  markdown: {
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    lineHeight: 1.7,
    color: 'var(--text-secondary)',
    wordBreak: 'break-word' as const,
  },
  empty: {
    textAlign: 'center' as const,
    color: 'var(--text-ghost)',
    fontSize: 12,
    padding: 'var(--sp-6)',
    fontStyle: 'italic',
  },
} as const;

// -- Tab label mapping (nice names for known keys) ------------------

const TAB_LABELS: Record<string, string> = {
  proposal: 'Proposal',
  design: 'Design',
  specs: 'Specs',
  tasks: 'Tasks',
};

function getTabLabel(key: string): string {
  return TAB_LABELS[key.toLowerCase()] ?? key;
}

// -- Sort tabs in preferred order -----------------------------------

const TAB_ORDER = ['proposal', 'design', 'specs', 'tasks'];

function sortTabKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const aIdx = TAB_ORDER.indexOf(a.toLowerCase());
    const bIdx = TAB_ORDER.indexOf(b.toLowerCase());
    if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
    if (aIdx >= 0) return -1;
    if (bIdx >= 0) return 1;
    return a.localeCompare(b);
  });
}

// -- Component ------------------------------------------------------

export function PlanTabs({ plan }: PlanTabsProps): JSX.Element {
  const keys = useMemo(() => sortTabKeys(Object.keys(plan)), [plan]);
  const [activeTab, setActiveTab] = useState(keys[0] ?? '');

  if (keys.length === 0) {
    return <div style={styles.empty}>No plan data available</div>;
  }

  const content = plan[activeTab] ?? '';

  return (
    <div style={styles.container}>
      {/* Tab bar */}
      <div style={styles.tabBar}>
        {keys.map((key) => (
          <button
            key={key}
            style={{
              ...styles.tab,
              ...(activeTab === key ? styles.tabActive : {}),
            }}
            onClick={() => setActiveTab(key)}
          >
            {getTabLabel(key)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={styles.content}>
        {content ? (
          <div style={styles.markdown}>
            <Markdown>{content}</Markdown>
          </div>
        ) : (
          <div style={styles.empty}>
            No content for this tab
          </div>
        )}
      </div>
    </div>
  );
}
