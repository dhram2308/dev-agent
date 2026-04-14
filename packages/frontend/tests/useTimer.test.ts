// ═══════════════════════════════════════════════════════════════
// useTimer hook tests
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── Mock useVisibility before importing useTimer ────────────────
// useTimer imports useVisibility internally. We mock it to control
// visibility state in tests without depending on real DOM events.

let mockVisible = true;
vi.mock('../src/hooks/useVisibility', () => ({
  useVisibility: () => ({
    visible: mockVisible,
    onVisibilityChange: () => () => {},
  }),
}));

// Import after mock is set up
import { useTimer, formatElapsed } from '../src/hooks/useTimer';

// ── Helpers ─────────────────────────────────────────────────────

// requestAnimationFrame/cancelAnimationFrame mocks for jsdom
let rafCallbacks: Map<number, FrameRequestCallback> = new Map();
let nextRafId = 1;

function setupRAFMock(): void {
  rafCallbacks = new Map();
  nextRafId = 1;

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    const id = nextRafId++;
    rafCallbacks.set(id, cb);
    return id;
  });

  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    rafCallbacks.delete(id);
  });

  vi.stubGlobal('performance', {
    now: vi.fn(() => Date.now()),
  });
}

function flushRAF(): void {
  // Execute all pending RAF callbacks once
  const cbs = new Map(rafCallbacks);
  rafCallbacks.clear();
  for (const [, cb] of cbs) {
    cb(performance.now());
  }
}

// ── Tests ──────────────────────────────────────────────────────

describe('useTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupRAFMock();
    mockVisible = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    // Don't use vi.restoreAllMocks() — it undoes vi.stubGlobal for raf/caf
    // which makes hook cleanup fail since jsdom lacks requestAnimationFrame
    vi.clearAllMocks();
  });

  it('starts counting from provided startTime', () => {
    // Start time was 5 seconds ago
    const startTime = Date.now() - 5000;

    const { result } = renderHook(() => useTimer(startTime));

    // Timer should have auto-started with the initial elapsed
    expect(result.current.isRunning).toBe(true);
    // Elapsed should be approximately 5000ms (since we set startTime 5s ago)
    expect(result.current.elapsed).toBeGreaterThanOrEqual(4900);
    expect(result.current.elapsed).toBeLessThanOrEqual(5200);
  });

  it('pauses when visibility is hidden', () => {
    const { result, rerender } = renderHook(() => useTimer());

    // Start the timer
    act(() => {
      result.current.start();
    });
    expect(result.current.isRunning).toBe(true);

    // Capture how many RAF callbacks are pending
    const rafCountBefore = rafCallbacks.size;
    expect(rafCountBefore).toBeGreaterThan(0);

    // Simulate tab becoming hidden
    mockVisible = false;
    rerender();

    // RAF should be cancelled when hidden
    // The hook cancels RAF on visibility change
    expect(rafCallbacks.size).toBe(0);
  });

  it('resumes when visibility becomes visible', () => {
    const { result, rerender } = renderHook(() => useTimer());

    // Start timer
    act(() => {
      result.current.start();
    });
    expect(result.current.isRunning).toBe(true);

    // Go hidden
    mockVisible = false;
    rerender();

    // RAF should be cancelled
    expect(rafCallbacks.size).toBe(0);

    // Go visible again
    mockVisible = true;
    rerender();

    // RAF should be re-scheduled
    expect(rafCallbacks.size).toBeGreaterThan(0);
    expect(result.current.isRunning).toBe(true);
  });

  it('cleans up intervals on unmount (no leaked intervals)', () => {
    const { result, unmount } = renderHook(() => useTimer());

    // Start timer
    act(() => {
      result.current.start();
    });

    // Verify RAF is scheduled
    expect(rafCallbacks.size).toBeGreaterThan(0);

    // Unmount
    unmount();

    // All RAF callbacks should be cancelled
    expect(rafCallbacks.size).toBe(0);
  });

  it('stop preserves elapsed time', () => {
    const { result } = renderHook(() => useTimer());

    act(() => {
      result.current.start();
    });

    // Advance time and flush RAF
    vi.advanceTimersByTime(2000);
    (performance.now as ReturnType<typeof vi.fn>).mockReturnValue(Date.now());
    act(() => {
      flushRAF();
    });

    const elapsedBeforeStop = result.current.elapsed;

    act(() => {
      result.current.stop();
    });

    expect(result.current.isRunning).toBe(false);
    // Elapsed should be preserved (not reset to 0)
    expect(result.current.elapsed).toBe(elapsedBeforeStop);
  });

  it('reset sets elapsed to 0', () => {
    const { result } = renderHook(() => useTimer());

    act(() => {
      result.current.start();
    });

    vi.advanceTimersByTime(1000);
    (performance.now as ReturnType<typeof vi.fn>).mockReturnValue(Date.now());
    act(() => {
      flushRAF();
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.elapsed).toBe(0);
    expect(result.current.formatted).toBe('0s');
  });
});

// ── formatElapsed unit tests ───────────────────────────────────

describe('formatElapsed', () => {
  it('formats 45 seconds as "45s"', () => {
    expect(formatElapsed(45_000)).toBe('45s');
  });

  it('formats 2 minutes 30 seconds as "2m 30s"', () => {
    expect(formatElapsed(150_000)).toBe('2m 30s');
  });

  it('formats 1 hour 5 minutes as "1h 5m"', () => {
    expect(formatElapsed(3_900_000)).toBe('1h 5m');
  });

  it('formats 0 as "0s"', () => {
    expect(formatElapsed(0)).toBe('0s');
  });

  it('handles negative values as "0s"', () => {
    expect(formatElapsed(-5000)).toBe('0s');
  });

  it('formats 1 hour 0 minutes 30 seconds as "1h 30s"', () => {
    expect(formatElapsed(3_630_000)).toBe('1h 30s');
  });

  it('formats exact hours as "1h"', () => {
    expect(formatElapsed(3_600_000)).toBe('1h');
  });

  it('formats exact minutes as "5m"', () => {
    expect(formatElapsed(300_000)).toBe('5m');
  });
});
