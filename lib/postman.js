"use strict";

/**
 * postman.js — Postman connector for MI Dev Agent
 *
 * Authenticates via API Key, fetches and flattens Postman collections.
 * Also detects Postman collection JSON in Jira attachments (zero-auth path).
 */

const https = require("https");

const CONNECTOR_BUDGET = 15 * 1024; // 15 KB per item

// ── URL pattern matching ────────────────────────────────────────

const POSTMAN_PATTERNS = [
  /(?:app\.)?(?:get)?postman\.com\/collections\/([a-zA-Z0-9-]+)/,
  /(?:app\.)?(?:get)?postman\.com\/.*\/workspace\/[^/]+\/collection\/([a-zA-Z0-9-]+)/,
];

/**
 * Match a URL to a Postman collection.
 * @returns {{ collectionId: string }} | null
 */
function matchUrl(url) {
  for (const re of POSTMAN_PATTERNS) {
    const m = url.match(re);
    if (m) return { collectionId: m[1] };
  }
  return null;
}

// ── HTTPS helper ────────────────────────────────────────────────

function _postmanGet(path) {
  const apiKey = process.env.POSTMAN_API_KEY;
  if (!apiKey) return Promise.reject(new Error("POSTMAN_API_KEY not set"));
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.getpostman.com",
      port: 443,
      path,
      method: "GET",
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
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
    req.on("timeout", () => { req.destroy(); reject(new Error("Postman API request timed out")); });
    req.end();
  });
}

// ── Collection flattening ───────────────────────────────────────

/**
 * Resolve Postman variables in a string.
 */
function _resolveVars(str, variables) {
  if (!str || typeof str !== "string") return str || "";
  return str.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const v = variables.find((vr) => vr.key === key);
    return v ? (v.value || v.key) : match;
  });
}

/**
 * Extract body schema (keys + types) from request body.
 */
function _extractBodySchema(body) {
  if (!body || !body.raw) return "";
  try {
    const parsed = JSON.parse(body.raw);
    const keys = Object.entries(parsed).map(([k, v]) => `${k}: ${typeof v}`);
    if (keys.length === 0) return "";
    return `  Body: { ${keys.join(", ")} }`;
  } catch {
    return "";
  }
}

/**
 * Build URL path from Postman request URL object.
 */
function _buildPath(urlObj, variables) {
  if (!urlObj) return "/";
  if (typeof urlObj === "string") return _resolveVars(urlObj, variables);
  if (urlObj.raw) return _resolveVars(urlObj.raw, variables);
  const host = Array.isArray(urlObj.host) ? urlObj.host.join(".") : (urlObj.host || "");
  const path = Array.isArray(urlObj.path) ? "/" + urlObj.path.join("/") : "";
  return _resolveVars(host + path, variables);
}

/**
 * Recursively flatten collection items into endpoint list.
 */
function _flattenItems(items, variables, folder, result) {
  if (!items) return;
  for (const item of items) {
    if (item.item) {
      // It's a folder
      _flattenItems(item.item, variables, item.name || folder, result);
    } else if (item.request) {
      const method = (typeof item.request === "string") ? "GET" : (item.request.method || "GET");
      const path = (typeof item.request === "string") ? item.request : _buildPath(item.request.url, variables);
      const desc = item.request.description
        ? (typeof item.request.description === "string" ? item.request.description : item.request.description.content || "")
        : "";
      const bodySchema = (typeof item.request !== "string") ? _extractBodySchema(item.request.body) : "";
      result.push({ folder, method, path, name: item.name || "", desc: desc.slice(0, 200), bodySchema });
    }
  }
}

/**
 * Flatten a Postman collection into a structured endpoint summary.
 * @param {object} collection - Postman collection object (the `collection` field from API, or top-level if from attachment)
 * @returns {string} - Flattened summary within connector budget
 */
function flattenCollection(collection) {
  // Handle both API response shape and raw export shape
  const col = collection.collection || collection;
  const info = col.info || {};
  const variables = col.variable || [];
  const items = col.item || [];

  const result = [];
  _flattenItems(items, variables, "", result);

  let content = `# ${info.name || "Postman Collection"}\n`;
  if (info.description) {
    const desc = typeof info.description === "string" ? info.description : (info.description.content || "");
    content += `\n${desc.slice(0, 500)}\n`;
  }
  content += `\n**${result.length} endpoints**\n\n`;

  // Group by folder
  const grouped = {};
  for (const ep of result) {
    const key = ep.folder || "(root)";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(ep);
  }

  for (const [folder, endpoints] of Object.entries(grouped)) {
    content += `## ${folder}\n\n`;
    for (const ep of endpoints) {
      content += `- **${ep.method}** ${ep.path}`;
      if (ep.name) content += ` — ${ep.name}`;
      if (ep.desc) content += `\n  ${ep.desc}`;
      if (ep.bodySchema) content += `\n${ep.bodySchema}`;
      content += "\n";
    }
    content += "\n";
  }

  // Truncate if needed — first try dropping body schemas
  if (content.length > CONNECTOR_BUDGET) {
    content = `# ${info.name || "Postman Collection"}\n\n**${result.length} endpoints**\n\n`;
    for (const [folder, endpoints] of Object.entries(grouped)) {
      content += `## ${folder}\n\n`;
      for (const ep of endpoints) {
        content += `- **${ep.method}** ${ep.path}`;
        if (ep.name) content += ` — ${ep.name}`;
        content += "\n";
      }
      content += "\n";
    }
  }

  if (content.length > CONNECTOR_BUDGET) {
    content = content.slice(0, CONNECTOR_BUDGET) + "\n\n[Content truncated]";
  }

  return content;
}

/**
 * Fetch a Postman collection by ID via the API.
 * @returns {{ ok: boolean, title?: string, content?: string, error?: string }}
 */
async function fetchCollection(collectionId) {
  try {
    const resp = await _postmanGet(`/collections/${collectionId}`);
    if (resp.status === 401) {
      return { ok: false, error: "Postman API key invalid — generate a new key at postman.co/settings" };
    }
    if (resp.status === 404) {
      return { ok: false, error: "Collection not found — verify the URL and API key permissions" };
    }
    if (resp.status !== 200) {
      return { ok: false, error: `Postman API error: HTTP ${resp.status}` };
    }
    const col = resp.data;
    const title = (col.collection && col.collection.info && col.collection.info.name) || `Postman Collection ${collectionId}`;
    const content = flattenCollection(col);
    return { ok: true, title, content };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Detect if a JSON string/object is a Postman collection.
 * @param {string|object} jsonContent
 * @returns {boolean}
 */
function detectPostmanAttachment(jsonContent) {
  try {
    const obj = typeof jsonContent === "string" ? JSON.parse(jsonContent) : jsonContent;
    if (!obj || typeof obj !== "object") return false;
    const info = obj.info || (obj.collection && obj.collection.info);
    if (!info) return false;
    if (info._postman_id) return true;
    if (typeof info.schema === "string" && info.schema.includes("collection")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Test connection — validate API key by calling /me.
 * @returns {{ ok: boolean, message?: string, error?: string }}
 */
async function testConnection() {
  try {
    const resp = await _postmanGet("/me");
    if (resp.status === 200 && resp.data.user) {
      return { ok: true, message: `Postman connected — user: ${resp.data.user.username || resp.data.user.email || "OK"}` };
    }
    if (resp.status === 401) {
      return { ok: false, error: "Postman API key invalid — check your key at postman.co/settings" };
    }
    return { ok: false, error: `Unexpected response: HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { matchUrl, fetchCollection, flattenCollection, detectPostmanAttachment, testConnection };
