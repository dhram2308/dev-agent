import * as https from 'https';
import * as http from 'http';
export interface RequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;
    body?: unknown;
    timeout?: number;
    maxRetries?: number;
    /** If true, return raw Buffer instead of parsing JSON */
    raw?: boolean;
}
export interface HttpResponse<T = unknown> {
    status: number;
    data: T;
    headers: Record<string, string>;
}
declare const httpAgent: http.Agent;
declare const httpsAgent: https.Agent;
export declare function sleep(ms: number): Promise<void>;
/**
 * Make an HTTP/HTTPS request with retries and timeout.
 *
 * @param url - Full URL to request
 * @param opts - Request options (method, headers, body, timeout, etc.)
 * @returns Response with status, parsed data, and headers
 */
export declare function req<T = unknown>(url: string, opts?: RequestOptions): Promise<HttpResponse<T>>;
export { httpAgent, httpsAgent };
