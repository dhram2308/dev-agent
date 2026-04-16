# Code Review UI Spec

## ADDED Requirements

### Requirement: FileTree SHALL support substring file search

`FileTree` inside `DiffViewer` MUST render a search input above the tree. When the user types, only files whose path contains the query (case-insensitive) remain visible. The currently-selected file remains selected even if filtered out (shown as "1 match outside filter" hint).

#### Scenario: User filters to a subset

- **WHEN** the diff includes 42 files and the user types `reducer` into the search input
- **THEN** only files whose path contains `reducer` render, and the file count badge updates (e.g. "3 of 42")

#### Scenario: User clears the search

- **WHEN** the user clears the search input
- **THEN** the full file list returns and the selection is preserved

### Requirement: DiffViewer SHALL warn before rendering diffs larger than 5 000 lines

`DiffViewer` MUST count the total added + removed + context lines across all hunks in the review payload. When the total is >= 5 000, the viewer renders a warning modal with the total line count and two actions: **Render anyway** (shows the diff) and **Close** (navigates back to the pipeline detail view). The user's choice is persisted in `sessionStorage` keyed by ticket so tab-switches don't re-nag.

#### Scenario: Small diff renders immediately

- **WHEN** the review payload has 450 total diff lines
- **THEN** the diff renders without showing the warning

#### Scenario: Very large diff shows warning

- **WHEN** the review payload has 8 200 total diff lines
- **THEN** the warning modal appears with "This diff has 8 200 lines. Rendering may be slow."
- **AND** clicking **Render anyway** dismisses the modal and displays the diff

#### Scenario: User already acknowledged this ticket

- **WHEN** the user already clicked **Render anyway** for this ticket in the current session
- **THEN** navigating back to the review view does not re-show the warning

### Requirement: LogViewer SHALL support exporting the visible buffer to a text file

`LogViewer` MUST expose an **Export** button in its toolbar. Clicking it serializes the currently-filtered logs to plain text (one line per entry, prefixed with `[HH:MM:SS]` and level) and triggers a browser download via a Blob URL. Filename: `{ticket}-logs-{YYYYMMDD-HHmmss}.txt`.

#### Scenario: Export current view

- **WHEN** the user applies a level filter (e.g. only `error` + `warn`) and clicks **Export**
- **THEN** the downloaded file contains only the filtered entries in the current display order

#### Scenario: No active ticket

- **WHEN** no ticket is active
- **THEN** the Export button is disabled

### Requirement: SSE named listeners SHALL be removed on close

`useSSE` MUST track every `(eventName, handler)` pair it registers via `addEventListener` on the `EventSource` in a ref, and remove each pair before calling `.close()` in `closeEventSource()`. This prevents listener accumulation across reconnects.

#### Scenario: Repeated reconnect

- **WHEN** `useSSE` reconnects 10 times over the lifetime of a session (simulated via `window.dispatchEvent('online')` / offline cycles)
- **THEN** the total number of active listeners at any time is at most the number of event types (currently 5: `log`, `status`, `state`, `pipelines`, `review`)
- **AND** no heap growth from listener references is observed between reconnects

#### Scenario: Component unmount

- **WHEN** the React root unmounts (e.g. HMR in dev)
- **THEN** `closeEventSource()` runs, detaches all listeners, and calls `.close()` exactly once
