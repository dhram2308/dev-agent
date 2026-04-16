// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Global Keyboard Shortcuts Hook
// Binds keyboard shortcuts that work from anywhere in the app
// (unless focus is in an input/textarea/contenteditable).
//
// Shortcuts:
//   ?        Show help (dispatches a 'mi:show-shortcuts' CustomEvent)
//   j / k    Navigate ticket list (next / prev)
//   a        Approve gate (if gate is waiting on active ticket)
//   r        Reject gate (if gate is waiting on active ticket)
//   f        Focus the topbar ticket input
//   g d      Go to dashboard
//   g s      Go to settings
//   g r      Go to review
// ═══════════════════════════════════════════════════════════════
import { useEffect, useRef } from 'react';
import { usePipelineStore } from '../store/pipeline';
import { useNavigationStore } from '../store/navigation';
import { useReviewStore } from '../store/review';
const CHORD_TIMEOUT_MS = 900;
function isTypingTarget(target) {
    if (!(target instanceof HTMLElement))
        return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')
        return true;
    if (target.isContentEditable)
        return true;
    return false;
}
function focusTicketInput() {
    // Topbar + TicketForm inputs both use name="ticket" or aria-label containing "ticket"
    const el = document.querySelector('input[name="ticket"]') ??
        document.querySelector('input[aria-label*="ticket" i]');
    if (el) {
        el.focus();
        el.select();
    }
}
/**
 * Mount once at App level to enable global shortcuts.
 */
export function useGlobalKeyboardShortcuts() {
    const chordArmed = useRef(false);
    const chordTimer = useRef(null);
    useEffect(() => {
        function clearChord() {
            chordArmed.current = false;
            if (chordTimer.current) {
                clearTimeout(chordTimer.current);
                chordTimer.current = null;
            }
        }
        function setView(view) {
            useNavigationStore.getState().setView(view);
        }
        function nextTicket(delta) {
            const { tickets, activeTicket, setActiveTicket } = usePipelineStore.getState();
            const keys = Array.from(tickets.keys());
            if (keys.length === 0)
                return;
            const idx = activeTicket ? keys.indexOf(activeTicket) : -1;
            const nextIdx = (idx + delta + keys.length) % keys.length;
            setActiveTicket(keys[nextIdx] ?? null);
        }
        async function approveActiveGate() {
            const { activeTicket, tickets, approveGate } = usePipelineStore.getState();
            if (!activeTicket)
                return;
            const t = tickets.get(activeTicket);
            if (!t?.gateWaiting)
                return;
            await approveGate(activeTicket, t.gateWaiting);
        }
        async function rejectActiveGate() {
            const { activeTicket, tickets, rejectGate } = usePipelineStore.getState();
            if (!activeTicket)
                return;
            const t = tickets.get(activeTicket);
            if (!t?.gateWaiting)
                return;
            // Keyboard reject sends an empty reason; the GateApproval UI
            // still lets users enter a detailed reason. This is a quick action.
            await rejectGate(activeTicket, t.gateWaiting, '');
        }
        function handleKey(e) {
            if (e.ctrlKey || e.metaKey || e.altKey)
                return;
            if (isTypingTarget(e.target))
                return;
            // Chord state: previous 'g' was pressed -> expect d/s/r
            if (chordArmed.current) {
                if (e.key === 'd')
                    setView('dashboard');
                else if (e.key === 's')
                    setView('settings');
                else if (e.key === 'r')
                    setView('review');
                clearChord();
                e.preventDefault();
                return;
            }
            switch (e.key) {
                case '?':
                    window.dispatchEvent(new CustomEvent('mi:show-shortcuts'));
                    e.preventDefault();
                    break;
                case 'j':
                    nextTicket(1);
                    e.preventDefault();
                    break;
                case 'k':
                    nextTicket(-1);
                    e.preventDefault();
                    break;
                case 'a':
                    void approveActiveGate();
                    e.preventDefault();
                    break;
                case 'r':
                    void rejectActiveGate();
                    e.preventDefault();
                    break;
                case 'f': {
                    // If paused at a refine-eligible gate, open the refine form.
                    // Otherwise fall back to focusing the ticket input.
                    const { activeTicket, tickets } = usePipelineStore.getState();
                    const t = activeTicket ? tickets.get(activeTicket) : null;
                    if (t?.gateWaiting === 'explore_plan') {
                        useReviewStore.getState().setRefineOpen(true);
                    }
                    else {
                        focusTicketInput();
                    }
                    e.preventDefault();
                    break;
                }
                case 'g':
                    chordArmed.current = true;
                    chordTimer.current = setTimeout(clearChord, CHORD_TIMEOUT_MS);
                    e.preventDefault();
                    break;
                default:
                    break;
            }
        }
        window.addEventListener('keydown', handleKey);
        return () => {
            window.removeEventListener('keydown', handleKey);
            clearChord();
        };
    }, []);
}
