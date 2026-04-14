## ADDED Requirements

### Requirement: Centralized timer registry manages all intervals
A `_timers` object in `server/html.js` SHALL track all `setInterval` timers by name. Functions `registerTimer(name, fn, intervalMs)`, `clearTimer(name)`, `clearAllTimers()`, `pauseTimers()`, and `resumeTimers()` SHALL manage the lifecycle.

#### Scenario: Timer registered and active
- **WHEN** `registerTimer('poll', pollState, 3000)` is called
- **THEN** a setInterval is created, its ID stored in `_timers.poll`, and the callback fires every 3s

#### Scenario: Timer cleared by name
- **WHEN** `clearTimer('poll')` is called
- **THEN** clearInterval is called with the stored ID and the entry is removed from `_timers`

#### Scenario: All timers cleared on page unload
- **WHEN** the `beforeunload` event fires
- **THEN** `clearAllTimers()` clears every interval in `_timers` and resets the registry

### Requirement: Single visibilitychange listener with tab-aware pause/resume
There SHALL be exactly ONE `visibilitychange` event listener. The duplicate listener SHALL be removed. On `document.hidden === true`, all timers except heartbeat SHALL be paused. On visible, all timers SHALL resume.

#### Scenario: Tab becomes hidden
- **WHEN** `document.visibilityState` changes to "hidden"
- **THEN** `pauseTimers()` clears all intervals except heartbeat timer, preserving timer configuration for resume

#### Scenario: Tab becomes visible
- **WHEN** `document.visibilityState` changes to "visible"
- **THEN** `resumeTimers()` re-creates all paused intervals with their original callbacks and intervals, and triggers an immediate poll

#### Scenario: Heartbeat continues in hidden tab
- **WHEN** the tab is hidden and timers are paused
- **THEN** the heartbeat timer continues running to maintain connection status

### Requirement: Timer initialization enforces dependency ordering
Timers SHALL be registered in dependency order: poll first, then review, then heartbeat, then leader check. The `fetchReview` timer SHALL only execute its callback if at least one successful poll has completed (guard flag `_pollComplete`).

#### Scenario: fetchReview skips when no poll has completed
- **WHEN** `fetchReview` timer fires but `_pollComplete` is false
- **THEN** the callback returns early without making any API call

#### Scenario: fetchReview runs after first poll completes
- **WHEN** `pollState()` succeeds and sets `_pollComplete = true`, then `fetchReview` timer fires
- **THEN** the fetchReview callback executes normally

### Requirement: leaderCheckInterval is cleared on tab hide
The `leaderCheckInterval` timer SHALL be managed through the timer registry and cleared when the tab is hidden, allowing other tabs to claim leadership.

#### Scenario: Tab hidden releases leadership check
- **WHEN** the tab becomes hidden and this tab is the leader
- **THEN** `leaderCheckInterval` is cleared, and other visible tabs can claim leadership via their own heartbeat

#### Scenario: Tab visible restarts leadership check
- **WHEN** the tab becomes visible again
- **THEN** `leaderCheckInterval` is restarted and the tab participates in leader election

### Requirement: showConfirmDialog uses null-safe element access
The `showConfirmDialog()` function SHALL check that `getElementById` returns a non-null element before accessing properties. If any required element is missing, the function SHALL fall back to native `confirm()`.

#### Scenario: Custom dialog elements exist
- **WHEN** `showConfirmDialog('Stop?', 'message', onConfirm)` is called and all dialog DOM elements exist
- **THEN** the custom modal dialog is shown with the title, message, and confirm button

#### Scenario: Custom dialog elements missing
- **WHEN** `showConfirmDialog()` is called but the dialog DOM element is not found
- **THEN** the function falls back to `window.confirm(message)` and calls `onConfirm()` if the user confirms

### Requirement: Ticket input validates format
The ticket input SHALL validate that the entered value matches a Jira ticket pattern (`/^[A-Z]+-\d+$/i`) before submitting. Invalid formats SHALL show a toast warning.

#### Scenario: Valid ticket ID entered
- **WHEN** user enters "AUT-1234" and clicks Start
- **THEN** the agent start request proceeds normally

#### Scenario: Invalid ticket ID entered
- **WHEN** user enters "hello world" and clicks Start
- **THEN** a warning toast "Invalid ticket ID format" is shown and the request is not sent

#### Scenario: Empty ticket ID
- **WHEN** user clicks Start with empty input
- **THEN** a warning toast "Enter a ticket ID" is shown (existing behavior preserved)

### Requirement: FormDrafts has size limits and expiration
Each form draft stored in localStorage SHALL be limited to 10KB. Drafts older than 7 days SHALL be cleaned up on page load.

#### Scenario: Draft within size limit
- **WHEN** user types a 500-character reject reason and the draft is auto-saved
- **THEN** the draft is stored in localStorage normally

#### Scenario: Draft exceeds size limit
- **WHEN** a draft would exceed 10KB
- **THEN** the draft is truncated to 10KB before storage

#### Scenario: Old drafts cleaned on load
- **WHEN** the page loads and drafts older than 7 days exist in localStorage
- **THEN** those expired drafts are removed from localStorage
