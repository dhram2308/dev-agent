// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Automation Tab
// Per-gate auto-approve policy and Playground resource limits.
// Reuses the same global config store (config/isDirty/saveConfig)
// as ConfigTab — these fields are additional CONFIG_SCHEMA keys
// (group: "automation" / "playground"), just rendered here instead
// of the generic ConfigTab group list, since a dedicated policy
// picker per gate reads better than raw ConfigField rows.
// ═══════════════════════════════════════════════════════════════

import { useEffect, useCallback } from 'react';
import { useSettingsStore } from '../../store/settings';
import { ConfigField } from './ConfigField';
import { useToast } from '../../contexts/ToastContext';

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-4)',
  },
  section: {
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-surface)',
    padding: 'var(--sp-4)',
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 'var(--sp-1)',
  },
  sectionDescription: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    marginBottom: 'var(--sp-3)',
    lineHeight: 1.5,
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
    fontFamily: 'var(--font-sans)',
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
    fontFamily: 'var(--font-sans)',
  },
} as const;

const AUTO_APPROVE_VALUES = ['manual', 'playground_validated', 'always'] as const;

interface GateFieldDef {
  key: string;
  label: string;
  description: string;
  /** Surfaces config-schema.ts's riskLevel: "DANGEROUS" for the two production gates. */
  dangerous?: boolean;
}

const GATE_FIELDS: GateFieldDef[] = [
  { key: 'AUTO_APPROVE_EXPLORE_PLAN', label: 'Explore & Plan', description: 'Policy for the plan-review gate.' },
  { key: 'AUTO_APPROVE_GATE_CODE_REVIEW', label: 'Code Review', description: 'Policy for the code-review gate.' },
  { key: 'AUTO_APPROVE_GATE_PREPROD_APPROVAL', label: 'Pre-Prod Gate', description: 'Policy for the pre-production approval gate.', dangerous: true },
  { key: 'AUTO_APPROVE_GATE_DUAL_APPROVAL', label: 'Dual Approval (Production)', description: 'Policy for the production dual-approval gate.', dangerous: true },
];

/**
 * Development Mode is a UI-only preset over two of the four gate-policy
 * keys above — it deliberately never touches the two production gates
 * (dangerous: true), which stay independently settable regardless of this
 * toggle. There is no backend concept of "Development Mode"; this exists
 * purely to save a couple of clicks for the common case.
 */
const DEV_MODE_KEYS = ['AUTO_APPROVE_EXPLORE_PLAN', 'AUTO_APPROVE_GATE_CODE_REVIEW'] as const;

function computeDevModePreset(config: Record<string, unknown>): 'auto' | 'plan' | 'custom' {
  const values = DEV_MODE_KEYS.map((k) => config[k]);
  if (values.every((v) => v === 'always')) return 'auto';
  if (values.every((v) => v === 'manual')) return 'plan';
  return 'custom';
}

export function AutomationTab(): JSX.Element {
  const config = useSettingsStore((s) => s.config);
  const loading = useSettingsStore((s) => s.loading);
  const saving = useSettingsStore((s) => s.saving);
  const isDirty = useSettingsStore((s) => s.isDirty);
  const error = useSettingsStore((s) => s.error);
  const fetchConfig = useSettingsStore((s) => s.fetchConfig);
  const updateField = useSettingsStore((s) => s.updateField);
  const saveConfig = useSettingsStore((s) => s.saveConfig);
  const resetConfig = useSettingsStore((s) => s.resetConfig);
  const { addToast } = useToast();

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const devModePreset = computeDevModePreset(config);

  // Not a real config key -- writes the two underlying AUTO_APPROVE_* keys
  // directly. Reuses ConfigField's enum renderer purely for the native
  // <select> look; the (key, value) it calls back with is ignored in favor
  // of the fixed DEV_MODE_KEYS writes below.
  const handleDevModePresetChange = useCallback(
    (_key: string, value: unknown) => {
      const policy = value === 'auto' ? 'always' : 'manual';
      for (const k of DEV_MODE_KEYS) updateField(k, policy);
    },
    [updateField],
  );

  const handleSave = useCallback(async () => {
    if (!isDirty || saving) return;
    const ok = await saveConfig();
    if (ok) {
      addToast('Automation settings saved', 'success');
    } else {
      const msg = useSettingsStore.getState().error ?? 'Failed to save settings';
      addToast(msg, 'error');
    }
  }, [isDirty, saving, saveConfig, addToast]);

  if (loading) {
    return <div style={{ padding: 'var(--sp-6)', color: 'var(--text-tertiary)', fontSize: 13 }}>Loading…</div>;
  }

  return (
    <div style={styles.container}>
      {error && (
        <div style={{ padding: 'var(--sp-3)', borderRadius: 'var(--radius-sm)', background: 'var(--danger-muted)', color: 'var(--danger)', fontSize: 13 }} role="alert">
          {error}
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Gate auto-approve policy</div>
        <div style={styles.sectionDescription}>
          Gates stay in the pipeline exactly as today — this only controls whether they resolve on their own.
          <strong> Manual</strong> always waits for you. <strong>Playground-validated</strong> auto-approves only if
          this ticket's stage has a completed Playground run. <strong>Always</strong> auto-approves unconditionally —
          use with care.
        </div>
        <ConfigField
          fieldKey="_devModePreset"
          label="Development Mode"
          type="enum"
          value={devModePreset === 'custom' ? '' : devModePreset}
          onChange={handleDevModePresetChange}
          required={false}
          description="Preset for Explore & Plan and Code Review below — never touches the two production gates."
          enumValues={['auto', 'plan']}
        />
        {GATE_FIELDS.map((field) => (
          <ConfigField
            key={field.key}
            fieldKey={field.key}
            label={field.label}
            type="enum"
            value={config[field.key]}
            onChange={updateField}
            required={false}
            description={field.description}
            enumValues={[...AUTO_APPROVE_VALUES]}
            dangerous={field.dangerous}
          />
        ))}
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Development methodology</div>
        <div style={styles.sectionDescription}>
          How the agent plans a ticket before writing code. Applies to the next ticket started —
          a ticket already past its Explore &amp; Plan stage keeps whatever mode it started with.
        </div>
        <ConfigField
          fieldKey="DEVELOPMENT_ADVANCE_MODE"
          label="Development Advance Mode"
          type="enum"
          value={config.DEVELOPMENT_ADVANCE_MODE}
          onChange={updateField}
          required={false}
          description="Direct — a plain implementation plan. OpenSpec — formal proposal/design/specs/tasks artifacts (default)."
          enumValues={['direct', 'openspec']}
        />
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Playground limits</div>
        <div style={styles.sectionDescription}>
          Resource guardrails for sandboxed runs — see the Playground page in the sidebar.
        </div>
        <ConfigField
          fieldKey="PLAYGROUND_MAX_RUNTIME_MS"
          label="Max runtime (ms)"
          type="number"
          value={config.PLAYGROUND_MAX_RUNTIME_MS}
          onChange={updateField}
          required={false}
          description="A run is killed if it exceeds this wall-clock time."
          min={30_000}
          max={3_600_000}
        />
        <ConfigField
          fieldKey="PLAYGROUND_MAX_CONCURRENT_RUNS"
          label="Max concurrent runs"
          type="number"
          value={config.PLAYGROUND_MAX_CONCURRENT_RUNS}
          onChange={updateField}
          required={false}
          description="How many Playground runs can be in flight at once."
          min={1}
          max={10}
        />
      </div>

      <div style={styles.actionBar}>
        {isDirty && <span style={styles.dirtyBadge}>Unsaved changes</span>}
        <div style={{ flex: 1 }} />
        <button type="button" style={styles.resetBtn} onClick={resetConfig} disabled={!isDirty} aria-label="Reset to saved values">
          Reset
        </button>
        <button
          type="button"
          style={{ ...styles.saveBtn, ...(!isDirty || saving ? styles.saveBtnDisabled : {}) }}
          onClick={handleSave}
          disabled={!isDirty || saving}
          aria-label="Save automation settings"
        >
          {saving ? 'Saving…' : 'Save Automation Settings'}
        </button>
      </div>
    </div>
  );
}
