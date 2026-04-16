## Why

The Settings Connectors page shows connector cards with basic status badges, but users have no way to inspect connection health details without navigating away. Clicking "Configure" switches to a different tab, breaking context. Users need a quick, in-place way to see connection status, auth type, account identity, and token expiry for any connector — and take actions (test, configure, disconnect) from that same view.

## What Changes

- Add a **"Manage" button** to every connector card footer (alongside existing Test and Configure)
- Clicking "Manage" opens a **modal dialog** showing connection status details for that connector
- Modal content adapts by auth type:
  - **PAT/Token connectors** (Jira, GitLab, Slack, Claude, Anthropic, Postman, Browser): status, auth type, last test result
  - **OAuth connectors** (Figma, Google Drive): status, auth type, account email, token expiry countdown, disconnect action
  - **Coming-soon connectors** (Confluence, Notion, Email): "not yet available" state
- Modal includes quick actions: Test Now, Configure (navigates to Config tab), Disconnect (OAuth only)
- No backend changes — all data already exists in the Zustand settings store (`connectors`, `oauthStatuses`, `testResults`)

## Capabilities

### New Capabilities
- `connector-manage-modal`: Modal dialog showing per-connector connection status, auth details, and quick actions when "Manage" is clicked on any connector card

### Modified Capabilities

## Impact

- **Frontend only** — no backend, API, or pipeline changes
- **Files affected**:
  - `packages/frontend/src/components/settings/ConnectorCard.tsx` — add Manage button to footer, render modal
  - `packages/frontend/src/components/settings/ConnectorsTab.tsx` — pass manage handler and state to cards
- **Reuses**: existing `ConfirmDialog` modal pattern (overlay, focus trap, Esc-to-close), existing store data (`oauthStatuses`, `testResults`, `connectors`)
- **No new dependencies** — pure React component using inline styles (matches codebase convention)
