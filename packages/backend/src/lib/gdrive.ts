// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Google Drive fetch (OAuth)
//
// Uses the OAuth access token persisted in CredentialStore for the
// `google` provider (via token-manager.getAccessToken, which handles
// proactive refresh). Exports Google Docs as markdown and Google
// Sheets as CSV via the Drive v3 export endpoint.
// ═══════════════════════════════════════════════════════════════

import https from 'https';

import type { GDriveResult, GDriveUrlMatch } from '@mi/shared';

import { getAccessToken } from '../oauth/token-manager';

const CONNECTOR_BUDGET = 15 * 1024;
const SHEET_ROW_CAP = 100;

// ── URL pattern matching ────────────────────────────────────────

const GDRIVE_PATTERNS: { re: RegExp; type: 'doc' | 'sheet' | 'file' }[] = [
  { re: /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/, type: 'doc' },
  { re: /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/, type: 'sheet' },
  { re: /sheets\.google\.com\/.*\/d\/([a-zA-Z0-9_-]+)/, type: 'sheet' },
  { re: /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/, type: 'file' },
];

export function matchUrl(url: string): GDriveUrlMatch | null {
  for (const p of GDRIVE_PATTERNS) {
    const m = url.match(p.re);
    if (m) {
      const result: GDriveUrlMatch = { type: p.type, fileId: m[1] };
      const gidMatch = url.match(/[?&#]gid=(\d+)/);
      if (gidMatch) result.gid = gidMatch[1];
      return result;
    }
  }
  return null;
}

// ── HTTPS helpers ───────────────────────────────────────────────

interface HttpResponse {
  status: number | undefined;
  data: string;
}

function _httpsGet(path: string, token: string, accept: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.googleapis.com',
        port: 443,
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: accept },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString('utf-8') });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Google API request timed out'));
    });
    req.end();
  });
}

async function _resolveToken(): Promise<string | { error: string }> {
  const token = await getAccessToken('google');
  if (!token) {
    return { error: 'Google not connected — connect via Settings → Connectors' };
  }
  return token;
}

function _truncateMarkdown(content: string): string {
  if (content.length <= CONNECTOR_BUDGET) return content;
  const cutoff = content.lastIndexOf('\n\n', CONNECTOR_BUDGET);
  return (
    content.slice(0, cutoff > 0 ? cutoff : CONNECTOR_BUDGET) +
    '\n\n[Content truncated — original document continues]'
  );
}

function _truncateCsv(content: string): string {
  const lines = content.split('\n');
  let truncated = content;
  if (lines.length > SHEET_ROW_CAP) {
    truncated = lines.slice(0, SHEET_ROW_CAP).join('\n') + `\n\n[Showing first ${SHEET_ROW_CAP} of ${lines.length} rows]`;
  }
  if (truncated.length > CONNECTOR_BUDGET) {
    truncated = truncated.slice(0, CONNECTOR_BUDGET) + '\n\n[Content truncated]';
  }
  return truncated;
}

async function _fetchTitle(fileId: string, token: string, fallback: string): Promise<string> {
  try {
    const meta = await _httpsGet(`/drive/v3/files/${fileId}?fields=name`, token, 'application/json');
    if (meta.status === 200) {
      const parsed = JSON.parse(meta.data);
      if (parsed.name) return String(parsed.name);
    }
  } catch {
    // Fall through to fallback title.
  }
  return fallback;
}

// ── Public API ──────────────────────────────────────────────────

export async function fetchGoogleDoc(fileId: string): Promise<GDriveResult> {
  const t = await _resolveToken();
  if (typeof t !== 'string') return { ok: false, error: t.error };
  try {
    const title = await _fetchTitle(fileId, t, `Google Doc ${fileId}`);
    const exp = await _httpsGet(
      `/drive/v3/files/${fileId}/export?mimeType=text%2Fmarkdown`,
      t,
      'text/markdown',
    );
    if (exp.status === 401) {
      return { ok: false, error: 'Google OAuth token rejected — re-authenticate via Settings → Connectors' };
    }
    if (exp.status === 403 || exp.status === 404) {
      return { ok: false, error: 'File not accessible — check the URL and that the OAuth account has access' };
    }
    if (exp.status !== 200) {
      return { ok: false, error: `Export failed: HTTP ${exp.status}` };
    }
    return { ok: true, title, content: _truncateMarkdown(exp.data) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchGoogleSheet(fileId: string, gid?: string): Promise<GDriveResult> {
  const t = await _resolveToken();
  if (typeof t !== 'string') return { ok: false, error: t.error };
  try {
    const title = await _fetchTitle(fileId, t, `Google Sheet ${fileId}`);
    let path = `/drive/v3/files/${fileId}/export?mimeType=text%2Fcsv`;
    if (gid) path += `&gid=${gid}`;
    const exp = await _httpsGet(path, t, 'text/csv');
    if (exp.status === 401) {
      return { ok: false, error: 'Google OAuth token rejected — re-authenticate via Settings → Connectors' };
    }
    if (exp.status === 403 || exp.status === 404) {
      return { ok: false, error: 'File not accessible — check the URL and that the OAuth account has access' };
    }
    if (exp.status !== 200) {
      return { ok: false, error: `Export failed: HTTP ${exp.status}` };
    }
    return { ok: true, title, content: _truncateCsv(exp.data) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchGoogleFile(fileId: string): Promise<GDriveResult> {
  // Generic Drive file (PDF, image, etc.). For now we return metadata + a note,
  // since binary content isn't useful as fetched-URL text.
  const t = await _resolveToken();
  if (typeof t !== 'string') return { ok: false, error: t.error };
  try {
    const meta = await _httpsGet(
      `/drive/v3/files/${fileId}?fields=name,mimeType,size,webViewLink`,
      t,
      'application/json',
    );
    if (meta.status === 200) {
      const parsed = JSON.parse(meta.data);
      return {
        ok: true,
        title: parsed.name || `Drive file ${fileId}`,
        content: `Drive file: ${parsed.name}\nMIME: ${parsed.mimeType}\nSize: ${parsed.size ?? 'unknown'} bytes\nLink: ${parsed.webViewLink ?? 'n/a'}\n\n[Binary file — content not fetched]`,
      };
    }
    return { ok: false, error: `Metadata fetch failed: HTTP ${meta.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Dispatch to the right fetcher based on a `matchUrl` result.
 * Returns `null` if the URL isn't a Drive URL.
 */
export async function fetchByUrl(url: string): Promise<GDriveResult | null> {
  const m = matchUrl(url);
  if (!m) return null;
  if (m.type === 'doc') return fetchGoogleDoc(m.fileId);
  if (m.type === 'sheet') return fetchGoogleSheet(m.fileId, m.gid);
  return fetchGoogleFile(m.fileId);
}
