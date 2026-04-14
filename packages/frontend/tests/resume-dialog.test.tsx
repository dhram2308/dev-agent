// =====================================================================
// ResumeDialog Component Tests
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from '@testing-library/react';
import type { PipelineSummary, PipelineStatus } from '../src/types';

// ── Mock the API module ──────────────────────────────────────────────

const mockApiStartAgent = vi.fn();
const mockApiStopAgent = vi.fn();
const mockApiResetAgent = vi.fn();
const mockApiApproveGate = vi.fn();
const mockApiRejectGate = vi.fn();
const mockApiGetPipelines = vi.fn();
const mockApiDeletePipeline = vi.fn();

vi.mock('../src/lib/api', () => ({
  startAgent: (...args: unknown[]) => mockApiStartAgent(...args),
  stopAgent: (...args: unknown[]) => mockApiStopAgent(...args),
  resetAgent: (...args: unknown[]) => mockApiResetAgent(...args),
  approveGate: (...args: unknown[]) => mockApiApproveGate(...args),
  rejectGate: (...args: unknown[]) => mockApiRejectGate(...args),
  getPipelines: (...args: unknown[]) => mockApiGetPipelines(...args),
  deletePipeline: (...args: unknown[]) => mockApiDeletePipeline(...args),
}));

// Import AFTER mocking
import { ResumeDialog } from '../src/components/ResumeDialog';
import { usePipelineStore } from '../src/store/pipeline';

// ── Helpers ──────────────────────────────────────────────────────────

function makePipeline(overrides: Partial<PipelineSummary> = {}): PipelineSummary {
  return {
    ticket: 'AUT-100',
    stage: 'generate_code',
    startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    lastActivity: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    running: false,
    resumable: true,
    daysRemaining: 5.5,
    needsApproval: false,
    gateStage: null,
    progress: 0.2,
    status: 'paused',
    resumeCount: 0,
    ...overrides,
  };
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

// ── Tests ────────────────────────────────────────────────────────────

describe('ResumeDialog', () => {
  beforeEach(() => {
    resetStore();
    mockApiStartAgent.mockReset().mockResolvedValue({ ok: true });
    mockApiDeletePipeline.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering for different statuses ────────────────────────────

  describe('rendering', () => {
    it('renders ticket ID and status for paused pipeline', () => {
      render(<ResumeDialog pipeline={makePipeline({ status: 'paused' })} />);

      expect(screen.getByText('AUT-100')).toBeInTheDocument();
      expect(screen.getByText('Paused')).toBeInTheDocument();
    });

    it('renders "Expired" badge for expired pipeline', () => {
      render(<ResumeDialog pipeline={makePipeline({
        status: 'expired',
        resumable: false,
        daysRemaining: 0,
      })} />);

      expect(screen.getByText('AUT-100')).toBeInTheDocument();
      // "Expired" appears in both the badge and the resume window field
      const expiredElements = screen.getAllByText('Expired');
      expect(expiredElements.length).toBeGreaterThanOrEqual(1);
    });

    it('renders "Completed" badge for done pipeline', () => {
      render(<ResumeDialog pipeline={makePipeline({
        status: 'done',
        stage: 'done',
        resumable: false,
        progress: 1,
      })} />);

      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('renders "Awaiting Approval" badge for gate_waiting pipeline', () => {
      render(<ResumeDialog pipeline={makePipeline({
        status: 'gate_waiting',
        stage: 'gate_code_review',
        needsApproval: true,
        gateStage: 'gate_code_review',
      })} />);

      expect(screen.getByText('Awaiting Approval')).toBeInTheDocument();
    });

    it('displays days remaining for non-done pipelines', () => {
      render(<ResumeDialog pipeline={makePipeline({ daysRemaining: 5.5 })} />);

      expect(screen.getByText('5.5 days remaining')).toBeInTheDocument();
    });

    it('displays "Expired" instead of days remaining for expired pipelines', () => {
      render(<ResumeDialog pipeline={makePipeline({
        status: 'expired',
        resumable: false,
        daysRemaining: 0,
      })} />);

      // "Expired" appears in both the badge and the resume window field
      const expiredElements = screen.getAllByText('Expired');
      expect(expiredElements.length).toBeGreaterThanOrEqual(2);
    });

    it('displays resume count when > 0', () => {
      render(<ResumeDialog pipeline={makePipeline({ resumeCount: 2 })} />);

      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('Resume Count')).toBeInTheDocument();
    });

    it('does not display resume count when 0', () => {
      render(<ResumeDialog pipeline={makePipeline({ resumeCount: 0 })} />);

      expect(screen.queryByText('Resume Count')).not.toBeInTheDocument();
    });
  });

  // ── Button states ───────────────────────────────────────────────

  describe('button states', () => {
    it('shows Resume, Start Fresh, and Delete buttons for paused pipeline', () => {
      render(<ResumeDialog pipeline={makePipeline({ status: 'paused', resumable: true })} />);

      expect(screen.getByText('Resume')).toBeInTheDocument();
      expect(screen.getByText('Start Fresh')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('disables Resume button for expired pipeline', () => {
      render(<ResumeDialog pipeline={makePipeline({
        status: 'expired',
        resumable: false,
        daysRemaining: 0,
      })} />);

      // The resume button should be replaced by a disabled "Resume (Expired)" button
      const disabledBtn = screen.getByText('Resume (Expired)');
      expect(disabledBtn).toBeInTheDocument();
      expect(disabledBtn.closest('button')).toBeDisabled();
    });

    it('shows Start Fresh and Delete for expired pipeline', () => {
      render(<ResumeDialog pipeline={makePipeline({
        status: 'expired',
        resumable: false,
        daysRemaining: 0,
      })} />);

      expect(screen.getByText('Start Fresh')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('does not show active Resume button for done pipeline', () => {
      render(<ResumeDialog pipeline={makePipeline({
        status: 'done',
        stage: 'done',
        resumable: false,
        progress: 1,
      })} />);

      // No active Resume button (canResume is false for done)
      expect(screen.queryByText('Resume')).not.toBeInTheDocument();
    });
  });

  // ── Resume warning ──────────────────────────────────────────────

  describe('resume history warning', () => {
    it('shows warning when resumeCount >= 3', () => {
      render(<ResumeDialog pipeline={makePipeline({ resumeCount: 3 })} />);

      expect(screen.getByText(/has been resumed 3 times/)).toBeInTheDocument();
    });

    it('shows warning when resumeCount > 3', () => {
      render(<ResumeDialog pipeline={makePipeline({ resumeCount: 5 })} />);

      expect(screen.getByText(/has been resumed 5 times/)).toBeInTheDocument();
    });

    it('does not show warning when resumeCount < 3', () => {
      render(<ResumeDialog pipeline={makePipeline({ resumeCount: 2 })} />);

      expect(screen.queryByText(/has been resumed/)).not.toBeInTheDocument();
    });

    it('does not show warning for expired pipeline even with high resume count', () => {
      render(<ResumeDialog pipeline={makePipeline({
        status: 'expired',
        resumable: false,
        resumeCount: 5,
        daysRemaining: 0,
      })} />);

      expect(screen.queryByText(/has been resumed/)).not.toBeInTheDocument();
    });
  });

  // ── Actions ─────────────────────────────────────────────────────

  describe('actions', () => {
    it('Resume button calls startAgent with mode=resume', async () => {
      render(<ResumeDialog pipeline={makePipeline({ status: 'paused', resumable: true })} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Resume'));
      });

      expect(mockApiStartAgent).toHaveBeenCalledWith('AUT-100', 'resume');
    });

    it('Start Fresh button calls startAgent with mode=fresh', async () => {
      render(<ResumeDialog pipeline={makePipeline({ status: 'paused' })} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Start Fresh'));
      });

      expect(mockApiStartAgent).toHaveBeenCalledWith('AUT-100', 'fresh');
    });

    it('Delete button calls deletePipeline', async () => {
      render(<ResumeDialog pipeline={makePipeline()} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Delete'));
      });

      expect(mockApiDeletePipeline).toHaveBeenCalledWith('AUT-100');
    });

    it('sets error in store on API failure', async () => {
      mockApiStartAgent.mockRejectedValueOnce(new Error('Network error'));

      render(<ResumeDialog pipeline={makePipeline({ status: 'paused', resumable: true })} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Resume'));
      });

      // The store's startAgent catches errors internally and sets them on the ticket
      await waitFor(() => {
        const ticketState = usePipelineStore.getState().tickets.get('AUT-100');
        expect(ticketState?.error).toBe('Network error');
      });
    });

    it('shows loading state on Resume button', async () => {
      // Make API hang (never resolve)
      let resolveApi!: () => void;
      mockApiStartAgent.mockReturnValueOnce(new Promise<void>((resolve) => { resolveApi = resolve; }));

      render(<ResumeDialog pipeline={makePipeline({ status: 'paused', resumable: true })} />);

      // Click resume
      act(() => {
        fireEvent.click(screen.getByText('Resume'));
      });

      // Should show loading text
      await waitFor(() => {
        expect(screen.getByText('Resuming...')).toBeInTheDocument();
      });

      // Resolve the API call
      await act(async () => {
        resolveApi();
      });
    });
  });
});
