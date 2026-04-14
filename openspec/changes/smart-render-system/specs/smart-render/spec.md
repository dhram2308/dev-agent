## ADDED Requirements

### Requirement: Dirty-flag render skipping
The render system SHALL track a snapshot key for each sub-renderer based on its specific input globals. A sub-renderer SHALL be skipped entirely when its snapshot key matches the previous render cycle's key.

#### Scenario: Poll returns identical data
- **WHEN** `pollState()` fetches state and the response is identical to the previous poll
- **THEN** `scheduleRender()` SHALL NOT be called
- **THEN** no sub-renderer SHALL execute
- **THEN** the DOM SHALL remain untouched

#### Scenario: Only stage timing changes
- **WHEN** `pollState()` fetches state where only `_lastActivity` timestamp differs but stage, step, and all other fields are unchanged
- **THEN** `scheduleRender()` SHALL be called
- **THEN** only `renderAgentActivity()` SHALL execute (its dirty key includes `_lastActivity`)
- **THEN** other sub-renderers SHALL be skipped

#### Scenario: Active step changes
- **WHEN** user clicks a sidebar nav item changing `activeStep`
- **THEN** `renderPills()`, `renderDetail()`, and `renderSummary()` SHALL execute (their dirty keys include `activeStep`)
- **THEN** `renderBanners()` and other renderers whose keys did not change SHALL be skipped

#### Scenario: Review data arrives
- **WHEN** `fetchReview()` returns new review data
- **THEN** `renderReviewPanel()` SHALL execute (its dirty key includes review data hash)
- **THEN** sidebar and banners SHALL be skipped if their inputs are unchanged

### Requirement: Scroll position preservation on diff table
The system SHALL save and restore the diff table's `scrollTop` position when the diff table DOM is rebuilt via innerHTML.

#### Scenario: Diff table re-render during scroll
- **WHEN** `renderReviewPanel()` rebuilds the diff table innerHTML while the user has scrolled to line 200
- **THEN** the diff table `scrollTop` SHALL be saved before innerHTML assignment
- **THEN** the diff table `scrollTop` SHALL be restored after innerHTML assignment via `requestAnimationFrame`
- **THEN** the user's visible position SHALL not change

#### Scenario: New file selected in diff viewer
- **WHEN** user clicks a different file tab in the diff viewer
- **THEN** the diff table `scrollTop` SHALL reset to 0 (new content, not a re-render of same content)

### Requirement: Gate scroll-into-view fires once per gate
The system SHALL fire `scrollIntoView()` for the review panel only once per new gate arrival, not on every render cycle.

#### Scenario: First render after gate arrival
- **WHEN** `currentStage` transitions to a gate stage (e.g., `gate_code_review`)
- **THEN** `renderReviewPanel()` SHALL call `scrollIntoView()` on the review panel
- **THEN** a tracking variable SHALL record this gate stage as "already scrolled"

#### Scenario: Subsequent renders during same gate
- **WHEN** `render()` fires again while still on the same gate stage
- **THEN** `scrollIntoView()` SHALL NOT be called
- **THEN** the user's scroll position SHALL be preserved

#### Scenario: New gate after previous gate
- **WHEN** the pipeline advances through a non-gate stage and then enters a new gate stage
- **THEN** `scrollIntoView()` SHALL fire again for the new gate
- **THEN** the tracking variable SHALL update to the new gate stage

### Requirement: pollState data comparison
The `pollState()` function SHALL compare fetched state data against the previous poll result before triggering a render.

#### Scenario: Identical consecutive polls
- **WHEN** `pollState()` fetches data identical to the previous poll (same JSON representation)
- **THEN** `scheduleRender()` SHALL NOT be called
- **THEN** state assignment (`lastStateData`, `currentStage`, etc.) SHALL still occur to keep variables current

#### Scenario: Changed data in poll
- **WHEN** `pollState()` fetches data that differs from the previous poll
- **THEN** `scheduleRender()` SHALL be called
- **THEN** all state variables SHALL be updated

### Requirement: Inline DOM morphing for stable trees
For structurally stable, small DOM trees (sidebar nav, summary grid), the system SHALL patch existing DOM nodes in-place instead of replacing via innerHTML.

#### Scenario: Sidebar nav item status change
- **WHEN** a pipeline stage completes and `renderPills()` executes
- **THEN** only the changed sidebar nav item's attributes and text SHALL be updated
- **THEN** other sidebar nav items SHALL retain their existing DOM nodes
- **THEN** any hover or focus state on unchanged items SHALL be preserved

#### Scenario: Summary grid timing update
- **WHEN** `renderSummary()` executes with updated timing for one stage
- **THEN** only the changed summary card's timing text SHALL be updated
- **THEN** scroll position within the summary section SHALL be preserved

#### Scenario: Morph fallback on structural change
- **WHEN** the new HTML has a different number of child nodes than the existing DOM (e.g., ticket switch changes sidebar item count)
- **THEN** the morph algorithm SHALL fall back to innerHTML replacement for that subtree
- **THEN** functionality SHALL be identical to the current behavior

### Requirement: Error boundary for render functions
Each sub-renderer invocation SHALL be wrapped in a try-catch to prevent one renderer's error from breaking the entire UI.

#### Scenario: Single renderer throws
- **WHEN** `renderSummary()` throws an error due to unexpected data shape
- **THEN** the error SHALL be caught and logged to console
- **THEN** all other sub-renderers SHALL still execute
- **THEN** a toast notification SHALL inform the user of the render error
