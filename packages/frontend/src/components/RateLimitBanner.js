import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Rate Limit Banner
// Listens for 'mi:rate-limit' CustomEvents (dispatched by apiFetch when
// the server returns 429) and shows a dismissible countdown banner
// until the Retry-After window elapses.
// ═══════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
const styles = {
    banner: {
        position: 'sticky',
        top: 0,
        zIndex: 70,
        padding: 'var(--sp-3) var(--sp-4)',
        background: 'var(--warning-muted)',
        borderBottom: '1px solid var(--warning)',
        color: 'var(--warning)',
        fontSize: 13,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
    },
    icon: {
        flexShrink: 0,
    },
    text: {
        flex: 1,
    },
    title: {
        fontWeight: 700,
    },
    detail: {
        fontSize: 12,
        opacity: 0.85,
    },
    dismiss: {
        padding: '2px 10px',
        borderRadius: 'var(--radius-sm)',
        background: 'transparent',
        border: '1px solid var(--warning)',
        color: 'var(--warning)',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
    },
};
export function RateLimitBanner() {
    const [state, setState] = useState({
        active: false,
        secondsLeft: 0,
        message: '',
    });
    // Listen for rate-limit events dispatched by apiFetch
    useEffect(() => {
        function onRateLimit(e) {
            const detail = e.detail;
            const secs = Math.max(1, Math.round(detail.retryAfter ?? 60));
            setState({
                active: true,
                secondsLeft: secs,
                message: detail.message ?? 'Rate limit exceeded',
            });
        }
        window.addEventListener('mi:rate-limit', onRateLimit);
        return () => {
            window.removeEventListener('mi:rate-limit', onRateLimit);
        };
    }, []);
    // Countdown tick
    useEffect(() => {
        if (!state.active)
            return;
        const id = setInterval(() => {
            setState((prev) => {
                if (!prev.active)
                    return prev;
                const next = prev.secondsLeft - 1;
                if (next <= 0) {
                    return { active: false, secondsLeft: 0, message: '' };
                }
                return { ...prev, secondsLeft: next };
            });
        }, 1000);
        return () => clearInterval(id);
    }, [state.active]);
    if (!state.active)
        return null;
    return (_jsxs("div", { style: styles.banner, role: "status", "aria-live": "polite", children: [_jsxs("svg", { width: "18", height: "18", viewBox: "0 0 18 18", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", style: styles.icon, children: [_jsx("circle", { cx: "9", cy: "9", r: "7.25" }), _jsx("path", { d: "M9 5v4l2.5 2.5" })] }), _jsxs("div", { style: styles.text, children: [_jsx("span", { style: styles.title, children: "Rate limit hit." }), ' ', _jsxs("span", { style: styles.detail, children: ["Retrying allowed in ", state.secondsLeft, "s. ", state.message] })] }), _jsx("button", { type: "button", style: styles.dismiss, onClick: () => setState({ active: false, secondsLeft: 0, message: '' }), "aria-label": "Dismiss rate limit banner", children: "Dismiss" })] }));
}
