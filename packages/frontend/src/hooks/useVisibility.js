// ═══════════════════════════════════════════════════════════════
// useVisibility — Single visibility change listener
// Fixes duplicate listeners from html.js (lines 5209, 6152)
// ONE document.addEventListener('visibilitychange') per hook instance
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect, useCallback, useRef } from 'react';
/**
 * Single visibility change listener hook.
 *
 * Provides:
 * - Current visibility state
 * - Callback registration for visibility changes
 * - Cleanup on unmount (removes the single listener)
 *
 * Replaces the duplicated `document.addEventListener('visibilitychange', ...)`
 * calls scattered throughout the original html.js.
 */
export function useVisibility() {
    const [visible, setVisible] = useState(typeof document !== 'undefined' ? !document.hidden : true);
    // Store callbacks in a ref to avoid re-registering the listener
    const callbacksRef = useRef(new Set());
    useEffect(() => {
        if (typeof document === 'undefined')
            return;
        const handleVisibilityChange = () => {
            const isVisible = !document.hidden;
            setVisible(isVisible);
            // Notify all registered callbacks
            for (const cb of callbacksRef.current) {
                try {
                    cb(isVisible);
                }
                catch {
                    // Swallow errors in callbacks to avoid breaking other listeners
                }
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);
    const onVisibilityChange = useCallback((cb) => {
        callbacksRef.current.add(cb);
        return () => {
            callbacksRef.current.delete(cb);
        };
    }, []);
    return { visible, onVisibilityChange };
}
export default useVisibility;
