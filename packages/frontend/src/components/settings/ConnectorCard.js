import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Connector Card Component
// Card with connector info, status badge, and test button
// Extended with OAuth status pill, connect/disconnect/re-auth
// buttons, expiry countdown, account identity, and PAT fallback
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect } from 'react';
// ── Styles ──────────────────────────────────────────────────
const styles = {
    card: {
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-default)',
        background: 'var(--bg-surface)',
        padding: 'var(--sp-5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-3)',
        transition: 'border-color 0.2s, box-shadow 0.2s',
    },
    cardHover: {
        borderColor: 'var(--border-strong)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
    },
    iconWrap: {
        width: 40,
        height: 40,
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        flexShrink: 0,
    },
    name: {
        fontSize: 15,
        fontWeight: 600,
        color: 'var(--text-primary)',
        flex: 1,
    },
    badge: {
        fontSize: 10,
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: 'var(--radius-full)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        whiteSpace: 'nowrap',
    },
    badgeConnected: {
        background: 'var(--success-muted)',
        color: 'var(--success)',
    },
    badgeDisconnected: {
        background: 'var(--bg-elevated)',
        color: 'var(--text-tertiary)',
    },
    badgeComingSoon: {
        background: 'var(--blue-muted)',
        color: 'var(--blue)',
    },
    description: {
        fontSize: 13,
        color: 'var(--text-secondary)',
        lineHeight: 1.5,
        flex: 1,
    },
    footer: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        marginTop: 'auto',
    },
    testBtn: {
        padding: 'var(--sp-2) var(--sp-3)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        border: '1px solid var(--border-default)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-secondary)',
        transition: 'all 0.15s',
        fontFamily: 'var(--font-sans)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-1)',
    },
    configLink: {
        padding: 'var(--sp-2) var(--sp-3)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        color: 'var(--accent)',
        transition: 'color 0.15s',
        fontFamily: 'var(--font-sans)',
    },
    btnDisabled: {
        opacity: 0.5,
        cursor: 'not-allowed',
        pointerEvents: 'none',
    },
    spinner: {
        width: 12,
        height: 12,
        border: '2px solid var(--text-tertiary)',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        animation: 'btnSpin 0.6s linear infinite',
        flexShrink: 0,
    },
    statusRow: {
        marginTop: 'var(--sp-2)',
        paddingTop: 'var(--sp-2)',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: 12,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--sp-1)',
        lineHeight: 1.4,
        wordBreak: 'break-word',
    },
    statusSuccess: {
        color: 'var(--success)',
    },
    statusError: {
        color: 'var(--danger)',
    },
    // OAuth-specific styles
    oauthSection: {
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-2)',
        paddingTop: 'var(--sp-2)',
        borderTop: '1px solid var(--border-subtle)',
    },
    oauthRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        flexWrap: 'wrap',
    },
    oauthBtn: {
        padding: 'var(--sp-1) var(--sp-3)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        border: '1px solid var(--border-default)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-secondary)',
        transition: 'all 0.15s',
        fontFamily: 'var(--font-sans)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-1)',
    },
    oauthBtnPrimary: {
        background: 'var(--accent-muted)',
        color: 'var(--accent)',
        border: '1px solid var(--accent)',
    },
    oauthBtnDanger: {
        background: 'var(--danger-muted)',
        color: 'var(--danger)',
        border: '1px solid rgba(239,68,68,0.2)',
    },
    oauthBtnWarning: {
        background: 'var(--warning-muted)',
        color: 'var(--warning)',
        border: '1px solid rgba(234,179,8,0.2)',
    },
    expiryText: {
        fontSize: 11,
        color: 'var(--text-tertiary)',
    },
    accountText: {
        fontSize: 11,
        color: 'var(--text-secondary)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-1)',
    },
    patDisclosure: {
        paddingTop: 'var(--sp-2)',
        borderTop: '1px solid var(--border-subtle)',
    },
    patToggle: {
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--text-tertiary)',
        fontSize: 11,
        fontWeight: 500,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
        transition: 'color 0.15s',
    },
    patContent: {
        marginTop: 'var(--sp-2)',
    },
};
// ── Connector Icon SVGs ─────────────────────────────────────
function ConnectorIcon({ icon }) {
    const common = {
        width: 20,
        height: 20,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'var(--text-secondary)',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
    };
    switch (icon) {
        case 'drive':
            return (_jsxs("svg", { ...common, children: [_jsx("path", { d: "M7 3l6 10H3l6-10z" }), _jsx("path", { d: "M13 3l4 7H7" }), _jsx("path", { d: "M3 13h10l4 4H7" })] }));
        case 'figma':
            return (_jsxs("svg", { ...common, children: [_jsx("rect", { x: "6", y: "2", width: "4", height: "5", rx: "2" }), _jsx("rect", { x: "10", y: "2", width: "4", height: "5", rx: "2" }), _jsx("rect", { x: "6", y: "7", width: "4", height: "5", rx: "2" }), _jsx("circle", { cx: "12", cy: "9.5", r: "2" }), _jsx("rect", { x: "6", y: "12", width: "4", height: "5", rx: "2" })] }));
        case 'postman':
            return (_jsxs("svg", { ...common, children: [_jsx("circle", { cx: "10", cy: "10", r: "7" }), _jsx("path", { d: "M7 10l2 2 4-4" })] }));
        case 'jira':
            return (_jsxs("svg", { ...common, children: [_jsx("path", { d: "M10 2l4 4-4 4-4-4 4-4z" }), _jsx("path", { d: "M10 10l4 4-4 4-4-4 4-4z" })] }));
        case 'gitlab':
            return (_jsx("svg", { ...common, children: _jsx("path", { d: "M10 17L3 9l2-5 2 5h6l2-5 2 5-7 8z" }) }));
        case 'slack':
            return (_jsxs("svg", { ...common, children: [_jsx("rect", { x: "3", y: "7", width: "5", height: "2", rx: "1" }), _jsx("rect", { x: "12", y: "11", width: "5", height: "2", rx: "1" }), _jsx("rect", { x: "7", y: "3", width: "2", height: "5", rx: "1" }), _jsx("rect", { x: "11", y: "12", width: "2", height: "5", rx: "1" }), _jsx("rect", { x: "7", y: "11", width: "6", height: "2", rx: "1" }), _jsx("rect", { x: "7", y: "7", width: "2", height: "6", rx: "1" })] }));
        case 'claude':
        case 'anthropic':
            return (_jsx("svg", { ...common, children: _jsx("path", { d: "M10 3l3 7 4 1-3 3 1 4-5-3-5 3 1-4-3-3 4-1 3-7z" }) }));
        case 'confluence':
            return (_jsxs("svg", { ...common, children: [_jsx("rect", { x: "3", y: "4", width: "14", height: "4", rx: "1" }), _jsx("rect", { x: "5", y: "9", width: "10", height: "4", rx: "1" }), _jsx("rect", { x: "7", y: "14", width: "6", height: "3", rx: "1" })] }));
        case 'notion':
            return (_jsxs("svg", { ...common, children: [_jsx("path", { d: "M4 3h9l3 3v11H4V3z" }), _jsx("path", { d: "M13 3v3h3" }), _jsx("path", { d: "M7 9h6M7 12h6M7 15h4" })] }));
        case 'browser':
            return (_jsxs("svg", { ...common, children: [_jsx("rect", { x: "2", y: "4", width: "16", height: "12", rx: "2" }), _jsx("path", { d: "M2 8h16" }), _jsx("circle", { cx: "5", cy: "6", r: "0.6", fill: "currentColor" }), _jsx("circle", { cx: "7", cy: "6", r: "0.6", fill: "currentColor" }), _jsx("circle", { cx: "9", cy: "6", r: "0.6", fill: "currentColor" })] }));
        case 'email':
            return (_jsxs("svg", { ...common, children: [_jsx("rect", { x: "2", y: "4", width: "16", height: "12", rx: "2" }), _jsx("path", { d: "M2 6l8 6 8-6" })] }));
        default:
            return (_jsxs("svg", { ...common, strokeLinejoin: "miter", children: [_jsx("rect", { x: "3", y: "3", width: "14", height: "14", rx: "3" }), _jsx("path", { d: "M7 10h6M10 7v6" })] }));
    }
}
// ── Status badge text (original) ────────────────────────────
function statusLabel(status) {
    switch (status) {
        case 'connected':
            return 'Connected';
        case 'disconnected':
            return 'Disconnected';
        case 'coming_soon':
            return 'Coming Soon';
    }
}
function statusBadgeStyle(status) {
    switch (status) {
        case 'connected':
            return styles.badgeConnected;
        case 'disconnected':
            return styles.badgeDisconnected;
        case 'coming_soon':
            return styles.badgeComingSoon;
    }
}
// ── OAuth Status Pill ───────────────────────────────────────
const OAUTH_PILL_MAP = {
    CONNECTED: {
        label: 'Connected',
        bg: 'var(--success-muted)',
        color: 'var(--success)',
    },
    REFRESHING: {
        label: 'Refreshing\u2026',
        bg: 'var(--blue-muted)',
        color: 'var(--blue)',
    },
    RE_AUTH_REQUIRED: {
        label: 'Re-auth required',
        bg: 'var(--warning-muted)',
        color: 'var(--warning)',
    },
    REVOKED: {
        label: 'Revoked',
        bg: 'var(--danger-muted)',
        color: 'var(--danger)',
    },
    NOT_CONNECTED: {
        label: 'Not connected',
        bg: 'var(--bg-elevated)',
        color: 'var(--text-tertiary)',
    },
    PAT: {
        label: 'Connected via PAT',
        bg: 'var(--success-muted)',
        color: 'var(--success)',
    },
};
function StatusPill({ oauthStatus }) {
    const pill = OAUTH_PILL_MAP[oauthStatus];
    return (_jsx("span", { style: {
            ...styles.badge,
            background: pill.bg,
            color: pill.color,
        }, children: pill.label }));
}
// ── Expiry countdown hook ───────────────────────────────────
function useExpiryCountdown(expiresAt) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!expiresAt)
            return;
        const id = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(id);
    }, [expiresAt]);
    if (!expiresAt)
        return null;
    const diff = expiresAt - now;
    if (diff <= 0)
        return null;
    const mins = Math.ceil(diff / 60_000);
    if (mins >= 60) {
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        return `Refreshes in ${hrs}h ${rem}m`;
    }
    return `Refreshes in ${mins} min`;
}
// ── Component ───────────────────────────────────────────────
export function ConnectorCard({ name, icon, description, status, onTest, onConfigure, testResult, supportsOAuth = false, oauthInfo, onOAuthConnect, onOAuthDisconnect, oauthLaunching = false, patFallbackContent, }) {
    const isComingSoon = status === 'coming_soon';
    const isTesting = testResult?.loading ?? false;
    const result = testResult?.result ?? null;
    // PAT fallback disclosure state (for OAuth-capable providers)
    const [patExpanded, setPatExpanded] = useState(false);
    // Expiry countdown
    const expiryText = useExpiryCountdown(oauthInfo?.expiresAt);
    // Derive OAuth display state
    const oauthStatus = oauthInfo?.oauthStatus ?? 'NOT_CONNECTED';
    const isOAuthConnected = oauthStatus === 'CONNECTED' || oauthStatus === 'REFRESHING';
    const needsReAuth = oauthStatus === 'RE_AUTH_REQUIRED' || oauthStatus === 'REVOKED';
    const showOAuthConnect = supportsOAuth && !isOAuthConnected && !needsReAuth && oauthStatus !== 'PAT';
    const accountEmail = oauthInfo?.metadata?.email;
    return (_jsxs("div", { style: styles.card, children: [_jsxs("div", { style: styles.header, children: [_jsx("div", { style: styles.iconWrap, children: _jsx(ConnectorIcon, { icon: icon }) }), _jsx("span", { style: styles.name, children: name }), supportsOAuth && oauthInfo ? (_jsx(StatusPill, { oauthStatus: oauthStatus })) : (_jsx("span", { style: { ...styles.badge, ...statusBadgeStyle(status) }, children: statusLabel(status) }))] }), _jsx("div", { style: styles.description, children: description }), supportsOAuth && accountEmail && (_jsxs("div", { style: styles.accountText, children: [_jsxs("svg", { width: "12", height: "12", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", children: [_jsx("circle", { cx: "8", cy: "5", r: "3" }), _jsx("path", { d: "M2 14c0-3 2.5-5 6-5s6 2 6 5" })] }), accountEmail] })), supportsOAuth && expiryText && (_jsx("div", { style: styles.expiryText, children: expiryText })), supportsOAuth && !isComingSoon && (_jsx("div", { style: styles.oauthSection, children: _jsxs("div", { style: styles.oauthRow, children: [showOAuthConnect && onOAuthConnect && (_jsx("button", { type: "button", style: {
                                ...styles.oauthBtn,
                                ...styles.oauthBtnPrimary,
                                ...(oauthLaunching ? styles.btnDisabled : {}),
                            }, onClick: onOAuthConnect, disabled: oauthLaunching, "aria-label": `Connect ${name} via OAuth`, children: oauthLaunching ? (_jsxs(_Fragment, { children: [_jsx("span", { style: styles.spinner }), "Connecting..."] })) : ('Connect') })), isOAuthConnected && onOAuthDisconnect && (_jsx("button", { type: "button", style: { ...styles.oauthBtn, ...styles.oauthBtnDanger }, onClick: onOAuthDisconnect, "aria-label": `Disconnect ${name}`, children: "Disconnect" })), icon === 'figma' && isOAuthConnected && (_jsxs("div", { style: { fontSize: '0.7rem', color: '#94a3b8', marginTop: 4 }, children: ["To fully revoke, visit", ' ', _jsx("a", { href: "https://www.figma.com/settings", target: "_blank", rel: "noopener noreferrer", style: { color: '#60a5fa', textDecoration: 'underline' }, children: "Figma Settings \u2192 Connected apps" })] })), needsReAuth && onOAuthConnect && (_jsx("button", { type: "button", style: {
                                ...styles.oauthBtn,
                                ...styles.oauthBtnWarning,
                                ...(oauthLaunching ? styles.btnDisabled : {}),
                            }, onClick: onOAuthConnect, disabled: oauthLaunching, "aria-label": `Re-authorize ${name}`, children: oauthLaunching ? (_jsxs(_Fragment, { children: [_jsx("span", { style: styles.spinner }), "Re-authorizing..."] })) : ('Re-authorize') }))] }) })), _jsxs("div", { style: styles.footer, children: [!isComingSoon && onTest && (_jsx("button", { type: "button", style: {
                            ...styles.testBtn,
                            ...(isTesting ? styles.btnDisabled : {}),
                        }, onClick: onTest, disabled: isTesting, "aria-label": `Test ${name} connection`, children: isTesting ? (_jsxs(_Fragment, { children: [_jsx("span", { style: styles.spinner }), "Testing\u2026"] })) : (_jsxs(_Fragment, { children: [_jsxs("svg", { width: "12", height: "12", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", children: [_jsx("path", { d: "M5 8l2 2 4-4" }), _jsx("circle", { cx: "8", cy: "8", r: "6" })] }), "Test"] })) })), !isComingSoon && (_jsx("button", { type: "button", style: {
                            ...styles.configLink,
                            ...(onConfigure ? {} : styles.btnDisabled),
                        }, onClick: onConfigure, disabled: !onConfigure, "aria-label": `Configure ${name}`, children: "Configure" }))] }), !isTesting && result && (_jsxs("div", { style: {
                    ...styles.statusRow,
                    ...(result.ok ? styles.statusSuccess : styles.statusError),
                }, role: "status", "aria-live": "polite", children: [result.ok ? (_jsx("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", style: { flexShrink: 0, marginTop: 2 }, children: _jsx("path", { d: "M4 8l3 3 5-6" }) })) : (_jsx("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", style: { flexShrink: 0, marginTop: 2 }, children: _jsx("path", { d: "M4 4l8 8M12 4l-8 8" }) })), _jsx("span", { children: result.message || (result.ok ? 'Connected' : 'Connection failed') })] })), supportsOAuth && patFallbackContent && (_jsxs("div", { style: styles.patDisclosure, children: [_jsx("button", { type: "button", style: styles.patToggle, onClick: () => setPatExpanded((v) => !v), "aria-expanded": patExpanded, children: patExpanded ? 'Hide API token \u25B4' : 'Use API token instead \u25BE' }), patExpanded && (_jsx("div", { style: styles.patContent, children: patFallbackContent }))] }))] }));
}
