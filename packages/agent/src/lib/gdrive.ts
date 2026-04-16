/**
 * gdrive.ts — Google Drive connector for MI Dev Agent
 *
 * Converted from lib/gdrive.js (zero functional changes).
 *
 * Authenticates via GCP Service Account JWT, fetches Google Docs (as markdown)
 * and Google Sheets (as CSV). Zero npm dependencies — uses native crypto + https.
 */

import crypto from "crypto";
import https from "https";

import type { GDriveResult, GDriveUrlMatch, ConnectorTestResult } from "@mi/shared";

const CONNECTOR_BUDGET = 15 * 1024; // 15 KB per item
const TOKEN_MARGIN = 60; // seconds before expiry to refresh

// In-memory token cache
let _cachedToken: string | null = null;
let _cachedExpiry = 0;

// ── URL pattern matching ────────────────────────────────────────

interface UrlPattern {
  re: RegExp;
  type: "doc" | "sheet" | "file";
}

const GDRIVE_PATTERNS: UrlPattern[] = [
  { re: /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/, type: "doc" },
  { re: /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/, type: "sheet" },
  { re: /sheets\.google\.com\/.*\/d\/([a-zA-Z0-9_-]+)/, type: "sheet" },
  { re: /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/, type: "file" },
];

/**
 * Match a URL to a Google Drive resource.
 * @returns Matched URL components or null
 */
function matchUrl(url: string): GDriveUrlMatch | null {
  for (const p of GDRIVE_PATTERNS) {
    const m = url.match(p.re);
    if (m) {
      const result: GDriveUrlMatch = { type: p.type, fileId: m[1] };
      // Extract gid for sheets
      const gidMatch = url.match(/[?&#]gid=(\d+)/);
      if (gidMatch) result.gid = gidMatch[1];
      return result;
    }
  }
  return null;
}

// ── JWT generation ──────────────────────────────────────────────

interface ServiceAccount {
  client_email: string;
  private_key: string;
  [key: string]: any;
}

interface ParseResult {
  ok: boolean;
  data?: ServiceAccount;
  error?: string;
}

function _parseServiceAccount(): ParseResult {
  const raw = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
  if (!raw) return { ok: false, error: "GDRIVE_SERVICE_ACCOUNT_JSON not set" };
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
      return { ok: false, error: "Invalid service account JSON: could not parse as JSON or base64" };
    }
  }
  if (!parsed.client_email) return { ok: false, error: "Invalid service account JSON: missing client_email" };
  if (!parsed.private_key) return { ok: false, error: "Invalid service account JSON: missing private_key" };
  return { ok: true, data: parsed };
}

function _base64url(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function _buildJwt(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const segments = _base64url(JSON.stringify(header)) + "." + _base64url(JSON.stringify(payload));
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(segments);
  const signature = sign.sign(sa.private_key);
  return segments + "." + _base64url(signature);
}

// ── Token exchange ──────────────────────────────────────────────

interface HttpResponse {
  status: number | undefined;
  data: any;
}

function _httpsPost(hostname: string, urlPath: string, body: string | object): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const opts = {
      hostname,
      port: 443,
      path: urlPath,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(data) },
      timeout: 15000,
    };
    const req = https.request(opts, (res) => {
      let buf = "";
      res.on("data", (c: Buffer) => { buf += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: buf }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Token exchange timed out")); });
    req.write(data);
    req.end();
  });
}

function _httpsGet(hostname: string, urlPath: string, token: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname,
      port: 443,
      path: urlPath,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 30000,
    };
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => { chunks.push(c); });
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Google API request timed out")); });
    req.end();
  });
}

function _httpsGetRaw(hostname: string, urlPath: string, token: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname,
      port: 443,
      path: urlPath,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
    };
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => { chunks.push(c); });
      res.on("end", () => {
        resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Google API request timed out")); });
    req.end();
  });
}

async function _getAccessToken(sa: ServiceAccount): Promise<string> {
  // OAuth mode: parent server injects access token via env var — bypass JWT exchange
  const oauthToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (oauthToken) return oauthToken;

  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && _cachedExpiry > now + TOKEN_MARGIN) {
    return _cachedToken;
  }
  const jwt = _buildJwt(sa);
  const body = `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}`;
  const resp = await _httpsPost("oauth2.googleapis.com", "/token", body);
  if (resp.status !== 200 || !resp.data.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }
  _cachedToken = resp.data.access_token;
  _cachedExpiry = now + (resp.data.expires_in || 3600);
  return _cachedToken!;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Fetch a Google Doc as markdown, truncated to connector budget.
 */
async function fetchGoogleDoc(fileId: string): Promise<GDriveResult> {
  const oauthMode = !!process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  const sa = oauthMode ? { ok: true as const, data: {} as ServiceAccount } : _parseServiceAccount();
  if (!sa.ok) return { ok: false, error: sa.error };
  try {
    const token = await _getAccessToken(sa.data!);
    const meta = await _httpsGet("www.googleapis.com", `/drive/v3/files/${fileId}?fields=name`, token);
    const title = (meta.status === 200 && meta.data.name) ? meta.data.name : `Google Doc ${fileId}`;
    const exp = await _httpsGetRaw("www.googleapis.com", `/drive/v3/files/${fileId}/export?mimeType=text%2Fmarkdown`, token);
    if (exp.status === 404 || exp.status === 403) {
      return { ok: false, error: oauthMode ? "File not accessible — check OAuth token permissions" : `File not accessible — share it with ${sa.data!.client_email}` };
    }
    if (exp.status !== 200) {
      return { ok: false, error: `Export failed: HTTP ${exp.status}` };
    }
    let content: string = exp.data;
    if (content.length > CONNECTOR_BUDGET) {
      const cutoff = content.lastIndexOf("\n\n", CONNECTOR_BUDGET);
      content = content.slice(0, cutoff > 0 ? cutoff : CONNECTOR_BUDGET) + "\n\n[Content truncated — original document continues]";
    }
    return { ok: true, title, content };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Fetch a Google Sheet as CSV, limited to first 100 rows.
 */
async function fetchGoogleSheet(fileId: string, gid?: string): Promise<GDriveResult> {
  const oauthMode = !!process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  const sa = oauthMode ? { ok: true as const, data: {} as ServiceAccount } : _parseServiceAccount();
  if (!sa.ok) return { ok: false, error: sa.error };
  try {
    const token = await _getAccessToken(sa.data!);
    const meta = await _httpsGet("www.googleapis.com", `/drive/v3/files/${fileId}?fields=name`, token);
    const title = (meta.status === 200 && meta.data.name) ? meta.data.name : `Google Sheet ${fileId}`;
    let exportPath = `/drive/v3/files/${fileId}/export?mimeType=text%2Fcsv`;
    if (gid) exportPath += `&gid=${gid}`;
    const exp = await _httpsGetRaw("www.googleapis.com", exportPath, token);
    if (exp.status === 404 || exp.status === 403) {
      return { ok: false, error: oauthMode ? "File not accessible — check OAuth token permissions" : `File not accessible — share it with ${sa.data!.client_email}` };
    }
    if (exp.status !== 200) {
      return { ok: false, error: `Export failed: HTTP ${exp.status}` };
    }
    let content: string = exp.data;
    const lines = content.split("\n");
    if (lines.length > 100) {
      content = lines.slice(0, 100).join("\n") + `\n\n[Showing first 100 of ${lines.length} rows]`;
    }
    if (content.length > CONNECTOR_BUDGET) {
      content = content.slice(0, CONNECTOR_BUDGET) + "\n\n[Content truncated]";
    }
    return { ok: true, title, content };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Test connection — validate service account credentials.
 */
async function testConnection(): Promise<ConnectorTestResult> {
  const oauthMode = !!process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  const sa = oauthMode ? { ok: true as const, data: {} as ServiceAccount } : _parseServiceAccount();
  if (!sa.ok) return { ok: false, error: sa.error };
  try {
    const token = await _getAccessToken(sa.data!);
    const resp = await _httpsGet("www.googleapis.com", "/drive/v3/about?fields=user", token);
    if (resp.status === 200 && resp.data.user) {
      return { ok: true, message: oauthMode ? "Google Drive connected — OAuth token" : `Google Drive connected — service account: ${sa.data!.client_email}` };
    }
    return { ok: false, error: `Unexpected response: HTTP ${resp.status}` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export { matchUrl, fetchGoogleDoc, fetchGoogleSheet, testConnection };
