// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Zustand Navigation Store
// Hash-based routing with 3 views: dashboard, settings, review
// Syncs URL hash to store on load and hashchange
// ═══════════════════════════════════════════════════════════════

import { create } from 'zustand';

/** Available application views */
export type AppView = 'dashboard' | 'settings' | 'review';

/** All valid views for validation */
const VALID_VIEWS: readonly AppView[] = ['dashboard', 'settings', 'review'] as const;

/** Parse the URL hash into a valid AppView, defaulting to 'dashboard' */
function parseHash(): AppView {
  const raw = window.location.hash.replace(/^#\/?/, '').toLowerCase();
  if (VALID_VIEWS.includes(raw as AppView)) {
    return raw as AppView;
  }
  return 'dashboard';
}

// ── Store Interface ────────────────────────────────────────────

export interface NavigationStore {
  currentView: AppView;
  setView: (view: AppView) => void;
}

// ── Store ──────────────────────────────────────────────────────

export const useNavigationStore = create<NavigationStore>((set) => ({
  currentView: parseHash(),

  setView: (view) => {
    window.location.hash = `#/${view}`;
    set({ currentView: view });
  },
}));

// ── Hash listener ──────────────────────────────────────────────
// Listens for browser back/forward navigation and syncs to store

function handleHashChange(): void {
  const view = parseHash();
  const { currentView } = useNavigationStore.getState();
  if (view !== currentView) {
    useNavigationStore.setState({ currentView: view });
  }
}

window.addEventListener('hashchange', handleHashChange);

// Set initial hash if empty
if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/') {
  window.location.hash = '#/dashboard';
}
