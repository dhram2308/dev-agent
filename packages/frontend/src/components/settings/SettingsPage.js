import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Settings Page
// 3-tab interface: Configuration, Notifications, Connectors
// with display settings in header area
// ═══════════════════════════════════════════════════════════════
import { useCallback } from 'react';
import { useSettingsStore } from '../../store/settings';
import { ConfigTab } from './ConfigTab';
import { NotificationsTab } from './NotificationsTab';
import { ConnectorsTab } from './ConnectorsTab';
import { DisplaySettings } from './DisplaySettings';
// ── Styles ──────────────────────────────────────────────────
const styles = {
    page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-5)',
        animation: 'fadeIn 0.3s ease-out',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-4)',
        flexWrap: 'wrap',
    },
    headerIcon: {
        width: 36,
        height: 36,
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--accent-muted)',
        color: 'var(--accent)',
        flexShrink: 0,
    },
    titleArea: {
        flex: 1,
    },
    title: {
        fontSize: 18,
        fontWeight: 700,
        color: 'var(--text-primary)',
        letterSpacing: '-0.02em',
    },
    subtitle: {
        fontSize: 12,
        color: 'var(--text-tertiary)',
        marginTop: 2,
    },
    tabBar: {
        display: 'flex',
        gap: 0,
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        padding: 3,
        overflow: 'hidden',
    },
    tab: {
        flex: 1,
        padding: 'var(--sp-2) var(--sp-4)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        color: 'var(--text-secondary)',
        transition: 'all 0.15s var(--ease-smooth)',
        fontFamily: 'var(--font-sans)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--sp-2)',
        whiteSpace: 'nowrap',
    },
    tabActive: {
        background: 'var(--accent-muted)',
        color: 'var(--accent)',
    },
    tabContent: {
        minHeight: 300,
    },
};
const TABS = [
    {
        id: 'config',
        label: 'Configuration',
        icon: (_jsxs("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("circle", { cx: "8", cy: "8", r: "2.5" }), _jsx("path", { d: "M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" })] })),
    },
    {
        id: 'notifications',
        label: 'Notifications',
        icon: (_jsxs("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("path", { d: "M4 6a4 4 0 018 0c0 2 1 3 2 4H2c1-1 2-2 2-4z" }), _jsx("path", { d: "M6 14h4" })] })),
    },
    {
        id: 'connectors',
        label: 'Connectors',
        icon: (_jsxs("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("rect", { x: "1", y: "5", width: "5", height: "6", rx: "1" }), _jsx("rect", { x: "10", y: "5", width: "5", height: "6", rx: "1" }), _jsx("path", { d: "M6 8h4" })] })),
    },
];
// ── Component ───────────────────────────────────────────────
export function SettingsPage() {
    const activeTab = useSettingsStore((s) => s.activeTab);
    const setActiveTab = useSettingsStore((s) => s.setActiveTab);
    const handleTabClick = useCallback((tab) => {
        setActiveTab(tab);
    }, [setActiveTab]);
    return (_jsxs("div", { style: styles.page, children: [_jsxs("div", { style: styles.header, children: [_jsx("div", { style: styles.headerIcon, children: _jsxs("svg", { width: "18", height: "18", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", children: [_jsx("circle", { cx: "8", cy: "8", r: "2.5" }), _jsx("path", { d: "M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" })] }) }), _jsxs("div", { style: styles.titleArea, children: [_jsx("div", { style: styles.title, children: "Settings" }), _jsx("div", { style: styles.subtitle, children: "Configure the agent pipeline, notification routing, and external connectors" })] })] }), _jsx(DisplaySettings, {}), _jsx("div", { style: styles.tabBar, role: "tablist", "aria-label": "Settings tabs", children: TABS.map((tab) => (_jsxs("button", { style: {
                        ...styles.tab,
                        ...(activeTab === tab.id ? styles.tabActive : {}),
                    }, onClick: () => handleTabClick(tab.id), role: "tab", "aria-selected": activeTab === tab.id, "aria-controls": `tabpanel-${tab.id}`, id: `tab-${tab.id}`, children: [tab.icon, tab.label] }, tab.id))) }), _jsxs("div", { style: styles.tabContent, role: "tabpanel", id: `tabpanel-${activeTab}`, "aria-labelledby": `tab-${activeTab}`, children: [activeTab === 'config' && _jsx(ConfigTab, {}), activeTab === 'notifications' && _jsx(NotificationsTab, {}), activeTab === 'connectors' && _jsx(ConnectorsTab, {})] })] }));
}
