"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.httpsAgent = exports.httpAgent = void 0;
exports.sleep = sleep;
exports.req = req;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const zlib = __importStar(require("zlib"));
const logger_1 = require("../lib/logger");
// -- Keep-alive agents ------------------------------------------------
const MAX_FREE_SOCKETS = parseInt(process.env.MAX_FREE_SOCKETS || '', 10) || 10;
const httpAgent = new http.Agent({ keepAlive: true, maxFreeSockets: MAX_FREE_SOCKETS });
exports.httpAgent = httpAgent;
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxFreeSockets: MAX_FREE_SOCKETS,
    rejectUnauthorized: false, // Self-signed certs on internal GitLab
});
exports.httpsAgent = httpsAgent;
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
function sleep(ms) {
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
async function req(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const timeout = opts.timeout || DEFAULT_TIMEOUT;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    let bodyStr;
    if (opts.body !== undefined && opts.body !== null) {
        bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
            const jitter = Math.floor(Math.random() * delay * 0.3);
            (0, logger_1.logDebug)(`HTTP retry ${attempt}/${maxRetries} for ${method} ${url} (waiting ${delay + jitter}ms)`);
            await sleep(delay + jitter);
        }
        try {
            const response = await _doRequest(url, method, opts.headers || {}, bodyStr, timeout, opts.raw);
            return response;
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            const code = err.code || '';
            const status = err.status;
            const isRetryable = RETRYABLE_NET_CODES.has(code) ||
                (status !== undefined && RETRYABLE_STATUS.has(status));
            if (!isRetryable || attempt >= maxRetries) {
                throw lastError;
            }
            (0, logger_1.logWarn)(`HTTP ${method} ${url} failed (attempt ${attempt + 1}): ${lastError.message} — retrying`);
        }
    }
    throw lastError || new Error(`HTTP ${method} ${url} failed after ${maxRetries + 1} attempts`);
}
// -- Internal request implementation ----------------------------------
function _doRequest(url, method, headers, body, timeout, raw) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const requestHeaders = {
            'Accept-Encoding': 'gzip, deflate',
            ...headers,
        };
        if (body !== undefined) {
            requestHeaders['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
            if (!requestHeaders['Content-Type']) {
                requestHeaders['Content-Type'] = 'application/json';
            }
        }
        const requestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method,
            headers: requestHeaders,
            agent: isHttps ? httpsAgent : httpAgent,
            timeout,
        };
        const transport = isHttps ? https : http;
        const request = transport.request(requestOptions, (res) => {
            const statusCode = res.statusCode || 0;
            const contentEncoding = (res.headers['content-encoding'] || '').toLowerCase();
            // Decompress if needed
            let stream = res;
            if (contentEncoding === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            }
            else if (contentEncoding === 'deflate') {
                stream = res.pipe(zlib.createInflate());
            }
            const chunks = [];
            let totalSize = 0;
            stream.on('data', (chunk) => {
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
                const responseHeaders = {};
                for (const [key, value] of Object.entries(res.headers)) {
                    if (value !== undefined) {
                        responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
                    }
                }
                if (raw) {
                    resolve({
                        status: statusCode,
                        data: buffer,
                        headers: responseHeaders,
                    });
                    return;
                }
                // Parse response body
                const bodyText = buffer.toString('utf8');
                let data;
                try {
                    data = JSON.parse(bodyText);
                }
                catch {
                    data = bodyText;
                }
                resolve({
                    status: statusCode,
                    data,
                    headers: responseHeaders,
                });
            });
            stream.on('error', (err) => {
                reject(err);
            });
        });
        request.on('error', (err) => {
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
//# sourceMappingURL=client.js.map