## Context

The Settings Connectors page (`ConnectorsTab.tsx`) renders 12 connector cards via `ConnectorCard.tsx`. Each card shows a status badge and has Test + Configure actions in the footer. OAuth connectors (Figma, Google Drive) additionally display account email, expiry countdown, and connect/disconnect buttons inline on the card.

Users currently cannot see connection health details at a glance — they must either run a test or navigate to the Config tab. The "Manage" modal consolidates status visibility and quick actions into one place for all connector types.

**Current data sources (already in Zustand store):**
- `connectors[]` — id, name, description, icon, status (`connected` / `disconnected` / `coming_soon`)
- `oauthStatuses[provider]` — oauthStatus, expiresAt, metadata (email, accountId)
- `testResults[id]` — loading, result (`ok`, `message`)

**Existing modal pattern:** `ConfirmDialog.tsx` — fixed overlay (z-index 9000), backdrop blur, focus trap, Esc-to-close, click-outside-to-close.

## Goals / Non-Goals

**Goals:**
- Add a "Manage" button to every connector card that opens a modal with connection status details
- Modal adapts content by auth type (PAT, OAuth, coming-soon)
- Reuse existing store data and modal patterns — no new API calls or backend changes
- Quick actions in the modal: Test Now, Configure, Disconnect (OAuth only)

**Non-Goals:**
- Editing configuration values inside the modal (Configure navigates to Config tab)
- Adding new API endpoints or backend status checks
- Changing the existing card layout or status badge behavior
- Adding credential rotation or token refresh controls

## Decisions

### 1. Single modal component inside ConnectorCard vs standalone

**Decision:** Create the modal markup directly inside `ConnectorCard.tsx`.

**Rationale:** The modal needs access to all card props (connector info, OAuth info, test results, action handlers). Keeping it in the same component avoids prop drilling through a separate component. The modal content is ~60 lines of JSX — not complex enough to warrant extraction.

**Alternative considered:** Separate `ManageConnectorModal.tsx` component. Rejected because it would need the full ConnectorCard props interface passed through, adding indirection with no real benefit for this size of feature.

### 2. State management for open/close

**Decision:** Local `useState<boolean>` inside `ConnectorCard` — `const [manageOpen, setManageOpen] = useState(false)`.

**Rationale:** Modal open/close is purely UI state scoped to one card. No need to lift to ConnectorsTab or Zustand store. Multiple cards can't have modals open simultaneously because clicking the overlay closes the current one.

### 3. Auth type detection

**Decision:** Derive auth type from existing props:
- `supportsOAuth && oauthInfo?.oauthStatus !== 'NOT_CONNECTED'` → OAuth connected
- `supportsOAuth && oauthInfo?.oauthStatus === 'NOT_CONNECTED'` → OAuth not connected
- `status === 'coming_soon'` → Coming soon
- Otherwise → PAT/Token

**Rationale:** No new data needed. The `supportsOAuth` prop and `oauthInfo` already distinguish OAuth from PAT connectors. `status` already identifies coming-soon connectors.

### 4. Modal layout

**Decision:** Use the `ConfirmDialog` overlay pattern (fixed position, backdrop blur, z-index 9000) but with custom body content — not the ConfirmDialog component itself, since we need a richer layout than confirm/cancel.

**Rationale:** ConfirmDialog is designed for yes/no confirmations with a single message. The manage modal needs a status table, multiple action buttons, and conditional sections. Reusing the overlay + close behavior CSS but with custom content gives the right UX without fighting the ConfirmDialog API.

### 5. Expiry countdown in modal

**Decision:** Reuse the same countdown logic already in `ConnectorCard` (30-second interval timer from `oauthInfo.expiresAt`).

**Rationale:** The card already computes and displays this. The modal can share the same computed value since it renders within the same component scope.

## Risks / Trade-offs

- **[Low] Modal z-index conflict** — The modal uses z-index 9000 (same as ConfirmDialog). If a ConfirmDialog is open at the same time, they'd overlap. → Mitigation: This is unlikely since Manage modal and ConfirmDialog serve different flows. No action needed.
- **[Low] Test result staleness** — The modal shows the last test result, which could be old. → Mitigation: The "Test Now" button in the modal lets users refresh. Existing behavior, not a new problem.
- **[None] Coming-soon connectors** — Modal shows "not yet available" which is low value. → Accepted trade-off for consistency: every card has Manage, no exceptions.
