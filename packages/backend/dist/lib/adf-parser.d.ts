/** A node in the Atlassian Document Format tree. */
export interface AdfNode {
    type: string;
    content?: AdfNode[];
    text?: string;
    attrs?: Record<string, unknown>;
    marks?: Array<{
        type: string;
        attrs?: Record<string, unknown>;
    }>;
}
/** Context carried through recursive ADF-to-markdown conversion. */
interface AdfContext {
    listDepth: number;
    listIndex: number;
    ordered: boolean;
    _depth: number;
}
/**
 * Unescape HTML entities in a string. Handles both named and numeric
 * entities (decimal and hex).
 */
export declare function unescapeHtml(text: string | null | undefined): string;
/**
 * Extracts plain text from an ADF node tree. This is the legacy lossy
 * extraction -- use `adfToMarkdown` for structured output.
 */
export declare function adfText(node: AdfNode | string | null | undefined): string;
/**
 * Converts an ADF JSON tree to a Markdown string. Preserves structure
 * including headings, lists, code blocks, tables, links, mentions,
 * status badges, panels, expand sections, task lists, and more.
 */
export declare function adfToMarkdown(node: AdfNode | string | null | undefined, ctx?: AdfContext): string;
/**
 * Walks an ADF tree and extracts all URLs found in:
 *   - inlineCard smart links (attrs.url)
 *   - Link marks on text nodes (mark.attrs.href)
 *   - Media nodes (attrs.url)
 *   - Raw URLs in text content (https?://...)
 *
 * Returns a flat array of URL strings. May contain duplicates.
 */
export declare function adfExtractUrls(node: AdfNode | null | undefined, urls?: string[]): string[];
export {};
