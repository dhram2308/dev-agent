// =====================================================================
// MI Dev Agent -- Claude Service (Anthropic API)
// =====================================================================
// Direct replacement for lib/claude.js which used `claude -p` CLI.
// Now uses the Anthropic Messages API over HTTPS.
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
// =====================================================================

import { logOk, logInfo, logWarn, logDebug } from '../lib/logger';
import { validatePromptSize, sleep } from '../lib/utils';
import { ToolExecutor, TOOL_DEFINITIONS } from '../agents/tool-executor';
import type { ToolDefinition, ToolResult } from '../agents/tool-executor';

// ── Types ────────────────────────────────────────────────────────────

export interface ClaudeOptions {
  /** Model to use (default: 'claude-sonnet-4-20250514') */
  model?: string;
  /** Max tokens in response (default: 16384) */
  maxTokens?: number;
  /** Tool definitions to make available to Claude */
  tools?: ToolDefinition[];
  /** System prompt to prepend */
  systemPrompt?: string;
  /** Temperature (0-1) */
  temperature?: number;
  /** Called periodically during long operations for state updates */
  onHeartbeat?: () => void;
  /** Agent name for logging (default: 'Claude') */
  agentName?: string;
  /** Maximum number of tool-use turns before stopping (default: 25) */
  maxTurns?: number;
  /** Whether to retry on timeout (default: true) */
  retry?: boolean;
  /** Working directory for tool executor */
  projectDir?: string;
}

/** Anthropic API content block types */
interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type ContentBlock = TextBlock | ToolUseBlock;

interface Message {
  role: 'user' | 'assistant';
  content: string | (ContentBlock | ToolResultBlock)[];
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * HTTP request function type -- will be provided by http/client.ts.
 */
type ReqFn = (url: string, opts: {
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}) => Promise<{
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}>;

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

export class ClaudeService {
  private readonly apiKey: string;
  private readonly req: ReqFn;
  private toolExecutor: ToolExecutor | null = null;

  constructor(apiKey: string, req: ReqFn) {
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
  setProjectDir(projectDir: string): void {
    this.toolExecutor = new ToolExecutor(projectDir);
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
  async callClaude(
    prompt: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    opts: ClaudeOptions = {},
  ): Promise<string> {
    const agentName = opts.agentName || 'Claude';
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    const retryEnabled = opts.retry !== false;
    const callStart = Date.now();

    // Set up project dir if provided
    if (opts.projectDir) {
      this.setProjectDir(opts.projectDir);
    }

    // Prompt size validation and logging
    const validatedPrompt = validatePromptSize(prompt, agentName);
    const promptChars = validatedPrompt.length;
    const estimatedTokens = Math.round(promptChars / 4);
    logInfo(
      `[${agentName}] Prompt: ${promptChars} chars (~${estimatedTokens} tokens) | ` +
      `Timeout: ${timeoutMs / 1000}s | MaxTurns: ${maxTurns}`,
    );
    if (promptChars > 100_000) {
      logWarn(`[${agentName}] Prompt exceeds 100K chars (${promptChars}) -- consider reducing context`);
    }

    try {
      const result = await this.callClaudeOnce(validatedPrompt, timeoutMs, opts);
      const elapsedSec = ((Date.now() - callStart) / 1000).toFixed(1);
      logOk(`[${agentName}] Complete in ${elapsedSec}s`);
      return result;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errMsg.includes('timed out') || errMsg.includes('timeout');

      if (isTimeout && retryEnabled) {
        const retryTimeout = Math.round(timeoutMs * 1.5);
        const retryMaxTurns = Math.max(2, Math.floor(maxTurns / 2));
        logWarn(
          `[${agentName}] Timeout -- retrying with ${retryTimeout / 1000}s timeout, ` +
          `${retryMaxTurns} maxTurns (degraded)`,
        );

        const retryResult = await this.callClaudeOnce(validatedPrompt, retryTimeout, {
          ...opts,
          maxTurns: retryMaxTurns,
        });
        const elapsedSec = ((Date.now() - callStart) / 1000).toFixed(1);
        logOk(`[${agentName}] Complete in ${elapsedSec}s (after retry)`);
        return retryResult;
      }

      throw err;
    }
  }

  // ── Single API call (no retry logic) ───────────────────────────────

  private async callClaudeOnce(
    prompt: string,
    timeoutMs: number,
    opts: ClaudeOptions = {},
  ): Promise<string> {
    const agentName = opts.agentName || 'Claude';
    const model = opts.model || process.env.CLAUDE_MODEL || DEFAULT_MODEL;
    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    const temperature = opts.temperature;
    const systemPrompt = opts.systemPrompt;
    const onHeartbeat = opts.onHeartbeat;

    // Build tool definitions
    const tools = opts.tools || (this.toolExecutor ? [...TOOL_DEFINITIONS] : []);

    // Start heartbeat
    const startTime = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      logInfo(`[${agentName}] Working... ${timeStr} elapsed`);
      if (onHeartbeat) {
        try { onHeartbeat(); } catch { /* swallow */ }
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Overall timeout guard
    const deadline = Date.now() + timeoutMs;

    try {
      // Initialize conversation
      const messages: Message[] = [
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
        logDebug(`[${agentName}] Turn ${turnCount}/${maxTurns}`);

        // Make API request
        const requestBody: Record<string, unknown> = {
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
        const textBlocks = response.content.filter(
          (block): block is TextBlock => block.type === 'text',
        );
        const toolUseBlocks = response.content.filter(
          (block): block is ToolUseBlock => block.type === 'tool_use',
        );

        // Accumulate text
        for (const block of textBlocks) {
          accumulatedText += block.text;
          if (accumulatedText.length > MAX_RESPONSE_TEXT) {
            logWarn(`[${agentName}] Response text exceeds ${MAX_RESPONSE_TEXT} bytes -- truncating`);
            accumulatedText = accumulatedText.substring(0, MAX_RESPONSE_TEXT);
            break;
          }
        }

        // Log usage
        logDebug(
          `[${agentName}] Turn ${turnCount}: ${response.usage.input_tokens} in / ` +
          `${response.usage.output_tokens} out | stop_reason: ${response.stop_reason}`,
        );

        // If stop_reason is not tool_use, we're done
        if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
          if (response.stop_reason === 'max_tokens') {
            logWarn(`[${agentName}] Response was truncated (max_tokens reached)`);
          }
          break;
        }

        // Execute tool calls
        if (!this.toolExecutor) {
          logWarn(`[${agentName}] Claude requested tool use but no ToolExecutor configured -- stopping`);
          break;
        }

        // Add assistant message to conversation
        messages.push({
          role: 'assistant',
          content: response.content,
        });

        // Execute each tool and collect results
        const toolResults: ToolResultBlock[] = [];
        for (const toolUse of toolUseBlocks) {
          logDebug(`[${agentName}] Executing tool: ${toolUse.name}`);
          const toolStart = Date.now();

          let result: ToolResult;
          try {
            result = await this.toolExecutor.execute(toolUse.name, toolUse.input);
          } catch (toolErr: unknown) {
            const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            result = { success: false, output: '', error: errMsg };
          }

          const toolElapsed = Date.now() - toolStart;
          const outputPreview = (result.output || result.error || '').substring(0, 200);
          logDebug(
            `[${agentName}] Tool ${toolUse.name}: ${result.success ? 'OK' : 'FAIL'} ` +
            `(${toolElapsed}ms) -- ${outputPreview}`,
          );

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
        logWarn(`[${agentName}] Reached maximum turns (${maxTurns}) -- returning accumulated text`);
      }

      return accumulatedText.trim();
    } finally {
      clearInterval(heartbeat);
    }
  }

  // ── API Request ────────────────────────────────────────────────────

  /**
   * Make a single request to the Anthropic Messages API.
   */
  private async makeApiRequest(
    body: Record<string, unknown>,
    timeoutMs: number,
    agentName: string,
  ): Promise<AnthropicResponse> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    };

    const start = Date.now();
    let response: { status: number; data: unknown; headers?: Record<string, string> };

    try {
      response = await this.req(ANTHROPIC_API_URL, {
        method: 'POST',
        body,
        headers,
        timeoutMs: Math.min(timeoutMs, 300_000), // Cap per-request timeout at 5min
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[${agentName}] Anthropic API request failed: ${msg}`);
    }

    const latency = Date.now() - start;
    logDebug(`[${agentName}] API response: ${response.status} (${latency}ms)`);

    // Handle error responses
    if (response.status !== 200) {
      const errorData = response.data as Record<string, unknown> | string;
      let errorMessage: string;

      if (typeof errorData === 'object' && errorData?.error) {
        const apiError = errorData.error as Record<string, unknown>;
        errorMessage = `${apiError.type || 'error'}: ${apiError.message || JSON.stringify(apiError)}`;
      } else if (typeof errorData === 'string') {
        errorMessage = errorData.substring(0, 500);
      } else {
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
        logWarn(`[${agentName}] Rate limited (429) -- waiting ${retryAfter / 1000}s`);
        await sleep(retryAfter);
        // Retry once
        return this.makeApiRequest(body, timeoutMs - (Date.now() - start), agentName);
      }
      if (response.status === 529) {
        // API overloaded
        logWarn(`[${agentName}] API overloaded (529) -- waiting 60s`);
        await sleep(60_000);
        return this.makeApiRequest(body, timeoutMs - (Date.now() - start), agentName);
      }

      throw new Error(`[${agentName}] Anthropic API error (${response.status}): ${errorMessage}`);
    }

    // Validate response structure
    const data = response.data as AnthropicResponse;
    if (!data || !data.content || !Array.isArray(data.content)) {
      throw new Error(`[${agentName}] Invalid Anthropic API response: missing content array`);
    }

    return data;
  }

  // ── Accessors ──────────────────────────────────────────────────────

  /** Check if the API key is configured. */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /** Get the tool executor instance. */
  getToolExecutor(): ToolExecutor | null {
    return this.toolExecutor;
  }
}

// ── Module-level convenience function ─────────────────────────────────

/**
 * Create a standalone callClaude function matching the original lib/claude.js API.
 *
 * Usage:
 *   const callClaude = createClaudeCaller(reqFn, { projectDir: '/path/to/repo' });
 *   const result = await callClaude('Explain this code', 180000);
 */
export function createClaudeCaller(
  req: ReqFn,
  defaults?: {
    apiKey?: string;
    projectDir?: string;
    model?: string;
    maxTokens?: number;
    systemPrompt?: string;
  },
): (prompt: string, timeoutMs?: number, opts?: ClaudeOptions) => Promise<string> {
  const apiKey = defaults?.apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    throw new Error('createClaudeCaller: ANTHROPIC_API_KEY is required (set in env or pass as option)');
  }

  const service = new ClaudeService(apiKey, req);
  if (defaults?.projectDir) {
    service.setProjectDir(defaults.projectDir);
  }

  return (prompt: string, timeoutMs?: number, opts?: ClaudeOptions) => {
    const mergedOpts: ClaudeOptions = {
      model: defaults?.model,
      maxTokens: defaults?.maxTokens,
      systemPrompt: defaults?.systemPrompt,
      ...opts,
    };
    return service.callClaude(prompt, timeoutMs, mergedOpts);
  };
}
