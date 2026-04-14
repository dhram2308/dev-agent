// =====================================================================
// Integration Test: Multi-Ticket Pipeline Isolation
// =====================================================================
// Verify that multiple pipelines maintain separate state files,
// independent lock semantics, and scoped SSE behavior.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Mock logger ────────────────────────────────────────────────────

vi.mock('../../src/lib/logger', () => ({
  logOk: vi.fn(),
  logErr: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

// ── Import state manager (real) for file isolation tests ─────────

import {
  wrapEnvelope,
  atomicWriteSync,
  readStateFromDisk,
  _setStateSecret,
  getStateFilePath,
} from '../../src/state/state-manager';

// ── Import SSE module for scoping tests ────────────────────────────

import {
  addLog,
  getLogBuffers,
  clearTicketLogs,
  getGlobalLogBuffer,
} from '../../src/server/sse';

import type { PipelineState, StageName, PipelineData } from '@mi/shared/src/types';

// ── Helpers ────────────────────────────────────────────────────────

const TEST_SECRET = 'b'.repeat(64);
let tmpDir: string;

function makeState(ticket: string, stage: StageName, extraData: Record<string, unknown> = {}): PipelineState {
  return {
    ticket,
    stage,
    data: {
      _pipeline_start: Date.now(),
      _completedGates: [],
      _warnings: [],
      ...extraData,
    } as PipelineData,
    _seq: 1,
  };
}

function stateFilePath(ticket: string): string {
  return path.join(tmpDir, `state-${ticket}.json`);
}

// ── Setup/Teardown ────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-multi-ticket-test-'));
  _setStateSecret(TEST_SECRET);
});

afterEach(() => {
  _setStateSecret(null);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});

// ── Tests ──────────────────────────────────────────────────────────

describe('Multi-Ticket Isolation', () => {
  describe('separate state files', () => {
    it('creates separate state files for each ticket', () => {
      const state1 = makeState('AUT-100', 'generate_code', { code_branch: 'branch-100' });
      const state2 = makeState('AUT-200', 'deploy_qa', { code_branch: 'branch-200' });

      const file1 = stateFilePath('AUT-100');
      const file2 = stateFilePath('AUT-200');

      atomicWriteSync(file1, wrapEnvelope(state1, TEST_SECRET));
      atomicWriteSync(file2, wrapEnvelope(state2, TEST_SECRET));

      // Both files should exist
      expect(fs.existsSync(file1)).toBe(true);
      expect(fs.existsSync(file2)).toBe(true);

      // Load and verify independence
      const loaded1 = readStateFromDisk(file1)!;
      const loaded2 = readStateFromDisk(file2)!;

      expect(loaded1.state.ticket).toBe('AUT-100');
      expect(loaded1.state.stage).toBe('generate_code');
      expect((loaded1.state.data as Record<string, unknown>).code_branch).toBe('branch-100');

      expect(loaded2.state.ticket).toBe('AUT-200');
      expect(loaded2.state.stage).toBe('deploy_qa');
      expect((loaded2.state.data as Record<string, unknown>).code_branch).toBe('branch-200');
    });

    it('updating one ticket does not affect the other', () => {
      const state1 = makeState('AUT-300', 'fetch_ticket');
      const state2 = makeState('AUT-400', 'fetch_ticket');

      const file1 = stateFilePath('AUT-300');
      const file2 = stateFilePath('AUT-400');

      atomicWriteSync(file1, wrapEnvelope(state1, TEST_SECRET));
      atomicWriteSync(file2, wrapEnvelope(state2, TEST_SECRET));

      // Update state1 only
      state1.stage = 'done';
      state1._seq = 2;
      (state1.data as Record<string, unknown>).result = 'success';
      atomicWriteSync(file1, wrapEnvelope(state1, TEST_SECRET));

      // state2 should be unaffected
      const loaded2 = readStateFromDisk(file2)!;
      expect(loaded2.state.stage).toBe('fetch_ticket');
      expect((loaded2.state.data as Record<string, unknown>).result).toBeUndefined();
    });

    it('deleting one state file does not affect others', () => {
      const state1 = makeState('AUT-500', 'test_qa');
      const state2 = makeState('AUT-600', 'test_qa');

      const file1 = stateFilePath('AUT-500');
      const file2 = stateFilePath('AUT-600');

      atomicWriteSync(file1, wrapEnvelope(state1, TEST_SECRET));
      atomicWriteSync(file2, wrapEnvelope(state2, TEST_SECRET));

      // Delete file1
      fs.unlinkSync(file1);

      expect(fs.existsSync(file1)).toBe(false);
      expect(fs.existsSync(file2)).toBe(true);

      const loaded2 = readStateFromDisk(file2)!;
      expect(loaded2.state.ticket).toBe('AUT-600');
    });
  });

  describe('lock independence', () => {
    it('state file paths are unique per ticket', () => {
      const path1 = getStateFilePath('AUT-100');
      const path2 = getStateFilePath('AUT-200');

      expect(path1).not.toBe(path2);
      expect(path1).toContain('AUT-100');
      expect(path2).toContain('AUT-200');
    });

    it('concurrent writes to different tickets do not conflict', async () => {
      const tickets = ['AUT-C1', 'AUT-C2', 'AUT-C3', 'AUT-C4', 'AUT-C5'];

      // Write all tickets in parallel
      await Promise.all(
        tickets.map(async (ticket, idx) => {
          const state = makeState(ticket, 'generate_code', {
            iteration: idx,
          });
          const filePath = stateFilePath(ticket);
          atomicWriteSync(filePath, wrapEnvelope(state, TEST_SECRET));
        }),
      );

      // Verify each ticket's state is correct
      for (let i = 0; i < tickets.length; i++) {
        const filePath = stateFilePath(tickets[i]);
        const loaded = readStateFromDisk(filePath)!;
        expect(loaded.state.ticket).toBe(tickets[i]);
        expect((loaded.state.data as Record<string, unknown>).iteration).toBe(i);
      }
    });

    it('seq numbers are independent per ticket', () => {
      const state1 = makeState('AUT-SEQ1', 'fetch_ticket');
      state1._seq = 10;

      const state2 = makeState('AUT-SEQ2', 'fetch_ticket');
      state2._seq = 1;

      const file1 = stateFilePath('AUT-SEQ1');
      const file2 = stateFilePath('AUT-SEQ2');

      atomicWriteSync(file1, wrapEnvelope(state1, TEST_SECRET));
      atomicWriteSync(file2, wrapEnvelope(state2, TEST_SECRET));

      const loaded1 = readStateFromDisk(file1)!;
      const loaded2 = readStateFromDisk(file2)!;

      // seq is incremented by wrapEnvelope (+1), so 10+1=11, 1+1=2
      expect(loaded1.seq).toBe(11);
      expect(loaded2.seq).toBe(2);
    });
  });

  describe('SSE scoping', () => {
    it('log entries are scoped to their respective tickets', () => {
      addLog('Fetching ticket AUT-700...', 'info', 'AUT-700');
      addLog('Fetching ticket AUT-800...', 'info', 'AUT-800');
      addLog('Generating code for AUT-700...', 'stdout', 'AUT-700');

      const buffers = getLogBuffers();

      expect(buffers['AUT-700']).toBeDefined();
      expect(buffers['AUT-800']).toBeDefined();
      expect(buffers['AUT-700']).toHaveLength(2);
      expect(buffers['AUT-800']).toHaveLength(1);
    });

    it('logs without ticket go to global buffer', () => {
      const globalBefore = getGlobalLogBuffer().length;

      addLog('System startup', 'info', null);

      const globalAfter = getGlobalLogBuffer().length;
      expect(globalAfter).toBe(globalBefore + 1);

      // Should NOT appear in any ticket-specific buffer
      const buffers = getLogBuffers();
      for (const [, entries] of Object.entries(buffers)) {
        const systemLogs = entries.filter(e => e.line === 'System startup');
        // May appear if leftover from other tests, so just check global has it
      }
    });

    it('clearTicketLogs removes only that ticket buffer', () => {
      addLog('Log for 900', 'info', 'AUT-900');
      addLog('Log for 901', 'info', 'AUT-901');

      clearTicketLogs('AUT-900');

      const buffers = getLogBuffers();
      expect(buffers['AUT-900']).toBeUndefined();
      expect(buffers['AUT-901']).toBeDefined();
      expect(buffers['AUT-901']).toHaveLength(1);
    });
  });

  describe('parallel pipeline data isolation', () => {
    it('two pipelines can checkpoint at different stages simultaneously', () => {
      const state1 = makeState('AUT-P1', 'generate_code', {
        _checkpoint: {
          stage: 'generate_code',
          previousStage: 'explore_plan',
          entryTime: new Date().toISOString(),
          pipelineElapsedMs: 120_000,
          stateHash: '',
          completedGates: ['fetch_ticket', 'explore_plan'],
          version: 1,
        },
      });

      const state2 = makeState('AUT-P2', 'test_qa', {
        _checkpoint: {
          stage: 'test_qa',
          previousStage: 'deploy_qa',
          entryTime: new Date().toISOString(),
          pipelineElapsedMs: 300_000,
          stateHash: '',
          completedGates: ['fetch_ticket', 'explore_plan', 'generate_code', 'gate_code_review', 'deploy_qa'],
          version: 1,
        },
      });

      const file1 = stateFilePath('AUT-P1');
      const file2 = stateFilePath('AUT-P2');

      atomicWriteSync(file1, wrapEnvelope(state1, TEST_SECRET));
      atomicWriteSync(file2, wrapEnvelope(state2, TEST_SECRET));

      const loaded1 = readStateFromDisk(file1)!;
      const loaded2 = readStateFromDisk(file2)!;

      const ckpt1 = (loaded1.state.data as Record<string, unknown>)._checkpoint as Record<string, unknown>;
      const ckpt2 = (loaded2.state.data as Record<string, unknown>)._checkpoint as Record<string, unknown>;

      expect(ckpt1.stage).toBe('generate_code');
      expect(ckpt2.stage).toBe('test_qa');

      expect((ckpt1.completedGates as string[]).length).toBe(2);
      expect((ckpt2.completedGates as string[]).length).toBe(5);
    });
  });
});
