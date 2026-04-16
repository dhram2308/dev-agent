/**
 * gdrive.ts — Google Drive connector for MI Dev Agent
 *
 * Converted from lib/gdrive.js (zero functional changes).
 *
 * Authenticates via GCP Service Account JWT, fetches Google Docs (as markdown)
 * and Google Sheets (as CSV). Zero npm dependencies — uses native crypto + https.
 */
import type { GDriveResult, GDriveUrlMatch, ConnectorTestResult } from "@mi/shared";
/**
 * Match a URL to a Google Drive resource.
 * @returns Matched URL components or null
 */
declare function matchUrl(url: string): GDriveUrlMatch | null;
/**
 * Fetch a Google Doc as markdown, truncated to connector budget.
 */
declare function fetchGoogleDoc(fileId: string): Promise<GDriveResult>;
/**
 * Fetch a Google Sheet as CSV, limited to first 100 rows.
 */
declare function fetchGoogleSheet(fileId: string, gid?: string): Promise<GDriveResult>;
/**
 * Test connection — validate service account credentials.
 */
declare function testConnection(): Promise<ConnectorTestResult>;
export { matchUrl, fetchGoogleDoc, fetchGoogleSheet, testConnection };
//# sourceMappingURL=gdrive.d.ts.map