"use strict";

/**
 * SSE (Server-Sent Events) — Robust implementation
 *
 * Features:
 *   1. Keepalive comments every 25s (below common 30s proxy timeout)
 *   2. LRU eviction (track lastActivity per client, evict least-recently-active)
 *   3. Backpressure: if res.write() returns false, pause queue, resume on 'drain'
 *   4. Auth: token via query param ?token=xxx validated before connection
 *   5. Connection limits: max 5 per session token, max 20 total
 *   6. Reconnection: retry:3000 so clients reconnect in 3s
 *   7. Message IDs: monotonic id: field per message
 *   8. Replay: buffer last 100 messages, replay on reconnect via Last-Event-ID
 */

// ── Constants ────────────────────────────────────────────────────

const KEEPALIVE_INTERVAL_MS = 25_000;       // 25s — under common 30s proxy timeout
const MAX_CLIENTS_TOTAL = 20;               // Hard cap on total SSE connections
const MAX_CLIENTS_PER_SESSION = 5;          // Per auth-token session cap
const REPLAY_BUFFER_SIZE = 100;             // Last N messages kept for reconnect replay
const RETRY_MS = 3000;                      // Client reconnect delay
const MAX_LOG = 2000;                       // Max log entries in memory

// ── State ────────────────────────────────────────────────────────

/** @type {Map<string, ClientInfo>} clientId -> ClientInfo */
const clients = new Map();

/**
 * @typedef {Object} ClientInfo
 * @property {import('http').ServerResponse} res
 * @property {string} sessionToken - Auth token for this connection
 * @property {number} lastActivity - Timestamp of last write activity (for LRU)
 * @property {boolean} paused - Whether backpressure has paused this client
 * @property {Array} pendingQueue - Messages queued while paused
 * @property {string} id - Unique client identifier
 */

// Per-ticket log buffers + global buffer for system messages
const logBuffers = {};           // ticket -> log entry array
const globalLogBuffer = [];      // system messages (no ticket)
let logBuffer = [];              // Backward-compat: all logs merged (deprecated, kept for getLogBuffer)
let nextMessageId = 1;           // Monotonic message counter
let nextClientId = 1;            // Unique client ID counter

/** @type {Array<{id: number, event: string, data: string}>} */
const replayBuffer = [];         // Ring buffer of last REPLAY_BUFFER_SIZE messages

// ── Keepalive Timer ──────────────────────────────────────────────

const keepaliveTimer = setInterval(() => {
  const now = Date.now();
  for (const [clientId, client] of clients) {
    try {
      // SSE comment — not a real event, but keeps connection alive
      const ok = client.res.write(`:keepalive ${now}\n\n`);
      if (ok) {
        client.lastActivity = now;
      }
      // If write returned false, the drain handler is already set up
    } catch {
      removeClient(clientId);
    }
  }
}, KEEPALIVE_INTERVAL_MS);
keepaliveTimer.unref(); // Don't prevent process exit

// ── Client Management ────────────────────────────────────────────

/**
 * Register a new SSE client connection.
 * Handles: auth validation, connection limits, LRU eviction,
 * replay from Last-Event-ID, keepalive, backpressure.
 *
 * @param {import('http').ServerResponse} res
 * @param {import('http').IncomingMessage} request
 * @param {URL} url
 * @param {string} apiToken - Server's auth token
 * @returns {{ok: boolean, error?: string}}
 */
function registerClient(res, request, url, apiToken) {
  // ── Auth: token from query param ──
  const clientToken = url.searchParams.get("token") || "";
  if (clientToken !== apiToken) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden: invalid or missing SSE token" }));
    return { ok: false, error: "auth_failed" };
  }

  // ── Per-session limit ──
  let sessionCount = 0;
  for (const [, c] of clients) {
    if (c.sessionToken === clientToken) sessionCount++;
  }
  if (sessionCount >= MAX_CLIENTS_PER_SESSION) {
    // Evict the LRU client for this session
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [cid, c] of clients) {
      if (c.sessionToken === clientToken && c.lastActivity < oldestTime) {
        oldestTime = c.lastActivity;
        oldestId = cid;
      }
    }
    if (oldestId) removeClient(oldestId);
  }

  // ── Global limit — LRU eviction ──
  if (clients.size >= MAX_CLIENTS_TOTAL) {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [cid, c] of clients) {
      if (c.lastActivity < oldestTime) {
        oldestTime = c.lastActivity;
        oldestId = cid;
      }
    }
    if (oldestId) removeClient(oldestId);
  }

  // ── SSE Response Headers ──
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",           // Disable nginx buffering
    "Access-Control-Allow-Origin": "*",   // CORS for SSE
  });

  // ── Send retry directive ──
  res.write(`retry: ${RETRY_MS}\n\n`);

  // ── Create client record ──
  const clientId = String(nextClientId++);
  const now = Date.now();
  const client = {
    id: clientId,
    res,
    sessionToken: clientToken,
    lastActivity: now,
    paused: false,
    pendingQueue: [],
  };
  clients.set(clientId, client);

  // ── Replay from Last-Event-ID ──
  const lastEventId = request.headers["last-event-id"];
  if (lastEventId) {
    const lastId = parseInt(lastEventId, 10);
    if (!isNaN(lastId)) {
      for (const msg of replayBuffer) {
        if (msg.id > lastId) {
          writeToClient(client, msg.id, msg.event, msg.data);
        }
      }
    }
  } else {
    // New connection: send log buffer replay
    // If ticket query param is provided, replay only that ticket's buffer + global
    const rawTicket = url.searchParams.get("ticket") || null;
    const ticketFilter = rawTicket && /^[A-Za-z]+-\d+$/.test(rawTicket.trim()) ? rawTicket.trim() : null;
    let replayEntries;
    if (ticketFilter && logBuffers[ticketFilter]) {
      // Merge ticket-specific + global, sorted by timestamp
      replayEntries = [...(logBuffers[ticketFilter] || []), ...globalLogBuffer]
        .sort((a, b) => a.ts - b.ts);
    } else {
      // No filter: replay all (backward compat)
      replayEntries = logBuffer;
    }
    for (const entry of replayEntries) {
      const msgId = nextMessageId++;
      const data = JSON.stringify(entry);
      writeToClient(client, msgId, "log", data);
      addToReplayBuffer(msgId, "log", data);
    }
  }

  // ── Send current status ──
  const { getAgentProcs } = require("./agent-process");
  const agentProcs = getAgentProcs();
  const statusData = JSON.stringify({
    running: Object.keys(agentProcs).length > 0,
    activeAgents: Object.keys(agentProcs),
  });
  const statusId = nextMessageId++;
  writeToClient(client, statusId, "status", statusData);
  addToReplayBuffer(statusId, "status", statusData);

  // ── Backpressure: drain handler ──
  res.on("drain", () => {
    const c = clients.get(clientId);
    if (!c || !c.paused) return;
    c.paused = false;
    // Flush pending queue
    while (c.pendingQueue.length > 0) {
      const msg = c.pendingQueue.shift();
      const ok = safeWrite(c, msg);
      if (!ok) {
        c.paused = true;
        break;
      }
    }
  });

  // ── Cleanup on disconnect ──
  const cleanup = () => removeClient(clientId);
  request.on("close", cleanup);
  request.on("error", cleanup);

  return { ok: true, clientId };
}

/**
 * Remove a client by ID — close connection and clean up.
 * @param {string} clientId
 */
function removeClient(clientId) {
  const client = clients.get(clientId);
  if (!client) return;
  clients.delete(clientId);
  try { client.res.end(); } catch { /* already closed */ }
}

/**
 * Write a formatted SSE message to a single client, respecting backpressure.
 * @param {ClientInfo} client
 * @param {number} id - Message ID
 * @param {string} event - Event name
 * @param {string} data - JSON-serialized data
 */
function writeToClient(client, id, event, data) {
  const formatted = `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;

  if (client.paused) {
    // Queue while backpressured — cap at 200 to prevent unbounded growth
    if (client.pendingQueue.length < 200) {
      client.pendingQueue.push(formatted);
    }
    // If queue exceeds 200, we silently drop — client will catch up on reconnect via replay
    return;
  }

  const ok = safeWrite(client, formatted);
  if (!ok) {
    client.paused = true;
  }
}

/**
 * Safe write with error handling. Returns false if backpressured.
 * @param {ClientInfo} client
 * @param {string} data
 * @returns {boolean}
 */
function safeWrite(client, data) {
  try {
    const ok = client.res.write(data);
    if (ok) {
      client.lastActivity = Date.now();
    }
    return ok;
  } catch {
    removeClient(client.id);
    return true; // Removed, no backpressure concern
  }
}

// ── Replay Buffer ────────────────────────────────────────────────

/**
 * Add a message to the replay buffer (ring buffer).
 * @param {number} id
 * @param {string} event
 * @param {string} data
 */
function addToReplayBuffer(id, event, data) {
  replayBuffer.push({ id, event, data });
  while (replayBuffer.length > REPLAY_BUFFER_SIZE) {
    replayBuffer.shift();
  }
}

// ── Broadcast ────────────────────────────────────────────────────

/**
 * Broadcast an event to ALL connected SSE clients.
 * Assigns a monotonic message ID and stores in replay buffer.
 *
 * @param {string} event - SSE event name
 * @param {*} data - Data to JSON-serialize
 */
function broadcast(event, data) {
  const id = nextMessageId++;
  const serialized = JSON.stringify(data);

  addToReplayBuffer(id, event, serialized);

  for (const [clientId, client] of clients) {
    writeToClient(client, id, event, serialized);
  }
}

// ── Log Buffer ───────────────────────────────────────────────────

/**
 * Add a log entry and broadcast to all SSE clients.
 * @param {string} line
 * @param {string} [type="stdout"]
 * @param {string|null} [ticket=null] - Ticket ID for per-ticket log buffers
 */
function addLog(line, type = "stdout", ticket = null) {
  const entry = { ts: Date.now(), line, type, ticket: ticket || null };

  // Store in per-ticket buffer or global buffer
  if (ticket) {
    if (!logBuffers[ticket]) logBuffers[ticket] = [];
    logBuffers[ticket].push(entry);
    if (logBuffers[ticket].length > MAX_LOG) logBuffers[ticket].shift();
  } else {
    globalLogBuffer.push(entry);
    if (globalLogBuffer.length > MAX_LOG) globalLogBuffer.shift();
  }

  // Backward compat: also add to merged buffer
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG) logBuffer.shift();

  broadcast("log", entry);
}

function getLogBuffer() { return logBuffer; }
function setLogBuffer(buf) { logBuffer = buf; }

/**
 * Clear a ticket's per-ticket log buffer.
 * @param {string} ticket
 */
function clearTicketLogs(ticket) {
  if (ticket && logBuffers[ticket]) {
    delete logBuffers[ticket];
  }
}

/**
 * Get per-ticket log buffers (for API endpoint).
 */
function getLogBuffers() { return logBuffers; }
function getGlobalLogBuffer() { return globalLogBuffer; }

// ── Backward-compatible client accessors ─────────────────────────
// These maintain API compatibility with existing code that uses the old interface

function getSseClients() {
  return Array.from(clients.values()).map(c => c.res);
}

function addSseClient(/* unused */) {
  // No-op: clients are now added via registerClient()
  // Kept for backward compatibility
}

function removeSseClient(res) {
  for (const [clientId, client] of clients) {
    if (client.res === res) {
      removeClient(clientId);
      return;
    }
  }
}

// ── Diagnostics ──────────────────────────────────────────────────

/**
 * Get current SSE connection stats for health/debug endpoints.
 * @returns {Object}
 */
function getSSEStats() {
  // T2.23: Return only aggregate counts, not session token values (prevents token leak)
  const uniqueSessions = new Set();
  for (const [, c] of clients) {
    uniqueSessions.add(c.sessionToken);
  }
  return {
    totalClients: clients.size,
    maxClients: MAX_CLIENTS_TOTAL,
    maxPerSession: MAX_CLIENTS_PER_SESSION,
    totalSessions: uniqueSessions.size,
    replayBufferSize: replayBuffer.length,
    replayBufferMax: REPLAY_BUFFER_SIZE,
    nextMessageId,
    logBufferSize: logBuffer.length,
  };
}

module.exports = {
  broadcast,
  addLog,
  getLogBuffer,
  setLogBuffer,
  getLogBuffers,
  getGlobalLogBuffer,
  clearTicketLogs,
  getSseClients,
  addSseClient,
  removeSseClient,
  registerClient,
  getSSEStats,

  // Constants exposed for route handler
  MAX_CLIENTS_TOTAL,
  MAX_CLIENTS_PER_SESSION,
  RETRY_MS,
};
