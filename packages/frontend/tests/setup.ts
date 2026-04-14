import '@testing-library/jest-dom';

// Polyfill requestAnimationFrame / cancelAnimationFrame for jsdom
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  let _rafId = 0;
  const _rafCallbacks = new Map<number, (ts: number) => void>();

  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = ++_rafId;
    _rafCallbacks.set(id, cb);
    setTimeout(() => {
      const fn = _rafCallbacks.get(id);
      if (fn) {
        _rafCallbacks.delete(id);
        fn(performance.now());
      }
    }, 16);
    return id;
  };

  globalThis.cancelAnimationFrame = (id: number): void => {
    _rafCallbacks.delete(id);
  };
}

// Polyfill EventSource for jsdom
if (typeof globalThis.EventSource === 'undefined') {
  class MockEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;

    url: string;
    readyState: number = 0;
    withCredentials = false;
    onopen: ((evt: Event) => void) | null = null;
    onmessage: ((evt: MessageEvent) => void) | null = null;
    onerror: ((evt: Event) => void) | null = null;

    private _listeners: Record<string, Array<(evt: any) => void>> = {};

    constructor(url: string | URL, _opts?: EventSourceInit) {
      this.url = typeof url === 'string' ? url : url.toString();
      // Auto-open after microtask
      queueMicrotask(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen(new Event('open'));
      });
    }

    addEventListener(type: string, listener: (evt: any) => void): void {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(listener);
    }

    removeEventListener(type: string, listener: (evt: any) => void): void {
      const list = this._listeners[type];
      if (list) {
        this._listeners[type] = list.filter(l => l !== listener);
      }
    }

    dispatchEvent(evt: Event): boolean {
      const list = this._listeners[evt.type];
      if (list) list.forEach(l => l(evt));
      return true;
    }

    close(): void {
      this.readyState = 2;
    }
  }

  (globalThis as any).EventSource = MockEventSource;
}
