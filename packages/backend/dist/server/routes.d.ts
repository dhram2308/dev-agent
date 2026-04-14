import type { IncomingMessage, ServerResponse } from 'http';
import type { StageName } from '@shared/types';
interface AgentProcessHandlers {
    startAgent: (ticket: string) => {
        ok: boolean;
        error?: string;
    };
    stopAgent: (ticket: string | null) => {
        ok: boolean;
        error?: string;
    };
    checkProcessHealth: (ticket: string) => {
        alive: boolean;
        reason?: string;
        exitCode?: number;
        pid?: number;
    };
    getAgentProcs: () => Record<string, AgentChildProcess>;
    STAGE_DATA_MAP: Record<string, string[]>;
}
interface AgentChildProcess {
    exitCode: number | null;
    kill: (signal: string) => void;
}
/**
 * Register agent process handlers. Called by http-server.ts on startup.
 */
export declare function setAgentProcessHandlers(handlers: AgentProcessHandlers): void;
/**
 * F12: Path traversal guard -- validate ticket params.
 * Uses security module's validateTicket when available, falls back to basic regex.
 */
export declare function safeTicket(t: string | null | undefined): string | null;
/**
 * Gate parameter sanitization -- whitelist valid gate names.
 */
export declare function safeGate(g: string | null | undefined): string | null;
/**
 * Stage parameter sanitization -- whitelist valid stage names.
 */
export declare function safeStage(s: string | null | undefined): StageName | null;
/**
 * Handle all API routes for the server.
 *
 * @param url - Parsed URL object
 * @param request - HTTP incoming message
 * @param res - HTTP server response
 * @param apiToken - The API token for auth
 * @param html - Pre-rendered HTML string (fallback for SPA)
 * @returns true if the route was handled
 */
export declare function handleRequest(url: URL, request: IncomingMessage, res: ServerResponse, apiToken: string, html?: string): Promise<boolean>;
export {};
