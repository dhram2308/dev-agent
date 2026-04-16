import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Refine Form Component
// Textarea + submit for plan refinement instructions
// ═══════════════════════════════════════════════════════════════
import { useState } from 'react';
const styles = {
    container: {
        marginTop: 'var(--sp-3)',
        animation: 'slideDown 0.2s ease-out',
    },
    label: {
        display: 'block',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text-secondary)',
        marginBottom: 'var(--sp-2)',
    },
    hint: {
        fontSize: 11,
        color: 'var(--text-tertiary)',
        marginBottom: 'var(--sp-2)',
        lineHeight: 1.5,
    },
    textarea: {
        width: '100%',
        height: 100,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--sp-3)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        resize: 'vertical',
        outline: 'none',
        transition: 'border-color 0.2s',
        boxSizing: 'border-box',
    },
    actions: {
        display: 'flex',
        gap: 'var(--sp-2)',
        marginTop: 'var(--sp-2)',
        alignItems: 'center',
    },
    btnSubmit: {
        padding: 'var(--sp-2) var(--sp-5)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        background: 'var(--accent)',
        color: '#fff',
        transition: 'all 0.2s',
        fontFamily: 'var(--font-sans)',
    },
    btnCancel: {
        padding: 'var(--sp-2) var(--sp-5)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        background: 'transparent',
        color: 'var(--text-secondary)',
        border: '1px solid var(--border-default)',
        transition: 'all 0.2s',
        fontFamily: 'var(--font-sans)',
    },
    disabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
    },
    spinner: {
        display: 'inline-block',
        width: 12,
        height: 12,
        border: '2px solid rgba(255,255,255,0.3)',
        borderTopColor: '#fff',
        borderRadius: '50%',
        animation: 'spin 0.6s linear infinite',
        marginRight: 6,
        verticalAlign: 'middle',
    },
};
export function RefineForm({ onSubmit, onCancel, submitting }) {
    const [instructions, setInstructions] = useState('');
    const canSubmit = instructions.trim().length > 0 && !submitting;
    const handleSubmit = async () => {
        if (!canSubmit)
            return;
        await onSubmit(instructions.trim());
        setInstructions('');
    };
    return (_jsxs("div", { style: styles.container, children: [_jsx("label", { style: styles.label, children: "Refinement Instructions" }), _jsx("div", { style: styles.hint, children: "Tell the agent how to improve the plan. E.g., \"dive deeper into API integration\", \"add error handling specs\", \"explore existing patterns in the reconcile module\"." }), _jsx("textarea", { value: instructions, onChange: (e) => setInstructions(e.target.value), placeholder: "e.g., dive deeper into API integration, add error handling specs...", style: styles.textarea, "aria-label": "Refinement instructions", disabled: submitting }), _jsxs("div", { style: styles.actions, children: [_jsxs("button", { onClick: handleSubmit, disabled: !canSubmit, style: {
                            ...styles.btnSubmit,
                            ...(!canSubmit ? styles.disabled : {}),
                        }, "aria-label": "Submit refinement", children: [submitting && _jsx("span", { style: styles.spinner }), "Submit Refinement"] }), _jsx("button", { onClick: onCancel, style: styles.btnCancel, disabled: submitting, "aria-label": "Cancel refinement", children: "Cancel" })] })] }));
}
