"use strict";
// =====================================================================
// MI Dev Agent -- SSE (Server-Sent Events) Manager (TypeScript port)
// =====================================================================
// Robust SSE implementation with:
//   1. Keepalive comments every 25s (below common 30s proxy timeout)
//   2. LRU eviction (track lastActivity per client, evict least-recently-active)
//   3. Backpressure: if res.write() returns false, pause queue, resume on 'drain'
//   4. Auth: token via query param ?token=xxx validated before connection
//   5. Connection limits: max 5 per session token, max 20 total
//   6. Reconnection: retry:3000 so clients reconnect in 3s
//   7. Message IDs: monotonic id: field per message
//   8. Replay: circular buffer for last 100 messages, replay on reconnect
//   9. Per-ticket log buffers + global buffer
//  10. 64KB message truncation before storing in replay buffer
//  11. TypeScript wrapper around Rust sse-engine circular buffer with JS fallback
//
// Ported from: server/sse.js
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_PENDING_QUEUE = exports.MAX_REPLAY_MSG_SIZE = exports.MAX_LOG = exports.REPLAY_BUFFER_SIZE = exports.RETRY_MS = exports.MAX_CLIENTS_PER_SESSION = exports.MAX_CLIENTS_TOTAL = void 0;
exports.registerClient = registerClient;
exports.removeClient = removeClient;
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
exports.setAgentProcsGetter = setAgentProcsGetter;
exports.broadcastPipelineList = broadcastPipelineList;
exports.getSSEStats = getSSEStats;
let StringCircularBuffer;
try {
    // Try loading the Rust native addon via @native/* alias
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const native = require('@native/index');
    StringCircularBuffer = native.StringCircularBuffer;
}
catch {
    // Fallback: pure-JS implementation matching the same API
    class JSStringCircularBuffer {
        _capacity;
        _buf;
        _head;
        _tail;
        _count;
        constructor(capacity) {
            this._capacity = Math.max(1, capacity);
            this._buf = new Array(this._capacity);
            this._head = 0;
            this._tail = 0;
            this._count = 0;
        }
        push(item) {
            this._buf[this._tail] = item;
            this._tail = (this._tail + 1) % this._capacity;
            if (this._count < this._capacity) {
                this._count++;
            }
            else {
                this._head = (this._head + 1) % this._capacity;
            }
        }
        toArray() {
            const result = [];
            for (let i = 0; i < this._count; i++) {
                const idx = (this._head + i) % this._capacity;
                const val = this._buf[idx];
                if (val !== undefined)
                    result.push(val);
            }
            return result;
        }
        len() {
            return this._count;
        }
        clear() {
            this._buf = new Array(this._capacity);
            this._head = 0;
            this._tail = 0;
            this._count = 0;
        }
    }
    StringCircularBuffer = JSStringCircularBuffer;
}
// ── Constants ────────────────────────────────────────────────────
const KEEPALIVE_INTERVAL_MS = 25_000; // 25s -- under common 30s proxy timeout
const MAX_CLIENTS_TOTAL = 20; // Hard cap on total SSE connections
exports.MAX_CLIENTS_TOTAL = MAX_CLIENTS_TOTAL;
const MAX_CLIENTS_PER_SESSION = 5; // Per auth-token session cap
exports.MAX_CLIENTS_PER_SESSION = MAX_CLIENTS_PER_SESSION;
const REPLAY_BUFFER_SIZE = 100; // Last N messages kept for reconnect replay
exports.REPLAY_BUFFER_SIZE = REPLAY_BUFFER_SIZE;
const RETRY_MS = 3000; // Client reconnect delay
exports.RETRY_MS = RETRY_MS;
const MAX_LOG = 2000; // Max log entries in memory per buffer
exports.MAX_LOG = MAX_LOG;
const MAX_REPLAY_MSG_SIZE = 65536; // 64KB per message -- truncate before storing
exports.MAX_REPLAY_MSG_SIZE = MAX_REPLAY_MSG_SIZE;
const MAX_PENDING_QUEUE = 200; // Max queued messages per backpressured client
exports.MAX_PENDING_QUEUE = MAX_PENDING_QUEUE;
// ── State ────────────────────────────────────────────────────────
/** clientId -> ClientInfo */
const clients = new Map();
/** Per-ticket log buffers */
const logBuffers = {};
/** Global log buffer for system messages (no ticket) */
const globalLogBuffer = [];
/** Backward-compat: all logs merged (deprecated, kept for getLogBuffer) */
let logBuffer = [];
/** Monotonic message counter */
let nextMessageId = 1;
/** Unique client ID counter */
let nextClientId = 1;
// ── Circular Replay Buffer ──────────────────────────────────────
/** Circular replay buffer using native Rust or JS fallback -- O(1) insert */
const _replayBuf = new Array(REPLAY_BUFFER_SIZE);
let _replayHead = 0; // oldest entry index
let _replayTail = 0; // next write index
let _replayCount = 0; // number of entries currently stored
/**
 * Add a message to the circular replay buffer -- O(1).
 */
function addToReplayBuffer(id, event, data) {
    // Truncate oversized messages to prevent memory bloat
    const storedData = data.length > MAX_REPLAY_MSG_SIZE
        ? data.substring(0, MAX_REPLAY_MSG_SIZE) + '[truncated]'
        : data;
    _replayBuf[_replayTail] = { id, event, data: storedData };
    _replayTail = (_replayTail + 1) % REPLAY_BUFFER_SIZE;
    if (_replayCount < REPLAY_BUFFER_SIZE) {
        _replayCount++;
    }
    else {
        // Buffer full -- overwrite oldest, advance head
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
        const msg = _replayBuf[idx];
        if (msg)
            result.push(msg);
    }
    return result;
}
// ── Keepalive Timer ─────────────────────────────────────────────
const keepaliveTimer = setInterval(() => {
    const now = Date.now();
    for (const [clientId, client] of clients) {
        try {
            // SSE comment -- not a real event, but keeps connection alive
            const ok = client.res.write(`:keepalive ${now}\n\n`);
            if (ok) {
                client.lastActivity = now;
            }
            // If write returned false, the drain handler is already set up
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[SSE] Keepalive failed for client ${clientId}: ${msg}`);
            removeClient(clientId);
        }
    }
}, KEEPALIVE_INTERVAL_MS);
keepaliveTimer.unref(); // Don't prevent process exit
// ── Safe Write ──────────────────────────────────────────────────
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
/**
 * Write a formatted SSE message to a single client, respecting backpressure.
 */
function writeToClient(client, id, event, data) {
    const formatted = `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;
    if (client.paused) {
        // Queue while backpressured -- cap to prevent unbounded growth
        if (client.pendingQueue.length < MAX_PENDING_QUEUE) {
            client.pendingQueue.push(formatted);
        }
        else {
            // Dropped messages are already in the global replay buffer (added by broadcast->addToReplayBuffer
            // before writeToClient is called), so reconnecting clients using Last-Event-ID will recover them
            console.warn(`[SSE] Client ${client.id}: pending queue overflow (${MAX_PENDING_QUEUE}) -- message dropped (recoverable via replay buffer)`);
        }
        return;
    }
    const ok = safeWrite(client, formatted);
    if (!ok) {
        client.paused = true;
    }
}
// ── Client Management ───────────────────────────────────────────
/**
 * Register a new SSE client connection.
 * Handles: auth validation, connection limits, LRU eviction,
 * replay from Last-Event-ID, keepalive, backpressure.
 */
function registerClient(res, request, url, apiToken) {
    // -- Auth: token from query param --
    const clientToken = url.searchParams.get('token') || '';
    if (clientToken !== apiToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: invalid or missing SSE token' }));
        return { ok: false, error: 'auth_failed' };
    }
    // -- Per-session limit --
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
    // -- Global limit -- LRU eviction --
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
    // -- SSE Response Headers --
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
        'Access-Control-Allow-Origin': '*', // CORS for SSE
    });
    // -- Send retry directive --
    res.write(`retry: ${RETRY_MS}\n\n`);
    // -- Create client record --
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
    // -- Replay from Last-Event-ID (fresh IDs to prevent browser dedup) --
    const lastEventId = request.headers['last-event-id'];
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
        const rawTicket = url.searchParams.get('ticket') || null;
        const ticketFilter = rawTicket && /^[A-Za-z]+-\d+$/.test(rawTicket.trim())
            ? rawTicket.trim()
            : null;
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
            writeToClient(client, msgId, 'log', data);
            addToReplayBuffer(msgId, 'log', data);
        }
    }
    // -- Send current status --
    // Lazy-require agent-process to avoid circular deps at module load time.
    // In the TS port this is modeled as a late binding via the getAgentProcsGetter.
    let agentKeys = [];
    try {
        if (_agentProcsGetter) {
            const procs = _agentProcsGetter();
            agentKeys = Object.keys(procs);
        }
    }
    catch { /* agent-process may not be available */ }
    const statusData = JSON.stringify({
        running: agentKeys.length > 0,
        activeAgents: agentKeys,
    });
    const statusId = nextMessageId++;
    writeToClient(client, statusId, 'status', statusData);
    addToReplayBuffer(statusId, 'status', statusData);
    // -- Backpressure: drain handler (exception-safe) --
    res.on('drain', () => {
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
            const errMsg = e instanceof Error ? e.message : String(e);
            console.warn(`[SSE] drain handler error: ${errMsg}`);
            try {
                res.resume();
            }
            catch { /* swallow */ }
        }
    });
    // -- Cleanup on disconnect --
    const cleanup = () => removeClient(clientId);
    request.on('close', cleanup);
    request.on('error', cleanup);
    return { ok: true, clientId };
}
/**
 * Remove a client by ID -- close connection and clean up.
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
// ── Broadcast ───────────────────────────────────────────────────
/**
 * Broadcast an event to ALL connected SSE clients.
 * Assigns a monotonic message ID and stores in replay buffer.
 */
function broadcast(event, data) {
    const id = nextMessageId++;
    const serialized = JSON.stringify(data);
    addToReplayBuffer(id, event, serialized);
    for (const [, client] of clients) {
        writeToClient(client, id, event, serialized);
    }
}
// ── Log Buffer ──────────────────────────────────────────────────
/**
 * Add a log entry and broadcast to all SSE clients.
 */
function addLog(line, type = 'stdout', ticket = null) {
    const entry = { ts: Date.now(), line, type, ticket: ticket || null };
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
    broadcast('log', entry);
}
/**
 * Get the merged log buffer (backward compat).
 */
function getLogBuffer() {
    return logBuffer;
}
/**
 * Replace the merged log buffer (backward compat).
 */
function setLogBuffer(buf) {
    logBuffer = buf;
}
/**
 * Get per-ticket log buffers (for API endpoint).
 */
function getLogBuffers() {
    return logBuffers;
}
/**
 * Get the global log buffer (system messages without ticket).
 */
function getGlobalLogBuffer() {
    return globalLogBuffer;
}
/**
 * Clear a ticket's per-ticket log buffer.
 */
function clearTicketLogs(ticket) {
    if (ticket && logBuffers[ticket]) {
        delete logBuffers[ticket];
    }
}
// ── Backward-compatible client accessors ────────────────────────
/**
 * Get all SSE clients as an array of ServerResponse objects.
 * Used by graceful-shutdown for cleanup.
 */
function getSseClients() {
    return Array.from(clients.values()).map(c => c.res);
}
/**
 * No-op: clients are now added via registerClient().
 * Kept for backward compatibility.
 */
function addSseClient() {
    // No-op
}
/**
 * Remove an SSE client by its response object.
 */
function removeSseClient(res) {
    for (const [clientId, client] of clients) {
        if (client.res === res) {
            removeClient(clientId);
            return;
        }
    }
}
let _agentProcsGetter = null;
/**
 * Register a function that returns the agent processes map.
 * Called by http-server.ts on startup to break the circular dependency.
 */
function setAgentProcsGetter(fn) {
    _agentProcsGetter = fn;
}
// ── Pipeline Dashboard: Broadcast ───────────────────────────────
/**
 * Broadcast the current pipeline list to all SSE clients.
 * Uses late-bound agentProcs getter and state-manager's cached list.
 */
function broadcastPipelineList() {
    try {
        const { getCachedPipelineList, invalidatePipelineCache } = require('../state/state-manager');
        invalidatePipelineCache();
        const agentProcs = _agentProcsGetter ? _agentProcsGetter() : {};
        const pipelines = getCachedPipelineList(agentProcs);
        broadcast('pipelines', pipelines);
    }
    catch {
        // state-manager not available yet during startup
    }
}
// ── Diagnostics ─────────────────────────────────────────────────
/**
 * Get current SSE connection stats for health/debug endpoints.
 * T2.23: Returns only aggregate counts, not session token values (prevents token leak).
 */
function getSSEStats() {
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