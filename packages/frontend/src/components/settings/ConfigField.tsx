// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Config Field Component
// Renders the appropriate input control for a config field based
// on its type: string, password, number, boolean, or enum
// ═══════════════════════════════════════════════════════════════

import { useState, useCallback } from 'react';
import type { FieldType } from '../../store/settings';

// ── Props ───────────────────────────────────────────────────

interface ConfigFieldProps {
  fieldKey: string;
  label: string;
  type: FieldType;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  required: boolean;
  description: string;
  enumValues?: string[];
  min?: number;
  max?: number;
  frozen?: boolean;
}

// ── Styles ──────────────────────────────────────────────────

const styles = {
  fieldRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-3) 0',
    borderBottom: '1px solid var(--border-subtle)',
  },
  labelCol: {
    width: 200,
    minWidth: 200,
    paddingTop: 'var(--sp-1)',
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-primary)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
  },
  required: {
    color: 'var(--danger)',
    fontSize: 14,
    fontWeight: 700,
    lineHeight: 1,
  },
  frozenBadge: {
    fontSize: 9,
    padding: '1px 5px',
    borderRadius: 'var(--radius-full)',
    background: 'var(--warning-muted)',
    color: 'var(--warning)',
    fontWeight: 600,
    marginLeft: 'var(--sp-1)',
    letterSpacing: '0.03em',
  },
  description: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    marginTop: 2,
    lineHeight: 1.4,
  },
  inputCol: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
  },
  input: {
    width: '100%',
    padding: 'var(--sp-2) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  },
  inputFocused: {
    borderColor: 'var(--accent)',
    boxShadow: '0 0 0 2px var(--accent-muted)',
  },
  passwordWrap: {
    position: 'relative' as const,
    flex: 1,
  },
  passwordToggle: {
    position: 'absolute' as const,
    right: 8,
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--text-tertiary)',
    padding: 4,
    borderRadius: 'var(--radius-sm)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'color 0.15s',
  },
  select: {
    width: '100%',
    padding: 'var(--sp-2) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    outline: 'none',
    cursor: 'pointer',
    transition: 'border-color 0.2s',
  },
  checkboxWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    cursor: 'pointer',
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    border: '2px solid var(--border-strong)',
    background: 'var(--bg-elevated)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'all 0.15s var(--ease-smooth)',
    flexShrink: 0,
  },
  checkboxChecked: {
    background: 'var(--accent)',
    borderColor: 'var(--accent)',
  },
  checkboxLabel: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    userSelect: 'none' as const,
  },
  tooltipIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
    fontSize: 10,
    fontWeight: 700,
    cursor: 'help',
    border: '1px solid var(--border-default)',
    flexShrink: 0,
    position: 'relative' as const,
  },
} as const;

// ── Eye Icons (for password toggle) ─────────────────────────

function EyeIcon({ open }: { open: boolean }): JSX.Element {
  if (open) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
        <circle cx="8" cy="8" r="2" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
      <circle cx="8" cy="8" r="2" />
      <path d="M2 14L14 2" />
    </svg>
  );
}

// ── Checkmark Icon ──────────────────────────────────────────

function CheckIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 6l2.5 2.5 4.5-5" />
    </svg>
  );
}

// ── Component ───────────────────────────────────────────────

export function ConfigField({
  fieldKey,
  label,
  type,
  value,
  onChange,
  required,
  description,
  enumValues,
  min,
  max,
  frozen,
}: ConfigFieldProps): JSX.Element {
  const [showPassword, setShowPassword] = useState(false);
  const [focused, setFocused] = useState(false);

  const handleChange = useCallback(
    (newVal: unknown) => {
      onChange(fieldKey, newVal);
    },
    [fieldKey, onChange],
  );

  const inputStyle = {
    ...styles.input,
    ...(focused ? styles.inputFocused : {}),
  };

  // ── Boolean field ──
  if (type === 'boolean') {
    const checked = Boolean(value);
    return (
      <div style={styles.fieldRow}>
        <div style={styles.labelCol}>
          <div style={styles.label}>
            {label}
            {required && <span style={styles.required}>*</span>}
            {frozen && <span style={styles.frozenBadge}>FROZEN</span>}
          </div>
          <div style={styles.description}>{description}</div>
        </div>
        <div style={styles.inputCol}>
          <div
            style={styles.checkboxWrap}
            onClick={() => handleChange(!checked)}
            role="checkbox"
            aria-checked={checked}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                handleChange(!checked);
              }
            }}
          >
            <div
              style={{
                ...styles.checkbox,
                ...(checked ? styles.checkboxChecked : {}),
              }}
            >
              {checked && <CheckIcon />}
            </div>
            <span style={styles.checkboxLabel}>
              {checked ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ── Enum field ──
  if (type === 'enum' && enumValues) {
    return (
      <div style={styles.fieldRow}>
        <div style={styles.labelCol}>
          <div style={styles.label}>
            {label}
            {required && <span style={styles.required}>*</span>}
            {frozen && <span style={styles.frozenBadge}>FROZEN</span>}
          </div>
          <div style={styles.description}>{description}</div>
        </div>
        <div style={styles.inputCol}>
          <select
            style={styles.select}
            value={String(value ?? '')}
            onChange={(e) => handleChange(e.target.value)}
            aria-label={label}
          >
            <option value="">-- Select --</option>
            {enumValues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  // ── Password field ──
  if (type === 'password') {
    return (
      <div style={styles.fieldRow}>
        <div style={styles.labelCol}>
          <div style={styles.label}>
            {label}
            {required && <span style={styles.required}>*</span>}
            {frozen && <span style={styles.frozenBadge}>FROZEN</span>}
          </div>
          <div style={styles.description}>{description}</div>
        </div>
        <div style={styles.inputCol}>
          <div style={styles.passwordWrap}>
            <input
              type={showPassword ? 'text' : 'password'}
              value={String(value ?? '')}
              onChange={(e) => handleChange(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={{ ...inputStyle, paddingRight: 36 }}
              placeholder={`Enter ${label.toLowerCase()}...`}
              aria-label={label}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              style={styles.passwordToggle}
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              <EyeIcon open={showPassword} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Number field ──
  if (type === 'number') {
    return (
      <div style={styles.fieldRow}>
        <div style={styles.labelCol}>
          <div style={styles.label}>
            {label}
            {required && <span style={styles.required}>*</span>}
            {frozen && <span style={styles.frozenBadge}>FROZEN</span>}
          </div>
          <div style={styles.description}>{description}</div>
        </div>
        <div style={styles.inputCol}>
          <input
            type="number"
            value={value != null ? String(value) : ''}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') {
                handleChange(undefined);
              } else {
                const num = Number(raw);
                if (!isNaN(num)) handleChange(num);
              }
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={inputStyle}
            placeholder={`Enter ${label.toLowerCase()}...`}
            aria-label={label}
            min={min}
            max={max}
          />
        </div>
      </div>
    );
  }

  // ── Default: string field ──
  return (
    <div style={styles.fieldRow}>
      <div style={styles.labelCol}>
        <div style={styles.label}>
          {label}
          {required && <span style={styles.required}>*</span>}
          {frozen && <span style={styles.frozenBadge}>FROZEN</span>}
        </div>
        <div style={styles.description}>{description}</div>
      </div>
      <div style={styles.inputCol}>
        <input
          type="text"
          value={String(value ?? '')}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={inputStyle}
          placeholder={`Enter ${label.toLowerCase()}...`}
          aria-label={label}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
