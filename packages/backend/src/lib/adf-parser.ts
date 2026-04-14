// ===================================================================
// MI Dev Agent -- ADF Parser (TypeScript port of lib/adf.js)
//
// Atlassian Document Format (ADF) parsing utilities.
//
// Functions:
//   - adfToMarkdown(adf) -- converts ADF JSON to markdown
//   - adfText(adf) -- extracts plain text from ADF (legacy, lossy)
//   - adfExtractUrls(adf) -- walks ADF tree for URLs (smart links,
//     inline cards, link marks, media, raw URLs in text)
//
// Zero external dependencies.
// ===================================================================

// ===================================================================
// Types
// ===================================================================

/** A node in the Atlassian Document Format tree. */
export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

/** Context carried through recursive ADF-to-markdown conversion. */
interface AdfContext {
  listDepth: number;
  listIndex: number;
  ordered: boolean;
  _depth: number;
}

// ===================================================================
// HTML Entity Unescaping
// ===================================================================

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&#x27;': "'",
  '&#x2F;': '/',
  '&#x60;': '`',
  '&nbsp;': ' ',
};

const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27|#x2F|#x60);/g;

/**
 * Unescape HTML entities in a string. Handles both named and numeric
 * entities (decimal and hex).
 */
export function unescapeHtml(text: string | null | undefined): string {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .replace(HTML_ENTITY_RE, (m) => HTML_ENTITIES[m] || m)
    // Decode numeric HTML entities (&#8212; &#160; &#x2019; etc.)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

// ===================================================================
// ADF -> Plain Text (legacy, lossy)
// ===================================================================

/**
 * Extracts plain text from an ADF node tree. This is the legacy lossy
 * extraction -- use `adfToMarkdown` for structured output.
 */
export function adfText(node: AdfNode | string | null | undefined): string {
  if (!node) return '';
  if (typeof node === 'string') return node;

  let out = '';

  if (node.type === 'text') out += node.text || '';
  if (node.type === 'hardBreak') out += '\n';
  if (node.type === 'listItem') out += '\u2022 '; // bullet

  if (Array.isArray(node.content)) {
    out += node.content.map(adfText).join('');
  }

  if (
    ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'rule'].includes(
      node.type,
    )
  ) {
    out += '\n';
  }

  return out;
}

// ===================================================================
// ADF -> Markdown (preserves structure, links, code, tables)
// ===================================================================

const DEFAULT_CTX: AdfContext = { listDepth: 0, listIndex: 0, ordered: false, _depth: 0 };

/** Max recursion depth to prevent stack overflow on malicious/deeply nested ADF. */
const MAX_DEPTH = 20;

/**
 * Converts an ADF JSON tree to a Markdown string. Preserves structure
 * including headings, lists, code blocks, tables, links, mentions,
 * status badges, panels, expand sections, task lists, and more.
 */
export function adfToMarkdown(
  node: AdfNode | string | null | undefined,
  ctx: AdfContext = DEFAULT_CTX,
): string {
  if (!node) return '';
  if (typeof node === 'string') return node;

  // Recursion depth limit
  const depth = (ctx._depth || 0) + 1;
  if (depth > MAX_DEPTH) return '[...deeply nested content omitted]';

  const depthCtx: AdfContext = { ...ctx, _depth: depth };

  /** Helper: recursively convert all children. */
  const children = (overrideCtx?: Partial<AdfContext>): string =>
    Array.isArray(node.content)
      ? node.content
          .map((c) =>
            adfToMarkdown(c, overrideCtx ? { ...overrideCtx, _depth: depth } as AdfContext : depthCtx),
          )
          .join('')
      : '';

  const attrs = node.attrs || {};

  switch (node.type) {
    case 'doc':
      return children();

    case 'text': {
      let t = unescapeHtml(node.text || '');
      // Apply marks (bold, italic, code, link, strike, etc.)
      if (Array.isArray(node.marks)) {
        for (const m of node.marks) {
          switch (m.type) {
            case 'strong':
              t = `**${t}**`;
              break;
            case 'em':
              t = `*${t}*`;
              break;
            case 'code':
              t = `\`${t}\``;
              break;
            case 'strike':
              t = `~~${t}~~`;
              break;
            case 'link':
              t = `[${t}](${(m.attrs && m.attrs.href) || ''})`;
              break;
            case 'underline':
              t = `<u>${t}</u>`;
              break;
            // textColor, subsup -- skip, not critical for requirements
          }
        }
      }
      return t;
    }

    case 'hardBreak':
      return '\n';

    case 'paragraph':
      return children() + '\n\n';

    case 'heading': {
      const level = (attrs.level as number) || 1;
      return '#'.repeat(level) + ' ' + children() + '\n\n';
    }

    case 'bulletList':
      return (
        (node.content || [])
          .map((c) =>
            adfToMarkdown(c, { ...ctx, listDepth: ctx.listDepth + 1, ordered: false, _depth: depth }),
          )
          .join('') + (ctx.listDepth === 0 ? '\n' : '')
      );

    case 'orderedList':
      return (
        (node.content || [])
          .map((c, i) =>
            adfToMarkdown(c, {
              ...ctx,
              listDepth: ctx.listDepth + 1,
              listIndex: i + 1,
              ordered: true,
              _depth: depth,
            }),
          )
          .join('') + (ctx.listDepth === 0 ? '\n' : '')
      );

    case 'listItem': {
      const indent = '  '.repeat(Math.max(0, ctx.listDepth - 1));
      const bullet = ctx.ordered ? `${ctx.listIndex}. ` : '- ';
      const content = children().replace(/\n$/, '');
      return indent + bullet + content + '\n';
    }

    case 'blockquote':
      return (
        children()
          .split('\n')
          .map((l) => '> ' + l)
          .join('\n') + '\n\n'
      );

    case 'codeBlock': {
      const lang = (attrs.language as string) || '';
      return '```' + lang + '\n' + children() + '\n```\n\n';
    }

    case 'rule':
      return '---\n\n';

    case 'inlineCard':
      // Smart links -- extract URL from attrs
      return attrs.url ? `[${attrs.url}](${attrs.url})` : '';

    case 'mention':
      return `@${(attrs.text as string) || (attrs.id as string) || 'user'}`;

    case 'emoji':
      return (attrs.shortName as string) || (attrs.text as string) || '';

    case 'date':
      return attrs.timestamp
        ? new Date(parseInt(attrs.timestamp as string)).toISOString().split('T')[0]
        : '';

    case 'status':
      return `[${(attrs.text as string) || 'STATUS'}]`;

    case 'panel': {
      const panelType = (attrs.panelType as string) || 'info';
      return `> **${panelType.toUpperCase()}**: ${children()}\n\n`;
    }

    case 'expand': {
      const title = (attrs.title as string) || 'Details';
      return `<details>\n<summary>${title}</summary>\n\n${children()}\n</details>\n\n`;
    }

    // Table support (insert markdown separator after header row)
    case 'table': {
      const rows = (node.content || []).map((c, i) => {
        const row = adfToMarkdown(c, ctx);
        // After the first row (header), insert separator
        if (i === 0) {
          const colCount = (c.content || []).length;
          return row + '| ' + Array(colCount).fill('---').join(' | ') + ' |\n';
        }
        return row;
      });
      return rows.join('') + '\n';
    }

    case 'tableRow': {
      const cells = (node.content || []).map((c) => adfToMarkdown(c, ctx));
      return '| ' + cells.join(' | ') + ' |\n';
    }

    case 'tableHeader': {
      const text = children().replace(/\n/g, ' ').trim();
      return text;
    }

    case 'tableCell': {
      const text = children().replace(/\n/g, ' ').trim();
      return text;
    }

    // Media -- just note the filename/ID
    case 'mediaSingle':
    case 'mediaGroup':
      return children();

    case 'media': {
      const alt = (attrs.alt as string) || (attrs.id as string) || 'media';
      return `[Attachment: ${alt}]\n`;
    }

    // Task lists
    case 'taskList':
      return (node.content || []).map((c) => adfToMarkdown(c, depthCtx)).join('') + '\n';

    case 'taskItem': {
      const checked = attrs.state === 'DONE' ? '[x]' : '[ ]';
      return `- ${checked} ${children()}\n`;
    }

    // Layout
    case 'layoutSection':
      return children() + '\n';

    case 'layoutColumn':
      return children();

    // Nested expand
    case 'nestedExpand': {
      const neTitle = (attrs.title as string) || 'Details';
      return `<details>\n<summary>${neTitle}</summary>\n\n${children()}\n</details>\n\n`;
    }

    // Decisions
    case 'decisionList':
      return (node.content || []).map((c) => adfToMarkdown(c, depthCtx)).join('') + '\n';

    case 'decisionItem': {
      const decState = (attrs.state as string) || 'DECIDED';
      return `- [${decState}] ${children()}\n`;
    }

    // Placeholder
    case 'placeholder':
      return attrs.text ? `[${attrs.text}]` : '';

    // Extensions
    case 'extension':
    case 'bodiedExtension': {
      const extTitle =
        (attrs.extensionTitle as string) || (attrs.extensionKey as string) || 'extension';
      return `[Extension: ${extTitle}]\n${children()}`;
    }

    case 'inlineExtension': {
      const inlExtTitle =
        (attrs.extensionTitle as string) || (attrs.extensionKey as string) || 'extension';
      return `[${inlExtTitle}]`;
    }

    default:
      // Fallback: recurse into children
      return children();
  }
}

// ===================================================================
// ADF URL Extractor
// ===================================================================

/**
 * Walks an ADF tree and extracts all URLs found in:
 *   - inlineCard smart links (attrs.url)
 *   - Link marks on text nodes (mark.attrs.href)
 *   - Media nodes (attrs.url)
 *   - Raw URLs in text content (https?://...)
 *
 * Returns a flat array of URL strings. May contain duplicates.
 */
export function adfExtractUrls(node: AdfNode | null | undefined, urls: string[] = []): string[] {
  if (!node) return urls;

  // inlineCard smart links
  if (node.type === 'inlineCard' && node.attrs && node.attrs.url) {
    urls.push(node.attrs.url as string);
  }

  // Link marks on text nodes
  if (node.type === 'text' && Array.isArray(node.marks)) {
    for (const m of node.marks) {
      if (m.type === 'link' && m.attrs && m.attrs.href) {
        urls.push(m.attrs.href as string);
      }
    }
  }

  // Media node URL extraction
  if (node.type === 'media' && node.attrs && node.attrs.url) {
    urls.push(node.attrs.url as string);
  }

  // Also extract raw URLs from text content
  if (node.type === 'text' && node.text) {
    const urlPattern = /https?:\/\/[^\s)>\]]+/g;
    const matches = node.text.match(urlPattern) || [];
    urls.push(...matches);
  }

  // Recurse into children
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      adfExtractUrls(child, urls);
    }
  }

  return urls;
}
