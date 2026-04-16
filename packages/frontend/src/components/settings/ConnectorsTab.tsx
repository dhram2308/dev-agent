// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Connectors Tab Component
// Grid of connector cards for third-party integrations
// with OAuth support for Figma, Google Drive, Postman
// ═══════════════════════════════════════════════════════════════

import { useCallback, useMemo } from 'react';
import { useSettingsStore } from '../../store/settings';
import { ConnectorCard, type OAuthInfo } from './ConnectorCard';
import { useOAuthLauncher } from '../../hooks/useOAuthLauncher';

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
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const setFocusGroup = useSettingsStore((s) => s.setFocusGroup);
  const oauthStatuses = useSettingsStore((s) => s.oauthStatuses);

  const { launch, disconnect, launching } = useOAuthLauncher();

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

  const handleConfigure = useCallback(
    (id: string) => {
      const groupId = CONNECTOR_TO_GROUP[id];
      if (!groupId) return;
      setFocusGroup(groupId);
      setActiveTab('config');
    },
    [setActiveTab, setFocusGroup],
  );

  const handleOAuthConnect = useCallback(
    (id: string) => {
      launch(id);
    },
    [launch],
  );

  const handleOAuthDisconnect = useCallback(
    (id: string) => {
      disconnect(id);
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
                const canConfigure =
                  canTest && CONNECTOR_TO_GROUP[connector.id] !== undefined;
                const isOAuth = OAUTH_PROVIDERS.has(connector.id);
                const oauthInfo: OAuthInfo | undefined = isOAuth && oauthStatuses
                  ? oauthStatuses[connector.id]
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
                    onConfigure={
                      canConfigure ? () => handleConfigure(connector.id) : undefined
                    }
                    supportsOAuth={isOAuth}
                    oauthInfo={oauthInfo}
                    onOAuthConnect={
                      isOAuth ? () => handleOAuthConnect(connector.id) : undefined
                    }
                    onOAuthDisconnect={
                      isOAuth ? () => handleOAuthDisconnect(connector.id) : undefined
                    }
                    oauthLaunching={launching === connector.id}
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
