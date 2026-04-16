import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Auth Required Banner
// Listens for SSE 'authRequired' events and shows a persistent
// amber banner with provider name, reason, and a re-authorize
// button. Auto-dismisses when 'connectorConnected' fires for
// the same provider.
// ═══════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { useOAuthLauncher } from '../hooks/useOAuthLauncher';
// ── Styles ──────────────────────────────────────────────────
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
    reAuthBtn: {
        padding: '2px 10px',
        borderRadius: 'var(--radius-sm)',
        background: 'transparent',
        border: '1px solid var(--warning)',
        color: 'var(--warning)',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-1)',
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
        fontFamily: 'var(--font-sans)',
    },
    spinner: {
        width: 10,
        height: 10,
        border: '2px solid var(--warning)',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        animation: 'btnSpin 0.6s linear infinite',
        flexShrink: 0,
    },
};
// ── Component ───────────────────────────────────────────────
export function AuthRequiredBanner() {
    const [authState, setAuthState] = useState(null);
    const { launch, launching } = useOAuthLauncher();
    // Listen for authRequired custom events (dispatched by SSE handler)
    useEffect(() => {
        function onAuthRequired(e) {
            const detail = e.detail;
            if (!detail.provider)
                return;
            setAuthState({
                provider: detail.provider,
                reason: detail.reason ?? 'Authorization expired or revoked',
            });
        }
        window.addEventListener('mi:auth-required', onAuthRequired);
        return () => {
            window.removeEventListener('mi:auth-required', onAuthRequired);
        };
    }, []);
    // Listen for connectorConnected custom events to auto-dismiss
    useEffect(() => {
        function onConnected(e) {
            const detail = e.detail;
            if (authState && detail.provider === authState.provider) {
                setAuthState(null);
            }
        }
        window.addEventListener('mi:connector-connected', onConnected);
        return () => {
            window.removeEventListener('mi:connector-connected', onConnected);
        };
    }, [authState]);
    if (!authState)
        return null;
    const providerLabel = authState.provider.charAt(0).toUpperCase() + authState.provider.slice(1);
    const isLaunching = launching === authState.provider;
    return (_jsxs("div", { style: styles.banner, role: "status", "aria-live": "polite", children: [_jsxs("svg", { width: "18", height: "18", viewBox: "0 0 18 18", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", style: styles.icon, children: [_jsx("path", { d: "M9 2l.7 1.8a1 1 0 00.6.6L12 5l-1.8.7a1 1 0 00-.6.6L9 8l-.7-1.8a1 1 0 00-.6-.6L6 5l1.8-.7a1 1 0 00.6-.6L9 2z" }), _jsx("circle", { cx: "9", cy: "12", r: "4" }), _jsx("path", { d: "M9 10v2.5l1.5 1" })] }), _jsxs("div", { style: styles.text, children: [_jsxs("span", { style: styles.title, children: [providerLabel, " re-authorization required."] }), ' ', _jsx("span", { style: styles.detail, children: authState.reason })] }), _jsx("button", { type: "button", style: styles.reAuthBtn, onClick: () => launch(authState.provider), disabled: isLaunching, "aria-label": `Re-authorize ${providerLabel}`, children: isLaunching ? (_jsxs(_Fragment, { children: [_jsx("span", { style: styles.spinner }), "Authorizing..."] })) : (`Re-authorize ${providerLabel}`) }), _jsx("button", { type: "button", style: styles.dismiss, onClick: () => setAuthState(null), "aria-label": "Dismiss auth required banner", children: "Dismiss" })] }));
}
