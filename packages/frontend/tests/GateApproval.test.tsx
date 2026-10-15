// =====================================================================
// GateApproval Component Tests
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { PipelineTicketState, StageName, ReviewData } from '../src/types';

// ── Mock store state ──────────────────────────────────────────────

let mockTicketState: PipelineTicketState | null = null;
let mockReviewData: ReviewData | null = null;
let mockActiveTicket: string | null = null;
const mockApproveGate = vi.fn();
const mockRejectGate = vi.fn();

vi.mock('../src/store/pipeline', () => ({
  usePipelineStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      reviewData: mockReviewData,
      activeTicket: mockActiveTicket,
      approveGate: mockApproveGate,
      rejectGate: mockRejectGate,
    }),
  useActiveTicketState: () => mockTicketState,
}));

import { GateApproval } from '../src/components/GateApproval';
import { ToastProvider } from '../src/contexts/ToastContext';

// ── Helpers ────────────────────────────────────────────────────────

function makeTicketState(overrides: Partial<PipelineTicketState> = {}): PipelineTicketState {
  return {
    ticket: 'AUT-123',
    state: {
      ticket: 'AUT-123',
      stage: 'gate_code_review' as StageName,
      data: {},
    },
    isRunning: true,
    stage: 'gate_code_review' as StageName,
    stageStartedAt: Date.now(),
    pipelineStartedAt: Date.now(),
    logs: [],
    error: null,
    gateWaiting: 'gate_code_review' as StageName,
    ...overrides,
  };
}

function renderApproval() {
  return render(
    <ToastProvider>
      <GateApproval />
    </ToastProvider>
  );
}

// ── Tests ──────────────────────────────────────────────────────────

describe('GateApproval', () => {
  beforeEach(() => {
    mockApproveGate.mockReset();
    mockRejectGate.mockReset();
    mockApproveGate.mockResolvedValue(undefined);
    mockRejectGate.mockResolvedValue(undefined);
    mockReviewData = null;
    mockActiveTicket = 'AUT-123';
    mockTicketState = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering conditions ──────────────────────────────────────

  describe('rendering conditions', () => {
    it('renders nothing when no gate is waiting', () => {
      mockTicketState = makeTicketState({ gateWaiting: null });

      const { container } = renderApproval();
      expect(container.innerHTML).toBe('');
    });

    it('renders nothing when activeTicket is null', () => {
      mockActiveTicket = null;
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      const { container } = renderApproval();
      expect(container.innerHTML).toBe('');
    });

    it('renders approve/reject buttons when gate is waiting', () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      expect(screen.getByLabelText('Approve MR')).toBeDefined();
      expect(screen.getByLabelText('Request Changes')).toBeDefined();
    });

    it('renders correct title for code review gate', () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      expect(screen.getByText('Code Review')).toBeDefined();
      expect(screen.getByText('Waiting')).toBeDefined();
    });

    it('renders correct title for explore_plan gate', () => {
      mockTicketState = makeTicketState({
        gateWaiting: 'explore_plan',
        state: {
          ticket: 'AUT-123',
          stage: 'explore_plan',
          data: { explore_plan: 'Test plan content' },
        },
      });

      renderApproval();

      expect(screen.getByText('Plan Review')).toBeDefined();
      expect(screen.getByLabelText('Approve Plan')).toBeDefined();
      expect(screen.getByLabelText('Reject Plan')).toBeDefined();
    });

    it('renders Refine button for explore_plan gate', () => {
      mockTicketState = makeTicketState({
        gateWaiting: 'explore_plan',
        state: {
          ticket: 'AUT-123',
          stage: 'explore_plan',
          data: { explore_plan: 'Test plan' },
        },
      });

      renderApproval();

      expect(screen.getByLabelText('Request refinement')).toBeDefined();
    });

    it('does not render Refine button for code review gate', () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      expect(screen.queryByLabelText('Request refinement')).toBeNull();
    });
  });

  // ── Confirm dialog (not window.confirm) ─────────────────────

  describe('confirm dialog', () => {
    it('shows confirm dialog when clicking Approve (not window.confirm)', () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });
      const windowConfirmSpy = vi.spyOn(window, 'confirm');

      renderApproval();

      fireEvent.click(screen.getByLabelText('Approve MR'));

      // Dialog should appear
      expect(screen.getByRole('alertdialog')).toBeDefined();
      expect(screen.getByText('Confirm Approval')).toBeDefined();

      // window.confirm should NOT be called
      expect(windowConfirmSpy).not.toHaveBeenCalled();
    });

    it('submits rejection directly via RejectForm without confirm dialog', async () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      // First click opens the feedback form
      fireEvent.click(screen.getByLabelText('Request Changes'));

      // Enter feedback
      const textarea = screen.getByLabelText('Rejection feedback');
      fireEvent.change(textarea, { target: { value: 'Fix the null check' } });

      // Click submit rejection — calls rejectGate directly (no confirm step)
      fireEvent.click(screen.getByLabelText('Submit rejection'));

      await waitFor(() => {
        expect(mockRejectGate).toHaveBeenCalledWith(
          'AUT-123',
          'gate_code_review',
          'Fix the null check',
        );
      });
    });

    it('cancel button on confirm dialog closes it without action', () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      fireEvent.click(screen.getByLabelText('Approve MR'));
      expect(screen.getByRole('alertdialog')).toBeDefined();

      // Click cancel
      fireEvent.click(screen.getByText('Cancel'));

      // Dialog should be gone
      expect(screen.queryByRole('alertdialog')).toBeNull();

      // approveGate should NOT have been called
      expect(mockApproveGate).not.toHaveBeenCalled();
    });
  });

  // ── Approve action ──────────────────────────────────────────

  describe('approve action', () => {
    it('calls approveGate with correct ticket and gate when confirmed', async () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      // Click approve -> confirm dialog
      fireEvent.click(screen.getByLabelText('Approve MR'));
      expect(screen.getByRole('alertdialog')).toBeDefined();

      // Click confirm Approve in dialog
      fireEvent.click(screen.getByText('Approve'));

      await waitFor(() => {
        expect(mockApproveGate).toHaveBeenCalledTimes(1);
        expect(mockApproveGate).toHaveBeenCalledWith('AUT-123', 'gate_code_review');
      });
    });
  });

  // ── Reject action ──────────────────────────────────────────

  describe('reject action', () => {
    it('calls rejectGate with feedback when submitted', async () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      // Open reject form
      fireEvent.click(screen.getByLabelText('Request Changes'));

      // Type feedback
      const textarea = screen.getByLabelText('Rejection feedback');
      fireEvent.change(textarea, { target: { value: 'Missing error handling' } });

      // Submit (no confirm dialog for reject anymore)
      fireEvent.click(screen.getByLabelText('Submit rejection'));

      await waitFor(() => {
        expect(mockRejectGate).toHaveBeenCalledTimes(1);
        expect(mockRejectGate).toHaveBeenCalledWith(
          'AUT-123',
          'gate_code_review',
          'Missing error handling',
        );
      });
    });

    it('disables submit rejection button when feedback is empty', () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      // Open reject form
      fireEvent.click(screen.getByLabelText('Request Changes'));

      // Submit button should be disabled with empty feedback
      const submitBtn = screen.getByLabelText('Submit rejection');
      expect(submitBtn).toBeDisabled();
    });
  });

  // ── Refine action (explore_plan only) ──────────────────────

  describe('refine action', () => {
    it('calls rejectGate with [REFINE] prefix when refinement submitted', async () => {
      mockTicketState = makeTicketState({
        gateWaiting: 'explore_plan',
        state: {
          ticket: 'AUT-123',
          stage: 'explore_plan',
          data: { explore_plan: 'Initial plan' },
        },
      });

      renderApproval();

      // Click Refine
      fireEvent.click(screen.getByLabelText('Request refinement'));

      // Enter refinement instructions
      const textarea = screen.getByLabelText('Refinement instructions');
      fireEvent.change(textarea, { target: { value: 'Add error handling specs' } });

      // Submit refinement (direct call, no confirm dialog for refine)
      fireEvent.click(screen.getByLabelText('Submit refinement'));

      await waitFor(() => {
        expect(mockRejectGate).toHaveBeenCalledTimes(1);
        expect(mockRejectGate).toHaveBeenCalledWith(
          'AUT-123',
          'explore_plan',
          '[REFINE] Add error handling specs',
        );
      });
    });
  });

  // ── MR link display ─────────────────────────────────────────

  describe('MR link display', () => {
    it('shows MR link for code review gate when mrUrl is available', () => {
      mockTicketState = makeTicketState({
        gateWaiting: 'gate_code_review',
        state: {
          ticket: 'AUT-123',
          stage: 'gate_code_review',
          data: {
            code_mr_url: 'https://gitlab.com/mr/42',
            code_mr_iid: 42,
          },
        },
      });

      renderApproval();

      const link = screen.getByText(/View Merge Request/);
      expect(link).toBeDefined();
      expect(link.getAttribute('href')).toBe('https://gitlab.com/mr/42');
      expect(link.getAttribute('target')).toBe('_blank');
    });
  });

  // ── Rejection budget & round history (code review gate only) ──

  describe('rejection budget', () => {
    it('shows 0/3 (default MAX_REJECTIONS) when no rejections have occurred', () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      expect(screen.getByText('Rejection rounds: 0/3')).toBeDefined();
    });

    it('shows the current rejection count against the budget', () => {
      mockTicketState = makeTicketState({
        gateWaiting: 'gate_code_review',
        state: {
          ticket: 'AUT-123',
          stage: 'gate_code_review',
          data: { _gate_rejections: { gate1: 1 } },
        },
      });

      renderApproval();

      expect(screen.getByText('Rejection rounds: 1/3')).toBeDefined();
    });

    it('does not render a rejection-round history toggle when there is no history', () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      expect(screen.queryByText(/Rejection rounds \(/)).toBeNull();
    });

    it('renders a round-history disclosure with feedback and timestamp, expandable on click', () => {
      mockTicketState = makeTicketState({
        gateWaiting: 'gate_code_review',
        state: {
          ticket: 'AUT-123',
          stage: 'gate_code_review',
          data: {
            _gate_rejections: { gate1: 1 },
            rejectionHistory: [
              { round: 1, feedback: 'Please add unit tests', timestamp: '2026-08-24T16:12:00.000Z' },
            ],
          },
        },
      });

      renderApproval();

      const toggle = screen.getByRole('button', { name: /Rejection rounds \(1\)/ });
      expect(screen.queryByText('Please add unit tests')).toBeNull();

      fireEvent.click(toggle);

      expect(screen.getByText('Please add unit tests')).toBeDefined();
      expect(screen.getByText('Round 1')).toBeDefined();
    });

    it('does not render the rejection budget section for other gates', () => {
      mockTicketState = makeTicketState({
        gateWaiting: 'explore_plan',
        state: {
          ticket: 'AUT-123',
          stage: 'explore_plan',
          data: { explore_plan: 'Test plan' },
        },
      });

      renderApproval();

      expect(screen.queryByText(/Rejection rounds:/)).toBeNull();
    });
  });

  // ── View full diff link (code review gate only) ────────────────

  describe('view full diff link', () => {
    it('renders a "View full diff" control for the code review gate', () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      expect(screen.getByText('View full diff →')).toBeDefined();
    });

    it('does not render "View full diff" for other gates', () => {
      mockTicketState = makeTicketState({
        gateWaiting: 'explore_plan',
        state: {
          ticket: 'AUT-123',
          stage: 'explore_plan',
          data: { explore_plan: 'Test plan' },
        },
      });

      renderApproval();

      expect(screen.queryByText('View full diff →')).toBeNull();
    });
  });

  // ── Comment thread panel (code review gate only) ────────────────

  describe('comment thread panel', () => {
    it('renders the Comments section for the code review gate', () => {
      mockTicketState = makeTicketState({ gateWaiting: 'gate_code_review' });

      renderApproval();

      expect(screen.getByText('Comments')).toBeDefined();
    });

    it('does not render the Comments section for other gates', () => {
      mockTicketState = makeTicketState({
        gateWaiting: 'explore_plan',
        state: {
          ticket: 'AUT-123',
          stage: 'explore_plan',
          data: { explore_plan: 'Test plan' },
        },
      });

      renderApproval();

      expect(screen.queryByText('Comments')).toBeNull();
    });
  });
});
