"use strict";

// ── ADF text extraction (legacy — plain text, lossy) ──────────────

function adfText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  let out = "";
  if (node.type === "text")       out += node.text || "";
  if (node.type === "hardBreak")  out += "\n";
  if (node.type === "listItem")   out += "• ";
  if (Array.isArray(node.content))
    out += node.content.map(adfText).join("");
  if (["paragraph", "heading", "bulletList", "orderedList", "blockquote", "codeBlock", "rule"]
      .includes(node.type))
    out += "\n";
  return out;
}

// ── T2: HTML entity unescaping ────────────────────────────────────
const HTML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&#x27;": "'", "&#x2F;": "/", "&#x60;": "`", "&nbsp;": " " };
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27|#x2F|#x60);/g;
function unescapeHtml(text) {
  if (!text || typeof text !== "string") return text || "";
  return text
    .replace(HTML_ENTITY_RE, (m) => HTML_ENTITIES[m] || m)
    // Fix 5b: Decode numeric HTML entities (&#8212; &#160; &#x2019; etc.)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ── ADF → Markdown (preserves structure, links, code, tables) ─────

function adfToMarkdown(node, ctx = { listDepth: 0, listIndex: 0, ordered: false, _depth: 0 }) {
  if (!node) return "";
  if (typeof node === "string") return node;

  // P5: ADF recursion depth limit
  const depth = (ctx._depth || 0) + 1;
  if (depth > 20) return "[...deeply nested content omitted]";

  const depthCtx = { ...ctx, _depth: depth };
  const children = (overrideCtx) =>
    Array.isArray(node.content)
      ? node.content.map((c) => adfToMarkdown(c, overrideCtx ? { ...overrideCtx, _depth: depth } : depthCtx)).join("")
      : "";

  switch (node.type) {
    case "doc":
      return children();

    case "text": {
      let t = unescapeHtml(node.text || "");
      // Apply marks (bold, italic, code, link, strike, etc.)
      if (Array.isArray(node.marks)) {
        for (const m of node.marks) {
          switch (m.type) {
            case "strong":    t = `**${t}**`; break;
            case "em":        t = `*${t}*`; break;
            case "code":      t = `\`${t}\``; break;
            case "strike":    t = `~~${t}~~`; break;
            case "link":      t = `[${t}](${(m.attrs && m.attrs.href) || ""})`; break;
            case "underline": t = `<u>${t}</u>`; break;
            // textColor, subsup — skip, not critical for requirements
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
      const level = (node.attrs && node.attrs.level) || 1;
      return "#".repeat(level) + " " + children() + "\n\n";
    }

    case "bulletList":
      return node.content
        .map((c) => adfToMarkdown(c, { ...ctx, listDepth: ctx.listDepth + 1, ordered: false }))
        .join("") + (ctx.listDepth === 0 ? "\n" : "");

    case "orderedList":
      return node.content
        .map((c, i) => adfToMarkdown(c, { ...ctx, listDepth: ctx.listDepth + 1, listIndex: i + 1, ordered: true }))
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
      const lang = (node.attrs && node.attrs.language) || "";
      return "```" + lang + "\n" + children() + "\n```\n\n";
    }

    case "rule":
      return "---\n\n";

    case "inlineCard":
      // Smart links — extract URL from attrs
      return (node.attrs && node.attrs.url) ? `[${node.attrs.url}](${node.attrs.url})` : "";

    case "mention":
      return `@${(node.attrs && node.attrs.text) || (node.attrs && node.attrs.id) || "user"}`;

    case "emoji":
      return (node.attrs && node.attrs.shortName) || (node.attrs && node.attrs.text) || "";

    case "date":
      return (node.attrs && node.attrs.timestamp)
        ? new Date(parseInt(node.attrs.timestamp)).toISOString().split("T")[0]
        : "";

    case "status":
      return `[${(node.attrs && node.attrs.text) || "STATUS"}]`;

    case "panel": {
      const panelType = (node.attrs && node.attrs.panelType) || "info";
      return `> **${panelType.toUpperCase()}**: ${children()}\n\n`;
    }

    case "expand": {
      const title = (node.attrs && node.attrs.title) || "Details";
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

    // Media — just note the filename/ID
    case "mediaSingle":
    case "mediaGroup":
      return children();

    case "media": {
      const alt = (node.attrs && node.attrs.alt) || (node.attrs && node.attrs.id) || "media";
      return `[Attachment: ${alt}]\n`;
    }

    // Z8: Missing ADF node types
    case "taskList":
      return (node.content || []).map((c) => adfToMarkdown(c, depthCtx)).join("") + "\n";

    case "taskItem": {
      const checked = (node.attrs && node.attrs.state === "DONE") ? "[x]" : "[ ]";
      return `- ${checked} ${children()}\n`;
    }

    case "layoutSection":
      return children() + "\n";

    case "layoutColumn":
      return children();

    case "nestedExpand": {
      const neTitle = (node.attrs && node.attrs.title) || "Details";
      return `<details>\n<summary>${neTitle}</summary>\n\n${children()}\n</details>\n\n`;
    }

    case "decisionList":
      return (node.content || []).map((c) => adfToMarkdown(c, depthCtx)).join("") + "\n";

    case "decisionItem": {
      const decState = (node.attrs && node.attrs.state) || "DECIDED";
      return `- [${decState}] ${children()}\n`;
    }

    case "placeholder":
      return (node.attrs && node.attrs.text) ? `[${node.attrs.text}]` : "";

    case "extension":
    case "bodiedExtension": {
      const extTitle = (node.attrs && node.attrs.extensionTitle) || (node.attrs && node.attrs.extensionKey) || "extension";
      return `[Extension: ${extTitle}]\n${children()}`;
    }

    case "inlineExtension": {
      const inlExtTitle = (node.attrs && node.attrs.extensionTitle) || (node.attrs && node.attrs.extensionKey) || "extension";
      return `[${inlExtTitle}]`;
    }

    default:
      // Fallback: recurse into children
      return children();
  }
}

// ── ADF URL extractor (walks tree, finds all URLs) ────────────────

function adfExtractUrls(node, urls = []) {
  if (!node) return urls;

  // inlineCard smart links
  if (node.type === "inlineCard" && node.attrs && node.attrs.url) {
    urls.push(node.attrs.url);
  }

  // Link marks on text nodes
  if (node.type === "text" && Array.isArray(node.marks)) {
    for (const m of node.marks) {
      if (m.type === "link" && m.attrs && m.attrs.href) {
        urls.push(m.attrs.href);
      }
    }
  }

  // Z9: Media node URL extraction
  if (node.type === "media" && node.attrs && node.attrs.url) {
    urls.push(node.attrs.url);
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

module.exports = { adfText, adfToMarkdown, adfExtractUrls, unescapeHtml };
