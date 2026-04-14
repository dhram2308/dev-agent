## Why

The MI Dev Agent has ~100 env vars that must be manually edited in `.env` files, all notifications are hardcoded with no per-gate toggle, and external document links in Jira tickets (Google Drive, Figma) fail silently because there's no authenticated access. Users need a Settings UI to configure the agent without SSH/file-editing, control which notifications fire at each gate, and connect external apps for richer ticket context.

## What Changes

### 1. Gate Notification Settings
- Per-gate toggle for Slack, Jira comments, and UI alerts
- Reminder/escalation timing per gate (1h, 4h configurable)
- Saved to `notification-config.json`, loaded by pipeline stages
- UI toggle grid in Settings page

### 2. App Connectors Framework
- Connector cards for existing services (Jira, GitLab, Slack, Claude) showing connection status
- Framework for future connectors (Google Drive, Figma, Confluence, Notion)
- Test connection button per service
- Status indicators (connected/disconnected/error)

### 3. Settings UI for .env Keys
- Full form UI for all ~100 env vars grouped by category
- Info icon per field with description + "how to get this key" instructions
- Password fields masked with show/hide toggle
- Save button writes atomically to `.env` file + reloads config
- Validation feedback before save
- Test Connection per service category

## Capabilities

### New Capabilities
- `gate-notification-settings`: Per-gate notification channel toggles (Slack/Jira/UI) with reminder timing
- `app-connectors`: Service connection status dashboard with test buttons
- `env-settings-ui`: Full .env management UI with info tooltips, masked secrets, save-to-file

## Impact

- **server/routes.js**: New endpoints: GET/POST /api/config, POST /api/config/test, GET /api/config/schema
- **server/html.js**: Expanded #/settings page with tabbed sections
- **lib/config.js**: Add config write-back capability, config schema export
- **lib/notification-config.js**: New module for per-gate notification preferences
- **stages/*.js**: Read notification config before sending Slack/Jira notifications
- **No breaking changes**: All notifications default to current behavior (all ON)
