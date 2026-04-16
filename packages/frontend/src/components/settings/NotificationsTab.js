import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Notifications Tab Component
// Grid of 9 pipeline gates x 5 notification channels with
// toggle switches for each cell
// ═══════════════════════════════════════════════════════════════
import { useEffect, useCallback } from 'react';
import { useSettingsStore, NOTIFICATION_GATES, NOTIFICATION_CHANNELS, } from '../../store/settings';
// ── Styles ──────────────────────────────────────────────────
const styles = {
    container: {
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-4)',
    },
    description: {
        fontSize: 13,
        color: 'var(--text-secondary)',
        lineHeight: 1.6,
        padding: 'var(--sp-3) var(--sp-4)',
        background: 'var(--bg-surface)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-default)',
    },
    tableWrap: {
        overflowX: 'auto',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-default)',
        background: 'var(--bg-surface)',
    },
    table: {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 13,
    },
    th: {
        padding: 'var(--sp-3) var(--sp-4)',
        textAlign: 'center',
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--text-tertiary)',
        borderBottom: '1px solid var(--border-default)',
        whiteSpace: 'nowrap',
    },
    thFirst: {
        textAlign: 'left',
        width: 200,
        minWidth: 200,
    },
    td: {
        padding: 'var(--sp-2) var(--sp-4)',
        textAlign: 'center',
        borderBottom: '1px solid var(--border-subtle)',
        verticalAlign: 'middle',
    },
    tdFirst: {
        textAlign: 'left',
        fontWeight: 500,
        color: 'var(--text-primary)',
        fontSize: 13,
    },
    row: {
        transition: 'background 0.1s',
    },
    rowHover: {
        background: 'var(--bg-elevated)',
    },
    toggle: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 36,
        height: 20,
        borderRadius: 10,
        cursor: 'pointer',
        transition: 'background 0.2s var(--ease-smooth)',
        position: 'relative',
        border: 'none',
        padding: 0,
    },
    toggleOff: {
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
    },
    toggleOn: {
        background: 'var(--accent)',
        border: '1px solid var(--accent)',
    },
    toggleDot: {
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: '#fff',
        position: 'absolute',
        top: 2,
        transition: 'left 0.2s var(--ease-smooth)',
    },
    toggleDotOff: {
        left: 2,
    },
    toggleDotOn: {
        left: 19,
    },
    actionBar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 'var(--sp-3)',
        padding: 'var(--sp-3) var(--sp-4)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
    },
    saveBtn: {
        padding: 'var(--sp-2) var(--sp-5)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        background: 'linear-gradient(135deg, var(--accent), #7c3aed)',
        color: '#fff',
        transition: 'all 0.15s',
        fontFamily: 'var(--font-sans)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
    },
    saveBtnDisabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
    },
    loadingWrap: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--sp-10)',
        color: 'var(--text-tertiary)',
        fontSize: 13,
        gap: 'var(--sp-2)',
    },
    spinner: {
        width: 18,
        height: 18,
        border: '2px solid var(--text-tertiary)',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        animation: 'btnSpin 0.6s linear infinite',
    },
    error: {
        padding: 'var(--sp-3) var(--sp-4)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--danger-muted)',
        border: '1px solid rgba(239,68,68,0.2)',
        color: 'var(--danger)',
        fontSize: 13,
    },
};
// ── Toggle Switch ───────────────────────────────────────────
function ToggleSwitch({ enabled, onChange, ariaLabel, }) {
    return (_jsx("button", { type: "button", role: "switch", "aria-checked": enabled, "aria-label": ariaLabel, style: {
            ...styles.toggle,
            ...(enabled ? styles.toggleOn : styles.toggleOff),
        }, onClick: onChange, children: _jsx("span", { style: {
                ...styles.toggleDot,
                ...(enabled ? styles.toggleDotOn : styles.toggleDotOff),
            } }) }));
}
// ── Component ───────────────────────────────────────────────
export function NotificationsTab() {
    const notificationConfig = useSettingsStore((s) => s.notificationConfig);
    const notificationLoading = useSettingsStore((s) => s.notificationLoading);
    const notificationSaving = useSettingsStore((s) => s.notificationSaving);
    const error = useSettingsStore((s) => s.error);
    const fetchNotificationConfig = useSettingsStore((s) => s.fetchNotificationConfig);
    const saveNotificationConfig = useSettingsStore((s) => s.saveNotificationConfig);
    const toggleNotification = useSettingsStore((s) => s.toggleNotification);
    useEffect(() => {
        fetchNotificationConfig();
    }, [fetchNotificationConfig]);
    const handleSave = useCallback(() => {
        if (notificationSaving)
            return;
        saveNotificationConfig();
    }, [notificationSaving, saveNotificationConfig]);
    if (notificationLoading) {
        return (_jsxs("div", { style: styles.loadingWrap, children: [_jsx("span", { style: styles.spinner }), "Loading notification config..."] }));
    }
    return (_jsxs("div", { style: styles.container, children: [_jsx("div", { style: styles.description, children: "Configure which notification channels fire at each pipeline gate. Toggle switches to enable or disable notifications per gate and channel." }), error && (_jsx("div", { style: styles.error, role: "alert", children: error })), _jsx("div", { style: styles.tableWrap, children: _jsxs("table", { style: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { style: { ...styles.th, ...styles.thFirst }, children: "Pipeline Gate" }), NOTIFICATION_CHANNELS.map((ch) => (_jsx("th", { style: styles.th, children: ch.label }, ch.id)))] }) }), _jsx("tbody", { children: NOTIFICATION_GATES.map((gate) => (_jsxs("tr", { style: styles.row, children: [_jsx("td", { style: { ...styles.td, ...styles.tdFirst }, children: gate.label }), NOTIFICATION_CHANNELS.map((ch) => {
                                        const enabled = notificationConfig[gate.id]?.[ch.id] ?? false;
                                        return (_jsx("td", { style: styles.td, children: _jsx(ToggleSwitch, { enabled: enabled, onChange: () => toggleNotification(gate.id, ch.id), ariaLabel: `${gate.label} via ${ch.label}` }) }, ch.id));
                                    })] }, gate.id))) })] }) }), _jsx("div", { style: styles.actionBar, children: _jsx("button", { type: "button", style: {
                        ...styles.saveBtn,
                        ...(notificationSaving ? styles.saveBtnDisabled : {}),
                    }, onClick: handleSave, disabled: notificationSaving, "aria-label": "Save notification configuration", children: notificationSaving ? (_jsxs(_Fragment, { children: [_jsx("span", { style: { ...styles.spinner, width: 14, height: 14, borderColor: '#fff', borderTopColor: 'transparent' } }), "Saving..."] })) : ('Save Notifications') }) })] }));
}
