// ═══════════════════════════════════════════════════════════════
// server/playground-process.ts — Playground run process management
// Sibling to agent-process.ts, mirroring its spawn/SSE-injection/
// redaction patterns, but for single-stage Playground runs instead
// of full per-ticket pipelines: no worktree, no OAuth token
// injection, no crash-loop/restart-protection — a Playground run is
// a short-lived, single-shot child process.
// ═══════════════════════════════════════════════════════════════

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

import type { ProcessRedactorHandle } from '@mi/shared';

// SSE module resolved lazily so the host (packages/backend) can inject its
// own implementation before any run starts — same rationale as agent-process.ts.
type SseLike = {
  addLog: (line: string, type: string, ticket: string) => void;
  broadcast: (event: string, data: unknown) => void;
};

let _sseModule: SseLike | null = null;

function _loadDefaultSse(): SseLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./sse') as SseLike;
}

function _sse(): SseLike {
  if (!_sseModule) _sseModule = _loadDefaultSse();
  return _sseModule;
}

export function setSseModule(mod: SseLike): void {
  _sseModule = mod;
}

const { wrapProcessOutput, setProcessRedactor } = require('../lib/process-redactor') as {
  wrapProcessOutput: (proc: ChildProcess, opts: {
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
    onBinaryDetected?: (stream: string) => void;
  }) => ProcessRedactorHandle;
  setProcessRedactor: (fn: (s: string) => string) => void;
};
const { redactAll } = require('../lib/redaction') as { redactAll: (s: string) => string };
// Idempotent: agent-process.ts (same process) may already have set this.
setProcessRedactor(redactAll);

const { trackChildProcess, untrackChildProcess } = require('../lib/graceful-shutdown') as {
  trackChildProcess: (proc: ChildProcess, name?: string) => ChildProcess | undefined;
  untrackChildProcess: (proc: ChildProcess) => void;
};

// Navigate to project root: at runtime __dirname is packages/agent/dist/server/
const BASE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
const PLAYGROUND_STATE_DIR = path.join(BASE_DIR, '.state', 'playground');

const MAX_CONCURRENT_PLAYGROUND_RUNS = parseInt(process.env.PLAYGROUND_MAX_CONCURRENT_RUNS as string, 10) || 3;

/**
 * Belt-and-suspenders wall-clock cap per run. `generate_code`'s own
 * `callClaude` timeout (600s) is the primary circuit breaker; this covers
 * anything outside that call — e.g. `ensureLocalRepo()` hanging on a slow
 * git fetch — so a Playground run can never hang indefinitely and leak a
 * child process or a permanently "running" UI state.
 */
const PLAYGROUND_MAX_RUNTIME_MS = parseInt(process.env.PLAYGROUND_MAX_RUNTIME_MS as string, 10) || 900_000;

/**
 * Stages actually wired for real execution. Deliberately narrower than the
 * broader UI-facing stage whitelist in routes.ts (which also allows
 * fetch_ticket so the picker can show it ahead of its own real-execution
 * phase) — routes.ts falls back to the stub echo for any allowed stage not
 * yet in this set.
 */
const PLAYGROUND_WIRED_STAGES = new Set<string>(['fetch_ticket', 'explore_plan', 'generate_code']);

interface PlaygroundRunEntry {
  proc: ChildProcess;
  redactor: ProcessRedactorHandle;
  stage: string;
  ticket: string | null;
  resultEmitted: boolean;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

const playgroundProcs: Record<string, PlaygroundRunEntry> = {};

function writeRunFile(runId: string, patch: Record<string, unknown>): void {
  try {
    fs.mkdirSync(PLAYGROUND_STATE_DIR, { recursive: true });
    const filePath = path.join(PLAYGROUND_STATE_DIR, `${runId}.json`);
    const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
    fs.writeFileSync(filePath, JSON.stringify({ ...existing, ...patch }, null, 2));
  } catch (e: unknown) {
    console.warn(`[Playground] Failed to persist run ${runId}:`, e instanceof Error ? e.message : String(e));
  }
}

export interface StartPlaygroundRunOptions {
  runId: string;
  stage: string;
  ticket?: string | null;
  customInstruction?: string;
}

export interface StartPlaygroundRunResult {
  ok: boolean;
  error?: string;
}

function startPlaygroundRun(opts: StartPlaygroundRunOptions): StartPlaygroundRunResult {
  const { runId, stage, ticket = null, customInstruction = '' } = opts;

  if (playgroundProcs[runId]) return { ok: false, error: `Run ${runId} already exists` };
  if (Object.keys(playgroundProcs).length >= MAX_CONCURRENT_PLAYGROUND_RUNS) {
    return { ok: false, error: `Max concurrent Playground runs reached (${MAX_CONCURRENT_PLAYGROUND_RUNS})` };
  }
  if (!PLAYGROUND_WIRED_STAGES.has(stage)) {
    return { ok: false, error: `Stage "${stage}" is not yet wired for real execution` };
  }

  try {
    const envVars: Record<string, string | undefined> = {
      ...process.env,
      PLAYGROUND_RUN_ID: runId,
      PLAYGROUND_STAGE: stage,
      PLAYGROUND_TICKET: ticket || '',
      PLAYGROUND_INSTRUCTION: customInstruction || '',
    };

    const proc = spawn('node', [path.join(BASE_DIR, 'run-playground.js')], {
      env: envVars,
      cwd: BASE_DIR,
    });

    trackChildProcess(proc, `playground-${runId}`);

    const timeoutTimer = setTimeout(() => {
      console.warn(`[Playground] Run ${runId} exceeded ${PLAYGROUND_MAX_RUNTIME_MS}ms — killing`);
      proc.kill('SIGKILL');
    }, PLAYGROUND_MAX_RUNTIME_MS);
    timeoutTimer.unref();

    const entry: PlaygroundRunEntry = {
      proc,
      // Placeholder — replaced immediately below once wrapProcessOutput returns.
      redactor: { cleanup: () => {} },
      stage,
      ticket,
      resultEmitted: false,
      timeoutTimer,
    };
    playgroundProcs[runId] = entry;

    entry.redactor = wrapProcessOutput(proc, {
      onStdoutLine(line: string) {
        const resultMatch = line.match(/^PLAYGROUND_RESULT:(.*)$/);
        if (resultMatch) {
          entry.resultEmitted = true;
          try {
            const result = JSON.parse(resultMatch[1]) as { ok: boolean; summary?: string; error?: string };
            const status = result.ok ? 'completed' : 'failed';
            const resultSummary = result.ok ? result.summary : result.error;
            _sse().broadcast('playground:status', { runId, status, stage, ticket, resultSummary });
            writeRunFile(runId, { status, finishedAt: Date.now(), resultSummary });
          } catch {
            // Malformed result line — ignore, close handler covers final status.
          }
          return;
        }
        _sse().broadcast('playground:log', { runId, level: 'info', message: line });
      },
      onStderrLine(line: string) {
        _sse().broadcast('playground:log', { runId, level: 'error', message: line });
      },
      onBinaryDetected(stream: string) {
        _sse().broadcast('playground:log', {
          runId, level: 'warn', message: `[${stream}] Binary data detected — redaction skipped for binary content`,
        });
      },
    });

    _sse().broadcast('playground:status', { runId, status: 'running', stage, ticket });
    writeRunFile(runId, {
      runId, stage, ticket, customInstruction, startedAt: Date.now(), finishedAt: null, status: 'running', resultSummary: null,
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(entry.timeoutTimer);
      untrackChildProcess(proc);
      try { entry.redactor.cleanup(); } catch (e: unknown) {
        console.warn('[Playground] redactor cleanup error:', e instanceof Error ? e.message : String(e));
      }
      delete playgroundProcs[runId];
      if (!entry.resultEmitted) {
        // Process exited without ever printing a PLAYGROUND_RESULT line
        // (e.g. crashed) — don't leave the UI stuck on "running".
        const resultSummary = `Process exited with code ${code}`;
        _sse().broadcast('playground:status', { runId, status: 'failed', stage, ticket, resultSummary });
        writeRunFile(runId, { status: 'failed', finishedAt: Date.now(), resultSummary });
      }
    });

    return { ok: true };
  } catch (err: unknown) {
    delete playgroundProcs[runId];
    return { ok: false, error: 'Failed to start Playground run: ' + (err instanceof Error ? err.message : String(err)) };
  }
}

function stopPlaygroundRun(runId: string): StartPlaygroundRunResult {
  const entry = playgroundProcs[runId];
  if (!entry) return { ok: false, error: `No running Playground run ${runId}` };
  clearTimeout(entry.timeoutTimer);
  entry.proc.kill('SIGTERM');
  _sse().broadcast('playground:status', { runId, status: 'stopped', stage: entry.stage, ticket: entry.ticket });
  writeRunFile(runId, { status: 'stopped', finishedAt: Date.now() });
  return { ok: true };
}

function getPlaygroundProcs(): Record<string, ChildProcess> {
  const out: Record<string, ChildProcess> = {};
  for (const [id, entry] of Object.entries(playgroundProcs)) out[id] = entry.proc;
  return out;
}

export {
  startPlaygroundRun,
  stopPlaygroundRun,
  getPlaygroundProcs,
  PLAYGROUND_WIRED_STAGES,
};
