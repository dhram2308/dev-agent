// =====================================================================
// TicketForm Component Tests
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mock pipeline store before importing component ────────────────

const mockStartAgent = vi.fn();
let mockActiveTicket: string | null = null;

vi.mock('../src/store/pipeline', () => ({
  usePipelineStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      startAgent: mockStartAgent,
      activeTicket: mockActiveTicket,
    }),
}));

import { TicketForm } from '../src/components/TicketForm';

// ── Helpers ────────────────────────────────────────────────────────

function renderForm() {
  return render(<TicketForm />);
}

function getInput(): HTMLInputElement {
  return screen.getByLabelText('Jira ticket ID') as HTMLInputElement;
}

function getSubmitButton(): HTMLButtonElement {
  return screen.getByLabelText('Start the agent pipeline') as HTMLButtonElement;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('TicketForm', () => {
  beforeEach(() => {
    // NOTE: Do NOT use vi.useFakeTimers() here — waitFor() needs real timers
    mockStartAgent.mockReset();
    mockStartAgent.mockResolvedValue(undefined);
    mockActiveTicket = null;
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  // ── Validation ──────────────────────────────────────────────────

  describe('ticket format validation', () => {
    it('accepts valid ticket format "AUT-1234"', async () => {
      renderForm();
      const input = getInput();
      const button = getSubmitButton();

      fireEvent.change(input, { target: { value: 'AUT-1234' } });
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockStartAgent).toHaveBeenCalledWith('AUT-1234');
      });
    });

    it('accepts valid ticket format "PROJ-1" (single digit)', async () => {
      renderForm();
      const input = getInput();
      const button = getSubmitButton();

      fireEvent.change(input, { target: { value: 'PROJ-1' } });
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockStartAgent).toHaveBeenCalledWith('PROJ-1');
      });
    });

    it('uppercases the ticket before submission', async () => {
      renderForm();
      const input = getInput();
      const button = getSubmitButton();

      fireEvent.change(input, { target: { value: 'aut-1234' } });
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockStartAgent).toHaveBeenCalledWith('AUT-1234');
      });
    });

    it('rejects "invalid" with an error message', async () => {
      renderForm();
      const input = getInput();
      const button = getSubmitButton();

      fireEvent.change(input, { target: { value: 'invalid' } });
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Invalid ticket ID format. Expected format: PROJECT-123'
        );
      });

      expect(mockStartAgent).not.toHaveBeenCalled();
    });

    it('rejects empty input with "Ticket ID is required"', async () => {
      renderForm();
      const input = getInput();

      // Type something, then clear to enable submit indirectly -- we submit via form
      fireEvent.change(input, { target: { value: ' ' } });

      // The button should be disabled for whitespace-only input
      const button = getSubmitButton();
      expect(button).toBeDisabled();
    });

    it('rejects "123-AUT" (reversed format)', async () => {
      renderForm();
      const input = getInput();
      const button = getSubmitButton();

      fireEvent.change(input, { target: { value: '123-AUT' } });
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeDefined();
      });
      expect(mockStartAgent).not.toHaveBeenCalled();
    });

    it('rejects "AUT_1234" (underscore instead of dash)', async () => {
      renderForm();
      const input = getInput();
      const button = getSubmitButton();

      fireEvent.change(input, { target: { value: 'AUT_1234' } });
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeDefined();
      });
      expect(mockStartAgent).not.toHaveBeenCalled();
    });
  });

  // ── Error display ──────────────────────────────────────────────

  describe('error display', () => {
    it('shows error from failed startAgent call', async () => {
      mockStartAgent.mockRejectedValueOnce(new Error('Server offline'));

      renderForm();
      const input = getInput();
      const button = getSubmitButton();

      fireEvent.change(input, { target: { value: 'AUT-1234' } });
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Server offline');
      });
    });

    it('shows generic error message for non-Error rejections', async () => {
      mockStartAgent.mockRejectedValueOnce('something broke');

      renderForm();
      const input = getInput();
      const button = getSubmitButton();

      fireEvent.change(input, { target: { value: 'AUT-1234' } });
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Failed to start agent');
      });
    });

    it('clears error when user types a new value', async () => {
      renderForm();
      const input = getInput();
      const button = getSubmitButton();

      // Trigger validation error
      fireEvent.change(input, { target: { value: 'bad' } });
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeDefined();
      });

      // Type new value -- error should clear
      fireEvent.change(input, { target: { value: 'AUT-123' } });

      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  // ── Submit behavior ────────────────────────────────────────────

  describe('submit behavior', () => {
    it('calls startAgent on valid submit', async () => {
      renderForm();
      const input = getInput();
      const button = getSubmitButton();

      fireEvent.change(input, { target: { value: 'AUT-8203' } });
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockStartAgent).toHaveBeenCalledTimes(1);
        expect(mockStartAgent).toHaveBeenCalledWith('AUT-8203');
      });
    });

    it('disables the button while submitting', async () => {
      // Make startAgent hang
      let resolveStart: () => void;
      mockStartAgent.mockImplementation(
        () => new Promise<void>((resolve) => { resolveStart = resolve; })
      );

      renderForm();
      const input = getInput();
      const button = getSubmitButton();

      fireEvent.change(input, { target: { value: 'AUT-123' } });
      fireEvent.click(button);

      await waitFor(() => {
        expect(button).toBeDisabled();
        expect(button).toHaveTextContent('Starting...');
      });

      // Resolve the promise
      resolveStart!();

      await waitFor(() => {
        expect(button).toHaveTextContent('Start');
      });
    });
  });

  // ── Draft persistence ──────────────────────────────────────────

  describe('draft persistence', () => {
    it('saves draft to localStorage after debounce', async () => {
      vi.useFakeTimers();
      try {
        renderForm();
        const input = getInput();

        fireEvent.change(input, { target: { value: 'AUT-999' } });

        // Advance past the 500ms debounce
        vi.advanceTimersByTime(600);

        const raw = localStorage.getItem('draft_ticket_0');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw!);
        expect(parsed.value).toBe('AUT-999');
        expect(parsed.savedAt).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('loads existing draft on mount', () => {
      // Pre-populate localStorage with a draft
      const draft = JSON.stringify({ value: 'AUT-555', savedAt: Date.now() });
      localStorage.setItem('draft_ticket_0', draft);

      renderForm();

      const input = getInput();
      expect(input.value).toBe('AUT-555');

      // "Draft restored" badge should appear
      expect(screen.getByText('Draft restored')).toBeDefined();
    });

    it('clears draft after successful submit', async () => {
      const draft = JSON.stringify({ value: 'AUT-100', savedAt: Date.now() });
      localStorage.setItem('draft_ticket_0', draft);

      renderForm();
      const button = getSubmitButton();

      fireEvent.click(button);

      await waitFor(() => {
        expect(mockStartAgent).toHaveBeenCalled();
      });

      expect(localStorage.getItem('draft_ticket_0')).toBeNull();
    });

    it('cleans up expired drafts (older than 7 days) on mount', () => {
      const oldDate = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      const expiredDraft = JSON.stringify({ value: 'OLD-1', savedAt: oldDate });
      localStorage.setItem('draft_ticket_0', expiredDraft);

      // Another current draft in a different slot
      const currentDraft = JSON.stringify({ value: 'NEW-1', savedAt: Date.now() });
      localStorage.setItem('draft_ticket_1', currentDraft);

      renderForm();

      // The expired draft for slot 0 should be cleaned
      // (loadDraft returns '' for expired, and cleanupOldDrafts removes it)
      const slot0 = localStorage.getItem('draft_ticket_0');
      expect(slot0).toBeNull();

      // The current draft for slot 1 should remain
      expect(localStorage.getItem('draft_ticket_1')).not.toBeNull();
    });

    it('ignores expired drafts when loading (does not restore)', () => {
      const oldDate = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const expiredDraft = JSON.stringify({ value: 'OLD-123', savedAt: oldDate });
      localStorage.setItem('draft_ticket_0', expiredDraft);

      renderForm();

      const input = getInput();
      expect(input.value).toBe('');
      expect(screen.queryByText('Draft restored')).toBeNull();
    });
  });
});
