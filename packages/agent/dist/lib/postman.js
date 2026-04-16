"use strict";
/**
 * postman.ts — Postman connector for MI Dev Agent
 *
 * Converted from lib/postman.js (zero functional changes).
 *
 * Authenticates via API Key, fetches and flattens Postman collections.
 * Also detects Postman collection JSON in Jira attachments (zero-auth path).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchUrl = matchUrl;
exports.fetchCollection = fetchCollection;
exports.flattenCollection = flattenCollection;
exports.detectPostmanAttachment = detectPostmanAttachment;
exports.testConnection = testConnection;
const https_1 = __importDefault(require("https"));
const CONNECTOR_BUDGET = 15 * 1024; // 15 KB per item
// ── URL pattern matching ────────────────────────────────────────
const POSTMAN_PATTERNS = [
    /(?:app\.)?(?:get)?postman\.com\/collections\/([a-zA-Z0-9-]+)/,
    /(?:app\.)?(?:get)?postman\.com\/.*\/workspace\/[^/]+\/collection\/([a-zA-Z0-9-]+)/,
];
/**
 * Match a URL to a Postman collection.
 */
function matchUrl(url) {
    for (const re of POSTMAN_PATTERNS) {
        const m = url.match(re);
        if (m)
            return { collectionId: m[1] };
    }
    return null;
}
function _postmanGet(urlPath) {
    const apiKey = process.env.POSTMAN_API_KEY;
    if (!apiKey)
        return Promise.reject(new Error("POSTMAN_API_KEY not set"));
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: "api.getpostman.com",
            port: 443,
            path: urlPath,
            method: "GET",
            headers: { "X-API-Key": apiKey, Accept: "application/json" },
            timeout: 30000,
        };
        const req = https_1.default.request(opts, (res) => {
            const chunks = [];
            res.on("data", (c) => { chunks.push(c); });
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(text) });
                }
                catch {
                    resolve({ status: res.statusCode, data: text });
                }
            });
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("Postman API request timed out")); });
        req.end();
    });
}
/**
 * Resolve Postman variables in a string.
 */
function _resolveVars(str, variables) {
    if (!str || typeof str !== "string")
        return str || "";
    return str.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
        const v = variables.find((vr) => vr.key === key);
        return v ? (v.value || v.key) : match;
    });
}
/**
 * Extract body schema (keys + types) from request body.
 */
function _extractBodySchema(body) {
    if (!body || !body.raw)
        return "";
    try {
        const parsed = JSON.parse(body.raw);
        const keys = Object.entries(parsed).map(([k, v]) => `${k}: ${typeof v}`);
        if (keys.length === 0)
            return "";
        return `  Body: { ${keys.join(", ")} }`;
    }
    catch {
        return "";
    }
}
/**
 * Build URL path from Postman request URL object.
 */
function _buildPath(urlObj, variables) {
    if (!urlObj)
        return "/";
    if (typeof urlObj === "string")
        return _resolveVars(urlObj, variables);
    if (urlObj.raw)
        return _resolveVars(urlObj.raw, variables);
    const host = Array.isArray(urlObj.host) ? urlObj.host.join(".") : (urlObj.host || "");
    const urlPath = Array.isArray(urlObj.path) ? "/" + urlObj.path.join("/") : "";
    return _resolveVars(host + urlPath, variables);
}
/**
 * Recursively flatten collection items into endpoint list.
 */
function _flattenItems(items, variables, folder, result) {
    if (!items)
        return;
    for (const item of items) {
        if (item.item) {
            _flattenItems(item.item, variables, item.name || folder, result);
        }
        else if (item.request) {
            const method = (typeof item.request === "string") ? "GET" : (item.request.method || "GET");
            const reqPath = (typeof item.request === "string") ? item.request : _buildPath(item.request.url, variables);
            const desc = item.request.description
                ? (typeof item.request.description === "string" ? item.request.description : item.request.description.content || "")
                : "";
            const bodySchema = (typeof item.request !== "string") ? _extractBodySchema(item.request.body) : "";
            result.push({ folder, method, path: reqPath, name: item.name || "", desc: desc.slice(0, 200), bodySchema });
        }
    }
}
/**
 * Flatten a Postman collection into a structured endpoint summary.
 */
function flattenCollection(collection) {
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
    const grouped = {};
    for (const ep of result) {
        const key = ep.folder || "(root)";
        if (!grouped[key])
            grouped[key] = [];
        grouped[key].push(ep);
    }
    for (const [folder, endpoints] of Object.entries(grouped)) {
        content += `## ${folder}\n\n`;
        for (const ep of endpoints) {
            content += `- **${ep.method}** ${ep.path}`;
            if (ep.name)
                content += ` — ${ep.name}`;
            if (ep.desc)
                content += `\n  ${ep.desc}`;
            if (ep.bodySchema)
                content += `\n${ep.bodySchema}`;
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
                if (ep.name)
                    content += ` — ${ep.name}`;
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
 * Resolve a bare collection ID to the full UID (userId-collectionId) format
 * that the Postman API requires. If the ID already contains a dash prefix
 * (indicating it's already a UID), return as-is.
 */
async function _resolveCollectionUid(collectionId) {
    // If the ID is already in UID format (userId-collectionId, 8+ digit prefix),
    // or contains multiple dash-separated segments longer than UUID, use as-is.
    // Postman UIDs look like: 12345678-abcdef12-3456-7890-abcd-ef1234567890
    const parts = collectionId.split("-");
    if (parts.length > 5)
        return collectionId; // already a UID
    // Fetch the user ID from /me and prepend it.
    try {
        const meResp = await _postmanGet("/me");
        if (meResp.status === 200 && meResp.data?.user?.id) {
            return `${meResp.data.user.id}-${collectionId}`;
        }
    }
    catch {
        // Fall through — try with the bare ID.
    }
    return collectionId;
}
/**
 * Parse Postman error responses into actionable messages.
 */
function _postmanErrorMessage(status, data) {
    if (status === 401) {
        return "Postman API key invalid — generate a new key at postman.co/settings";
    }
    if (status === 403) {
        return "Postman API key rejected (403 Forbidden). Possible causes: "
            + "(1) key was auto-revoked by Postman security scanner, "
            + "(2) Enterprise admin set a key expiry policy, "
            + "(3) monthly API call quota exhausted. "
            + "Check your key at postman.co → Profile → Settings → API Keys";
    }
    if (status === 404) {
        return "Collection not found — verify the URL and API key permissions";
    }
    if (status === 429) {
        return "Postman API rate limit hit (300 req/min or monthly quota). Try again later";
    }
    const serverMsg = data?.error?.message || data?.error?.name || "";
    return `Postman API error: HTTP ${status}${serverMsg ? ` — ${serverMsg}` : ""}`;
}
/**
 * Fetch a Postman collection by ID via the API.
 * Automatically resolves bare collection IDs to full UIDs.
 */
async function fetchCollection(collectionId) {
    try {
        // First attempt with the ID as provided.
        let resp = await _postmanGet(`/collections/${collectionId}`);
        // If 400, the ID might be a bare UUID — resolve to full UID and retry.
        if (resp.status === 400) {
            const uid = await _resolveCollectionUid(collectionId);
            if (uid !== collectionId) {
                resp = await _postmanGet(`/collections/${uid}`);
            }
        }
        if (resp.status !== 200) {
            return { ok: false, error: _postmanErrorMessage(resp.status, resp.data) };
        }
        const col = resp.data;
        const title = (col.collection && col.collection.info && col.collection.info.name) || `Postman Collection ${collectionId}`;
        const content = flattenCollection(col);
        return { ok: true, title, content };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
/**
 * Detect if a JSON string/object is a Postman collection.
 */
function detectPostmanAttachment(jsonContent) {
    try {
        const obj = typeof jsonContent === "string" ? JSON.parse(jsonContent) : jsonContent;
        if (!obj || typeof obj !== "object")
            return false;
        const info = obj.info || (obj.collection && obj.collection.info);
        if (!info)
            return false;
        if (info._postman_id)
            return true;
        if (typeof info.schema === "string" && info.schema.includes("collection"))
            return true;
        return false;
    }
    catch {
        return false;
    }
}
/**
 * Test connection — validate API key by calling /me.
 */
async function testConnection() {
    try {
        const resp = await _postmanGet("/me");
        if (resp.status === 200 && resp.data?.user) {
            return { ok: true, message: `Postman connected — user: ${resp.data.user.username || resp.data.user.email || "OK"}` };
        }
        return { ok: false, error: _postmanErrorMessage(resp.status, resp.data) };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
//# sourceMappingURL=postman.js.map