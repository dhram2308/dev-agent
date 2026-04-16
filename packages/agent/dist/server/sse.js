"use strict";
// ═══════════════════════════════════════════════════════════════
// server/sse.ts — SSE (Server-Sent Events) — Robust implementation
// Converted from: server/sse.js (454 lines)
// ═══════════════════════════════════════════════════════════════
Object.defineProperty(exports, "__esModule", { value: true });
exports.RETRY_MS = exports.MAX_CLIENTS_PER_SESSION = exports.MAX_CLIENTS_TOTAL = void 0;
exports.broadcast = broadcast;
exports.addLog = addLog;
exports.getLogBuffer = getLogBuffer;
exports.setLogBuffer = setLogBuffer;
exports.getLogBuffers = getLogBuffers;
exports.getGlobalLogBuffer = getGlobalLogBuffer;
exports.clearTicketLogs = clearTicketLogs;
exports.getSseClients = getSseClients;
exports.addSseClient = addSseClient;
exports.removeSseClient = removeSseClient;
exports.registerClient = registerClient;
exports.getSSEStats = getSSEStats;
// ── Constants ────────────────────────────────────────────────────
const KEEPALIVE_INTERVAL_MS = 25_000; // 25s — under common 30s proxy timeout
const MAX_CLIENTS_TOTAL = 20; // Hard cap on total SSE connections
exports.MAX_CLIENTS_TOTAL = MAX_CLIENTS_TOTAL;
const MAX_CLIENTS_PER_SESSION = 5; // Per auth-token session cap
exports.MAX_CLIENTS_PER_SESSION = MAX_CLIENTS_PER_SESSION;
const REPLAY_BUFFER_SIZE = 100; // Last N messages kept for reconnect replay
const RETRY_MS = 3000; // Client reconnect delay
exports.RETRY_MS = RETRY_MS;
const MAX_LOG = 2000; // Max log entries in memory
// ── State ────────────────────────────────────────────────────────
const clients = new Map();
// Per-ticket log buffers + global buffer for system messages
const logBuffers = {};
const globalLogBuffer = [];
let logBuffer = []; // Backward-compat: all logs merged (deprecated, kept for getLogBuffer)
let nextMessageId = 1; // Monotonic message counter
let nextClientId = 1; // Unique client ID counter
/** Circular replay buffer — O(1) insert, O(n) ordered iteration */
const _replayBuf = new Array(REPLAY_BUFFER_SIZE);
let _replayHead = 0; // oldest entry index
let _replayTail = 0; // next write index
let _replayCount = 0; // number of entries currently stored
const MAX_REPLAY_MSG_SIZE = 65536; // 64KB per message
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
        }
        catch (e) {
            console.warn("[SSE] Keepalive failed for client " + clientId + ":", e.message);
            removeClient(clientId);
        }
    }
}, KEEPALIVE_INTERVAL_MS);
keepaliveTimer.unref(); // Don't prevent process exit
/**
 * Register a new SSE client connection.
 * Handles: auth validation, connection limits, LRU eviction,
 * replay from Last-Event-ID, keepalive, backpressure.
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
        if (c.sessionToken === clientToken)
            sessionCount++;
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
        if (oldestId)
            removeClient(oldestId);
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
        if (oldestId)
            removeClient(oldestId);
    }
    // ── SSE Response Headers ──
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no", // Disable nginx buffering
        "Access-Control-Allow-Origin": "*", // CORS for SSE
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
    // ── Replay from Last-Event-ID (fresh IDs to prevent browser dedup) ──
    const lastEventId = request.headers["last-event-id"];
    if (lastEventId) {
        const lastId = parseInt(lastEventId, 10);
        if (!isNaN(lastId)) {
            for (const msg of _replayIterate()) {
                if (msg.id > lastId) {
                    // Assign fresh ID to prevent EventSource dedup of already-seen IDs
                    const freshId = nextMessageId++;
                    writeToClient(client, freshId, msg.event, msg.data);
                }
            }
        }
    }
    else {
        // New connection: send log buffer replay
        // If ticket query param is provided, replay only that ticket's buffer + global
        const rawTicket = url.searchParams.get("ticket") || null;
        const ticketFilter = rawTicket && /^[A-Za-z]+-\d+$/.test(rawTicket.trim()) ? rawTicket.trim() : null;
        let replayEntries;
        if (ticketFilter && logBuffers[ticketFilter]) {
            // Merge ticket-specific + global, sorted by timestamp
            replayEntries = [...(logBuffers[ticketFilter] || []), ...globalLogBuffer]
                .sort((a, b) => a.ts - b.ts);
        }
        else {
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
    // TODO: Circular dependency — lazy require to match original behavior
    const { getAgentProcs } = require("./agent-process");
    const agentProcs = getAgentProcs();
    const statusData = JSON.stringify({
        running: Object.keys(agentProcs).length > 0,
        activeAgents: Object.keys(agentProcs),
    });
    const statusId = nextMessageId++;
    writeToClient(client, statusId, "status", statusData);
    addToReplayBuffer(statusId, "status", statusData);
    // ── Backpressure: drain handler (exception-safe) ──
    res.on("drain", () => {
        try {
            const c = clients.get(clientId);
            if (!c || !c.paused)
                return;
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
        }
        catch (e) {
            console.warn("[SSE] drain handler error:", e.message);
            try {
                res.resume?.();
            }
            catch { /* ignore */ }
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
 */
function removeClient(clientId) {
    const client = clients.get(clientId);
    if (!client)
        return;
    clients.delete(clientId);
    try {
        client.res.end();
    }
    catch { /* already closed */ }
}
/**
 * Write a formatted SSE message to a single client, respecting backpressure.
 */
function writeToClient(client, id, event, data) {
    const formatted = `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;
    if (client.paused) {
        // Queue while backpressured — cap at 200 to prevent unbounded growth
        if (client.pendingQueue.length < 200) {
            client.pendingQueue.push(formatted);
        }
        else {
            // Dropped messages are already in the global replay buffer (added by broadcast->addToReplayBuffer
            // before writeToClient is called), so reconnecting clients using Last-Event-ID will recover them
            console.warn(`[SSE] Client ${client.id}: pending queue overflow (200) — message dropped (recoverable via replay buffer)`);
        }
        return;
    }
    const ok = safeWrite(client, formatted);
    if (!ok) {
        client.paused = true;
    }
}
/**
 * Safe write with error handling. Returns false if backpressured.
 */
function safeWrite(client, data) {
    try {
        const ok = client.res.write(data);
        if (ok) {
            client.lastActivity = Date.now();
        }
        return ok;
    }
    catch {
        removeClient(client.id);
        return true; // Removed, no backpressure concern
    }
}
// ── Replay Buffer ────────────────────────────────────────────────
/**
 * Add a message to the circular replay buffer — O(1).
 */
function addToReplayBuffer(id, event, data) {
    // Truncate oversized messages to prevent memory bloat
    const storedData = data.length > MAX_REPLAY_MSG_SIZE
        ? data.substring(0, MAX_REPLAY_MSG_SIZE) + "[truncated]"
        : data;
    _replayBuf[_replayTail] = { id, event, data: storedData };
    _replayTail = (_replayTail + 1) % REPLAY_BUFFER_SIZE;
    if (_replayCount < REPLAY_BUFFER_SIZE) {
        _replayCount++;
    }
    else {
        // Buffer full — overwrite oldest, advance head
        _replayHead = (_replayHead + 1) % REPLAY_BUFFER_SIZE;
    }
}
/**
 * Iterate replay buffer in chronological order (head -> tail).
 */
function _replayIterate() {
    const result = [];
    for (let i = 0; i < _replayCount; i++) {
        const idx = (_replayHead + i) % REPLAY_BUFFER_SIZE;
        if (_replayBuf[idx])
            result.push(_replayBuf[idx]);
    }
    return result;
}
// ── Broadcast ────────────────────────────────────────────────────
/**
 * Broadcast an event to ALL connected SSE clients.
 * Assigns a monotonic message ID and stores in replay buffer.
 */
function broadcast(event, data) {
    const id = nextMessageId++;
    const serialized = JSON.stringify(data);
    addToReplayBuffer(id, event, serialized);
    for (const [_clientId, client] of clients) {
        writeToClient(client, id, event, serialized);
    }
}
// ── Log Buffer ───────────────────────────────────────────────────
/**
 * Add a log entry and broadcast to all SSE clients.
 */
function addLog(line, type = "stdout", ticket = null) {
    const entry = { ts: Date.now(), line, type: type, ticket: ticket || null };
    // Store in per-ticket buffer or global buffer
    if (ticket) {
        if (!logBuffers[ticket])
            logBuffers[ticket] = [];
        logBuffers[ticket].push(entry);
        if (logBuffers[ticket].length > MAX_LOG)
            logBuffers[ticket].shift();
    }
    else {
        globalLogBuffer.push(entry);
        if (globalLogBuffer.length > MAX_LOG)
            globalLogBuffer.shift();
    }
    // Backward compat: also add to merged buffer
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG)
        logBuffer.shift();
    broadcast("log", entry);
}
function getLogBuffer() { return logBuffer; }
function setLogBuffer(buf) { logBuffer = buf; }
/**
 * Clear a ticket's per-ticket log buffer.
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
function addSseClient( /* unused */) {
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
        replayBufferSize: _replayCount,
        replayBufferMax: REPLAY_BUFFER_SIZE,
        nextMessageId,
        logBufferSize: logBuffer.length,
    };
}
//# sourceMappingURL=sse.js.map