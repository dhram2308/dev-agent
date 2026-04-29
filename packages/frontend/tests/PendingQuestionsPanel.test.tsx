/**
 * Tests for <PendingQuestionsPanel> — renders Architect-raised
 * clarifying questions as a choice widget over the Plan Review gate.
 *
 * We stub out the pipeline store hooks so the panel renders in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PendingQuestion } from '@mi/shared';

const answerMock = vi.fn().mockResolvedValue(undefined);
const acceptAllMock = vi.fn().mockResolvedValue(undefined);

// Shared store state the mock reads from. Each test mutates this before
// rendering.
let mockPending: PendingQuestion[] = [];

vi.mock('../src/store/pipeline', () => ({
  usePipelineStore: (selector: (s: any) => any) =>
    selector({
      answerQuestions: answerMock,
      acceptAllAIPicks: acceptAllMock,
    }),
  usePendingQuestions: (_ticket: string | null) => mockPending,
}));

import { PendingQuestionsPanel } from '../src/components/PendingQuestionsPanel';

function makeQ(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    id: 'q1',
    text: 'Where should X go?',
    options: ['Option A description', 'Option B description'],
    recommend: 0,
    reason: 'Option A keeps symmetry',
    stage: 'explore_plan',
    ts: Date.now(),
    ...overrides,
  };
}

describe('PendingQuestionsPanel', () => {
  beforeEach(() => {
    answerMock.mockClear();
    acceptAllMock.mockClear();
    mockPending = [];
  });

  it('renders nothing when there are no pending questions', () => {
    const { container } = render(<PendingQuestionsPanel ticket="AUT-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one radio group per question with the AI-pick indicator', () => {
    mockPending = [makeQ({ id: 'q1' }), makeQ({ id: 'q2', recommend: 1 })];
    const { container } = render(<PendingQuestionsPanel ticket="AUT-1" />);

    const radios = container.querySelectorAll('input[type="radio"]');
    // 2 questions × 2 options = 4 radios
    expect(radios.length).toBe(4);

    // Each question has distinct name so radios within a group are exclusive.
    const names = Array.from(radios).map((r) => (r as HTMLInputElement).name);
    expect(new Set(names).size).toBe(2);

    // The "AI suggests" marker appears on the recommend index for each question.
    const aiMarkers = container.querySelectorAll('[title="AI-recommended option"]');
    expect(aiMarkers.length).toBe(2);
  });

  it('shows the reason line when provided', () => {
    mockPending = [makeQ({ reason: 'Because symmetry matters' })];
    render(<PendingQuestionsPanel ticket="AUT-1" />);
    expect(screen.getByText('Because symmetry matters')).toBeInTheDocument();
  });

  it('disables the Save button until the user picks an option (no recommend)', () => {
    mockPending = [makeQ({ id: 'noRec', recommend: undefined })];
    render(<PendingQuestionsPanel ticket="AUT-1" />);
    const save = screen.getByLabelText('Save answer for noRec');
    expect(save).toBeDisabled();
  });

  it('pre-selects the AI-recommended option so Save is enabled', () => {
    mockPending = [makeQ({ id: 'q1', recommend: 1 })];
    render(<PendingQuestionsPanel ticket="AUT-1" />);
    const save = screen.getByLabelText('Save answer for q1');
    expect(save).not.toBeDisabled();
  });

  it('calls answerQuestions with the chosen option on Save', async () => {
    mockPending = [makeQ({ id: 'ledger', recommend: 0 })];
    render(<PendingQuestionsPanel ticket="AUT-42" />);

    // Pick option B (index 1)
    const radios = screen.getAllByRole('radio');
    fireEvent.click(radios[1]);

    fireEvent.click(screen.getByLabelText('Save answer for ledger'));

    // Async — flush microtasks
    await Promise.resolve();

    expect(answerMock).toHaveBeenCalledWith(
      'AUT-42',
      [{ id: 'ledger', choice: 1 }],
      'user',
    );
  });

  it('"Accept all AI picks" calls acceptAllAIPicks', async () => {
    mockPending = [
      makeQ({ id: 'q1', recommend: 0 }),
      makeQ({ id: 'q2', recommend: 1 }),
    ];
    render(<PendingQuestionsPanel ticket="AUT-99" />);
    fireEvent.click(screen.getByLabelText('Accept all AI recommendations'));
    await Promise.resolve();
    expect(acceptAllMock).toHaveBeenCalledWith('AUT-99');
  });

  it('shows skips-footer when some questions lack a recommend', () => {
    mockPending = [
      makeQ({ id: 'q1', recommend: 0 }),
      makeQ({ id: 'q2', recommend: undefined }),
      makeQ({ id: 'q3', recommend: undefined }),
    ];
    render(<PendingQuestionsPanel ticket="AUT-1" />);
    expect(screen.getByText(/skips 2 questions/i)).toBeInTheDocument();
  });

  it('disables "Accept all AI picks" when no question has a recommend', () => {
    mockPending = [
      makeQ({ id: 'q1', recommend: undefined }),
      makeQ({ id: 'q2', recommend: undefined }),
    ];
    render(<PendingQuestionsPanel ticket="AUT-1" />);
    const btn = screen.getByLabelText('Accept all AI recommendations');
    expect(btn).toBeDisabled();
  });

  it('header count matches the number of pending questions', () => {
    mockPending = [makeQ({ id: 'q1' }), makeQ({ id: 'q2' }), makeQ({ id: 'q3' })];
    render(<PendingQuestionsPanel ticket="AUT-1" />);
    expect(screen.getByText(/Decisions needed \(3\)/i)).toBeInTheDocument();
  });
});
