// =====================================================================
// Markdown Component Tests
// Validates the <Markdown> wrapper around react-markdown + remark-gfm.
// Spec: openspec/changes/openspec-tabs-markdown-render/specs/
//       markdown-component/spec.md
// =====================================================================

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown';

describe('Markdown', () => {
  // ── Headings ─────────────────────────────────────────────────────

  it('renders `# Hello` as an h1 element containing "Hello"', () => {
    const { container } = render(<Markdown># Hello</Markdown>);
    const h1 = container.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1!.textContent).toBe('Hello');
  });

  it('renders h2 / h3 / h4 heading levels correctly', () => {
    const source = '## Level 2\n\n### Level 3\n\n#### Level 4';
    const { container } = render(<Markdown>{source}</Markdown>);

    const h2 = container.querySelector('h2');
    const h3 = container.querySelector('h3');
    const h4 = container.querySelector('h4');

    expect(h2).not.toBeNull();
    expect(h2!.textContent).toBe('Level 2');
    expect(h3).not.toBeNull();
    expect(h3!.textContent).toBe('Level 3');
    expect(h4).not.toBeNull();
    expect(h4!.textContent).toBe('Level 4');
  });

  // ── GFM task lists ───────────────────────────────────────────────

  it('renders `- [x] done` and `- [ ] todo` as two styled task items', () => {
    const source = '- [x] done\n- [ ] todo';
    const { container } = render(<Markdown>{source}</Markdown>);

    const items = container.querySelectorAll('li');
    expect(items.length).toBe(2);

    // The input override should replace <input type="checkbox"> with a span.
    // No native checkbox should appear in the tree.
    const rawCheckboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(rawCheckboxes.length).toBe(0);

    // First li should contain the "done" indicator (☑ / U+2611).
    // Second li should contain the "pending" indicator (☐ / U+2610).
    expect(items[0].textContent).toContain('\u2611');
    expect(items[1].textContent).toContain('\u2610');
  });

  // ── Inline code ──────────────────────────────────────────────────

  it('renders inline `code` without a <pre> ancestor', () => {
    const { container } = render(<Markdown>{'The `inline` variable'}</Markdown>);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe('inline');
    // Walk up and confirm no <pre> parent.
    let parent: HTMLElement | null = code!.parentElement;
    while (parent) {
      expect(parent.tagName).not.toBe('PRE');
      parent = parent.parentElement;
    }
  });

  // ── Fenced code with language ───────────────────────────────────

  it('renders fenced code with `language-ts` className on the <code>', () => {
    const source = '```ts\nconst x: number = 1;\n```';
    const { container } = render(<Markdown>{source}</Markdown>);

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();

    const code = pre!.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.className).toContain('language-ts');
    expect(code!.textContent).toContain('const x: number = 1;');
  });

  // ── Links ────────────────────────────────────────────────────────

  it('renders links with target="_blank" and rel="noopener noreferrer"', () => {
    const { container } = render(
      <Markdown>{'[click](https://example.com)'}</Markdown>,
    );

    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('https://example.com');
    expect(a!.getAttribute('target')).toBe('_blank');
    expect(a!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a!.textContent).toBe('click');
  });

  // ── GFM tables ───────────────────────────────────────────────────

  it('renders GFM tables with thead (th) and tbody (td)', () => {
    const source = '| a | b |\n|---|---|\n| 1 | 2 |';
    const { container } = render(<Markdown>{source}</Markdown>);

    const table = container.querySelector('table');
    expect(table).not.toBeNull();

    const thead = table!.querySelector('thead');
    const tbody = table!.querySelector('tbody');
    expect(thead).not.toBeNull();
    expect(tbody).not.toBeNull();

    const headCells = thead!.querySelectorAll('th');
    expect(headCells.length).toBe(2);
    expect(headCells[0].textContent).toBe('a');
    expect(headCells[1].textContent).toBe('b');

    const bodyRows = tbody!.querySelectorAll('tr');
    expect(bodyRows.length).toBe(1);
    const bodyCells = bodyRows[0].querySelectorAll('td');
    expect(bodyCells.length).toBe(2);
    expect(bodyCells[0].textContent).toBe('1');
    expect(bodyCells[1].textContent).toBe('2');
  });

  // ── Strikethrough ────────────────────────────────────────────────

  it('renders ~~strike~~ as a <del> element', () => {
    const { container } = render(<Markdown>{'~~strike~~'}</Markdown>);
    const del = container.querySelector('del');
    expect(del).not.toBeNull();
    expect(del!.textContent).toBe('strike');
  });

  // ── Safety: no raw <script> tags rendered ───────────────────────

  it('does not render raw <script> tags from source markdown', () => {
    const source = '<script>alert(1)</script>';
    const { container } = render(<Markdown>{source}</Markdown>);
    expect(container.querySelectorAll('script').length).toBe(0);
  });

  // ── Safety: no dangerouslySetInnerHTML injection artifacts ─────

  it('does not use dangerouslySetInnerHTML (no script nodes, no double-escape)', () => {
    // Content includes characters that would be mangled if the renderer
    // were double-escaping through an HTML-string path.
    const source = 'Compare: `2 < 3 & 3 > 2` is true.';
    const { container } = render(<Markdown>{source}</Markdown>);

    // No script nodes injected anywhere.
    expect(container.querySelectorAll('script').length).toBe(0);

    // The text content of the <code> element should be the exact raw
    // characters, NOT HTML-escaped entities like &amp;lt; or &amp;amp;.
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe('2 < 3 & 3 > 2');

    // A quick sanity check that the rendered HTML does not carry
    // double-escape artifacts like `&amp;lt;` or `&amp;amp;`.
    expect(container.innerHTML).not.toContain('&amp;lt;');
    expect(container.innerHTML).not.toContain('&amp;amp;');
    expect(container.innerHTML).not.toContain('&amp;gt;');
  });
});
