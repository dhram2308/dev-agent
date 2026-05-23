/**
 * figma.ts — Figma connector for MI Dev Agent
 *
 * Converted from lib/figma.js (zero functional changes).
 *
 * Authenticates via Personal Access Token (PAT), fetches file structure,
 * extracts text content and component names. Optional Vision path for
 * frame screenshot descriptions.
 */
import type { FigmaResult, FigmaUrlMatch, ConnectorTestResult } from "@mi/shared";
/**
 * Match a URL to a Figma file.
 */
declare function matchUrl(url: string): FigmaUrlMatch | null;
/**
 * Fetch a Figma file and extract structure + text content.
 */
declare function fetchFigmaFile(fileKey: string, nodeId?: string): Promise<FigmaResult>;
/**
 * Export frame images and describe them with Anthropic Vision.
 */
declare function describeFramesWithVision(fileKey: string, frameIds: string[] | undefined, callAnthropicVision: (base64: string, mimeType: string, description: string) => Promise<string>): Promise<string>;
/**
 * Test connection — call /v1/me which works for both PAT and OAuth (with
 * `current_user:read` scope). Distinguishes auth modes in the error so a
 * user looking at the message knows which credential to fix.
 */
declare function testConnection(): Promise<ConnectorTestResult>;
export { matchUrl, fetchFigmaFile, describeFramesWithVision, testConnection };
//# sourceMappingURL=figma.d.ts.map