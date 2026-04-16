// ===================================================================
// MI Dev Agent -- Plan Tabs Component
// Tabs: Proposal, Design, Specs, Tasks (and any other plan keys)
// Renders markdown content with basic formatting
// ===================================================================

import { useState, useMemo } from 'react';

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

// -- Simple markdown to HTML ----------------------------------------
// Basic transformation: headers, bold, italic, lists, code blocks,
// links, line breaks. Not a full markdown parser.

function renderMarkdownToHtml(md: string): string {
  let html = md;

  // Escape HTML entities
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (triple backtick)
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, _lang, code) =>
      `<pre style="background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:6px;padding:12px;overflow-x:auto;font-family:var(--font-mono);font-size:11px;line-height:1.6;color:var(--text-secondary);margin:8px 0"><code>${code.trim()}</code></pre>`,
  );

  // Inline code
  html = html.replace(
    /`([^`]+)`/g,
    '<code style="background:var(--bg-elevated);padding:1px 5px;border-radius:3px;font-family:var(--font-mono);font-size:11px">$1</code>',
  );

  // Headers (h1-h4)
  html = html.replace(
    /^#### (.+)$/gm,
    '<h4 style="font-size:13px;font-weight:700;color:var(--text-primary);margin:16px 0 4px">$1</h4>',
  );
  html = html.replace(
    /^### (.+)$/gm,
    '<h3 style="font-size:14px;font-weight:700;color:var(--text-primary);margin:16px 0 4px">$1</h3>',
  );
  html = html.replace(
    /^## (.+)$/gm,
    '<h2 style="font-size:15px;font-weight:700;color:var(--text-primary);margin:20px 0 6px">$1</h2>',
  );
  html = html.replace(
    /^# (.+)$/gm,
    '<h1 style="font-size:18px;font-weight:700;color:var(--text-primary);margin:20px 0 8px">$1</h1>',
  );

  // Bold
  html = html.replace(
    /\*\*(.+?)\*\*/g,
    '<strong style="font-weight:700;color:var(--text-primary)">$1</strong>',
  );

  // Italic
  html = html.replace(
    /\*(.+?)\*/g,
    '<em>$1</em>',
  );

  // Strikethrough
  html = html.replace(
    /~~(.+?)~~/g,
    '<del>$1</del>',
  );

  // Links
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline">$1</a>',
  );

  // Checkbox lists
  html = html.replace(
    /^(\s*)-\s*\[x\]\s+(.+)$/gm,
    '<div style="padding:2px 0;display:flex;gap:6px;align-items:baseline"><span style="color:var(--success);font-weight:700">&#x2611;</span><span style="text-decoration:line-through;color:var(--text-tertiary)">$2</span></div>',
  );
  html = html.replace(
    /^(\s*)-\s*\[\s*\]\s+(.+)$/gm,
    '<div style="padding:2px 0;display:flex;gap:6px;align-items:baseline"><span style="color:var(--text-ghost)">&#x2610;</span><span>$2</span></div>',
  );

  // Unordered list items
  html = html.replace(
    /^(\s*)-\s+(.+)$/gm,
    '<div style="padding:2px 0 2px 16px;position:relative"><span style="position:absolute;left:4px;color:var(--text-ghost)">&bull;</span>$2</div>',
  );

  // Numbered list items
  html = html.replace(
    /^(\s*)(\d+)\.\s+(.+)$/gm,
    '<div style="padding:2px 0 2px 24px;position:relative"><span style="position:absolute;left:4px;color:var(--text-ghost);font-weight:600;font-size:11px">$2.</span>$3</div>',
  );

  // Horizontal rule
  html = html.replace(
    /^---+$/gm,
    '<hr style="border:none;border-top:1px solid var(--border-subtle);margin:12px 0">',
  );

  // Blockquote
  html = html.replace(
    /^&gt;\s+(.+)$/gm,
    '<blockquote style="border-left:3px solid var(--accent);padding:4px 12px;margin:8px 0;color:var(--text-tertiary);font-style:italic">$1</blockquote>',
  );

  // Paragraphs: double line breaks
  html = html.replace(/\n\n/g, '<br><br>');

  // Single line breaks within paragraphs
  html = html.replace(/\n/g, '<br>');

  return html;
}

// -- Component ------------------------------------------------------

export function PlanTabs({ plan }: PlanTabsProps): JSX.Element {
  const keys = useMemo(() => sortTabKeys(Object.keys(plan)), [plan]);
  const [activeTab, setActiveTab] = useState(keys[0] ?? '');

  if (keys.length === 0) {
    return <div style={styles.empty}>No plan data available</div>;
  }

  const content = plan[activeTab] ?? '';
  const htmlContent = useMemo(
    () => renderMarkdownToHtml(content),
    [content],
  );

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
          <div
            style={styles.markdown}
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        ) : (
          <div style={styles.empty}>
            No content for this tab
          </div>
        )}
      </div>
    </div>
  );
}
