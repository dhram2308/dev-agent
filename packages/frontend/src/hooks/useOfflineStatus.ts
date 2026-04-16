// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — useOfflineStatus Hook
// Tracks navigator.onLine so UI can show an offline banner.
// ═══════════════════════════════════════════════════════════════

import { useState, useEffect } from 'react';

/**
 * Returns true when the browser reports the network is offline.
 * Listens to online/offline window events.
 */
export function useOfflineStatus(): boolean {
  const [offline, setOffline] = useState<boolean>(() => {
    // Guard for older Node/jsdom that may not expose navigator.onLine
    if (typeof navigator === 'undefined') return false;
    return navigator.onLine === false;
  });

  useEffect(() => {
    function handleOnline(): void {
      setOffline(false);
    }
    function handleOffline(): void {
      setOffline(true);
    }
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return offline;
}
