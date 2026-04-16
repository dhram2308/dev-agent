import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ===================================================================
// MI Dev Agent -- File Tree Component
// File list with action indicators, line-change badges, search filter
// ===================================================================
import { useState, useMemo } from 'react';
import { useReviewStore } from '../../store/review';
import { actionColor, actionBgColor, actionLabel, parseDiffStatsFromChanges, } from '../../utils/diff';
// -- Styles ---------------------------------------------------------
const styles = {
    container: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
    },
    searchBox: {
        padding: 'var(--sp-2) var(--sp-3)',
        borderBottom: '1px solid var(--border-subtle)',
    },
    searchInput: {
        width: '100%',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        padding: '5px 8px',
        outline: 'none',
        transition: 'border-color 0.2s',
    },
    header: {
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--text-tertiary)',
        padding: 'var(--sp-3) var(--sp-3) var(--sp-1)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    fileCount: {
        fontSize: 9,
        background: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-full)',
        padding: '1px 6px',
        color: 'var(--text-tertiary)',
        fontWeight: 600,
    },
    list: {
        flex: 1,
        overflowY: 'auto',
        padding: 'var(--sp-1) var(--sp-2)',
    },
    dirHeader: {
        fontSize: 10,
        fontWeight: 600,
        color: 'var(--text-tertiary)',
        padding: '6px 8px 2px',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-1)',
    },
    item: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: '4px 8px',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        width: '100%',
        textAlign: 'left',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-secondary)',
        transition: 'all 0.1s',
        position: 'relative',
    },
    itemActive: {
        background: 'var(--accent-muted)',
        color: 'var(--text-primary)',
    },
    itemHover: {
        background: 'var(--bg-elevated)',
    },
    actionBadge: {
        width: 16,
        height: 16,
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 9,
        fontWeight: 700,
        flexShrink: 0,
    },
    fileName: {
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        direction: 'rtl',
        textAlign: 'left',
    },
    lineStats: {
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        display: 'flex',
        gap: 4,
        flexShrink: 0,
        whiteSpace: 'nowrap',
    },
    added: {
        color: 'var(--success)',
    },
    deleted: {
        color: 'var(--danger)',
    },
    noResults: {
        padding: 'var(--sp-4)',
        textAlign: 'center',
        color: 'var(--text-tertiary)',
        fontSize: 11,
    },
};
// -- Helpers --------------------------------------------------------
function countDiffLines(diff) {
    if (!diff)
        return { added: 0, deleted: 0 };
    let added = 0;
    let deleted = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++'))
            added++;
        else if (line.startsWith('-') && !line.startsWith('---'))
            deleted++;
    }
    return { added, deleted };
}
/** Group files by their directory path */
function groupByDirectory(changes) {
    const groups = new Map();
    for (const change of changes) {
        const lastSlash = change.file.lastIndexOf('/');
        const dir = lastSlash >= 0 ? change.file.slice(0, lastSlash) : '';
        const list = groups.get(dir) ?? [];
        list.push(change);
        groups.set(dir, list);
    }
    return groups;
}
// -- Component ------------------------------------------------------
export function FileTree({ changes, selectedFile, onSelect, }) {
    const fileFilter = useReviewStore((s) => s.fileFilter);
    const setFileFilter = useReviewStore((s) => s.setFileFilter);
    const [hoveredFile, setHoveredFile] = useState(null);
    // Filter files
    const filteredChanges = useMemo(() => {
        if (!fileFilter.trim())
            return changes;
        const lower = fileFilter.toLowerCase();
        return changes.filter((c) => c.file.toLowerCase().includes(lower));
    }, [changes, fileFilter]);
    // Group by directory
    const grouped = useMemo(() => groupByDirectory(filteredChanges), [filteredChanges]);
    // Overall stats
    const stats = useMemo(() => parseDiffStatsFromChanges(changes), [changes]);
    return (_jsxs("div", { style: styles.container, children: [_jsx("div", { style: styles.searchBox, children: _jsx("input", { type: "text", value: fileFilter, onChange: (e) => setFileFilter(e.target.value), placeholder: "Filter files...", spellCheck: false, style: styles.searchInput, "aria-label": "Filter files" }) }), _jsxs("div", { style: styles.header, children: [_jsx("span", { children: "Files Changed" }), _jsxs("span", { style: styles.fileCount, children: [filteredChanges.length, fileFilter && filteredChanges.length !== changes.length
                                ? ` / ${changes.length}`
                                : ''] })] }), _jsx("div", { style: styles.list, children: filteredChanges.length === 0 ? (_jsx("div", { style: styles.noResults, children: fileFilter ? 'No files match filter' : 'No files' })) : (Array.from(grouped.entries()).map(([dir, files]) => (_jsxs("div", { children: [grouped.size > 1 && dir && (_jsxs("div", { style: styles.dirHeader, children: [_jsx("svg", { width: "12", height: "12", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", children: _jsx("path", { d: "M2 4h4l2 2h6v7H2z", strokeLinejoin: "round" }) }), dir] })), files.map((change) => {
                            const isActive = change.file === selectedFile;
                            const isHovered = change.file === hoveredFile && !isActive;
                            const diffLines = countDiffLines(change.diff);
                            const fileName = change.file.split('/').pop() ?? change.file;
                            return (_jsxs("button", { style: {
                                    ...styles.item,
                                    ...(isActive ? styles.itemActive : {}),
                                    ...(isHovered ? styles.itemHover : {}),
                                }, onClick: () => onSelect(change.file), onMouseEnter: () => setHoveredFile(change.file), onMouseLeave: () => setHoveredFile(null), title: change.file, children: [_jsx("span", { style: {
                                            ...styles.actionBadge,
                                            background: actionBgColor(change.action),
                                            color: actionColor(change.action),
                                        }, children: actionLabel(change.action) }), _jsx("span", { style: styles.fileName, children: _jsx("bdi", { children: fileName }) }), (diffLines.added > 0 || diffLines.deleted > 0) && (_jsxs("span", { style: styles.lineStats, children: [diffLines.added > 0 && (_jsxs("span", { style: styles.added, children: ["+", diffLines.added] })), diffLines.deleted > 0 && (_jsxs("span", { style: styles.deleted, children: ["-", diffLines.deleted] }))] }))] }, change.file));
                        })] }, dir)))) })] }));
}
