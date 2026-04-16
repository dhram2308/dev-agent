// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Connectors Tab Component
// Grid of connector cards for third-party integrations
// with OAuth support for Figma, Google Drive, Postman
// ═══════════════════════════════════════════════════════════════

import { useCallback, useMemo } from 'react';
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

// ── Component ───────────────────────────────────────────────

export function ConnectorsTab(): JSX.Element {
  const connectors = useSettingsStore((s) => s.connectors);
  const testResults = useSettingsStore((s) => s.testResults);
  const testConnection = useSettingsStore((s) => s.testConnection);
  const oauthStatuses = useSettingsStore((s) => s.oauthStatuses);

  const { launch, disconnect, launching } = useOAuthLauncher();

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
