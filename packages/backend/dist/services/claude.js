"use strict";
// =====================================================================
// MI Dev Agent -- Claude Service (Anthropic API + CLI fallback)
// =====================================================================
// Primary: Anthropic Messages API over HTTPS (requires ANTHROPIC_API_KEY).
// Fallback: ClaudeCLIService wraps `claude -p` CLI (browser auth, no key).
//
// Features:
//   - POST to https://api.anthropic.com/v1/messages
//   - Multi-turn agent loop (tool_use -> tool_result -> response)
//   - 7 tool definitions: read_file, write_file, edit_file, bash,
//     glob, grep, list_dir
//   - ToolExecutor with security sandbox
//   - Retry on timeout (1 retry)
//   - Heartbeat callback during long operations
//   - Prompt size validation and logging
//   - Output size limits (2MB stdout, 1MB stderr)
//   - ClaudeCLIService: spawns `claude -p` for browser-authenticated usage
// =====================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaudeCLIService = exports.ClaudeService = void 0;
exports.createClaudeCaller = createClaudeCaller;
const child_process_1 = require("child_process");
const logger_1 = require("../lib/logger");
const utils_1 = require("../lib/utils");
const tool_executor_1 = require("../agents/tool-executor");
// ── Constants ────────────────────────────────────────────────────────
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const MAX_RESPONSE_TEXT = 2_000_000; // 2MB cap on accumulated text
// ── ClaudeService Class ──────────────────────────────────────────────
class ClaudeService {
    apiKey;
    req;
    toolExecutor = null;
    constructor(apiKey, req) {
        if (!apiKey) {
            throw new Error('ClaudeService: ANTHROPIC_API_KEY is required');
        }
        this.apiKey = apiKey;
        this.req = req;
    }
    /**
     * Set the tool executor for a specific project directory.
     * Must be called before using tools in callClaude.
     */
    setProjectDir(projectDir) {
        this.toolExecutor = new tool_executor_1.ToolExecutor(projectDir);
    }
    /**
     * Call Claude via the Anthropic Messages API.
     *
     * Drop-in replacement for the old CLI-based callClaude().
     * Supports multi-turn tool use (agent loop).
     *
     * @param prompt - The user prompt to send
     * @param timeoutMs - Total timeout for the entire interaction (default: 180s)
     * @param opts - Additional options (model, maxTokens, tools, systemPrompt, etc.)
     * @returns The final text response from Claude
     */
    async callClaude(prompt, timeoutMs = DEFAULT_TIMEOUT_MS, opts = {}) {
        const agentName = opts.agentName || 'Claude';
        const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
        const retryEnabled = opts.retry !== false;
        const callStart = Date.now();
        // Set up project dir if provided
        if (opts.projectDir) {
            this.setProjectDir(opts.projectDir);
        }
        // Prompt size validation and logging
        const validatedPrompt = (0, utils_1.validatePromptSize)(prompt, agentName);
        const promptChars = validatedPrompt.length;
        const estimatedTokens = Math.round(promptChars / 4);
        (0, logger_1.logInfo)(`[${agentName}] Prompt: ${promptChars} chars (~${estimatedTokens} tokens) | ` +
            `Timeout: ${timeoutMs / 1000}s | MaxTurns: ${maxTurns}`);
        if (promptChars > 100_000) {
            (0, logger_1.logWarn)(`[${agentName}] Prompt exceeds 100K chars (${promptChars}) -- consider reducing context`);
        }
        try {
            const result = await this.callClaudeOnce(validatedPrompt, timeoutMs, opts);
            const elapsedSec = ((Date.now() - callStart) / 1000).toFixed(1);
            (0, logger_1.logOk)(`[${agentName}] Complete in ${elapsedSec}s`);
            return result;
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isTimeout = errMsg.includes('timed out') || errMsg.includes('timeout');
            if (isTimeout && retryEnabled) {
                const retryTimeout = Math.round(timeoutMs * 1.5);
                const retryMaxTurns = Math.max(2, Math.floor(maxTurns / 2));
                (0, logger_1.logWarn)(`[${agentName}] Timeout -- retrying with ${retryTimeout / 1000}s timeout, ` +
                    `${retryMaxTurns} maxTurns (degraded)`);
                const retryResult = await this.callClaudeOnce(validatedPrompt, retryTimeout, {
                    ...opts,
                    maxTurns: retryMaxTurns,
                });
                const elapsedSec = ((Date.now() - callStart) / 1000).toFixed(1);
                (0, logger_1.logOk)(`[${agentName}] Complete in ${elapsedSec}s (after retry)`);
                return retryResult;
            }
            throw err;
        }
    }
    // ── Single API call (no retry logic) ───────────────────────────────
    async callClaudeOnce(prompt, timeoutMs, opts = {}) {
        const agentName = opts.agentName || 'Claude';
        const model = opts.model || process.env.CLAUDE_MODEL || DEFAULT_MODEL;
        const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
        const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
        const temperature = opts.temperature;
        const systemPrompt = opts.systemPrompt;
        const onHeartbeat = opts.onHeartbeat;
        // Build tool definitions
        const tools = opts.tools || (this.toolExecutor ? [...tool_executor_1.TOOL_DEFINITIONS] : []);
        // Start heartbeat
        const startTime = Date.now();
        const heartbeat = setInterval(() => {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const mins = Math.floor(elapsed / 60);
            const secs = elapsed % 60;
            const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
            (0, logger_1.logInfo)(`[${agentName}] Working... ${timeStr} elapsed`);
            if (onHeartbeat) {
                try {
                    onHeartbeat();
                }
                catch { /* swallow */ }
            }
        }, HEARTBEAT_INTERVAL_MS);
        // Overall timeout guard
        const deadline = Date.now() + timeoutMs;
        try {
            // Initialize conversation
            const messages = [
                { role: 'user', content: prompt },
            ];
            let accumulatedText = '';
            let turnCount = 0;
            // Agent loop: keep going while Claude requests tool use
            while (turnCount < maxTurns) {
                // Check timeout
                if (Date.now() > deadline) {
                    throw new Error(`Claude API timed out after ${timeoutMs / 1000}s`);
                }
                turnCount++;
                (0, logger_1.logDebug)(`[${agentName}] Turn ${turnCount}/${maxTurns}`);
                // Make API request
                const requestBody = {
                    model,
                    max_tokens: maxTokens,
                    messages,
                };
                if (systemPrompt) {
                    requestBody.system = systemPrompt;
                }
                if (temperature !== undefined) {
                    requestBody.temperature = temperature;
                }
                if (tools.length > 0) {
                    requestBody.tools = tools;
                }
                const remainingMs = deadline - Date.now();
                if (remainingMs <= 0) {
                    throw new Error(`Claude API timed out after ${timeoutMs / 1000}s`);
                }
                const response = await this.makeApiRequest(requestBody, remainingMs, agentName);
                // Extract text blocks from response
                const textBlocks = response.content.filter((block) => block.type === 'text');
                const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');
                // Accumulate text
                for (const block of textBlocks) {
                    accumulatedText += block.text;
                    if (accumulatedText.length > MAX_RESPONSE_TEXT) {
                        (0, logger_1.logWarn)(`[${agentName}] Response text exceeds ${MAX_RESPONSE_TEXT} bytes -- truncating`);
                        accumulatedText = accumulatedText.substring(0, MAX_RESPONSE_TEXT);
                        break;
                    }
                }
                // Log usage
                (0, logger_1.logDebug)(`[${agentName}] Turn ${turnCount}: ${response.usage.input_tokens} in / ` +
                    `${response.usage.output_tokens} out | stop_reason: ${response.stop_reason}`);
                // If stop_reason is not tool_use, we're done
                if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
                    if (response.stop_reason === 'max_tokens') {
                        (0, logger_1.logWarn)(`[${agentName}] Response was truncated (max_tokens reached)`);
                    }
                    break;
                }
                // Execute tool calls
                if (!this.toolExecutor) {
                    (0, logger_1.logWarn)(`[${agentName}] Claude requested tool use but no ToolExecutor configured -- stopping`);
                    break;
                }
                // Add assistant message to conversation
                messages.push({
                    role: 'assistant',
                    content: response.content,
                });
                // Execute each tool and collect results
                const toolResults = [];
                for (const toolUse of toolUseBlocks) {
                    (0, logger_1.logDebug)(`[${agentName}] Executing tool: ${toolUse.name}`);
                    const toolStart = Date.now();
                    let result;
                    try {
                        result = await this.toolExecutor.execute(toolUse.name, toolUse.input);
                    }
                    catch (toolErr) {
                        const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                        result = { success: false, output: '', error: errMsg };
                    }
                    const toolElapsed = Date.now() - toolStart;
                    const outputPreview = (result.output || result.error || '').substring(0, 200);
                    (0, logger_1.logDebug)(`[${agentName}] Tool ${toolUse.name}: ${result.success ? 'OK' : 'FAIL'} ` +
                        `(${toolElapsed}ms) -- ${outputPreview}`);
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolUse.id,
                        content: result.success
                            ? result.output
                            : `Error: ${result.error || 'Unknown error'}\n${result.output || ''}`.trim(),
                        is_error: !result.success,
                    });
                }
                // Add tool results as user message
                messages.push({
                    role: 'user',
                    content: toolResults,
                });
            }
            if (turnCount >= maxTurns) {
                (0, logger_1.logWarn)(`[${agentName}] Reached maximum turns (${maxTurns}) -- returning accumulated text`);
            }
            return accumulatedText.trim();
        }
        finally {
            clearInterval(heartbeat);
        }
    }
    // ── API Request ────────────────────────────────────────────────────
    /**
     * Make a single request to the Anthropic Messages API.
     */
    async makeApiRequest(body, timeoutMs, agentName) {
        const headers = {
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
        };
        const start = Date.now();
        let response;
        try {
            response = await this.req(ANTHROPIC_API_URL, {
                method: 'POST',
                body,
                headers,
                timeoutMs: Math.min(timeoutMs, 300_000), // Cap per-request timeout at 5min
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`[${agentName}] Anthropic API request failed: ${msg}`);
        }
        const latency = Date.now() - start;
        (0, logger_1.logDebug)(`[${agentName}] API response: ${response.status} (${latency}ms)`);
        // Handle error responses
        if (response.status !== 200) {
            const errorData = response.data;
            let errorMessage;
            if (typeof errorData === 'object' && errorData?.error) {
                const apiError = errorData.error;
                errorMessage = `${apiError.type || 'error'}: ${apiError.message || JSON.stringify(apiError)}`;
            }
            else if (typeof errorData === 'string') {
                errorMessage = errorData.substring(0, 500);
            }
            else {
                errorMessage = JSON.stringify(errorData).substring(0, 500);
            }
            // Specific error handling
            if (response.status === 401) {
                throw new Error(`[${agentName}] Anthropic API authentication failed (401). Check ANTHROPIC_API_KEY.`);
            }
            if (response.status === 429) {
                // Rate limited -- extract retry-after if available
                const retryAfter = (response.headers?.['retry-after'])
                    ? parseInt(response.headers['retry-after'], 10) * 1000
                    : 30_000;
                (0, logger_1.logWarn)(`[${agentName}] Rate limited (429) -- waiting ${retryAfter / 1000}s`);
                await (0, utils_1.sleep)(retryAfter);
                // Retry once
                return this.makeApiRequest(body, timeoutMs - (Date.now() - start), agentName);
            }
            if (response.status === 529) {
                // API overloaded
                (0, logger_1.logWarn)(`[${agentName}] API overloaded (529) -- waiting 60s`);
                await (0, utils_1.sleep)(60_000);
                return this.makeApiRequest(body, timeoutMs - (Date.now() - start), agentName);
            }
            throw new Error(`[${agentName}] Anthropic API error (${response.status}): ${errorMessage}`);
        }
        // Validate response structure
        const data = response.data;
        if (!data || !data.content || !Array.isArray(data.content)) {
            throw new Error(`[${agentName}] Invalid Anthropic API response: missing content array`);
        }
        return data;
    }
    // ── Accessors ──────────────────────────────────────────────────────
    /** Check if the API key is configured. */
    isConfigured() {
        return !!this.apiKey;
    }
    /** Get the tool executor instance. */
    getToolExecutor() {
        return this.toolExecutor;
    }
}
exports.ClaudeService = ClaudeService;
// ── Module-level convenience function ─────────────────────────────────
/**
 * Create a standalone callClaude function matching the original lib/claude.js API.
 *
 * Usage:
 *   const callClaude = createClaudeCaller(reqFn, { projectDir: '/path/to/repo' });
 *   const result = await callClaude('Explain this code', 180000);
 */
function createClaudeCaller(req, defaults) {
    const apiKey = defaults?.apiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
        throw new Error('createClaudeCaller: ANTHROPIC_API_KEY is required (set in env or pass as option)');
    }
    const service = new ClaudeService(apiKey, req);
    if (defaults?.projectDir) {
        service.setProjectDir(defaults.projectDir);
    }
    return (prompt, timeoutMs, opts) => {
        const mergedOpts = {
            model: defaults?.model,
            maxTokens: defaults?.maxTokens,
            systemPrompt: defaults?.systemPrompt,
            ...opts,
        };
        return service.callClaude(prompt, timeoutMs, mergedOpts);
    };
}
// =====================================================================
// ClaudeCLIService -- Fallback using `claude -p` CLI (browser auth)
// =====================================================================
// Used when ANTHROPIC_API_KEY is not set. Spawns the Claude Code CLI
// which authenticates via browser login (no API key needed).
//
// Implements the same callClaude(prompt, timeout, opts) interface as
// ClaudeService so it can be used as a drop-in replacement.
// =====================================================================
class ClaudeCLIService {
    model;
    constructor(opts) {
        this.model = opts?.model || process.env.CLAUDE_MODEL || undefined;
        (0, logger_1.logInfo)('[ClaudeCLI] Using `claude -p` CLI (browser auth, no API key)');
    }
    /**
     * Call Claude via the `claude -p` CLI.
     * Compatible with ClaudeService.callClaude() interface.
     */
    async callClaude(prompt, timeoutMs = 180_000, opts = {}) {
        const agentName = opts.agentName || 'Claude';
        const maxTurns = String(opts.maxTurns ?? 4);
        const validated = (0, utils_1.validatePromptSize)(prompt, agentName);
        const args = ['-p', '--output-format', 'text', '--max-turns', maxTurns];
        if (this.model)
            args.push('--model', this.model);
        const allowedTools = opts.allowedTools;
        if (allowedTools) {
            args.push('--allowedTools', allowedTools.join(','));
        }
        // Whitelist env vars for the subprocess
        const ALLOWED_ENV = [
            'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
            'NODE_PATH', 'NODE_OPTIONS', 'TMPDIR', 'XDG_CONFIG_HOME',
            'XDG_DATA_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL',
            'npm_config_prefix',
        ];
        const cleanEnv = {};
        for (const k of ALLOWED_ENV) {
            if (process.env[k])
                cleanEnv[k] = process.env[k];
        }
        const spawnOpts = {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: cleanEnv,
        };
        if (opts.projectDir)
            spawnOpts.cwd = opts.projectDir;
        (0, logger_1.logInfo)(`[${agentName}] CLI spawn: claude ${args.slice(0, 6).join(' ')}... ` +
            `(prompt=${validated.length} chars, timeout=${timeoutMs / 1000}s)`);
        return new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)('claude', args, spawnOpts);
            let stdout = '';
            let stderr = '';
            let done = false;
            const startTs = Date.now();
            // Timeout guard
            const timer = setTimeout(() => {
                if (!done) {
                    done = true;
                    try {
                        proc.kill('SIGTERM');
                    }
                    catch { /* swallow */ }
                    setTimeout(() => {
                        try {
                            proc.kill('SIGKILL');
                        }
                        catch { /* swallow */ }
                    }, 5_000);
                    reject(new Error(`[${agentName}] Claude CLI timed out after ${timeoutMs / 1000}s`));
                }
            }, timeoutMs);
            // Heartbeat logging
            const heartbeat = setInterval(() => {
                const elapsed = Math.round((Date.now() - startTs) / 1000);
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                (0, logger_1.logInfo)(`[${agentName}] Still running... ${mins}m ${secs}s ` +
                    `(stdout: ${stdout.length} chars)`);
            }, 30_000);
            proc.stdout?.on('data', (chunk) => {
                stdout += chunk.toString();
            });
            proc.stderr?.on('data', (chunk) => {
                stderr += chunk.toString();
                // Log errors as they come
                const line = chunk.toString().trim();
                if (line)
                    (0, logger_1.logDebug)(`[${agentName}] stderr: ${line.substring(0, 200)}`);
            });
            proc.on('close', (code) => {
                clearTimeout(timer);
                clearInterval(heartbeat);
                if (done)
                    return;
                done = true;
                const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
                if (code === 0 && stdout.trim()) {
                    (0, logger_1.logOk)(`[${agentName}] Done in ${elapsed}s ` +
                        `(${stdout.length} chars output)`);
                    resolve(stdout.trim());
                }
                else if (code === 0) {
                    reject(new Error(`[${agentName}] Claude CLI returned empty output`));
                }
                else {
                    const errSnippet = stderr.substring(0, 500) || '(no stderr)';
                    reject(new Error(`[${agentName}] Claude CLI exited with code ${code}: ${errSnippet}`));
                }
            });
            proc.on('error', (err) => {
                clearTimeout(timer);
                clearInterval(heartbeat);
                if (done)
                    return;
                done = true;
                reject(new Error(`[${agentName}] Claude CLI spawn failed: ${err.message}. ` +
                    `Is 'claude' installed and in PATH?`));
            });
            // Send prompt on stdin
            proc.stdin?.write(validated);
            proc.stdin?.end();
        });
    }
    /** No-op for CLI mode (project dir passed via cwd in callClaude opts) */
    setProjectDir(_dir) {
        // CLI mode uses cwd, not a project dir setter
    }
}
exports.ClaudeCLIService = ClaudeCLIService;
//# sourceMappingURL=claude.js.map