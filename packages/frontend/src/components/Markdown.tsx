// ===================================================================
// MI Dev Agent -- Markdown Component
// Single source for rendering markdown strings in the frontend.
// Built on `react-markdown` + `remark-gfm` (tables, task lists,
// strikethrough, autolinks).
//
// This component replaces the homegrown regex-based
// `renderMarkdownToHtml` that previously lived inline in
// `review/PlanTabs.tsx`. It uses React elements end-to-end; there is
// no `dangerouslySetInnerHTML`.
//
// Styling is centralised in the `mdComponents` theme map below, so
// every surface that renders markdown looks consistent with the rest
// of the UI. When adding support for a new markdown construct, extend
// the map here; consumers do not need to change.
// ===================================================================

import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CSSProperties } from 'react';

// -- Style tokens ---------------------------------------------------
// Mirror the inline styles that the prior `renderMarkdownToHtml`
// emitted, so the visual diff on existing Plan Review content is
// near-zero. See design.md §D8.

const S = {
  h1: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: '20px 0 8px',
  },
  h2: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: '20px 0 6px',
  },
  h3: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: '16px 0 4px',
  },
  h4: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: '16px 0 4px',
  },
  p: {
    margin: '8px 0',
  },
  ul: {
    margin: '4px 0',
    paddingLeft: 20,
  },
  ol: {
    margin: '4px 0',
    paddingLeft: 28,
  },
  li: {
    padding: '2px 0',
  },
  inlineCode: {
    background: 'var(--bg-elevated)',
    padding: '1px 5px',
    borderRadius: 3,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
  } as CSSProperties,
  pre: {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
    padding: 12,
    overflowX: 'auto',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    lineHeight: 1.6,
    color: 'var(--text-secondary)',
    margin: '8px 0',
  } as CSSProperties,
  a: {
    color: 'var(--accent)',
    textDecoration: 'underline',
  } as CSSProperties,
  blockquote: {
    borderLeft: '3px solid var(--accent)',
    padding: '4px 12px',
    margin: '8px 0',
    color: 'var(--text-tertiary)',
    fontStyle: 'italic',
  } as CSSProperties,
  hr: {
    border: 'none',
    borderTop: '1px solid var(--border-subtle)',
    margin: '12px 0',
  } as CSSProperties,
  strong: {
    fontWeight: 700,
    color: 'var(--text-primary)',
  } as CSSProperties,
  table: {
    borderCollapse: 'collapse' as const,
    margin: '8px 0',
    fontSize: 12,
    width: '100%',
  } as CSSProperties,
  th: {
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-elevated)',
    padding: '6px 10px',
    textAlign: 'left' as const,
    fontWeight: 700,
    color: 'var(--text-primary)',
  } as CSSProperties,
  td: {
    border: '1px solid var(--border-subtle)',
    padding: '6px 10px',
    color: 'var(--text-secondary)',
  } as CSSProperties,
  checkDone: {
    color: 'var(--success)',
    fontWeight: 700,
    marginRight: 6,
    display: 'inline-block',
  } as CSSProperties,
  checkPending: {
    color: 'var(--text-ghost)',
    marginRight: 6,
    display: 'inline-block',
  } as CSSProperties,
};

// -- Component map --------------------------------------------------
// Exported for consumers that want to wrap `ReactMarkdown` themselves
// (advanced use case; the `<Markdown>` wrapper below covers 99%).

export const mdComponents: Components = {
  h1: ({ children }) => <h1 style={S.h1}>{children}</h1>,
  h2: ({ children }) => <h2 style={S.h2}>{children}</h2>,
  h3: ({ children }) => <h3 style={S.h3}>{children}</h3>,
  h4: ({ children }) => <h4 style={S.h4}>{children}</h4>,
  p: ({ children }) => <p style={S.p}>{children}</p>,
  ul: ({ children }) => <ul style={S.ul}>{children}</ul>,
  ol: ({ children }) => <ol style={S.ol}>{children}</ol>,
  li: ({ children }) => <li style={S.li}>{children}</li>,
  strong: ({ children }) => <strong style={S.strong}>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del>{children}</del>,
  blockquote: ({ children }) => <blockquote style={S.blockquote}>{children}</blockquote>,
  hr: () => <hr style={S.hr} />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={S.a}
    >
      {children}
    </a>
  ),
  // react-markdown v9 distinguishes inline vs block code by whether a
  // `language-*` className is present (block) or not (inline).
  code: ({ className, children }) => {
    if (className && className.startsWith('language-')) {
      return <code className={className}>{children}</code>;
    }
    return <code style={S.inlineCode}>{children}</code>;
  },
  pre: ({ children }) => <pre style={S.pre}>{children}</pre>,
  table: ({ children }) => <table style={S.table}>{children}</table>,
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => <th style={S.th}>{children}</th>,
  td: ({ children }) => <td style={S.td}>{children}</td>,
  // remark-gfm turns `- [x]` / `- [ ]` into `<li class="task-list-item">`
  // with a disabled `<input type="checkbox">` child. Replace that input
  // with a styled indicator so the affordance matches the rest of the UI.
  input: ({ type, checked, ...rest }) => {
    if (type === 'checkbox') {
      return checked ? (
        <span style={S.checkDone} aria-hidden="true">
          &#x2611;
        </span>
      ) : (
        <span style={S.checkPending} aria-hidden="true">
          &#x2610;
        </span>
      );
    }
    return <input type={type} {...rest} />;
  },
};

// -- Wrapper --------------------------------------------------------

interface MarkdownProps {
  /** Raw markdown source to render. */
  children: string;
}

/**
 * Render a markdown string as React elements, using the project theme.
 * Safe by construction — does not use `dangerouslySetInnerHTML` and
 * does not render inline HTML from the source markdown.
 */
export function Markdown({ children }: MarkdownProps): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={mdComponents}
    >
      {children}
    </ReactMarkdown>
  );
}

export default Markdown;
