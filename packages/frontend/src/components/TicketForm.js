import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Ticket Form Component
// Input for ticket ID with validation and draft persistence
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect, useCallback, useRef } from 'react';
import { usePipelineStore } from '../store/pipeline';
// ── Validation ─────────────────────────────────────────────────
/** Jira ticket ID pattern: PROJECT-123 */
const TICKET_REGEX = /^[A-Z]+-\d+$/i;
function isValidTicketId(value) {
    return TICKET_REGEX.test(value.trim());
}
// ── Draft persistence ──────────────────────────────────────────
const DRAFT_KEY_PREFIX = 'draft_ticket_';
const DRAFT_MAX_SIZE = 10240; // 10KB per draft
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
function saveDraft(slot, value) {
    if (value.length > DRAFT_MAX_SIZE)
        return;
    const entry = { value, savedAt: Date.now() };
    try {
        localStorage.setItem(`${DRAFT_KEY_PREFIX}${slot}`, JSON.stringify(entry));
    }
    catch {
        // localStorage full or unavailable
    }
}
function loadDraft(slot) {
    try {
        const raw = localStorage.getItem(`${DRAFT_KEY_PREFIX}${slot}`);
        if (!raw)
            return '';
        const entry = JSON.parse(raw);
        if (Date.now() - entry.savedAt > DRAFT_MAX_AGE_MS) {
            localStorage.removeItem(`${DRAFT_KEY_PREFIX}${slot}`);
            return '';
        }
        return entry.value;
    }
    catch {
        return '';
    }
}
function cleanupOldDrafts() {
    try {
        const now = Date.now();
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key?.startsWith(DRAFT_KEY_PREFIX))
                continue;
            const raw = localStorage.getItem(key);
            if (!raw)
                continue;
            try {
                const entry = JSON.parse(raw);
                if (now - entry.savedAt > DRAFT_MAX_AGE_MS) {
                    localStorage.removeItem(key);
                }
            }
            catch {
                localStorage.removeItem(key);
            }
        }
    }
    catch {
        // Ignore errors during cleanup
    }
}
// ── Component ──────────────────────────────────────────────────
const styles = {
    form: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--sp-4)',
        padding: '80px var(--sp-6) 60px',
        textAlign: 'center',
        animation: 'fadeIn 0.3s ease-out',
    },
    iconWrap: {
        width: 64,
        height: 64,
        background: 'linear-gradient(135deg, var(--accent-muted), var(--blue-muted))',
        borderRadius: 'var(--radius-lg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 'var(--sp-6)',
        fontSize: 28,
    },
    title: {
        fontSize: 20,
        fontWeight: 700,
        marginBottom: 'var(--sp-2)',
    },
    subtitle: {
        fontSize: 14,
        color: 'var(--text-secondary)',
        maxWidth: 400,
        lineHeight: 1.6,
    },
    inputRow: {
        display: 'flex',
        gap: 'var(--sp-2)',
        alignItems: 'center',
        width: '100%',
        maxWidth: 440,
        marginTop: 'var(--sp-4)',
    },
    input: {
        flex: 1,
        padding: 'var(--sp-3) var(--sp-4)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 14,
        outline: 'none',
        transition: 'border-color 0.2s, box-shadow 0.2s',
    },
    inputFocused: {
        borderColor: 'var(--accent)',
        boxShadow: '0 0 0 3px var(--accent-muted)',
    },
    inputError: {
        borderColor: 'var(--danger)',
        boxShadow: '0 0 0 3px var(--danger-muted)',
    },
    button: {
        padding: 'var(--sp-3) var(--sp-6)',
        borderRadius: 'var(--radius-md)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)',
        color: '#fff',
        boxShadow: '0 0 16px var(--accent-glow)',
        transition: 'all 0.2s',
        whiteSpace: 'nowrap',
        fontFamily: 'var(--font-sans)',
    },
    buttonDisabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
        boxShadow: 'none',
    },
    errorText: {
        fontSize: 12,
        color: 'var(--danger)',
        fontWeight: 500,
        marginTop: 'var(--sp-1)',
    },
    pipelineHint: {
        marginTop: 'var(--sp-6)',
        fontSize: 12,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.02em',
    },
    shortcutHint: {
        marginTop: 'var(--sp-4)',
        fontSize: 11,
        color: 'var(--text-ghost)',
    },
    draftBadge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 10,
        background: 'var(--warning-muted)',
        color: 'var(--warning)',
        fontWeight: 600,
    },
};
export function TicketForm() {
    const startAgent = usePipelineStore((s) => s.startAgent);
    const activeTicket = usePipelineStore((s) => s.activeTicket);
    const [value, setValue] = useState('');
    const [error, setError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [hasDraft, setHasDraft] = useState(false);
    const [focused, setFocused] = useState(false);
    const inputRef = useRef(null);
    // Cleanup old drafts and load existing draft on mount
    useEffect(() => {
        cleanupOldDrafts();
        const draft = loadDraft(0);
        if (draft) {
            setValue(draft);
            setHasDraft(true);
        }
    }, []);
    // Save draft on value change (debounced)
    useEffect(() => {
        if (!value.trim())
            return;
        const timer = setTimeout(() => saveDraft(0, value), 500);
        return () => clearTimeout(timer);
    }, [value]);
    // Keyboard shortcut: Cmd+K or Ctrl+K to focus input
    useEffect(() => {
        function handleKeyDown(e) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                inputRef.current?.focus();
                inputRef.current?.select();
            }
        }
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);
    const handleSubmit = useCallback(async (e) => {
        e.preventDefault();
        setError(null);
        const trimmed = value.trim().toUpperCase();
        if (!trimmed) {
            setError('Ticket ID is required');
            return;
        }
        if (!isValidTicketId(trimmed)) {
            setError('Invalid ticket ID format. Expected format: PROJECT-123');
            return;
        }
        setSubmitting(true);
        try {
            await startAgent(trimmed);
            // Clear draft on successful submit
            localStorage.removeItem(`${DRAFT_KEY_PREFIX}0`);
            setHasDraft(false);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to start agent');
        }
        finally {
            setSubmitting(false);
        }
    }, [value, startAgent]);
    const handleChange = useCallback((e) => {
        setValue(e.target.value);
        setError(null);
        setHasDraft(false);
    }, []);
    const inputStyle = {
        ...styles.input,
        ...(error ? styles.inputError : focused ? styles.inputFocused : {}),
    };
    const buttonStyle = {
        ...styles.button,
        ...(submitting || !value.trim() ? styles.buttonDisabled : {}),
    };
    return (_jsxs("form", { style: styles.form, onSubmit: handleSubmit, children: [_jsx("div", { style: styles.iconWrap, "aria-hidden": "true", children: _jsx("svg", { width: "28", height: "28", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round", children: _jsx("path", { d: "M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5z" }) }) }), _jsx("h2", { style: styles.title, children: "AI Dev Agent" }), _jsx("p", { style: styles.subtitle, children: "Enter a Jira ticket ID to start the automated pipeline." }), hasDraft && (_jsx("span", { style: styles.draftBadge, children: "Draft restored" })), _jsxs("div", { style: styles.inputRow, children: [_jsx("input", { ref: inputRef, type: "text", value: value, onChange: handleChange, onFocus: () => setFocused(true), onBlur: () => setFocused(false), placeholder: "e.g. AUT-8203", spellCheck: false, autoComplete: "off", "aria-label": "Jira ticket ID", "aria-invalid": error ? 'true' : undefined, "aria-describedby": error ? 'ticket-error' : undefined, style: inputStyle }), _jsx("button", { type: "submit", disabled: submitting || !value.trim(), style: buttonStyle, "aria-label": "Start the agent pipeline", children: submitting ? 'Starting...' : 'Start' })] }), error && (_jsx("div", { id: "ticket-error", style: styles.errorText, role: "alert", children: error })), _jsx("div", { style: styles.pipelineHint, children: "Jira \u2192 Claude \u2192 GitLab \u2192 QA \u2192 Pre-Prod \u2192 Production" }), _jsxs("div", { style: styles.shortcutHint, children: ["Press ", _jsx("kbd", { style: { display: 'inline-flex', padding: '1px 6px', borderRadius: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', fontFamily: 'var(--font-mono)', fontSize: 10 }, children: "Ctrl+K" }), " to focus search"] })] }));
}
