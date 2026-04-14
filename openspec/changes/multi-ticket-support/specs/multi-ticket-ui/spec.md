## ADDED Requirements

### Requirement: Ticket tab bar for switching between active tickets
The Web UI SHALL display a horizontal tab bar above the main content area showing all active tickets. Each tab SHALL show the ticket ID and a status indicator.

#### Scenario: Two tickets running
- **WHEN** two agents are running (AUT-8203 at generate_code, AUT-8343 at gate_code_review)
- **THEN** tab bar shows two tabs: `[● AUT-8203] [◉ AUT-8343]`
- **THEN** `●` indicates running, `◉` indicates needs approval

#### Scenario: User clicks a tab
- **WHEN** user clicks the AUT-8343 tab
- **THEN** `selectedTicket` changes to "AUT-8343"
- **THEN** sidebar pipeline, detail card, review panel, and logs update to show AUT-8343's state
- **THEN** the clicked tab gets an active visual indicator (e.g., accent border-bottom)

#### Scenario: No tickets active
- **WHEN** no agents are running and no tickets are tracked
- **THEN** tab bar is hidden and the empty state / welcome screen is shown

### Requirement: Add ticket button
The tab bar SHALL include an [+ Add] button that allows the user to start a new ticket.

#### Scenario: User clicks Add
- **WHEN** user clicks [+ Add] button
- **THEN** topbar ticket input is focused and cleared for entry
- **THEN** user enters a ticket ID and clicks Start to begin a new agent

#### Scenario: Max concurrent agents reached
- **WHEN** 3 agents are already running and user tries to start a 4th
- **THEN** server returns error "Max concurrent agents reached (3). Stop one first."
- **THEN** UI shows the error as a toast notification

### Requirement: Close/stop ticket from tab
Each ticket tab SHALL have a close button [x] that stops the agent and removes the tab.

#### Scenario: User closes a running ticket tab
- **WHEN** user clicks [x] on the AUT-8203 tab while the agent is running
- **THEN** system shows a confirm dialog: "Stop agent for AUT-8203?"
- **THEN** on confirm, agent is stopped and tab is removed
- **THEN** UI switches to the next available tab (or empty state if none)

#### Scenario: User closes a completed ticket tab
- **WHEN** user clicks [x] on a tab for a ticket whose agent has already exited
- **THEN** tab is removed without confirmation
- **THEN** per-ticket log buffer and state are cleared from memory

### Requirement: Per-ticket state management with backward-compatible shims
The UI SHALL store state per-ticket in a `ticketStates` map. Global variables (`currentStage`, `isRunning`, `lastStateData`, `reviewData`, `isStuck`, `stuckMinutes`, `completedGates`, `lastHealth`) SHALL be exposed via `Object.defineProperty` getters/setters that redirect to the selected ticket's state.

#### Scenario: Render reads currentStage
- **WHEN** `render()` reads `currentStage`
- **THEN** it gets `ticketStates[selectedTicket].currentStage` via the property getter
- **THEN** all existing render logic works without modification

#### Scenario: pollState sets currentStage
- **WHEN** `pollState()` sets `currentStage = "generate_code"`
- **THEN** the property setter writes to `ticketStates[selectedTicket].currentStage`

#### Scenario: Switch selected ticket
- **WHEN** user switches from AUT-8203 tab to AUT-8343 tab
- **THEN** `selectedTicket` changes to "AUT-8343"
- **THEN** all global property shims now redirect to AUT-8343's state
- **THEN** `render()` automatically shows AUT-8343's data

### Requirement: Per-ticket log display
The UI SHALL maintain separate log buffers per ticket. Only the selected ticket's logs SHALL be displayed in the log terminal.

#### Scenario: Receiving SSE log for selected ticket
- **WHEN** SSE `log` event arrives with `ticket: "AUT-8203"` and selectedTicket is "AUT-8203"
- **THEN** log line is appended to the visible log terminal
- **THEN** log line is also stored in the per-ticket client-side log buffer

#### Scenario: Receiving SSE log for non-selected ticket
- **WHEN** SSE `log` event arrives with `ticket: "AUT-8343"` and selectedTicket is "AUT-8203"
- **THEN** log line is stored in AUT-8343's client-side log buffer
- **THEN** log line is NOT appended to the visible log terminal

#### Scenario: Switching tickets restores logs
- **WHEN** user switches from AUT-8203 to AUT-8343
- **THEN** log terminal is cleared and repopulated from AUT-8343's client-side log buffer

### Requirement: Multi-ticket polling
The UI SHALL poll `GET /api/tickets` every 5 seconds to update the tab bar overview. The UI SHALL also poll `GET /api/state?ticket=X` and `GET /api/review?ticket=X` for the selected ticket.

#### Scenario: New ticket appears in /api/tickets
- **WHEN** `/api/tickets` returns a ticket not in the current tab bar (e.g., started from another tab)
- **THEN** a new tab is added to the tab bar for that ticket

#### Scenario: Ticket disappears from /api/tickets
- **WHEN** `/api/tickets` no longer includes a ticket that was in the tab bar (agent exited)
- **THEN** the tab's status indicator changes to show "completed" or "stopped"
- **THEN** the tab is NOT auto-removed (user may want to review logs/state)

### Requirement: Gate notification badges on tabs
Ticket tabs SHALL show a pulsing notification badge when the ticket is at a gate stage requiring user approval.

#### Scenario: Ticket arrives at gate_code_review
- **WHEN** AUT-8343's stage changes to `gate_code_review` (a gate stage)
- **THEN** AUT-8343's tab shows a pulsing accent-colored badge
- **THEN** if the tab is not selected, the badge persists until the user switches to that tab

#### Scenario: User switches to gated ticket
- **WHEN** user clicks the AUT-8343 tab that has a gate badge
- **THEN** the badge is cleared
- **THEN** the review panel for AUT-8343 is shown with approve/reject buttons

### Requirement: Auto-switch to ticket needing approval
When a ticket enters a gate stage and no other ticket is currently needing active user interaction, the UI SHALL auto-switch to that ticket.

#### Scenario: User is viewing a running ticket, another hits a gate
- **WHEN** user is viewing AUT-8203 (at `generate_code`, no interaction needed) and AUT-8343 enters `gate_code_review`
- **THEN** UI auto-switches to AUT-8343 tab
- **THEN** toast: "AUT-8343 needs your approval"

#### Scenario: User is actively interacting, another hits a gate
- **WHEN** user is typing in a reject feedback form for AUT-8203 and AUT-8343 enters a gate
- **THEN** UI does NOT auto-switch (user is actively interacting)
- **THEN** AUT-8343's tab shows a pulsing badge instead

### Requirement: Agent activity indicator
The UI SHALL display the currently active agents (from `_active_agents` in state data) for the selected ticket, showing which Claude agents are running in parallel.

#### Scenario: Three parallel agents running
- **WHEN** selected ticket's `_active_agents` is `["Requirements Agent", "Explorer Agent", "Risk Agent"]`
- **THEN** UI shows activity bar: `[Requirements ◉] [Explorer ◉] [Risk ◉]`

#### Scenario: One agent completes
- **WHEN** `_active_agents` changes to `["Explorer Agent", "Risk Agent"]`
- **THEN** UI updates: `[Requirements ✓] [Explorer ◉] [Risk ◉]`

#### Scenario: No agents active
- **WHEN** `_active_agents` is empty or absent
- **THEN** activity bar is hidden

### Requirement: Cross-tab sync with ticket awareness
All `BroadcastChannel` messages SHALL include a `ticket` field. Follower tabs SHALL only apply state updates for their `selectedTicket`.

#### Scenario: Leader broadcasts state for AUT-8203, follower views AUT-8343
- **WHEN** leader tab sends `state:sync` with `{ ticket: "AUT-8203", currentStage: "generate_code", ... }`
- **THEN** follower tab viewing AUT-8343 ignores the message (ticket mismatch)
- **THEN** follower tab viewing AUT-8203 applies the state update

#### Scenario: Gate approved in one tab, reflected in others
- **WHEN** user approves gate in tab A for AUT-8203
- **THEN** `gate:approved` message includes `{ ticket: "AUT-8203" }`
- **THEN** tab B viewing AUT-8203 disables approve/reject buttons
- **THEN** tab C viewing AUT-8343 does NOT disable its buttons
