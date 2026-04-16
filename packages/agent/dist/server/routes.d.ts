import type { IncomingMessage, ServerResponse } from 'http';
/**
 * Handle all API routes for the server.
 */
declare function handleRequest(url: URL, request: IncomingMessage, res: ServerResponse, apiToken: string, html: string): Promise<boolean>;
export { handleRequest };
//# sourceMappingURL=routes.d.ts.map