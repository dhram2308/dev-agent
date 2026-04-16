import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ===================================================================
// MI Dev Agent -- Diff Stats Bar
// Compact horizontal stats: N files changed, +N additions, -N deletions
// with proportional green/red bar
// ===================================================================
import { useMemo } from 'react';
import { parseDiffStatsFromChanges } from '../../utils/diff';
// -- Styles ---------------------------------------------------------
const styles = {
    container: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-tertiary)',
        whiteSpace: 'nowrap',
    },
    files: {
        color: 'var(--text-secondary)',
        fontWeight: 600,
    },
    additions: {
        color: 'var(--success)',
        fontWeight: 600,
    },
    deletions: {
        color: 'var(--danger)',
        fontWeight: 600,
    },
    barContainer: {
        display: 'flex',
        gap: 1,
        height: 8,
        width: 50,
        borderRadius: 2,
        overflow: 'hidden',
        background: 'var(--bg-elevated)',
    },
    barAdd: {
        background: 'var(--success)',
        borderRadius: '2px 0 0 2px',
        transition: 'width 0.3s',
        minWidth: 0,
    },
    barDel: {
        background: 'var(--danger)',
        borderRadius: '0 2px 2px 0',
        transition: 'width 0.3s',
        minWidth: 0,
    },
};
// -- Component ------------------------------------------------------
export function DiffStatsBar({ changes }) {
    const stats = useMemo(() => parseDiffStatsFromChanges(changes), [changes]);
    const total = stats.additions + stats.deletions;
    const addPct = total > 0 ? (stats.additions / total) * 100 : 50;
    const delPct = total > 0 ? (stats.deletions / total) * 100 : 50;
    return (_jsxs("div", { style: styles.container, children: [_jsx("span", { style: styles.files, children: stats.filesChanged }), _jsx("span", { children: "files" }), _jsxs("span", { style: styles.additions, children: ["+", stats.additions] }), _jsxs("span", { style: styles.deletions, children: ["-", stats.deletions] }), total > 0 && (_jsxs("div", { style: styles.barContainer, children: [_jsx("div", { style: {
                            ...styles.barAdd,
                            width: `${addPct}%`,
                        } }), _jsx("div", { style: {
                            ...styles.barDel,
                            width: `${delPct}%`,
                        } })] }))] }));
}
