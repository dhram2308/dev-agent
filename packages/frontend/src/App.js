import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Main App Component
// Sidebar layout with pipeline dashboard, resume dialog,
// gate notifications, and multi-ticket support
// ═══════════════════════════════════════════════════════════════
import { useCallback, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { TicketForm } from './components/TicketForm';
import { AgentStatus } from './components/AgentStatus';
import { LogViewer } from './components/LogViewer';
import { GateApproval } from './components/GateApproval';
import { ResumeDialog } from './components/ResumeDialog';
import { GateNotificationBar } from './components/GateNotificationBar';
import { PipelineDetail } from './components/PipelineDetail';
import { ErrorOverlay } from './components/ErrorOverlay';
import { ContextInjectionPanel } from './components/ContextInjectionPanel';
import { StuckBanner } from './components/StuckBanner';
import { LogFileArchiveViewer } from './components/LogFileArchiveViewer';
import { TicketTabBar } from './components/TicketTabBar';
import { QAProgressPanel } from './components/QAProgressPanel';
import { WriteCodeDetail } from './components/WriteCodeDetail';
import { DiffViewer } from './components/review/DiffViewer';
import { SettingsPage as SettingsPageImpl } from './components/settings/SettingsPage';
import { ShortcutsHelpModal } from './components/ShortcutsHelpModal';
import { RateLimitBanner } from './components/RateLimitBanner';
import { AuthRequiredBanner } from './components/AuthRequiredBanner';
import { usePipelineStore, useActiveTicketState } from './store/pipeline';
import { useNavigationStore } from './store/navigation';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { useSSEConnection } from './hooks/useSSEConnection';
import { useTheme } from './hooks/useTheme';
import { useOfflineStatus } from './hooks/useOfflineStatus';
import { useGlobalKeyboardShortcuts } from './hooks/useGlobalKeyboardShortcuts';
import { setApiToken } from './lib/api';
// ── Styles ─────────────────────────────────────────────────────
const styles = {
    appLayout: {
        display: 'flex',
        minHeight: '100vh',
        position: 'relative',
        zIndex: 1,
    },
    mainContent: {
        flex: 1,
        marginLeft: 'var(--sidebar-w)',
        minHeight: '100vh',
        transition: 'margin-left 0.3s var(--ease-smooth)',
        position: 'relative',
        zIndex: 1,
    },
    topbar: {
        position: 'sticky',
        top: 3,
        zIndex: 50,
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
        borderBottom: '1px solid var(--glass-border)',
        padding: 'var(--sp-3) var(--sp-5)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
    },
    topbarSearch: {
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--sp-2) var(--sp-3)',
        transition: 'border-color 0.2s, box-shadow 0.2s',
    },
    topbarInput: {
        flex: 1,
        border: 'none',
        background: 'transparent',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        outline: 'none',
    },
    topbarStatus: {
        padding: 'var(--sp-1) var(--sp-3)',
        borderRadius: 'var(--radius-full)',
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        whiteSpace: 'nowrap',
    },
    topbarBtn: {
        padding: 'var(--sp-2) var(--sp-4)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        transition: 'all 0.2s var(--ease-smooth)',
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-1)',
        fontFamily: 'var(--font-sans)',
    },
    mainPanels: {
        padding: 'var(--sp-5)',
        maxWidth: 1200,
    },
    iconBtn: {
        padding: 'var(--sp-2)',
        width: 32,
        height: 32,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.2s var(--ease-smooth)',
    },
    offlineBanner: {
        position: 'sticky',
        top: 0,
        zIndex: 60,
        padding: 'var(--sp-2) var(--sp-4)',
        background: 'var(--danger)',
        color: '#fff',
        fontSize: 12,
        fontWeight: 600,
        textAlign: 'center',
        letterSpacing: '0.03em',
    },
};
// ── Initialize API token ───────────────────────────────────────
function initApiToken() {
    const globalToken = window.__API_TOKEN__;
    if (globalToken) {
        setApiToken(globalToken);
        return;
    }
    const envToken = import.meta.env.VITE_API_TOKEN;
    if (envToken) {
        setApiToken(envToken);
        return;
    }
    const metaToken = document.querySelector('meta[name="api-token"]')?.getAttribute('content');
    if (metaToken) {
        setApiToken(metaToken);
    }
}
// Run synchronously at module load so the token is available before
// any hook (useSSEConnection, etc.) reads it during first render.
initApiToken();
// ── Settings Page ─────────────────────────────────────────────
function SettingsPage() {
    return (_jsx("div", { style: { padding: 'var(--sp-5)', maxWidth: 1200 }, children: _jsx(SettingsPageImpl, {}) }));
}
// ── Review Page (Diff Viewer) ────────────────────────────────────
function ReviewPage() {
    return (_jsx("div", { style: { padding: 'var(--sp-5)', maxWidth: 1400 }, children: _jsx(DiffViewer, {}) }));
}
// ── Dashboard View (existing content) ───────────────────────────
// ── Theme toggle button (used in topbar) ──────────────────────
function ThemeToggleButton() {
    const { theme, toggleTheme } = useTheme();
    const isLight = theme === 'light';
    return (_jsx("button", { type: "button", onClick: toggleTheme, style: styles.iconBtn, "aria-label": isLight ? 'Switch to dark theme' : 'Switch to light theme', title: isLight ? 'Switch to dark theme' : 'Switch to light theme', children: isLight ? (
        // Moon icon (click to go dark)
        _jsx("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", children: _jsx("path", { d: "M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" }) })) : (
        // Sun icon (click to go light)
        _jsxs("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("circle", { cx: "8", cy: "8", r: "3" }), _jsx("path", { d: "M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4" })] })) }));
}
function DashboardView({ activeTicket, activePipeline, isRunning, hasActiveTicket, showResumeDialog, showLiveView, startAgent, stopAgent, resetAgent, }) {
    // Topbar quick-start handler
    const handleTopbarSubmit = useCallback((e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const input = form.elements.namedItem('ticket');
        const value = input?.value?.trim().toUpperCase();
        if (value && /^[A-Z]+-\d+$/i.test(value)) {
            void startAgent(value);
            if (input)
                input.value = '';
        }
    }, [startAgent]);
    return (_jsxs(_Fragment, { children: [_jsxs("div", { style: styles.topbar, children: [_jsxs("form", { onSubmit: handleTopbarSubmit, style: styles.topbarSearch, children: [_jsxs("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", children: [_jsx("circle", { cx: "7", cy: "7", r: "4" }), _jsx("path", { d: "M10 10l3.5 3.5" })] }), _jsx("input", { name: "ticket", type: "text", placeholder: "Enter ticket ID...", spellCheck: false, style: styles.topbarInput, "aria-label": "Jira ticket ID" })] }), _jsx("div", { style: {
                            ...styles.topbarStatus,
                            ...(isRunning
                                ? { background: 'var(--success-muted)', color: 'var(--success)', animation: 'pulse 2s infinite' }
                                : { background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }),
                        }, role: "status", children: isRunning ? 'Running' : 'Idle' }), isRunning && activeTicket && (_jsx("button", { style: {
                            ...styles.topbarBtn,
                            background: 'var(--danger-muted)',
                            color: 'var(--danger)',
                            border: '1px solid rgba(239,68,68,0.2)',
                        }, onClick: () => stopAgent(activeTicket), "aria-label": "Stop the running agent", children: "Stop" })), hasActiveTicket && !isRunning && (_jsx("button", { style: {
                            ...styles.topbarBtn,
                            background: 'var(--bg-elevated)',
                            color: 'var(--text-secondary)',
                            border: '1px solid var(--border-default)',
                        }, onClick: () => resetAgent(activeTicket ?? undefined), "aria-label": "Reset agent state", children: "Reset" })), _jsx(ThemeToggleButton, {})] }), _jsx(TicketTabBar, {}), _jsx(GateNotificationBar, {}), _jsx("div", { style: styles.mainPanels, children: !hasActiveTicket ? (
                /* Empty state: show ticket form */
                _jsx(TicketForm, {})) : showResumeDialog && activePipeline ? (
                /* Paused/expired/done pipeline: show resume dialog */
                _jsx(ResumeDialog, { pipeline: activePipeline })) : showLiveView ? (
                /* Active ticket: show pipeline detail + status + gate + logs */
                _jsxs(_Fragment, { children: [activePipeline && _jsx(PipelineDetail, { pipeline: activePipeline }), _jsx(StuckBanner, {}), _jsx(AgentStatus, {}), _jsx(WriteCodeDetail, {}), _jsx(QAProgressPanel, {}), activeTicket && (_jsx(ContextInjectionPanel, { ticket: activeTicket, isRunning: isRunning })), _jsx(GateApproval, {}), _jsx(LogViewer, {}), activeTicket && _jsx(LogFileArchiveViewer, { ticket: activeTicket })] })) : (
                /* Fallback: show ticket form */
                _jsx(TicketForm, {})) })] }));
}
// ── Connector Error Toaster ────────────────────────────────────
// Bridges mi:connector-error custom events to the Toast system.
// Must be rendered inside <ToastProvider>.
function ConnectorErrorToaster() {
    const { addToast } = useToast();
    useEffect(() => {
        function onError(e) {
            const detail = e.detail;
            const label = detail.provider.charAt(0).toUpperCase() + detail.provider.slice(1);
            addToast(`${label}: ${detail.error}`, 'error');
        }
        window.addEventListener('mi:connector-error', onError);
        return () => window.removeEventListener('mi:connector-error', onError);
    }, [addToast]);
    return null;
}
// ── App Component ──────────────────────────────────────────────
export function App() {
    const activeTicket = usePipelineStore((s) => s.activeTicket);
    const ticketState = useActiveTicketState();
    const pipelines = usePipelineStore((s) => s.pipelines);
    const startAgent = usePipelineStore((s) => s.startAgent);
    const stopAgent = usePipelineStore((s) => s.stopAgent);
    const resetAgent = usePipelineStore((s) => s.resetAgent);
    const currentView = useNavigationStore((s) => s.currentView);
    const globalError = usePipelineStore((s) => s.globalError);
    const setGlobalError = usePipelineStore((s) => s.setGlobalError);
    const clearGlobalError = usePipelineStore((s) => s.clearGlobalError);
    // Connect to SSE (token already set synchronously at module load)
    useSSEConnection();
    // Network offline detection (shows banner at top)
    const isOffline = useOfflineStatus();
    // Global keyboard shortcuts (?, j, k, a, r, f, g+d/s/r)
    useGlobalKeyboardShortcuts();
    // Surface uncaught errors and unhandled promise rejections globally
    useEffect(() => {
        function onError(e) {
            setGlobalError(e.error ?? e.message ?? 'Unknown error');
        }
        function onRejection(e) {
            const reason = e.reason;
            setGlobalError(reason instanceof Error ? reason : String(reason));
        }
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
        return () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
        };
    }, [setGlobalError]);
    // Find the active pipeline summary from the dashboard list
    const activePipeline = activeTicket
        ? pipelines.find((p) => p.ticket === activeTicket)
        : undefined;
    // Determine what to show in the main panel
    const isRunning = ticketState?.isRunning ?? activePipeline?.running ?? false;
    const hasActiveTicket = activeTicket !== null;
    const showResumeDialog = !!(hasActiveTicket && activePipeline && !isRunning &&
        (activePipeline.status === 'paused' || activePipeline.status === 'expired' ||
            activePipeline.status === 'gate_waiting'));
    const showLiveView = hasActiveTicket && (isRunning || ticketState !== null) && !showResumeDialog;
    // Render the current view
    function renderView() {
        switch (currentView) {
            case 'settings':
                return _jsx(SettingsPage, {});
            case 'review':
                return _jsx(ReviewPage, {});
            case 'dashboard':
            default:
                return (_jsx(DashboardView, { activeTicket: activeTicket, activePipeline: activePipeline, isRunning: isRunning, hasActiveTicket: hasActiveTicket, showResumeDialog: showResumeDialog, showLiveView: showLiveView, startAgent: startAgent, stopAgent: stopAgent, resetAgent: resetAgent }));
        }
    }
    return (_jsxs(ToastProvider, { children: [isOffline && (_jsx("div", { style: styles.offlineBanner, role: "status", "aria-live": "polite", children: "You are offline \u2014 live updates are paused until the connection returns." })), _jsx(RateLimitBanner, {}), _jsx(AuthRequiredBanner, {}), _jsxs("div", { style: styles.appLayout, children: [_jsx(Sidebar, {}), _jsx("main", { style: styles.mainContent, children: renderView() })] }), globalError && (_jsx(ErrorOverlay, { error: globalError, showStack: import.meta.env.DEV, onDismiss: clearGlobalError })), _jsx(ShortcutsHelpModal, {}), _jsx(ConnectorErrorToaster, {})] }));
}
