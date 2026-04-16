/**
 * adf.ts -- ADF text extraction, Markdown conversion, and URL extraction
 *
 * Converted from lib/adf.js (zero functional changes).
 */
import type { AdfNode } from "@shared/types/adf";
export type { AdfNode };
/** Context passed during ADF-to-Markdown recursive traversal */
interface AdfToMarkdownCtx {
    listDepth: number;
    listIndex: number;
    ordered: boolean;
    _depth: number;
}
/**
 * Extract plain text from an ADF node tree (lossy).
 * Kept for backward compatibility; prefer adfToMarkdown() for structured output.
 */
export declare function adfText(node: AdfNode | string | null | undefined): string;
export declare function unescapeHtml(text: string | null | undefined): string;
export declare function adfToMarkdown(node: AdfNode | string | null | undefined, ctx?: AdfToMarkdownCtx): string;
export declare function adfExtractUrls(node: AdfNode | null | undefined, urls?: string[]): string[];
//# sourceMappingURL=adf.d.ts.map