// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Figma fetch (OAuth + PAT)
//
// Uses the OAuth access token from `getAccessToken('figma')` when
// available, falls back to a Personal Access Token from FIGMA_TOKEN.
// Cross-workspace Figma files frequently reject OAuth tokens (the
// grant doesn't cover the workspace) but accept PATs — so when both
// are present we try OAuth first and retry with PAT on 401/403.
//
// Ported from packages/agent/src/lib/figma.ts. Vision-export support
// is intentionally omitted here; the fetch loop only needs the file
// structure + text content.
// ═══════════════════════════════════════════════════════════════

import https from 'https';

import type { FigmaResult, FigmaUrlMatch } from '@mi/shared';

import { getAccessToken } from '../oauth/token-manager';

const CONNECTOR_BUDGET = 15 * 1024; // 15 KB per item
const MAX_DEPTH = 4;
const MAX_NODES = 500;

// ── URL pattern matching ────────────────────────────────────────

const FIGMA_PATTERNS: RegExp[] = [
  /figma\.com\/design\/([a-zA-Z0-9]+)/,
  /figma\.com\/file\/([a-zA-Z0-9]+)/,
  /figma\.com\/proto\/([a-zA-Z0-9]+)/,
];

export function matchUrl(url: string): FigmaUrlMatch | null {
  for (const re of FIGMA_PATTERNS) {
    const m = url.match(re);
    if (m) {
      const result: FigmaUrlMatch = { fileKey: m[1] };
      const nodeMatch = url.match(/[?&]node-id=([^&]+)/);
      if (nodeMatch) result.nodeId = decodeURIComponent(nodeMatch[1]);
      return result;
    }
  }
  return null;
}

// ── HTTPS helpers ───────────────────────────────────────────────

interface HttpResponse {
  status: number | undefined;
  data: unknown;
}

type AuthMode = 'oauth' | 'pat';

function _httpsGet(urlPath: string, token: string, mode: AuthMode): Promise<HttpResponse> {
  const authHeaders: Record<string, string> = mode === 'oauth'
    ? { Authorization: `Bearer ${token}` }
    : { 'X-Figma-Token': token };
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.figma.com',
        port: 443,
        path: urlPath,
        method: 'GET',
        headers: { ...authHeaders, Accept: 'application/json' },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
          catch { resolve({ status: res.statusCode, data: text }); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Figma API request timed out'));
    });
    req.end();
  });
}

interface FigmaCreds {
  oauth: string | null;
  pat: string | null;
}

async function _resolveCreds(): Promise<FigmaCreds> {
  const oauth = await getAccessToken('figma');
  const pat = process.env.FIGMA_TOKEN || null;
  return { oauth, pat };
}

/**
 * Authenticated GET. Tries OAuth first when available; on 401/403 retries
 * with PAT if one is configured — Figma OAuth tokens often can't reach
 * files outside the workspaces the grant covers, while PATs inherit full
 * account access.
 */
async function _figmaGet(urlPath: string, creds: FigmaCreds): Promise<HttpResponse> {
  if (!creds.oauth && !creds.pat) {
    throw new Error('Figma not connected — connect via Settings → Connectors, or set FIGMA_TOKEN');
  }
  if (creds.oauth) {
    const resp = await _httpsGet(urlPath, creds.oauth, 'oauth');
    if ((resp.status === 401 || resp.status === 403) && creds.pat) {
      return _httpsGet(urlPath, creds.pat, 'pat');
    }
    return resp;
  }
  return _httpsGet(urlPath, creds.pat!, 'pat');
}

// ── Node tree traversal ─────────────────────────────────────────

interface TraversalResult {
  pages: string[];
  frames: string[];
  components: string[];
  texts: Array<{ name: string; value: string; frame: string }>;
  nodeCount: number;
  currentFrame: string;
}

interface FigmaNodeLike {
  type?: string;
  name?: string;
  characters?: string;
  children?: FigmaNodeLike[];
  id?: string;
}

function _traverse(node: FigmaNodeLike, depth: number, result: TraversalResult): void {
  if (depth > MAX_DEPTH || result.nodeCount >= MAX_NODES) return;
  result.nodeCount++;

  if (node.type === 'TEXT' && node.characters) {
    result.texts.push({ name: node.name || '', value: node.characters, frame: result.currentFrame });
  }

  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    if (depth <= 2 && node.name) result.frames.push(node.name);
    if ((node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.name) {
      result.components.push(node.name);
    }
    const prevFrame = result.currentFrame;
    result.currentFrame = node.name || '';
    if (node.children) {
      for (const child of node.children) _traverse(child, depth + 1, result);
    }
    result.currentFrame = prevFrame;
    return;
  }

  if (node.type === 'CANVAS' && node.name) {
    result.pages.push(node.name);
  }

  if (node.children) {
    for (const child of node.children) _traverse(child, depth + 1, result);
  }
}

function _renderContent(title: string, result: TraversalResult, truncated: boolean): string {
  let content = `# ${title}\n\n`;
  if (result.pages.length > 0) {
    content += `## Pages\n${result.pages.map((p) => `- ${p}`).join('\n')}\n\n`;
  }
  if (result.frames.length > 0) {
    content += `## Frames\n${result.frames.map((f) => `- ${f}`).join('\n')}\n\n`;
  }
  if (result.components.length > 0) {
    content += `## Components\n${result.components.map((c) => `- ${c}`).join('\n')}\n\n`;
  }
  if (result.texts.length > 0) {
    const grouped: Record<string, Array<{ name: string; value: string }>> = {};
    for (const t of result.texts) {
      const key = t.frame || '(root)';
      (grouped[key] ||= []).push(t);
    }
    content += '## Text Content\n';
    for (const [frame, texts] of Object.entries(grouped)) {
      content += `\n### ${frame}\n`;
      for (const t of texts) content += `- **${t.name}**: ${t.value}\n`;
    }
    content += '\n';
  }
  if (truncated) {
    content += `\n[Tree truncated at depth ${MAX_DEPTH} -- ${result.nodeCount} nodes processed]\n`;
  }
  if (content.length > CONNECTOR_BUDGET) {
    const cutoff = content.lastIndexOf('\n', CONNECTOR_BUDGET);
    content = content.slice(0, cutoff > 0 ? cutoff : CONNECTOR_BUDGET) +
      '\n\n[Content truncated -- original file continues]';
  }
  return content;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Fetch a Figma file (optionally a specific node) and extract structure +
 * text into markdown. Returns `ok: false` with a human-readable error on
 * auth failure, network failure, or empty document.
 */
export async function fetchFigmaFile(fileKey: string, nodeId?: string): Promise<FigmaResult> {
  let creds: FigmaCreds;
  try {
    creds = await _resolveCreds();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }

  try {
    const path = nodeId
      ? `/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`
      : `/v1/files/${fileKey}`;
    const resp = await _figmaGet(path, creds);

    if (resp.status === 401 || resp.status === 403) {
      const snippet = typeof resp.data === 'string'
        ? resp.data.slice(0, 200)
        : JSON.stringify(resp.data).slice(0, 200);
      const hint = creds.oauth
        ? "OAuth token rejected -- the file may live in a workspace the OAuth grant doesn't cover. Disconnect/reconnect Figma in Settings, or set FIGMA_TOKEN as a PAT fallback."
        : 'PAT rejected -- token expired, revoked, or lacks access to this file. Regenerate at figma.com/developers.';
      return { ok: false, error: `Figma ${resp.status}: ${hint} [${snippet}]` };
    }
    if (resp.status !== 200) {
      const snippet = typeof resp.data === 'string'
        ? resp.data.slice(0, 200)
        : JSON.stringify(resp.data).slice(0, 200);
      return { ok: false, error: `Figma API error: HTTP ${resp.status} ${snippet}`.trim() };
    }

    const fileData = resp.data as { name?: string; document?: FigmaNodeLike; nodes?: Record<string, { document?: FigmaNodeLike }> };
    const title = fileData.name || `Figma file ${fileKey}`;

    let rootNode: FigmaNodeLike | undefined;
    if (nodeId && fileData.nodes) {
      const first = Object.values(fileData.nodes)[0];
      rootNode = first?.document;
    } else {
      rootNode = fileData.document;
    }
    if (!rootNode) {
      return { ok: false, error: 'No document data in Figma response' };
    }

    const result: TraversalResult = {
      pages: [], frames: [], components: [], texts: [],
      nodeCount: 0, currentFrame: '',
    };
    _traverse(rootNode, 0, result);
    const truncated = result.nodeCount >= MAX_NODES;
    const content = _renderContent(title, result, truncated);

    const frameIds: string[] = [];
    if (rootNode.children) {
      for (const page of rootNode.children) {
        if (page.children) {
          for (const frame of page.children) {
            if (frame.type === 'FRAME' && frame.id) frameIds.push(frame.id);
          }
        }
      }
    }

    return { ok: true, title, content, fileKey, frameIds: frameIds.slice(0, 3) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/**
 * Dispatch to fetchFigmaFile based on a `matchUrl` result.
 * Returns `null` if the URL isn't a Figma URL.
 */
export async function fetchByUrl(url: string): Promise<FigmaResult | null> {
  const m = matchUrl(url);
  if (!m) return null;
  return fetchFigmaFile(m.fileKey, m.nodeId);
}
