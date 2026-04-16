/**
 * adf.ts -- ADF text extraction, Markdown conversion, and URL extraction
 *
 * Converted from lib/adf.js (zero functional changes).
 */

import type { AdfNode } from "@shared/types/adf";

// Re-export the AdfNode type for consumers
export type { AdfNode };

/** Context passed during ADF-to-Markdown recursive traversal */
interface AdfToMarkdownCtx {
  listDepth: number;
  listIndex: number;
  ordered: boolean;
  _depth: number;
}

// ── ADF text extraction (legacy -- plain text, lossy) ──────────────

/**
 * Extract plain text from an ADF node tree (lossy).
 * Kept for backward compatibility; prefer adfToMarkdown() for structured output.
 */
export function adfText(node: AdfNode | string | null | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  let out = "";
  if (node.type === "text")       out += node.text || "";
  if (node.type === "hardBreak")  out += "\n";
  if (node.type === "listItem")   out += "\u2022 ";
  if (Array.isArray(node.content))
    out += node.content.map(adfText).join("");
  if (["paragraph", "heading", "bulletList", "orderedList", "blockquote", "codeBlock", "rule"]
      .includes(node.type))
    out += "\n";
  return out;
}

// ── T2: HTML entity unescaping ────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&#x27;": "'", "&#x2F;": "/", "&#x60;": "`", "&nbsp;": " " };
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27|#x2F|#x60);/g;

export function unescapeHtml(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return text || "";
  return text
    .replace(HTML_ENTITY_RE, (m) => HTML_ENTITIES[m] || m)
    // Fix 5b: Decode numeric HTML entities (&#8212; &#160; &#x2019; etc.)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

// ── ADF -> Markdown (preserves structure, links, code, tables) ─────

export function adfToMarkdown(
  node: AdfNode | string | null | undefined,
  ctx: AdfToMarkdownCtx = { listDepth: 0, listIndex: 0, ordered: false, _depth: 0 },
): string {
  if (!node) return "";
  if (typeof node === "string") return node;

  // P5: ADF recursion depth limit
  const depth = (ctx._depth || 0) + 1;
  if (depth > 20) return "[...deeply nested content omitted]";

  const depthCtx: AdfToMarkdownCtx = { ...ctx, _depth: depth };
  const children = (overrideCtx?: AdfToMarkdownCtx): string =>
    Array.isArray(node.content)
      ? node.content.map((c) => adfToMarkdown(c, overrideCtx ? { ...overrideCtx, _depth: depth } : depthCtx)).join("")
      : "";

  const attrs = node.attrs as Record<string, any> | undefined;

  switch (node.type) {
    case "doc":
      return children();

    case "text": {
      let t = unescapeHtml(node.text || "");
      // Apply marks (bold, italic, code, link, strike, etc.)
      if (Array.isArray(node.marks)) {
        for (const m of node.marks) {
          const mAttrs = m.attrs as Record<string, any> | undefined;
          switch (m.type) {
            case "strong":    t = `**${t}**`; break;
            case "em":        t = `*${t}*`; break;
            case "code":      t = `\`${t}\``; break;
            case "strike":    t = `~~${t}~~`; break;
            case "link":      t = `[${t}](${(mAttrs && mAttrs.href) || ""})`; break;
            case "underline": t = `<u>${t}</u>`; break;
            // textColor, subsup -- skip, not critical for requirements
          }
        }
      }
      return t;
    }

    case "hardBreak":
      return "\n";

    case "paragraph":
      return children() + "\n\n";

    case "heading": {
      const level: number = (attrs && attrs.level) || 1;
      return "#".repeat(level) + " " + children() + "\n\n";
    }

    case "bulletList":
      return (node.content || [])
        .map((c) => adfToMarkdown(c, { ...ctx, listDepth: ctx.listDepth + 1, ordered: false, _depth: depth }))
        .join("") + (ctx.listDepth === 0 ? "\n" : "");

    case "orderedList":
      return (node.content || [])
        .map((c, i) => adfToMarkdown(c, { ...ctx, listDepth: ctx.listDepth + 1, listIndex: i + 1, ordered: true, _depth: depth }))
        .join("") + (ctx.listDepth === 0 ? "\n" : "");

    case "listItem": {
      const indent = "  ".repeat(Math.max(0, ctx.listDepth - 1));
      const bullet = ctx.ordered ? `${ctx.listIndex}. ` : "- ";
      const content = children().replace(/\n$/, "");
      return indent + bullet + content + "\n";
    }

    case "blockquote":
      return children().split("\n").map((l) => "> " + l).join("\n") + "\n\n";

    case "codeBlock": {
      const lang: string = (attrs && attrs.language) || "";
      return "```" + lang + "\n" + children() + "\n```\n\n";
    }

    case "rule":
      return "---\n\n";

    case "inlineCard":
      // Smart links -- extract URL from attrs
      return (attrs && attrs.url) ? `[${attrs.url}](${attrs.url})` : "";

    case "mention":
      return `@${(attrs && attrs.text) || (attrs && attrs.id) || "user"}`;

    case "emoji":
      return (attrs && attrs.shortName) || (attrs && attrs.text) || "";

    case "date":
      return (attrs && attrs.timestamp)
        ? new Date(parseInt(attrs.timestamp)).toISOString().split("T")[0]
        : "";

    case "status":
      return `[${(attrs && attrs.text) || "STATUS"}]`;

    case "panel": {
      const panelType: string = (attrs && attrs.panelType) || "info";
      return `> **${panelType.toUpperCase()}**: ${children()}\n\n`;
    }

    case "expand": {
      const title: string = (attrs && attrs.title) || "Details";
      return `<details>\n<summary>${title}</summary>\n\n${children()}\n</details>\n\n`;
    }

    // Table support (D11: insert markdown separator after header row)
    case "table": {
      const rows = (node.content || []).map((c, i) => {
        const row = adfToMarkdown(c, ctx);
        // After the first row (header), insert separator
        if (i === 0) {
          const colCount = (c.content || []).length;
          return row + "| " + Array(colCount).fill("---").join(" | ") + " |\n";
        }
        return row;
      });
      return rows.join("") + "\n";
    }

    case "tableRow": {
      const cells = (node.content || []).map((c) => adfToMarkdown(c, ctx));
      return "| " + cells.join(" | ") + " |\n";
    }

    case "tableHeader": {
      const text = children().replace(/\n/g, " ").trim();
      return text;
    }

    case "tableCell": {
      const text = children().replace(/\n/g, " ").trim();
      return text;
    }

    // Media -- just note the filename/ID
    case "mediaSingle":
    case "mediaGroup":
      return children();

    case "media": {
      const alt: string = (attrs && attrs.alt) || (attrs && attrs.id) || "media";
      return `[Attachment: ${alt}]\n`;
    }

    // Z8: Missing ADF node types
    case "taskList":
      return (node.content || []).map((c) => adfToMarkdown(c, depthCtx)).join("") + "\n";

    case "taskItem": {
      const checked = (attrs && attrs.state === "DONE") ? "[x]" : "[ ]";
      return `- ${checked} ${children()}\n`;
    }

    case "layoutSection":
      return children() + "\n";

    case "layoutColumn":
      return children();

    case "nestedExpand": {
      const neTitle: string = (attrs && attrs.title) || "Details";
      return `<details>\n<summary>${neTitle}</summary>\n\n${children()}\n</details>\n\n`;
    }

    case "decisionList":
      return (node.content || []).map((c) => adfToMarkdown(c, depthCtx)).join("") + "\n";

    case "decisionItem": {
      const decState: string = (attrs && attrs.state) || "DECIDED";
      return `- [${decState}] ${children()}\n`;
    }

    case "placeholder":
      return (attrs && attrs.text) ? `[${attrs.text}]` : "";

    case "extension":
    case "bodiedExtension": {
      const extTitle: string = (attrs && attrs.extensionTitle) || (attrs && attrs.extensionKey) || "extension";
      return `[Extension: ${extTitle}]\n${children()}`;
    }

    case "inlineExtension": {
      const inlExtTitle: string = (attrs && attrs.extensionTitle) || (attrs && attrs.extensionKey) || "extension";
      return `[${inlExtTitle}]`;
    }

    default:
      // Fallback: recurse into children
      return children();
  }
}

// ── ADF URL extractor (walks tree, finds all URLs) ────────────────

export function adfExtractUrls(node: AdfNode | null | undefined, urls: string[] = []): string[] {
  if (!node) return urls;

  const attrs = node.attrs as Record<string, any> | undefined;

  // inlineCard smart links
  if (node.type === "inlineCard" && attrs && attrs.url) {
    urls.push(attrs.url);
  }

  // Link marks on text nodes
  if (node.type === "text" && Array.isArray(node.marks)) {
    for (const m of node.marks) {
      const mAttrs = m.attrs as Record<string, any> | undefined;
      if (m.type === "link" && mAttrs && mAttrs.href) {
        urls.push(mAttrs.href);
      }
    }
  }

  // Z9: Media node URL extraction
  if (node.type === "media" && attrs && attrs.url) {
    urls.push(attrs.url);
  }

  // Also extract raw URLs from text content
  if (node.type === "text" && node.text) {
    const urlPattern = /https?:\/\/[^\s)>\]]+/g;
    const matches = node.text.match(urlPattern) || [];
    urls.push(...matches);
  }

  // Recurse
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      adfExtractUrls(child, urls);
    }
  }

  return urls;
}
