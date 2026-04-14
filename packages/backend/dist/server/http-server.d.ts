import type { Server } from 'http';
/** M6: Auth token for POST endpoints */
declare const API_TOKEN: string;
/** Server port */
declare const PORT: number;
/** Server bind host */
declare const BIND_HOST: string;
/**
 * Start the HTTP server.
 *
 * Sets up:
 *   1. Clean orphaned locks from previous crashes
 *   2. Graceful shutdown handlers
 *   3. HTTP server with security middleware and route handling
 *   4. SSE client management registration
 *   5. Shutdown hooks for server close and worktree cleanup
 *   6. Error handling for EADDRINUSE
 *
 * @returns The HTTP server instance
 */
export declare function startServer(): Server;
/**
 * Get the HTTP server instance (available after startServer() is called).
 */
export declare function getServer(): Server | undefined;
/**
 * Get the API token (for testing or embedding in HTML).
 */
export declare function getApiToken(): string;
/**
 * Get the pre-rendered HTML string.
 */
export declare function getRenderedHTML(): string;
/**
 * Get the configured port.
 */
export declare function getPort(): number;
/**
 * Get the configured bind host.
 */
export declare function getBindHost(): string;
export { API_TOKEN, PORT, BIND_HOST };
