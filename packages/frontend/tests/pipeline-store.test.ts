// =====================================================================
// Pipeline Store (Zustand) Tests
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import type { PipelineState, StageName, LogEntry } from '../src/types';

// ── Mock the API module ───────────────────────────────────────────

const mockApiStartAgent = vi.fn();
const mockApiStopAgent = vi.fn();
const mockApiResetAgent = vi.fn();
const mockApiApproveGate = vi.fn();
const mockApiRejectGate = vi.fn();

vi.mock('../src/lib/api', () => ({
  startAgent: (...args: unknown[]) => mockApiStartAgent(...args),
  stopAgent: (...args: unknown[]) => mockApiStopAgent(...args),
  resetAgent: (...args: unknown[]) => mockApiResetAgent(...args),
  approveGate: (...args: unknown[]) => mockApiApproveGate(...args),
  rejectGate: (...args: unknown[]) => mockApiRejectGate(...args),
}));

// Import store after mocking
import { usePipelineStore } from '../src/store/pipeline';

// ── Helpers ────────────────────────────────────────────────────────

function getStore() {
  return usePipelineStore.getState();
}

function resetStore() {
  usePipelineStore.setState({
    tickets: new Map(),
    activeTicket: null,
    sseConnected: false,
    sseRetryCount: 0,
    lastHeartbeat: null,
    reviewData: null,
  });
}

function makeLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: `log-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    level: 'info',
    message: 'test log',
    ...overrides,
  };
}

function makePipelineState(ticket: string, stage: StageName, data: Record<string, unknown> = {}): PipelineState {
  return { ticket, stage, data };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Pipeline Store', () => {
  beforeEach(() => {
    resetStore();
    mockApiStartAgent.mockReset().mockResolvedValue({ ok: true });
    mockApiStopAgent.mockReset().mockResolvedValue({ ok: true });
    mockApiResetAgent.mockReset().mockResolvedValue({ ok: true });
    mockApiApproveGate.mockReset().mockResolvedValue({ ok: true });
    mockApiRejectGate.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Multi-ticket isolation ──────────────────────────────────

  describe('multi-ticket isolation', () => {
    it('maintains separate state per ticket', () => {
      const store = getStore();

      act(() => {
        store.addTicket('AUT-100');
        store.addTicket('AUT-200');
      });

      const { tickets } = getStore();
      expect(tickets.size).toBe(2);
      expect(tickets.get('AUT-100')?.ticket).toBe('AUT-100');
      expect(tickets.get('AUT-200')?.ticket).toBe('AUT-200');
    });

    it('does not duplicate tickets when adding same ticket twice', () => {
      const store = getStore();

      act(() => {
        store.addTicket('AUT-100');
        store.addTicket('AUT-100');
      });

      expect(getStore().tickets.size).toBe(1);
    });

    it('sets the active ticket when adding a new ticket', () => {
      const store = getStore();

      act(() => {
        store.addTicket('AUT-100');
      });

      expect(getStore().activeTicket).toBe('AUT-100');
    });

    it('switches active ticket to next available when removing the active one', () => {
      const store = getStore();

      act(() => {
        store.addTicket('AUT-100');
        store.addTicket('AUT-200');
      });

      expect(getStore().activeTicket).toBe('AUT-200');

      act(() => {
        getStore().removeTicket('AUT-200');
      });

      expect(getStore().activeTicket).toBe('AUT-100');
    });

    it('sets activeTicket to null when all tickets are removed', () => {
      const store = getStore();

      act(() => {
        store.addTicket('AUT-100');
        store.removeTicket('AUT-100');
      });

      expect(getStore().activeTicket).toBeNull();
    });

    it('logs are isolated per ticket', () => {
      const store = getStore();

      act(() => {
        store.addTicket('AUT-100');
        store.addTicket('AUT-200');
      });

      act(() => {
        getStore().addLog(makeLogEntry({ ticket: 'AUT-100', message: 'log for 100' }));
        getStore().addLog(makeLogEntry({ ticket: 'AUT-200', message: 'log for 200' }));
      });

      const { tickets } = getStore();
      expect(tickets.get('AUT-100')?.logs).toHaveLength(1);
      expect(tickets.get('AUT-100')?.logs[0].message).toBe('log for 100');
      expect(tickets.get('AUT-200')?.logs).toHaveLength(1);
      expect(tickets.get('AUT-200')?.logs[0].message).toBe('log for 200');
    });
  });

  // ── addLog caps at 5000 ──────────────────────────────────────

  describe('addLog caps at 5000', () => {
    it('caps log entries at MAX_LOG_ENTRIES (5000)', () => {
      const store = getStore();

      act(() => {
        store.addTicket('AUT-100');
      });

      // Add 5010 logs
      act(() => {
        for (let i = 0; i < 5010; i++) {
          getStore().addLog(makeLogEntry({ ticket: 'AUT-100', message: `log-${i}` }));
        }
      });

      const logs = getStore().tickets.get('AUT-100')?.logs;
      expect(logs).toHaveLength(5000);

      // Should keep the most recent entries, not the oldest
      expect(logs![0].message).toBe('log-10');
      expect(logs![4999].message).toBe('log-5009');
    });

    it('addLogBatch also caps at 5000', () => {
      const store = getStore();

      act(() => {
        store.addTicket('AUT-100');
      });

      // Add batch that exceeds cap
      const batch: LogEntry[] = [];
      for (let i = 0; i < 5010; i++) {
        batch.push(makeLogEntry({ ticket: 'AUT-100', message: `batch-${i}` }));
      }

      act(() => {
        getStore().addLogBatch(batch);
      });

      const logs = getStore().tickets.get('AUT-100')?.logs;
      expect(logs).toHaveLength(5000);
    });
  });

  // ── updateState ──────────────────────────────────────────────

  describe('updateState', () => {
    it('updates the correct ticket state', () => {
      const store = getStore();

      act(() => {
        store.addTicket('AUT-100');
        store.addTicket('AUT-200');
      });

      act(() => {
        getStore().updateState(makePipelineState('AUT-100', 'generate_code', {
          _pipeline_start: 12345,
        }));
      });

      const t100 = getStore().tickets.get('AUT-100');
      expect(t100?.stage).toBe('generate_code');
      expect(t100?.state?.stage).toBe('generate_code');

      // AUT-200 should be unchanged
      const t200 = getStore().tickets.get('AUT-200');
      expect(t200?.stage).toBe('fetch_ticket');
    });

    it('creates ticket state if it does not exist', () => {
      act(() => {
        getStore().updateState(makePipelineState('AUT-300', 'deploy_qa', {
          _pipeline_start: 1,
        }));
      });

      const t300 = getStore().tickets.get('AUT-300');
      expect(t300).toBeDefined();
      expect(t300?.stage).toBe('deploy_qa');
    });

    it('updates stageStartedAt when stage changes', () => {
      const store = getStore();

      act(() => {
        store.addTicket('AUT-100');
        store.updateState(makePipelineState('AUT-100', 'fetch_ticket', {
          _pipeline_start: 1,
        }));
      });

      // First updateState with same stage as addTicket default => no stage change
      // stageStartedAt may still be null
      const firstStageStart = getStore().tickets.get('AUT-100')?.stageStartedAt;

      act(() => {
        getStore().updateState(makePipelineState('AUT-100', 'generate_code', {
          _pipeline_start: 1,
        }));
      });

      const secondStageStart = getStore().tickets.get('AUT-100')?.stageStartedAt;
      // Stage changed from fetch_ticket -> generate_code, so stageStartedAt should be set
      expect(secondStageStart).toBeTypeOf('number');
      // If firstStageStart was set, second should be >= first
      if (typeof firstStageStart === 'number') {
        expect(secondStageStart).toBeGreaterThanOrEqual(firstStageStart);
      }
    });

    it('sets isRunning=false when stage is "done"', () => {
      const store = getStore();

      act(() => {
        store.addTicket('AUT-100');
        store.updateState(makePipelineState('AUT-100', 'done', {
          _pipeline_start: 1,
        }));
      });

      expect(getStore().tickets.get('AUT-100')?.isRunning).toBe(false);
    });

    it('ignores state updates without a ticket', () => {
      const sizeBefore = getStore().tickets.size;

      act(() => {
        getStore().updateState({
          ticket: '',
          stage: 'done',
          data: {},
        });
      });

      expect(getStore().tickets.size).toBe(sizeBefore);
    });
  });

  // ── startAgent ──────────────────────────────────────────────

  describe('startAgent', () => {
    it('calls api.startAgent with the ticket', async () => {
      await act(async () => {
        await getStore().startAgent('AUT-100');
      });

      expect(mockApiStartAgent).toHaveBeenCalledTimes(1);
      expect(mockApiStartAgent).toHaveBeenCalledWith('AUT-100', undefined);
    });

    it('sets the ticket to running state after successful API call', async () => {
      await act(async () => {
        await getStore().startAgent('AUT-100');
      });

      const ticket = getStore().tickets.get('AUT-100');
      expect(ticket?.isRunning).toBe(true);
      expect(ticket?.pipelineStartedAt).toBeGreaterThan(0);
      expect(ticket?.error).toBeNull();
    });

    it('sets the active ticket', async () => {
      await act(async () => {
        await getStore().startAgent('AUT-100');
      });

      expect(getStore().activeTicket).toBe('AUT-100');
    });

    it('sets error on API failure', async () => {
      mockApiStartAgent.mockRejectedValueOnce(new Error('Network error'));

      await act(async () => {
        await getStore().startAgent('AUT-100');
      });

      expect(getStore().tickets.get('AUT-100')?.error).toBe('Network error');
    });

    it('creates ticket if it does not exist before calling API', async () => {
      await act(async () => {
        await getStore().startAgent('AUT-NEW');
      });

      expect(getStore().tickets.has('AUT-NEW')).toBe(true);
    });
  });

  // ── Gate detection ──────────────────────────────────────────

  describe('gate detection', () => {
    it('detects gate_code_review waiting', () => {
      act(() => {
        getStore().addTicket('AUT-100');
        getStore().updateState(makePipelineState('AUT-100', 'gate_code_review', {
          _pipeline_start: 1,
        }));
      });

      expect(getStore().tickets.get('AUT-100')?.gateWaiting).toBe('gate_code_review');
    });

    it('does not detect gate when _ui_approve_gate is set', () => {
      act(() => {
        getStore().addTicket('AUT-100');
        getStore().updateState(makePipelineState('AUT-100', 'gate_code_review', {
          _pipeline_start: 1,
          _ui_approve_gate: 'approved',
        }));
      });

      expect(getStore().tickets.get('AUT-100')?.gateWaiting).toBeNull();
    });

    it('detects explore_plan gate when plan data exists', () => {
      act(() => {
        getStore().addTicket('AUT-100');
        getStore().updateState(makePipelineState('AUT-100', 'explore_plan', {
          _pipeline_start: 1,
          explore_plan: 'The plan',
        }));
      });

      expect(getStore().tickets.get('AUT-100')?.gateWaiting).toBe('explore_plan');
    });

    it('does not detect explore_plan gate when no plan data', () => {
      act(() => {
        getStore().addTicket('AUT-100');
        getStore().updateState(makePipelineState('AUT-100', 'explore_plan', {
          _pipeline_start: 1,
        }));
      });

      expect(getStore().tickets.get('AUT-100')?.gateWaiting).toBeNull();
    });

    it('detects gate_preprod_approval waiting', () => {
      act(() => {
        getStore().addTicket('AUT-100');
        getStore().updateState(makePipelineState('AUT-100', 'gate_preprod_approval', {
          _pipeline_start: 1,
        }));
      });

      expect(getStore().tickets.get('AUT-100')?.gateWaiting).toBe('gate_preprod_approval');
    });

    it('detects gate_dual_approval waiting', () => {
      act(() => {
        getStore().addTicket('AUT-100');
        getStore().updateState(makePipelineState('AUT-100', 'gate_dual_approval', {
          _pipeline_start: 1,
        }));
      });

      expect(getStore().tickets.get('AUT-100')?.gateWaiting).toBe('gate_dual_approval');
    });

    it('clears gate when _ui_approve_dual is set', () => {
      act(() => {
        getStore().addTicket('AUT-100');
        getStore().updateState(makePipelineState('AUT-100', 'gate_dual_approval', {
          _pipeline_start: 1,
          _ui_approve_dual: 'approved',
        }));
      });

      expect(getStore().tickets.get('AUT-100')?.gateWaiting).toBeNull();
    });
  });

  // ── Gate actions ──────────────────────────────────────────────

  describe('gate actions', () => {
    it('approveGate calls api.approveGate', async () => {
      act(() => {
        getStore().addTicket('AUT-100');
      });

      await act(async () => {
        await getStore().approveGate('AUT-100', 'gate_code_review');
      });

      expect(mockApiApproveGate).toHaveBeenCalledWith('AUT-100', 'gate_code_review');
    });

    it('rejectGate calls api.rejectGate with reason', async () => {
      act(() => {
        getStore().addTicket('AUT-100');
      });

      await act(async () => {
        await getStore().rejectGate('AUT-100', 'gate_code_review', 'Bad code');
      });

      expect(mockApiRejectGate).toHaveBeenCalledWith('AUT-100', 'gate_code_review', 'Bad code');
    });

    it('sets error on approveGate failure', async () => {
      mockApiApproveGate.mockRejectedValueOnce(new Error('Forbidden'));

      act(() => {
        getStore().addTicket('AUT-100');
      });

      await act(async () => {
        await getStore().approveGate('AUT-100', 'gate_code_review');
      });

      expect(getStore().tickets.get('AUT-100')?.error).toBe('Forbidden');
    });
  });

  // ── SSE connection state ──────────────────────────────────────

  describe('SSE connection state', () => {
    it('setSseConnected updates connected state', () => {
      act(() => {
        getStore().setSseConnected(true);
      });

      expect(getStore().sseConnected).toBe(true);
    });

    it('setSseConnected resets retry count on connect', () => {
      act(() => {
        getStore().setSseRetryCount(5);
        getStore().setSseConnected(true);
      });

      expect(getStore().sseRetryCount).toBe(0);
    });

    it('setLastHeartbeat updates timestamp', () => {
      const ts = Date.now();

      act(() => {
        getStore().setLastHeartbeat(ts);
      });

      expect(getStore().lastHeartbeat).toBe(ts);
    });
  });

  // ── Error handling ──────────────────────────────────────────

  describe('error handling', () => {
    it('setError sets error on ticket', () => {
      act(() => {
        getStore().addTicket('AUT-100');
        getStore().setError('AUT-100', 'Something went wrong');
      });

      expect(getStore().tickets.get('AUT-100')?.error).toBe('Something went wrong');
    });

    it('clearError clears error on ticket', () => {
      act(() => {
        getStore().addTicket('AUT-100');
        getStore().setError('AUT-100', 'Some error');
        getStore().clearError('AUT-100');
      });

      expect(getStore().tickets.get('AUT-100')?.error).toBeNull();
    });
  });
});
