import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ===================================================================
// MI Dev Agent -- Diff Viewer (Main Shell)
// GitHub/GitLab-style code review with split/unified toggle,
// file tree sidebar, diff content, inline comments, plan tabs
// ===================================================================
import { useEffect, useState, useCallback } from 'react';
import { usePipelineStore } from '../../store/pipeline';
import { useReviewStore } from '../../store/review';
import * as api from '../../lib/api';
import { FileTree } from './FileTree';
import { DiffPane } from './DiffPane';
import { DiffStatsBar } from './DiffStatsBar';
import { PlanTabs } from './PlanTabs';
// -- Styles ---------------------------------------------------------
const styles = {
    container: {
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        height: '100%',
        minHeight: 0,
    },
    toolbar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--sp-3) var(--sp-4)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
        gap: 'var(--sp-3)',
        flexWrap: 'wrap',
    },
    toolbarLeft: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        flex: 1,
        minWidth: 0,
    },
    toolbarRight: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
    },
    title: {
        fontSize: 15,
        fontWeight: 700,
        color: 'var(--text-primary)',
        letterSpacing: '-0.01em',
    },
    gateBadge: {
        fontSize: 10,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 'var(--radius-full)',
        background: 'var(--accent-muted)',
        color: 'var(--accent)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
    },
    modeToggle: {
        display: 'flex',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border-default)',
        overflow: 'hidden',
    },
    modeBtn: {
        padding: '4px 12px',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-sans)',
        transition: 'all 0.15s',
    },
    modeBtnActive: {
        background: 'var(--accent-muted)',
        color: 'var(--accent)',
    },
    tabBar: {
        display: 'flex',
        gap: 0,
        background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border-subtle)',
        borderRight: '1px solid var(--border-subtle)',
    },
    tab: {
        padding: 'var(--sp-2) var(--sp-4)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        borderBottom: '2px solid transparent',
        background: 'transparent',
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-sans)',
        transition: 'all 0.15s',
    },
    tabActive: {
        color: 'var(--accent)',
        borderBottomColor: 'var(--accent)',
        background: 'var(--bg-elevated)',
    },
    body: {
        display: 'flex',
        flex: 1,
        minHeight: 0,
        border: '1px solid var(--border-subtle)',
        borderTop: 'none',
        borderRadius: '0 0 var(--radius-md) var(--radius-md)',
        overflow: 'hidden',
    },
    fileSidebar: {
        width: 260,
        minWidth: 200,
        maxWidth: 360,
        borderRight: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        overflowY: 'auto',
        flexShrink: 0,
    },
    diffArea: {
        flex: 1,
        overflowY: 'auto',
        overflowX: 'auto',
        background: 'var(--bg-base)',
        minWidth: 0,
    },
    loading: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--sp-8)',
        color: 'var(--text-tertiary)',
        fontSize: 13,
        fontFamily: 'var(--font-mono)',
    },
    empty: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--sp-8)',
        color: 'var(--text-tertiary)',
        fontSize: 13,
        gap: 'var(--sp-2)',
        textAlign: 'center',
    },
    mrLink: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-1)',
        padding: '4px 12px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--blue-muted)',
        color: 'var(--blue)',
        textDecoration: 'none',
        fontSize: 12,
        fontWeight: 600,
        transition: 'background 0.15s',
    },
};
// -- Component ------------------------------------------------------
export function DiffViewer() {
    const activeTicket = usePipelineStore((s) => s.activeTicket);
    const reviewData = usePipelineStore((s) => s.reviewData);
    const viewMode = useReviewStore((s) => s.viewMode);
    const setViewMode = useReviewStore((s) => s.setViewMode);
    const selectedFile = useReviewStore((s) => s.selectedFile);
    const setSelectedFile = useReviewStore((s) => s.setSelectedFile);
    const [activeTab, setActiveTab] = useState('changes');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    // Fetch review data on mount or when active ticket changes
    const fetchData = useCallback(async () => {
        if (!activeTicket)
            return;
        setLoading(true);
        setError(null);
        try {
            const data = await api.getReviewData(activeTicket);
            usePipelineStore.getState().updateReviewData(data);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setLoading(false);
        }
    }, [activeTicket]);
    useEffect(() => {
        fetchData();
    }, [fetchData]);
    // Auto-select first file when review data arrives
    useEffect(() => {
        if (reviewData?.changes && reviewData.changes.length > 0 && !selectedFile) {
            setSelectedFile(reviewData.changes[0].file);
        }
    }, [reviewData, selectedFile, setSelectedFile]);
    // Find the selected change
    const selectedChange = reviewData?.changes?.find((c) => c.file === selectedFile);
    const hasPlan = reviewData?.plan && Object.keys(reviewData.plan).length > 0;
    const hasChanges = reviewData?.changes && reviewData.changes.length > 0;
    // Loading state
    if (loading) {
        return (_jsx("div", { style: styles.container, children: _jsx("div", { style: styles.loading, children: "Loading review data..." }) }));
    }
    // Error state
    if (error) {
        return (_jsx("div", { style: styles.container, children: _jsxs("div", { style: styles.empty, children: [_jsx("div", { style: { color: 'var(--danger)', fontWeight: 600 }, children: "Failed to load review data" }), _jsx("div", { children: error }), _jsx("button", { onClick: fetchData, style: {
                            marginTop: 'var(--sp-2)',
                            padding: 'var(--sp-2) var(--sp-4)',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-default)',
                            background: 'var(--bg-elevated)',
                            color: 'var(--text-secondary)',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                            fontFamily: 'var(--font-sans)',
                        }, children: "Retry" })] }) }));
    }
    // No review data
    if (!reviewData) {
        return (_jsx("div", { style: styles.container, children: _jsxs("div", { style: styles.empty, children: [_jsx("div", { style: { fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)' }, children: "No Review Data" }), _jsx("div", { children: activeTicket
                            ? 'No review data available for this ticket yet. Wait for the pipeline to reach a gate stage.'
                            : 'Select a ticket to view review data.' })] }) }));
    }
    return (_jsxs("div", { style: styles.container, children: [_jsxs("div", { style: styles.toolbar, children: [_jsxs("div", { style: styles.toolbarLeft, children: [_jsx("span", { style: styles.title, children: "Code Review" }), reviewData.gate && (_jsx("span", { style: styles.gateBadge, children: reviewData.gate.replace(/_/g, ' ') })), reviewData.mrUrl && (_jsxs("a", { href: reviewData.mrUrl, target: "_blank", rel: "noopener noreferrer", style: styles.mrLink, children: [_jsx("svg", { width: "12", height: "12", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", children: _jsx("path", { d: "M6 3H3v10h10v-3M10 2h4v4M7 9l7-7", strokeLinecap: "round", strokeLinejoin: "round" }) }), "MR ", reviewData.mrIid ? `!${reviewData.mrIid}` : ''] }))] }), _jsxs("div", { style: styles.toolbarRight, children: [hasChanges && (_jsx(DiffStatsBar, { changes: reviewData.changes })), _jsxs("div", { style: styles.modeToggle, children: [_jsx("button", { style: {
                                            ...styles.modeBtn,
                                            ...(viewMode === 'unified' ? styles.modeBtnActive : {}),
                                        }, onClick: () => setViewMode('unified'), children: "Unified" }), _jsx("button", { style: {
                                            ...styles.modeBtn,
                                            ...(viewMode === 'split' ? styles.modeBtnActive : {}),
                                            borderLeft: '1px solid var(--border-default)',
                                        }, onClick: () => setViewMode('split'), children: "Split" })] })] })] }), hasPlan && (_jsxs("div", { style: styles.tabBar, children: [_jsxs("button", { style: {
                            ...styles.tab,
                            ...(activeTab === 'changes' ? styles.tabActive : {}),
                        }, onClick: () => setActiveTab('changes'), children: ["Changes ", hasChanges ? `(${reviewData.changes.length})` : ''] }), _jsx("button", { style: {
                            ...styles.tab,
                            ...(activeTab === 'plan' ? styles.tabActive : {}),
                        }, onClick: () => setActiveTab('plan'), children: "Plan" })] })), activeTab === 'plan' && reviewData.plan ? (_jsx("div", { style: {
                    ...styles.body,
                    ...(hasPlan ? { borderRadius: '0 0 var(--radius-md) var(--radius-md)' } : {}),
                }, children: _jsx("div", { style: { flex: 1, overflowY: 'auto', padding: 'var(--sp-4)' }, children: _jsx(PlanTabs, { plan: reviewData.plan }) }) })) : (_jsxs("div", { style: {
                    ...styles.body,
                    ...(hasPlan ? { borderRadius: '0 0 var(--radius-md) var(--radius-md)' } : {}),
                }, children: [hasChanges && (_jsx("div", { style: styles.fileSidebar, children: _jsx(FileTree, { changes: reviewData.changes, selectedFile: selectedFile, onSelect: setSelectedFile }) })), _jsx("div", { style: styles.diffArea, children: selectedChange ? (_jsx(DiffPane, { change: selectedChange, viewMode: viewMode })) : (_jsx("div", { style: styles.empty, children: hasChanges
                                ? 'Select a file to view changes'
                                : 'No file changes in this review' })) })] }))] }));
}
