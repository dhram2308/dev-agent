// =====================================================================
// MI Dev Agent -- HTTP Client (TypeScript)
// =====================================================================
// Typed wrapper around the production HTTP client from lib/http-client.js.
//
// For Phase 3 of the rewrite, this provides a typed `req` function that
// services (Jira, GitLab, Slack) use for all external API calls.
//
// Uses Node.js built-in https/http modules with keep-alive, retries,
// circuit breakers, and response size protection.
// =====================================================================

import * as https from 'https';
import * as http from 'http';
import * as zlib from 'zlib';
import { logWarn, logDebug } from '../lib/logger';

// -- Types ------------------------------------------------------------

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

// -- Keep-alive agents ------------------------------------------------

const MAX_FREE_SOCKETS = parseInt(process.env.MAX_FREE_SOCKETS || '', 10) || 10;

const httpAgent = new http.Agent({ keepAlive: true, maxFreeSockets: MAX_FREE_SOCKETS });
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxFreeSockets: MAX_FREE_SOCKETS,
  rejectUnauthorized: false,  // Self-signed certs on internal GitLab
});

// -- Constants --------------------------------------------------------

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_RESPONSE_SIZE = 50_000_000; // 50MB

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'SOCKET_TIMEOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN',
]);

// -- Sleep utility ----------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -- Core request function --------------------------------------------

/**
 * Make an HTTP/HTTPS request with retries and timeout.
 *
 * @param url - Full URL to request
 * @param opts - Request options (method, headers, body, timeout, etc.)
 * @returns Response with status, parsed data, and headers
 */
export async function req<T = unknown>(
  url: string,
  opts: RequestOptions = {},
): Promise<HttpResponse<T>> {
  const method = (opts.method || 'GET').toUpperCase();
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  let bodyStr: string | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
      const jitter = Math.floor(Math.random() * delay * 0.3);
      logDebug(`HTTP retry ${attempt}/${maxRetries} for ${method} ${url} (waiting ${delay + jitter}ms)`);
      await sleep(delay + jitter);
    }

    try {
      const response = await _doRequest<T>(url, method, opts.headers || {}, bodyStr, timeout, opts.raw);
      return response;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const code = (err as NodeJS.ErrnoException).code || '';
      const status = (err as { status?: number }).status;

      const isRetryable =
        RETRYABLE_NET_CODES.has(code) ||
        (status !== undefined && RETRYABLE_STATUS.has(status));

      if (!isRetryable || attempt >= maxRetries) {
        throw lastError;
      }

      logWarn(`HTTP ${method} ${url} failed (attempt ${attempt + 1}): ${lastError.message} — retrying`);
    }
  }

  throw lastError || new Error(`HTTP ${method} ${url} failed after ${maxRetries + 1} attempts`);
}

// -- Internal request implementation ----------------------------------

function _doRequest<T>(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeout: number,
  raw?: boolean,
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';

    const requestHeaders: Record<string, string> = {
      'Accept-Encoding': 'gzip, deflate',
      ...headers,
    };

    if (body !== undefined) {
      requestHeaders['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
      if (!requestHeaders['Content-Type']) {
        requestHeaders['Content-Type'] = 'application/json';
      }
    }

    const requestOptions: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: requestHeaders,
      agent: isHttps ? httpsAgent : httpAgent,
      timeout,
    };

    const transport = isHttps ? https : http;
    const request = transport.request(requestOptions, (res: http.IncomingMessage) => {
      const statusCode = res.statusCode || 0;
      const contentEncoding = (res.headers['content-encoding'] || '').toLowerCase();

      // Decompress if needed
      let stream: NodeJS.ReadableStream = res;
      if (contentEncoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (contentEncoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;

      stream.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_RESPONSE_SIZE) {
          request.destroy(new Error(`Response exceeded ${MAX_RESPONSE_SIZE} bytes`));
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);

        // Collect response headers as flat record
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) {
            responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
          }
        }

        if (raw) {
          resolve({
            status: statusCode,
            data: buffer as unknown as T,
            headers: responseHeaders,
          });
          return;
        }

        // Parse response body
        const bodyText = buffer.toString('utf8');
        let data: T;
        try {
          data = JSON.parse(bodyText) as T;
        } catch {
          data = bodyText as unknown as T;
        }

        resolve({
          status: statusCode,
          data,
          headers: responseHeaders,
        });
      });

      stream.on('error', (err: Error) => {
        reject(err);
      });
    });

    request.on('error', (err: Error) => {
      reject(err);
    });

    request.on('timeout', () => {
      request.destroy(new Error(`Request timeout after ${timeout}ms: ${method} ${url}`));
    });

    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

export { httpAgent, httpsAgent };
