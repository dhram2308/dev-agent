"use strict";

/**
 * figma.js — Figma connector for MI Dev Agent
 *
 * Authenticates via Personal Access Token (PAT), fetches file structure,
 * extracts text content and component names. Optional Vision path for
 * frame screenshot descriptions.
 */

const https = require("https");

const CONNECTOR_BUDGET = 15 * 1024; // 15 KB per item
const MAX_DEPTH = 4;
const MAX_NODES = 500;

// ── URL pattern matching ────────────────────────────────────────

const FIGMA_PATTERNS = [
  /figma\.com\/design\/([a-zA-Z0-9]+)/,
  /figma\.com\/file\/([a-zA-Z0-9]+)/,
  /figma\.com\/proto\/([a-zA-Z0-9]+)/,
];

/**
 * Match a URL to a Figma file.
 * @returns {{ fileKey: string, nodeId?: string }} | null
 */
function matchUrl(url) {
  for (const re of FIGMA_PATTERNS) {
    const m = url.match(re);
    if (m) {
      const result = { fileKey: m[1] };
      // Extract node-id from query params
      const nodeMatch = url.match(/[?&]node-id=([^&]+)/);
      if (nodeMatch) result.nodeId = decodeURIComponent(nodeMatch[1]);
      return result;
    }
  }
  return null;
}

// ── HTTPS helpers ───────────────────────────────────────────────

function _figmaGet(path) {
  const token = process.env.FIGMA_TOKEN;
  if (!token) return Promise.reject(new Error("FIGMA_TOKEN not set"));
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.figma.com",
      port: 443,
      path,
      method: "GET",
      headers: { "X-Figma-Token": token, Accept: "application/json" },
      timeout: 30000,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
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

// ── Node tree traversal ─────────────────────────────────────────

function _traverseNodes(node, depth, result) {
  if (depth > MAX_DEPTH || result.nodeCount >= MAX_NODES) return;
  result.nodeCount++;

  // Collect text content
  if (node.type === "TEXT" && node.characters) {
    result.texts.push({ name: node.name, value: node.characters, frame: result.currentFrame });
  }

  // Track frames and components
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

  // Pages
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
 * @returns {{ ok: boolean, title?: string, content?: string, fileKey?: string, frameIds?: string[], error?: string }}
 */
async function fetchFigmaFile(fileKey, nodeId) {
  try {
    let resp;
    if (nodeId) {
      resp = await _figmaGet(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`);
    } else {
      resp = await _figmaGet(`/v1/files/${fileKey}`);
    }

    if (resp.status === 403) {
      return { ok: false, error: "Figma token expired or invalid — generate a new PAT at figma.com/developers" };
    }
    if (resp.status !== 200) {
      return { ok: false, error: `Figma API error: HTTP ${resp.status}` };
    }

    const fileData = resp.data;
    const title = fileData.name || `Figma file ${fileKey}`;

    // For node-specific requests, the structure is different
    let rootNode;
    if (nodeId && fileData.nodes) {
      const nodeData = Object.values(fileData.nodes)[0];
      rootNode = nodeData ? nodeData.document : null;
    } else {
      rootNode = fileData.document;
    }

    if (!rootNode) {
      return { ok: false, error: "No document data in Figma response" };
    }

    const result = { pages: [], frames: [], components: [], texts: [], nodeCount: 0, currentFrame: "" };
    _traverseNodes(rootNode, 0, result);

    // Build summary
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
      // Group texts by frame
      const grouped = {};
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

    // Truncate to budget
    if (content.length > CONNECTOR_BUDGET) {
      const cutoff = content.lastIndexOf("\n", CONNECTOR_BUDGET);
      content = content.slice(0, cutoff > 0 ? cutoff : CONNECTOR_BUDGET) + "\n\n[Content truncated — original file continues]";
    }

    // Collect top-level frame node IDs for optional vision export
    const frameIds = [];
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
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Export frame images and describe them with Anthropic Vision.
 * @param {string} fileKey
 * @param {string[]} frameIds - up to 3 frame IDs
 * @param {Function} callAnthropicVision - from lib/jira.js
 * @returns {string} - vision descriptions to append to content
 */
async function describeFramesWithVision(fileKey, frameIds, callAnthropicVision) {
  if (!frameIds || frameIds.length === 0) return "";
  const descriptions = [];
  try {
    // Get image URLs from Figma
    const ids = frameIds.slice(0, 3).join(",");
    const imgResp = await _figmaGet(`/v1/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=png&scale=2`);
    if (imgResp.status !== 200 || !imgResp.data.images) return "";

    for (const [nodeId, imageUrl] of Object.entries(imgResp.data.images)) {
      if (!imageUrl) continue;
      try {
        // Download the PNG
        const imgData = await new Promise((resolve, reject) => {
          https.get(imageUrl, { timeout: 15000 }, (res) => {
            const chunks = [];
            res.on("data", (c) => { chunks.push(c); });
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
 * Test connection — validate PAT by calling /v1/me.
 * @returns {{ ok: boolean, message?: string, error?: string }}
 */
async function testConnection() {
  try {
    const resp = await _figmaGet("/v1/me");
    if (resp.status === 200 && resp.data.handle) {
      return { ok: true, message: `Figma connected — user: ${resp.data.handle}` };
    }
    if (resp.status === 403) {
      return { ok: false, error: "Figma authentication failed — check your Personal Access Token" };
    }
    return { ok: false, error: `Unexpected response: HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { matchUrl, fetchFigmaFile, describeFramesWithVision, testConnection };
