import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Write Code Detail Panel
// Three tabs (Developer, Test & Verify, Create MR) showing
// checkpoint data from state.data during and after generate_code.
// ═══════════════════════════════════════════════════════════════
import { useState, useMemo } from 'react';
import { useActiveTicketState } from '../store/pipeline';
// Stages during/after which this panel is visible
const SHOW_STAGES = [
    'generate_code',
    'gate_code_review',
    'deploy_qa',
    'test_qa',
    'gate_preprod_approval',
    'create_preprod_mr',
    'gate_dual_approval',
    'deploy_prod',
    'done',
];
const TABS = [
    { key: 'developer', label: 'Developer' },
    { key: 'test_verify', label: 'Test & Verify' },
    { key: 'create_mr', label: 'Create MR' },
];
// ── Styles ─────────────────────────────────────────────────────
const styles = {
    container: {
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--glass-border)',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
        padding: 'var(--sp-5)',
        marginBottom: 'var(--sp-6)',
        animation: 'fadeIn 0.3s ease-out',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        marginBottom: 'var(--sp-4)',
    },
    title: {
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--text-primary)',
    },
    tabBar: {
        display: 'flex',
        gap: 0,
        borderBottom: '2px solid var(--border-default)',
        marginBottom: 'var(--sp-4)',
    },
    tab: {
        padding: '8px 18px',
        borderRadius: '8px 8px 0 0',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        border: '1px solid transparent',
        borderBottom: 'none',
        background: 'transparent',
        color: 'var(--text-tertiary)',
        transition: 'all 0.15s',
        fontFamily: 'var(--font-sans)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
    },
    tabActive: {
        borderColor: 'var(--border-default)',
        borderBottom: '2px solid var(--bg-surface)',
        marginBottom: -2,
        background: 'var(--bg-surface)',
        color: 'var(--accent)',
    },
    dot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
    },
    content: {
        minHeight: 60,
    },
    row: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: '6px 10px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        fontSize: 12,
        marginBottom: 'var(--sp-2)',
    },
    rowDot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
    },
    rowLabel: {
        flex: 1,
        color: 'var(--text-primary)',
        fontWeight: 500,
    },
    rowBadge: {
        fontSize: 10,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 'var(--radius-full)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
    },
    summary: {
        fontSize: 12,
        color: 'var(--text-secondary)',
        lineHeight: 1.6,
        padding: 'var(--sp-3)',
        background: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border-subtle)',
        marginTop: 'var(--sp-2)',
        maxHeight: 200,
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        fontFamily: 'var(--font-mono)',
    },
    link: {
        color: 'var(--accent)',
        textDecoration: 'underline',
        cursor: 'pointer',
        fontSize: 12,
    },
    empty: {
        textAlign: 'center',
        color: 'var(--text-ghost)',
        fontSize: 12,
        padding: 'var(--sp-4)',
        fontStyle: 'italic',
    },
};
function statusDotColor(s) {
    switch (s) {
        case 'done': return 'var(--success)';
        case 'in_progress': return 'var(--warning)';
        case 'fail': return 'var(--danger)';
        default: return 'var(--text-ghost)';
    }
}
function statusBadge(s) {
    switch (s) {
        case 'done': return { bg: 'var(--success-muted)', fg: 'var(--success)', label: 'Done' };
        case 'in_progress': return { bg: 'var(--warning-muted)', fg: 'var(--warning)', label: 'Running' };
        case 'fail': return { bg: 'var(--danger-muted)', fg: 'var(--danger)', label: 'Failed' };
        default: return { bg: 'var(--bg-elevated)', fg: 'var(--text-tertiary)', label: 'Pending' };
    }
}
function StatusRow({ label, status, extra }) {
    const badge = statusBadge(status);
    return (_jsxs("div", { style: styles.row, children: [_jsx("span", { style: { ...styles.rowDot, background: statusDotColor(status) } }), _jsx("span", { style: styles.rowLabel, children: label }), extra && _jsx("span", { style: { fontSize: 11, color: 'var(--text-tertiary)', marginRight: 4 }, children: extra }), _jsx("span", { style: { ...styles.rowBadge, background: badge.bg, color: badge.fg }, children: badge.label })] }));
}
// ── Tab status derivation ─────────────────────────────────────
function deriveTabStatus(tab, data, isGenerating) {
    switch (tab) {
        case 'developer': {
            if (data._dev_failed)
                return 'fail';
            if (data._dev_complete)
                return 'done';
            if (isGenerating)
                return 'in_progress';
            return 'pending';
        }
        case 'test_verify': {
            if (!data._dev_complete)
                return 'pending';
            const allDone = data._reviewed && (data._build_tsc !== false) && data._ac_verified;
            if (allDone)
                return 'done';
            if (data._reviewed || data._build_tsc !== undefined || data._unit_tests_complete)
                return 'in_progress';
            if (isGenerating && data._dev_complete)
                return 'in_progress';
            return 'pending';
        }
        case 'create_mr': {
            if (data.code_mr_url)
                return 'done';
            if (data.code_committed || data.code_branch)
                return 'in_progress';
            return 'pending';
        }
    }
}
// ── Tab content renderers ─────────────────────────────────────
function DeveloperTab({ data }) {
    const devStatus = data._dev_failed ? 'fail' : data._dev_complete ? 'done' : 'pending';
    const complexity = data._complexity;
    return (_jsxs("div", { children: [_jsx(StatusRow, { label: "Code Generation", status: devStatus, extra: complexity ? `(${complexity})` : undefined }), data._dev_summary ? (_jsx("div", { style: styles.summary, children: String(data._dev_summary) })) : null] }));
}
function TestVerifyTab({ data }) {
    const reviewStatus = data._reviewed ? 'done' : 'pending';
    const securityStatus = data._fixed !== undefined ? (data._fixed ? 'done' : 'fail') : 'pending';
    const tscVal = data._build_tsc;
    const tscStatus = tscVal === true || tscVal === 'PASS' ? 'done' : tscVal === false || tscVal === 'FAIL' ? 'fail' : 'pending';
    const eslintVal = data._build_eslint;
    const eslintStatus = eslintVal === true || eslintVal === 'PASS' ? 'done' : eslintVal === false || eslintVal === 'FAIL' ? 'fail' : 'pending';
    const unitVal = data._unit_tests_complete;
    const unitStatus = unitVal && unitVal !== 'SKIP' ? 'done' : unitVal === 'SKIP' ? 'done' : 'pending';
    const unitCount = data._unit_tests_count;
    const acStatus = data._ac_verified ? 'done' : 'pending';
    const acGaps = data._ac_known_gaps;
    const browserStatus = data._browser_verified ? 'done' : 'pending';
    return (_jsxs("div", { children: [_jsx(StatusRow, { label: "Code Review", status: reviewStatus }), _jsx(StatusRow, { label: "Security Fix", status: securityStatus }), _jsx(StatusRow, { label: "Build (TSC)", status: tscStatus }), _jsx(StatusRow, { label: "ESLint", status: eslintStatus }), _jsx(StatusRow, { label: "Unit Tests", status: unitStatus, extra: unitVal === 'SKIP' ? 'skipped' : unitCount != null ? `${unitCount}` : undefined }), _jsx(StatusRow, { label: "AC Verification", status: acStatus }), acGaps && acGaps.length > 0 && (_jsxs("div", { style: { ...styles.summary, maxHeight: 100 }, children: ["Known gaps: ", acGaps.join(', ')] })), _jsx(StatusRow, { label: "Browser Verify", status: browserStatus })] }));
}
function CreateMRTab({ data }) {
    const branchStatus = data.code_branch ? 'done' : 'pending';
    const commitStatus = data.code_committed ? 'done' : 'pending';
    const conflictStatus = data._conflict_check_done ? 'done' : 'pending';
    const mrStatus = data.code_mr_url ? 'done' : 'pending';
    const slackStatus = data.code_slack_sent ? 'done' : 'pending';
    const branch = data.code_branch;
    const sha = data._last_commit_sha;
    const mrUrl = data.code_mr_url;
    const mrIid = data.code_mr_iid;
    return (_jsxs("div", { children: [_jsx(StatusRow, { label: "Branch", status: branchStatus, extra: branch || undefined }), _jsx(StatusRow, { label: "Committed", status: commitStatus, extra: sha ? sha.slice(0, 8) : undefined }), _jsx(StatusRow, { label: "Conflict Check", status: conflictStatus }), _jsx(StatusRow, { label: "Merge Request", status: mrStatus, extra: mrIid ? `!${mrIid}` : undefined }), mrUrl && (_jsx("div", { style: { padding: '4px 10px', marginBottom: 'var(--sp-2)' }, children: _jsx("a", { href: String(mrUrl), target: "_blank", rel: "noopener noreferrer", style: styles.link, children: "Open MR in GitLab" }) })), _jsx(StatusRow, { label: "Slack Notification", status: slackStatus })] }));
}
// ── Main Component ────────────────────────────────────────────
export function WriteCodeDetail() {
    const ticketState = useActiveTicketState();
    const [activeTab, setActiveTab] = useState('developer');
    const shouldShow = useMemo(() => {
        if (!ticketState)
            return false;
        // Show if we're on or past generate_code stage
        if (SHOW_STAGES.includes(ticketState.stage))
            return true;
        // Also show if state data has any generate_code checkpoint fields
        // (covers edge cases where stage is stale but data is populated)
        const d = ticketState.state?.data;
        if (d && (d._dev_complete || d.code_branch || d.code_mr_url))
            return true;
        return false;
    }, [ticketState]);
    const data = useMemo(() => {
        return ticketState?.state?.data ?? {};
    }, [ticketState]);
    if (!shouldShow)
        return null;
    const isGenerating = ticketState?.stage === 'generate_code' && ticketState.isRunning;
    return (_jsxs("div", { style: styles.container, children: [_jsxs("div", { style: styles.header, children: [_jsxs("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("polyline", { points: "4 7 8 3 12 7" }), _jsx("polyline", { points: "4 13 8 9 12 13" })] }), _jsx("span", { style: styles.title, children: "Write Code" })] }), _jsx("div", { style: styles.tabBar, children: TABS.map(({ key, label }) => {
                    const tabStatus = deriveTabStatus(key, data, !!isGenerating);
                    const isActive = activeTab === key;
                    return (_jsxs("button", { style: {
                            ...styles.tab,
                            ...(isActive ? styles.tabActive : {}),
                        }, onClick: () => setActiveTab(key), children: [_jsx("span", { style: { ...styles.dot, background: statusDotColor(tabStatus) } }), label] }, key));
                }) }), _jsxs("div", { style: styles.content, children: [activeTab === 'developer' && _jsx(DeveloperTab, { data: data }), activeTab === 'test_verify' && _jsx(TestVerifyTab, { data: data }), activeTab === 'create_mr' && _jsx(CreateMRTab, { data: data })] })] }));
}
