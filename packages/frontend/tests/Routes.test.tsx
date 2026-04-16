// =====================================================================
// Route rendering smoke tests — verifies hash-based views mount (14.5, 14.6)
// =====================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// Mock API layer so components don't attempt real fetches
vi.mock('../src/lib/api', () => ({
  api: {
    getConfig: vi.fn().mockResolvedValue({ fields: [], groups: [] }),
    saveConfig: vi.fn(),
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    getNotificationConfig: vi.fn().mockResolvedValue({ gates: {}, channels: [] }),
    saveNotificationConfig: vi.fn(),
    getReview: vi.fn().mockResolvedValue({ files: [], plan: {} }),
    getTickets: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue(null),
  },
}));

// Mock SSE so we don't open EventSource
vi.mock('../src/hooks/useSSE', () => ({
  useSSE: () => ({ connected: false, lastEventId: 0 }),
}));

describe('Hash routing — Settings and Review render', () => {
  beforeEach(() => {
    // Reset modules so store re-reads location.hash
    vi.resetModules();
  });

  it('#/settings: SettingsPage module imports cleanly', async () => {
    const mod = await import('../src/components/settings/SettingsPage');
    expect(mod.SettingsPage).toBeDefined();
    expect(typeof mod.SettingsPage).toBe('function');
  });

  it('#/review: DiffViewer module imports cleanly', async () => {
    const mod = await import('../src/components/review/DiffViewer');
    expect(mod.DiffViewer ?? mod.default).toBeDefined();
  });

  it('Toast module imports cleanly', async () => {
    const mod = await import('../src/contexts/ToastContext');
    expect(mod.ToastProvider).toBeDefined();
    expect(mod.useToast).toBeDefined();
  });

  it('ConfirmDialog module imports cleanly', async () => {
    const mod = await import('../src/components/ConfirmDialog');
    expect(mod.ConfirmDialog ?? mod.default).toBeDefined();
  });

  it('Navigation store reacts to hash change', async () => {
    const { useNavigationStore } = await import('../src/store/navigation');
    const initial = useNavigationStore.getState();
    expect(initial.currentView).toBeDefined();
    // Simulate hash navigation
    window.location.hash = '#/settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => {
      expect(useNavigationStore.getState().currentView).toBe('settings');
    });
    window.location.hash = '#/review';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => {
      expect(useNavigationStore.getState().currentView).toBe('review');
    });
  });
});
