// ═══════════════════════════════════════════════════════════════
// useSSE hook tests
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSSE, type SSEHandlers } from '../src/hooks/useSSE';

// ── Mock EventSource ────────────────────────────────────────────

type EventSourceListener = (event: MessageEvent) => void;
type EventSourceErrorHandler = (event: Event) => void;
type EventSourceOpenHandler = () => void;

interface MockEventSourceInstance {
  url: string;
  onopen: EventSourceOpenHandler | null;
  onerror: EventSourceErrorHandler | null;
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  readyState: number;
  _listeners: Map<string, EventSourceListener[]>;
  _simulateOpen: () => void;
  _simulateError: () => void;
  _simulateMessage: (event: string, data: unknown) => void;
}

let mockESInstances: MockEventSourceInstance[] = [];

function createMockEventSource(url: string): MockEventSourceInstance {
  const listeners = new Map<string, EventSourceListener[]>();

  const instance: MockEventSourceInstance = {
    url,
    onopen: null,
    onerror: null,
    close: vi.fn(),
    addEventListener: vi.fn((event: string, listener: EventSourceListener) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    }),
    readyState: 0,
    _listeners: listeners,
    _simulateOpen() {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    },
    _simulateError() {
      this.readyState = 2;
      if (this.onerror) this.onerror(new Event('error'));
    },
    _simulateMessage(event: string, data: unknown) {
      const eventListeners = this._listeners.get(event) || [];
      const msgEvent = new MessageEvent(event, {
        data: JSON.stringify(data),
      });
      for (const listener of eventListeners) {
        listener(msgEvent);
      }
    },
  };

  mockESInstances.push(instance);
  return instance;
}

// ── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  mockESInstances = [];

  // Mock EventSource as a constructor class (arrow fns can't be used with `new`)
  vi.stubGlobal('EventSource', vi.fn(function (this: any, url: string) {
    const inst = createMockEventSource(url);
    Object.assign(this, inst);
    return inst;
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────

describe('useSSE', () => {
  it('connects to SSE endpoint with auth token in URL', () => {
    const handlers: SSEHandlers = {};

    renderHook(() => useSSE('/api/logs', handlers, 'my-secret-token'));

    expect(EventSource).toHaveBeenCalledTimes(1);
    const calledUrl = (EventSource as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toBe('/api/logs?token=my-secret-token');
  });

  it('appends token with & when URL already has query params', () => {
    const handlers: SSEHandlers = {};

    renderHook(() => useSSE('/api/logs?ticket=AUT-123', handlers, 'tok'));

    const calledUrl = (EventSource as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toBe('/api/logs?ticket=AUT-123&token=tok');
  });

  it('connects without token when none provided', () => {
    const handlers: SSEHandlers = {};

    renderHook(() => useSSE('/api/logs', handlers));

    const calledUrl = (EventSource as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toBe('/api/logs');
  });

  it('dispatches onLog callback for "log" events', () => {
    const onLog = vi.fn();
    const handlers: SSEHandlers = { onLog };

    renderHook(() => useSSE('/api/logs', handlers, 'tok'));

    const instance = mockESInstances[0];
    const logData = { ticket: 'AUT-123', line: 'hello', level: 'info' };

    act(() => {
      instance._simulateOpen();
      instance._simulateMessage('log', logData);
    });

    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith(logData);
  });

  it('dispatches onStatus callback for "status" events', () => {
    const onStatus = vi.fn();
    const handlers: SSEHandlers = { onStatus };

    renderHook(() => useSSE('/api/logs', handlers, 'tok'));

    const instance = mockESInstances[0];
    const statusData = { running: true, stage: 'generate_code' };

    act(() => {
      instance._simulateOpen();
      instance._simulateMessage('status', statusData);
    });

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(statusData);
  });

  it('dispatches onState callback for "state" events', () => {
    const onState = vi.fn();
    const handlers: SSEHandlers = { onState };

    renderHook(() => useSSE('/api/logs', handlers, 'tok'));

    const instance = mockESInstances[0];
    const stateData = { ticket: 'AUT-123', stage: 'deploy_qa' };

    act(() => {
      instance._simulateOpen();
      instance._simulateMessage('state', stateData);
    });

    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith(stateData);
  });

  it('disconnects cleanly on unmount (EventSource.close called)', () => {
    const handlers: SSEHandlers = {};

    const { unmount } = renderHook(() => useSSE('/api/logs', handlers, 'tok'));

    const instance = mockESInstances[0];

    act(() => {
      instance._simulateOpen();
    });

    unmount();

    expect(instance.close).toHaveBeenCalled();
  });

  it('sets connectionState to "connected" on successful open', () => {
    const handlers: SSEHandlers = {};

    const { result } = renderHook(() => useSSE('/api/logs', handlers, 'tok'));

    const instance = mockESInstances[0];

    act(() => {
      instance._simulateOpen();
    });

    expect(result.current.connectionState).toBe('connected');
  });

  it('sets connectionState to "error" on EventSource error', () => {
    const handlers: SSEHandlers = {};

    const { result } = renderHook(() => useSSE('/api/logs', handlers, 'tok'));

    const instance = mockESInstances[0];

    act(() => {
      instance._simulateError();
    });

    expect(result.current.connectionState).toBe('error');
  });

  it('reconnects with exponential backoff on error (3s, 6s, 12s)', () => {
    const handlers: SSEHandlers = {};

    renderHook(() => useSSE('/api/logs', handlers, 'tok'));

    // First connection
    expect(EventSource).toHaveBeenCalledTimes(1);

    // Simulate error
    act(() => {
      mockESInstances[0]._simulateError();
    });

    // After 3s (initial retry), should reconnect
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(EventSource).toHaveBeenCalledTimes(2);

    // Simulate second error
    act(() => {
      mockESInstances[1]._simulateError();
    });

    // After 3s, should NOT reconnect (backoff is now 6s)
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(EventSource).toHaveBeenCalledTimes(2);

    // After another 3s (total 6s), should reconnect
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(EventSource).toHaveBeenCalledTimes(3);

    // Simulate third error
    act(() => {
      mockESInstances[2]._simulateError();
    });

    // After 6s, should NOT reconnect (backoff is now 12s)
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(EventSource).toHaveBeenCalledTimes(3);

    // After another 6s (total 12s), should reconnect
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(EventSource).toHaveBeenCalledTimes(4);
  });

  it('resets backoff on successful connection', () => {
    const handlers: SSEHandlers = {};

    renderHook(() => useSSE('/api/logs', handlers, 'tok'));

    // First error -> 3s backoff
    act(() => {
      mockESInstances[0]._simulateError();
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(EventSource).toHaveBeenCalledTimes(2);

    // Second error -> 6s backoff
    act(() => {
      mockESInstances[1]._simulateError();
    });
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(EventSource).toHaveBeenCalledTimes(3);

    // Successful connection -> resets backoff
    act(() => {
      mockESInstances[2]._simulateOpen();
    });

    // Now trigger another error -> should be back to 3s backoff
    act(() => {
      mockESInstances[2]._simulateError();
    });

    // After 3s, should reconnect (backoff reset to 3s)
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(EventSource).toHaveBeenCalledTimes(4);
  });

  it('does not connect when enabled is false', () => {
    const handlers: SSEHandlers = {};

    renderHook(() => useSSE('/api/logs', handlers, 'tok', false));

    expect(EventSource).toHaveBeenCalledTimes(0);
  });

  it('disconnect() stops reconnection attempts', () => {
    const handlers: SSEHandlers = {};

    const { result } = renderHook(() => useSSE('/api/logs', handlers, 'tok'));

    // Trigger error (schedules reconnect)
    act(() => {
      mockESInstances[0]._simulateError();
    });

    // Manually disconnect
    act(() => {
      result.current.disconnect();
    });

    // Wait past reconnect interval
    act(() => {
      vi.advanceTimersByTime(10000);
    });

    // Should not have created a new EventSource for reconnect
    // Only the initial connection
    expect(EventSource).toHaveBeenCalledTimes(1);
    expect(result.current.connectionState).toBe('disconnected');
  });

  it('reconnect() resets backoff and reconnects immediately', () => {
    const handlers: SSEHandlers = {};

    const { result } = renderHook(() => useSSE('/api/logs', handlers, 'tok'));

    // Build up backoff through multiple errors
    act(() => {
      mockESInstances[0]._simulateError();
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      mockESInstances[1]._simulateError();
    });
    // Backoff is now 6s

    const countBefore = (EventSource as ReturnType<typeof vi.fn>).mock.calls.length;

    // Manual reconnect resets backoff
    act(() => {
      result.current.reconnect();
    });

    expect((EventSource as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countBefore + 1);
  });

  it('ignores malformed JSON in event data', () => {
    const onLog = vi.fn();
    const handlers: SSEHandlers = { onLog };

    renderHook(() => useSSE('/api/logs', handlers, 'tok'));

    const instance = mockESInstances[0];

    act(() => {
      instance._simulateOpen();
    });

    // Simulate a message with non-JSON data
    const logListeners = instance._listeners.get('log') || [];
    const badEvent = new MessageEvent('log', { data: 'not-json{{{' });

    act(() => {
      for (const listener of logListeners) {
        listener(badEvent);
      }
    });

    // Should not crash and should not call the handler
    expect(onLog).not.toHaveBeenCalled();
  });
});
