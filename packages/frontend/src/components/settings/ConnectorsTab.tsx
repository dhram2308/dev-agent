// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Connectors Tab Component
// Grid of connector cards for third-party integrations
// with OAuth support for Figma, Google Drive, Postman
// ═══════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettingsStore, CONFIG_GROUPS } from '../../store/settings';
import { ConnectorCard, type OAuthInfo, type ConnectorConfigField } from './ConnectorCard';
import { useOAuthLauncher } from '../../hooks/useOAuthLauncher';
import * as api from '../../lib/api';

// Map a connector id to the config-group id that owns its settings.
// Connectors not listed here have no configurable group (e.g. coming-soon ones).
const CONNECTOR_TO_GROUP: Record<string, string> = {
  jira: 'jira',
  gitlab: 'gitlab',
  slack: 'slack',
  claude: 'claude',
  anthropic: 'claude',
  browser: 'browser',
  figma: 'figma',
  'google-drive': 'google-drive',
  postman: 'postman',
};

// Providers that support OAuth flow (show Connect/Disconnect buttons)
const OAUTH_PROVIDERS = new Set(['figma', 'google-drive']);

// Providers that store a Personal Access Token in the keychain-backed credential
// store (via `POST /api/connectors/:provider/pat`). For Figma, the PAT acts as
// a fallback for cross-workspace files OAuth can't reach. For Postman, it's the
// only auth mode (provider has no OAuth). See `pat-in-credential-store` change.
const PAT_CAPABLE_PROVIDERS = new Set(['figma', 'postman']);

// Hint text shown above the PAT input for each provider. Keep concise — the
// disclosure is collapsed by default, so this only renders when the user opens it.
const PAT_HINT: Record<string, { text: string; href: string; linkText: string; placeholder: string; instructions?: string }> = {
  figma: {
    text: "OAuth handles most files; a PAT covers files in workspaces your OAuth grant doesn't reach.",
    href: 'https://www.figma.com/settings',
    linkText: 'figma.com/settings',
    placeholder: 'figd_…',
    instructions: "Open figma.com/settings → scroll to 'Personal access tokens' → click 'Generate new token' → name it, give it read access → copy the figd_… value (Figma shows it only once).",
  },
  postman: {
    text: 'Postman has no OAuth. Generate a PAT in your Postman account settings.',
    href: 'https://www.postman.com/settings/me/api-keys',
    linkText: 'postman.com/settings/me/api-keys',
    placeholder: 'PMAK-…',
    instructions: "Open postman.com/settings/me/api-keys → click 'Generate API Key' → copy the PMAK-… value.",
  },
};

// Map connector IDs to OAuth provider names (backend registers as 'google', not 'google-drive')
const OAUTH_PROVIDER_NAME: Record<string, string> = {
  'google-drive': 'google',
};
const toOAuthName = (id: string): string => OAUTH_PROVIDER_NAME[id] || id;

// Provider categories for grouped display
interface ProviderCategory {
  label: string;
  description: string;
  ids: string[];
}

const CATEGORIES: ProviderCategory[] = [
  {
    label: 'Core Services',
    description: 'Essential pipeline integrations',
    ids: ['jira', 'gitlab', 'slack', 'claude'],
  },
  {
    label: 'Design & Documents',
    description: 'Auto-fetch designs, docs, and API specs from linked resources',
    ids: ['figma', 'google-drive', 'postman'],
  },
  {
    label: 'Additional',
    description: 'Extended integrations and runtime services',
    ids: ['confluence', 'notion', 'anthropic', 'browser', 'email'],
  },
];

// ── Styles ──────────────────────────────────────────────────

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-4)',
  },
  description: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
    padding: 'var(--sp-3) var(--sp-4)',
    background: 'var(--bg-surface)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-default)',
  },
  categoryLabel: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: '-0.01em',
  },
  categoryDesc: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    marginTop: 2,
  },
  categoryHeader: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 0,
    marginTop: 'var(--sp-2)',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: 'var(--sp-4)',
  },
} as const;

// ── KeychainPatInput ────────────────────────────────────────
// Tiny inline component for the PAT-in-keychain disclosure. Lives inside the
// PAT disclosure of ConnectorCard for Figma and Postman. Posts to the new
// /api/connectors/:provider/pat route from `pat-in-credential-store` change.

function KeychainPatInput({
  provider,
  alreadyStored,
  onChange,
}: {
  provider: string;
  alreadyStored: boolean;
  onChange: () => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const hint = PAT_HINT[provider];

  const handleSave = async (): Promise<void> => {
    if (!value.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.savePat(provider, value.trim());
      setMsg({ ok: true, text: 'Saved to keychain' });
      setValue('');
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await api.removePat(provider);
      setMsg({ ok: true, text: 'Removed from keychain' });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {hint && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            {hint.text}
          </p>
          {hint.instructions && (
            <p style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: 0, lineHeight: 1.5 }}>
              {hint.instructions}
            </p>
          )}
          <a
            href={hint.href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 12,
              color: 'var(--text-link, #60a5fa)',
              textDecoration: 'none',
              alignSelf: 'flex-start',
              padding: '4px 10px',
              border: '1px solid var(--text-link, #60a5fa)',
              borderRadius: 4,
              marginTop: 4,
            }}
          >
            Open {hint.linkText} ↗
          </a>
        </div>
      )}
      {alreadyStored && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ color: '#22c55e' }}>● PAT stored in keychain</span>
          <button
            type="button"
            onClick={handleRemove}
            disabled={busy}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              borderRadius: 4,
              border: '1px solid #ef4444',
              background: 'transparent',
              color: '#ef4444',
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            Remove
          </button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="password"
          placeholder={hint?.placeholder ?? 'paste token'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{
            flex: 1,
            padding: '6px 10px',
            fontSize: 12,
            borderRadius: 4,
            border: '1px solid var(--border-default)',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
          }}
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !value.trim()}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            borderRadius: 4,
            border: '1px solid var(--border-default)',
            background: 'var(--button-bg, #1e293b)',
            color: 'var(--text-primary)',
            cursor: busy || !value.trim() ? 'not-allowed' : 'pointer',
            opacity: busy || !value.trim() ? 0.5 : 1,
          }}
        >
          {alreadyStored ? 'Replace' : 'Save'}
        </button>
      </div>
      {msg && (
        <div style={{ fontSize: 11, color: msg.ok ? '#22c55e' : '#ef4444' }}>{msg.text}</div>
      )}
    </div>
  );
}

// ── Component ───────────────────────────────────────────────

export function ConnectorsTab(): JSX.Element {
  const connectors = useSettingsStore((s) => s.connectors);
  const testResults = useSettingsStore((s) => s.testResults);
  const testConnection = useSettingsStore((s) => s.testConnection);
  const oauthStatuses = useSettingsStore((s) => s.oauthStatuses);
  const fetchOAuthStatuses = useSettingsStore((s) => s.fetchOAuthStatuses);

  const { launch, disconnect, launching } = useOAuthLauncher();

  // Hydrate persisted OAuth/credential statuses from the backend on mount,
  // so a browser refresh doesn't lose the connected state.
  useEffect(() => {
    fetchOAuthStatuses();
  }, [fetchOAuthStatuses]);

  const config = useSettingsStore((s) => s.config);
  const fetchConfig = useSettingsStore((s) => s.fetchConfig);

  // Build map: connector id → config group fields
  const configFieldsMap = useMemo(() => {
    const map = new Map<string, ConnectorConfigField[]>();
    for (const [connectorId, groupId] of Object.entries(CONNECTOR_TO_GROUP)) {
      const group = CONFIG_GROUPS.find((g) => g.id === groupId);
      if (group) {
        map.set(connectorId, group.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          description: f.description,
          required: f.required,
          frozen: f.frozen,
          enumValues: f.enumValues,
          min: f.min,
          max: f.max,
        })));
      }
    }
    return map;
  }, []);

  // Save only specific connector config fields via API, then refresh store
  const handleSaveConnectorConfig = useCallback(async (values: Record<string, unknown>) => {
    await api.saveConfig(values as Record<string, string>);
    fetchConfig();
  }, [fetchConfig]);

  // Build a map from connector id → ConnectorInfo for quick lookup
  const connectorMap = useMemo(() => {
    const map = new Map(connectors.map((c) => [c.id, c]));
    return map;
  }, [connectors]);

  const handleTest = useCallback(
    (id: string) => {
      testConnection(id);
    },
    [testConnection],
  );

  const handleOAuthConnect = useCallback(
    (id: string) => {
      launch(toOAuthName(id));
    },
    [launch],
  );

  const handleOAuthDisconnect = useCallback(
    (id: string) => {
      disconnect(toOAuthName(id));
    },
    [disconnect],
  );

  return (
    <div style={styles.container}>
      <div style={styles.description}>
        Connect external services to enrich the agent pipeline with additional
        context from design tools, API collections, and document stores.
      </div>

      {CATEGORIES.map((category) => {
        // Filter to only connectors that exist in the store
        const categoryConnectors = category.ids
          .map((id) => connectorMap.get(id))
          .filter(Boolean) as typeof connectors;
        if (categoryConnectors.length === 0) return null;

        return (
          <div key={category.label}>
            <div style={styles.categoryHeader}>
              <div style={styles.categoryLabel}>{category.label}</div>
              <div style={styles.categoryDesc}>{category.description}</div>
            </div>

            <div style={{ ...styles.grid, marginTop: 'var(--sp-3)' }}>
              {categoryConnectors.map((connector) => {
                const canTest = connector.status !== 'coming_soon';
                const isOAuth = OAUTH_PROVIDERS.has(connector.id);
                const oauthInfo: OAuthInfo | undefined = isOAuth && oauthStatuses
                  ? (oauthStatuses[toOAuthName(connector.id)] || oauthStatuses[connector.id])
                  : undefined;

                // [pat-in-credential-store] Mount the keychain PAT input as
                // patFallbackContent for providers in PAT_CAPABLE_PROVIDERS.
                // Detect "already stored" by reading oauthStatuses[provider]
                // — the store sets oauthStatus='PAT' for kind:'pat' entries.
                const isPatCapable = PAT_CAPABLE_PROVIDERS.has(connector.id);
                const patAlreadyStored = !!oauthStatuses?.[connector.id]
                  && oauthStatuses[connector.id].oauthStatus === 'PAT';
                const patFallbackContent = isPatCapable ? (
                  <KeychainPatInput
                    provider={connector.id}
                    alreadyStored={patAlreadyStored}
                    onChange={fetchOAuthStatuses}
                  />
                ) : undefined;
                // Auto-expand the PAT disclosure for Figma right after the user
                // completes OAuth, so they don't have to discover the disclosure
                // toggle. Triggered only when (a) it's Figma, (b) OAuth is live,
                // (c) no PAT is stored yet. Once stored or user dismisses, the
                // auto-prompt stops. See `pat-in-credential-store` task 5.x.
                const patAutoOpen = connector.id === 'figma'
                  && oauthInfo?.oauthStatus === 'CONNECTED'
                  && !patAlreadyStored;

                return (
                  <ConnectorCard
                    key={connector.id}
                    name={connector.name}
                    icon={connector.icon}
                    description={connector.description}
                    status={connector.status}
                    testResult={testResults[connector.id]}
                    onTest={canTest ? () => handleTest(connector.id) : undefined}
                    supportsOAuth={isOAuth}
                    oauthInfo={oauthInfo}
                    onOAuthConnect={
                      isOAuth ? () => handleOAuthConnect(connector.id) : undefined
                    }
                    onOAuthDisconnect={
                      isOAuth ? () => handleOAuthDisconnect(connector.id) : undefined
                    }
                    oauthLaunching={launching === toOAuthName(connector.id)}
                    patFallbackContent={patFallbackContent}
                    patAutoOpen={patAutoOpen}
                    configFields={configFieldsMap.get(connector.id)}
                    configValues={config}
                    onSaveConnectorConfig={handleSaveConnectorConfig}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
