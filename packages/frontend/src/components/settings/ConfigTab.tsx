// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Config Tab Component
// Groups config fields by service with collapsible sections,
// dirty state tracking, test connection buttons, and save/reset
// ═══════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSettingsStore } from '../../store/settings';
import type { ConfigGroup } from '../../store/settings';
import { ConfigField } from './ConfigField';
import { TestConnectionButton } from './TestConnectionButton';

// ── Styles ──────────────────────────────────────────────────

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-4)',
  },
  group: {
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-surface)',
    overflow: 'hidden',
    transition: 'border-color 0.2s',
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-3) var(--sp-4)',
    cursor: 'pointer',
    userSelect: 'none' as const,
    transition: 'background 0.15s',
    background: 'transparent',
    border: 'none',
    width: '100%',
    textAlign: 'left' as const,
    fontFamily: 'var(--font-sans)',
    color: 'var(--text-primary)',
  },
  chevron: {
    transition: 'transform 0.2s var(--ease-smooth)',
    color: 'var(--text-tertiary)',
    flexShrink: 0,
  },
  chevronOpen: {
    transform: 'rotate(90deg)',
  },
  groupIcon: {
    width: 28,
    height: 28,
    borderRadius: 'var(--radius-sm)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
    fontSize: 13,
    flexShrink: 0,
  },
  groupLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  groupDescription: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    marginLeft: 'auto',
    whiteSpace: 'nowrap' as const,
  },
  groupFieldCount: {
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 'var(--radius-full)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
    fontWeight: 600,
    flexShrink: 0,
  },
  groupBody: {
    padding: '0 var(--sp-4) var(--sp-3)',
    overflow: 'hidden',
    transition: 'max-height 0.3s var(--ease-smooth), padding 0.3s',
  },
  groupBodyCollapsed: {
    maxHeight: 0,
    padding: '0 var(--sp-4)',
    overflow: 'hidden',
  },
  testRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: 'var(--sp-2) 0',
    borderTop: '1px solid var(--border-subtle)',
    marginTop: 'var(--sp-2)',
  },
  actionBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    position: 'sticky' as const,
    bottom: 0,
    zIndex: 10,
  },
  dirtyBadge: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 'var(--radius-full)',
    background: 'var(--warning-muted)',
    color: 'var(--warning)',
    fontWeight: 600,
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
    transition: 'all 0.15s var(--ease-smooth)',
    fontFamily: 'var(--font-sans)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
  },
  saveBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  resetBtn: {
    padding: 'var(--sp-2) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    transition: 'all 0.15s var(--ease-smooth)',
    fontFamily: 'var(--font-sans)',
  },
  error: {
    padding: 'var(--sp-3) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--danger-muted)',
    border: '1px solid rgba(239,68,68,0.2)',
    color: 'var(--danger)',
    fontSize: 13,
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
} as const;

// ── Services that support test connection ────────────────────

const TESTABLE_SERVICES = new Set(['jira', 'gitlab', 'slack']);

// ── Group Icon SVGs ──────────────────────────────────────────

function GroupIcon({ id }: { id: string }): JSX.Element {
  // Simple SVG icons matching the Cursor dark theme
  const iconMap: Record<string, JSX.Element> = {
    jira: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 8l-6-6-6 6 6 6 6-6zM8 2.8L13.2 8 8 13.2 2.8 8 8 2.8z" /></svg>
    ),
    gitlab: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 14L1.5 9.5 3.5 2l2 5h5l2-5 2 7.5z" /></svg>
    ),
    slack: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="2" y="6" width="4" height="4" rx="1" /><rect x="10" y="6" width="4" height="4" rx="1" /><rect x="6" y="2" width="4" height="4" rx="1" /><rect x="6" y="10" width="4" height="4" rx="1" /></svg>
    ),
    default: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 1" /></svg>
    ),
  };
  return iconMap[id] ?? iconMap.default;
}

// ── Config Group Section ────────────────────────────────────

function ConfigGroupSection({ group }: { group: ConfigGroup }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const config = useSettingsStore((s) => s.config);
  const updateField = useSettingsStore((s) => s.updateField);
  const focusGroup = useSettingsStore((s) => s.focusGroup);
  const setFocusGroup = useSettingsStore((s) => s.setFocusGroup);
  const sectionRef = useRef<HTMLDivElement | null>(null);

  // If this group is the target of a Configure click, expand it and scroll
  // it into view, then clear the focus signal so subsequent renders are idle.
  useEffect(() => {
    if (focusGroup !== group.id) return;
    setCollapsed(false);
    // Defer scroll until after the group body has rendered expanded.
    const id = window.requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setFocusGroup(null);
    });
    return () => window.cancelAnimationFrame(id);
  }, [focusGroup, group.id, setFocusGroup]);

  return (
    <div style={styles.group} ref={sectionRef}>
      <button
        style={styles.groupHeader}
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        aria-controls={`group-${group.id}`}
      >
        <span
          style={{
            ...styles.chevron,
            ...(collapsed ? {} : styles.chevronOpen),
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M4.5 2l4 4-4 4" />
          </svg>
        </span>
        <span style={styles.groupIcon}>
          <GroupIcon id={group.id} />
        </span>
        <span style={styles.groupLabel}>{group.label}</span>
        <span style={styles.groupDescription}>{group.description}</span>
        <span style={styles.groupFieldCount}>{group.fields.length}</span>
      </button>

      <div
        id={`group-${group.id}`}
        style={collapsed ? styles.groupBodyCollapsed : styles.groupBody}
        role="region"
        aria-hidden={collapsed}
      >
        {!collapsed && (
          <>
            {group.fields.map((field) => (
              <ConfigField
                key={field.key}
                fieldKey={field.key}
                label={field.label}
                type={field.type}
                value={config[field.key]}
                onChange={updateField}
                required={field.required}
                description={field.description}
                enumValues={field.enumValues}
                min={field.min}
                max={field.max}
                frozen={field.frozen}
              />
            ))}

            {TESTABLE_SERVICES.has(group.id) && (
              <div style={styles.testRow}>
                <TestConnectionButton service={group.id} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────

export function ConfigTab(): JSX.Element {
  const configGroups = useSettingsStore((s) => s.configGroups);
  const loading = useSettingsStore((s) => s.loading);
  const saving = useSettingsStore((s) => s.saving);
  const isDirty = useSettingsStore((s) => s.isDirty);
  const error = useSettingsStore((s) => s.error);
  const fetchConfig = useSettingsStore((s) => s.fetchConfig);
  const saveConfig = useSettingsStore((s) => s.saveConfig);
  const resetConfig = useSettingsStore((s) => s.resetConfig);

  // Fetch config on mount
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleSave = useCallback(() => {
    if (!isDirty || saving) return;
    saveConfig();
  }, [isDirty, saving, saveConfig]);

  if (loading) {
    return (
      <div style={styles.loadingWrap}>
        <span style={styles.spinner} />
        Loading configuration...
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {error && (
        <div style={styles.error} role="alert">
          {error}
        </div>
      )}

      {configGroups.map((group) => (
        <ConfigGroupSection key={group.id} group={group} />
      ))}

      {/* Sticky action bar */}
      <div style={styles.actionBar}>
        {isDirty && (
          <span style={styles.dirtyBadge}>Unsaved changes</span>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          style={styles.resetBtn}
          onClick={resetConfig}
          disabled={!isDirty}
          aria-label="Reset to saved values"
        >
          Reset
        </button>
        <button
          type="button"
          style={{
            ...styles.saveBtn,
            ...(!isDirty || saving ? styles.saveBtnDisabled : {}),
          }}
          onClick={handleSave}
          disabled={!isDirty || saving}
          aria-label="Save configuration"
        >
          {saving ? (
            <>
              <span style={{ ...styles.spinner, width: 14, height: 14, borderColor: '#fff', borderTopColor: 'transparent' }} />
              Saving...
            </>
          ) : (
            'Save Configuration'
          )}
        </button>
      </div>
    </div>
  );
}
