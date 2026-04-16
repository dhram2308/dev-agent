import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Agent Activity Bar
// Single-line live status driven by `state.data._agent_action`.
// Returns null when no action is set so it doesn't reserve layout space.
// ═══════════════════════════════════════════════════════════════
import { useActiveTicketState } from '../store/pipeline';
const styles = {
    container: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: 'var(--sp-2) var(--sp-3)',
        marginBottom: 'var(--sp-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        fontSize: 12,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.5,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        animation: 'fadeIn 0.2s ease-out',
    },
    dot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: 'var(--blue)',
        boxShadow: '0 0 6px var(--blue)',
        flexShrink: 0,
        animation: 'pulse 1.5s infinite',
    },
    text: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
    },
};
export function AgentActivityBar() {
    const ticketState = useActiveTicketState();
    const action = ticketState?.state?.data?._agent_action;
    if (typeof action !== 'string' || action.trim().length === 0) {
        return null;
    }
    return (_jsxs("div", { style: styles.container, role: "status", "aria-live": "polite", children: [_jsx("span", { style: styles.dot, "aria-hidden": "true" }), _jsx("span", { style: styles.text, children: action })] }));
}
