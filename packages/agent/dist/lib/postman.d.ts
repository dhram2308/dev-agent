/**
 * postman.ts — Postman connector for MI Dev Agent
 *
 * Converted from lib/postman.js (zero functional changes).
 *
 * Authenticates via API Key, fetches and flattens Postman collections.
 * Also detects Postman collection JSON in Jira attachments (zero-auth path).
 */
import type { PostmanResult, PostmanUrlMatch, ConnectorTestResult } from "@mi/shared";
/**
 * Match a URL to a Postman collection.
 */
declare function matchUrl(url: string): PostmanUrlMatch | null;
/**
 * Flatten a Postman collection into a structured endpoint summary.
 */
declare function flattenCollection(collection: any): string;
/**
 * Fetch a Postman collection by ID via the API.
 * Automatically resolves bare collection IDs to full UIDs.
 */
declare function fetchCollection(collectionId: string): Promise<PostmanResult>;
/**
 * Detect if a JSON string/object is a Postman collection.
 */
declare function detectPostmanAttachment(jsonContent: string | object): boolean;
/**
 * Test connection — validate API key by calling /me.
 */
declare function testConnection(): Promise<ConnectorTestResult>;
export { matchUrl, fetchCollection, flattenCollection, detectPostmanAttachment, testConnection };
//# sourceMappingURL=postman.d.ts.map