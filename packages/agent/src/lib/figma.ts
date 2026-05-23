/**
 * figma.ts — Figma connector for MI Dev Agent
 *
 * Converted from lib/figma.js (zero functional changes).
 *
 * Authenticates via Personal Access Token (PAT), fetches file structure,
 * extracts text content and component names. Optional Vision path for
 * frame screenshot descriptions.
 */

import https from "https";

import type { FigmaResult, FigmaUrlMatch, ConnectorTestResult } from "@mi/shared";

const CONNECTOR_BUDGET = 15 * 1024; // 15 KB per item
const MAX_DEPTH = 4;
const MAX_NODES = 500;

// ── URL pattern matching ────────────────────────────────────────

const FIGMA_PATTERNS: RegExp[] = [
  /figma\.com\/design\/([a-zA-Z0-9]+)/,
  /figma\.com\/file\/([a-zA-Z0-9]+)/,
  /figma\.com\/proto\/([a-zA-Z0-9]+)/,
];

/**
 * Match a URL to a Figma file.
 */
function matchUrl(url: string): FigmaUrlMatch | null {
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
  data: any;
}

type FigmaAuthMode = 'oauth' | 'pat';

function _figmaGetWithMode(urlPath: string, mode: FigmaAuthMode): Promise<HttpResponse> {
  const token = mode === 'oauth' ? process.env.FIGMA_OAUTH_ACCESS_TOKEN : process.env.FIGMA_TOKEN;
  if (!token) return Promise.reject(new Error(`Figma ${mode === 'oauth' ? 'FIGMA_OAUTH_ACCESS_TOKEN' : 'FIGMA_TOKEN'} not set`));
  const authHeaders: Record<string, string> = mode === 'oauth'
    ? { Authorization: `Bearer ${token}` }
    : { "X-Figma-Token": token };
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.figma.com",
      port: 443,
      path: urlPath,
      method: "GET",
      headers: { ...authHeaders, Accept: "application/json" },
      timeout: 30000,
    };
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => { chunks.push(c); });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Figma API request timed out")); });
    req.end();
  });
}

/**
 * Authenticated Figma GET. When both OAuth and PAT credentials are present,
 * tries OAuth first (cheap, refreshable, no per-token rotation), falls back
 * to PAT on 401/403 — Figma's OAuth tokens often can't reach files outside
 * the workspaces the OAuth grant explicitly covers, while PATs inherit the
 * full account access. Without this fallback, an OAuth-only setup fails
 * silently for cross-workspace files even though the user has access in
 * the Figma UI.
 */
function _figmaGet(urlPath: string): Promise<HttpResponse> {
  const hasOAuth = !!process.env.FIGMA_OAUTH_ACCESS_TOKEN;
  const hasPat = !!process.env.FIGMA_TOKEN;
  if (!hasOAuth && !hasPat) {
    return Promise.reject(new Error("FIGMA_TOKEN or FIGMA_OAUTH_ACCESS_TOKEN not set"));
  }
  const primary: FigmaAuthMode = hasOAuth ? 'oauth' : 'pat';
  return _figmaGetWithMode(urlPath, primary).then((resp) => {
    if ((resp.status === 401 || resp.status === 403) && primary === 'oauth' && hasPat) {
      // OAuth was rejected — common for cross-workspace files. Retry with PAT.
      return _figmaGetWithMode(urlPath, 'pat');
    }
    return resp;
  });
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

function _traverseNodes(node: any, depth: number, result: TraversalResult): void {
  if (depth > MAX_DEPTH || result.nodeCount >= MAX_NODES) return;
  result.nodeCount++;

  if (node.type === "TEXT" && node.characters) {
    result.texts.push({ name: node.name, value: node.characters, frame: result.currentFrame });
  }

  if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    if (depth <= 2) result.frames.push(node.name);
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      result.components.push(node.name);
    }
    const prevFrame = result.currentFrame;
    result.currentFrame = node.name;
    if (node.children) {
      for (const child of node.children) {
        _traverseNodes(child, depth + 1, result);
      }
    }
    result.currentFrame = prevFrame;
    return;
  }

  if (node.type === "CANVAS") {
    result.pages.push(node.name);
  }

  if (node.children) {
    for (const child of node.children) {
      _traverseNodes(child, depth + 1, result);
    }
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Fetch a Figma file and extract structure + text content.
 */
async function fetchFigmaFile(fileKey: string, nodeId?: string): Promise<FigmaResult> {
  try {
    const oauthMode = !!process.env.FIGMA_OAUTH_ACCESS_TOKEN;
    let resp: HttpResponse;
    if (nodeId) {
      resp = await _figmaGet(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`);
    } else {
      resp = await _figmaGet(`/v1/files/${fileKey}`);
    }

    if (resp.status === 403 || resp.status === 401) {
      const bodySnippet = typeof resp.data === 'string'
        ? resp.data.slice(0, 200)
        : JSON.stringify(resp.data).slice(0, 200);
      const hint = oauthMode
        ? `OAuth token rejected for file ${fileKey} — likely the file lives in a workspace your OAuth grant doesn't cover, or the app's registered scopes don't include file_content:read. Try: (1) open the file in Figma and ensure your OAuth user has access, (2) disconnect/reconnect Figma in Settings to re-grant scopes, (3) fall back to a PAT by setting FIGMA_TOKEN in .env.`
        : `PAT rejected — token expired, revoked, or lacks access to ${fileKey}. Generate a new one at figma.com/developers.`;
      return { ok: false, error: `Figma ${resp.status} (${oauthMode ? 'OAuth' : 'PAT'}): ${hint} [${bodySnippet}]` };
    }
    if (resp.status !== 200) {
      const bodySnippet = typeof resp.data === 'string'
        ? resp.data.slice(0, 200)
        : JSON.stringify(resp.data).slice(0, 200);
      return { ok: false, error: `Figma API error: HTTP ${resp.status} ${bodySnippet}`.trim() };
    }

    const fileData = resp.data;
    const title = fileData.name || `Figma file ${fileKey}`;

    let rootNode: any;
    if (nodeId && fileData.nodes) {
      const nodeData = Object.values(fileData.nodes)[0] as any;
      rootNode = nodeData ? nodeData.document : null;
    } else {
      rootNode = fileData.document;
    }

    if (!rootNode) {
      return { ok: false, error: "No document data in Figma response" };
    }

    const result: TraversalResult = { pages: [], frames: [], components: [], texts: [], nodeCount: 0, currentFrame: "" };
    _traverseNodes(rootNode, 0, result);

    const truncated = result.nodeCount >= MAX_NODES;
    let content = `# ${title}\n\n`;
    if (result.pages.length > 0) {
      content += `## Pages\n${result.pages.map((p) => `- ${p}`).join("\n")}\n\n`;
    }
    if (result.frames.length > 0) {
      content += `## Frames\n${result.frames.map((f) => `- ${f}`).join("\n")}\n\n`;
    }
    if (result.components.length > 0) {
      content += `## Components\n${result.components.map((c) => `- ${c}`).join("\n")}\n\n`;
    }
    if (result.texts.length > 0) {
      const grouped: Record<string, Array<{ name: string; value: string }>> = {};
      for (const t of result.texts) {
        const key = t.frame || "(root)";
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(t);
      }
      content += "## Text Content\n";
      for (const [frame, texts] of Object.entries(grouped)) {
        content += `\n### ${frame}\n`;
        for (const t of texts) {
          content += `- **${t.name}**: ${t.value}\n`;
        }
      }
      content += "\n";
    }
    if (truncated) {
      content += `\n[Tree truncated at depth ${MAX_DEPTH} — ${result.nodeCount} nodes processed, additional nodes omitted]\n`;
    }

    if (content.length > CONNECTOR_BUDGET) {
      const cutoff = content.lastIndexOf("\n", CONNECTOR_BUDGET);
      content = content.slice(0, cutoff > 0 ? cutoff : CONNECTOR_BUDGET) + "\n\n[Content truncated — original file continues]";
    }

    const frameIds: string[] = [];
    if (rootNode.children) {
      for (const page of rootNode.children) {
        if (page.children) {
          for (const frame of page.children) {
            if (frame.type === "FRAME" && frame.id) {
              frameIds.push(frame.id);
            }
          }
        }
      }
    }

    return { ok: true, title, content, fileKey, frameIds: frameIds.slice(0, 3) };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Export frame images and describe them with Anthropic Vision.
 */
async function describeFramesWithVision(
  fileKey: string,
  frameIds: string[] | undefined,
  callAnthropicVision: (base64: string, mimeType: string, description: string) => Promise<string>
): Promise<string> {
  if (!frameIds || frameIds.length === 0) return "";
  const descriptions: string[] = [];
  try {
    const ids = frameIds.slice(0, 3).join(",");
    const imgResp = await _figmaGet(`/v1/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=png&scale=2`);
    if (imgResp.status !== 200 || !imgResp.data.images) return "";

    for (const [nodeId, imageUrl] of Object.entries(imgResp.data.images)) {
      if (!imageUrl) continue;
      try {
        const imgData: Buffer = await new Promise((resolve, reject) => {
          https.get(imageUrl as string, { timeout: 15000 }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => { chunks.push(c); });
            res.on("end", () => resolve(Buffer.concat(chunks)));
          }).on("error", reject);
        });
        const base64 = imgData.toString("base64");
        const desc = await callAnthropicVision(base64, "image/png", `Figma frame ${nodeId}`);
        if (desc) descriptions.push(`### Frame ${nodeId}\n${desc}`);
      } catch {
        // Skip individual frame failures
      }
    }
  } catch {
    // Vision export failed entirely — not critical
  }
  return descriptions.length > 0 ? "\n## Visual Descriptions\n\n" + descriptions.join("\n\n") + "\n" : "";
}

/**
 * Test connection — call /v1/me which works for both PAT and OAuth (with
 * `current_user:read` scope). Distinguishes auth modes in the error so a
 * user looking at the message knows which credential to fix.
 */
async function testConnection(): Promise<ConnectorTestResult> {
  const oauthMode = !!process.env.FIGMA_OAUTH_ACCESS_TOKEN;
  const modeTag = oauthMode ? "OAuth" : "PAT";
  try {
    const resp = await _figmaGet("/v1/me");
    if (resp.status === 200 && resp.data.handle) {
      return { ok: true, message: `Figma connected — user: ${resp.data.handle} (${modeTag})` };
    }
    const bodySnippet = typeof resp.data === "string"
      ? resp.data.slice(0, 200)
      : JSON.stringify(resp.data).slice(0, 200);
    if (resp.status === 403) {
      const hint = oauthMode
        ? "OAuth token rejected — likely missing `current_user:read` scope or token revoked. Disconnect and reconnect Figma in Settings."
        : "Personal Access Token rejected — token expired, revoked, or invalid.";
      return { ok: false, error: `Figma 403 (${modeTag}): ${hint} ${bodySnippet ? `[${bodySnippet}]` : ""}`.trim() };
    }
    if (resp.status === 401) {
      return { ok: false, error: `Figma 401 (${modeTag}): credentials missing or malformed. ${bodySnippet}`.trim() };
    }
    return { ok: false, error: `Unexpected response: HTTP ${resp.status} (${modeTag}) ${bodySnippet}`.trim() };
  } catch (e: any) {
    return { ok: false, error: `${e.message} (${modeTag})` };
  }
}

export { matchUrl, fetchFigmaFile, describeFramesWithVision, testConnection };
