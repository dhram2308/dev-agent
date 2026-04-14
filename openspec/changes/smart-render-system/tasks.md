## 1. pollState Data Comparison (eliminates 90% of unnecessary renders)

- [x] 1.1 Add `_previousPollJSON` variable to track last poll result as JSON string. In `pollState()`, after fetching state, compare `JSON.stringify(data)` against `_previousPollJSON`. Only call `scheduleRender()` when they differ. Always update state variables regardless. File: `server/html.js` ~line 4875
- [x] 1.2 Add `_previousReviewJSON` variable. In `fetchReview()`, compare new review data against previous before calling `renderReviewPanel()`. File: `server/html.js` ~line 3292

## 2. Dirty-Flag System for Sub-Renderers

- [x] 2.1 Add `_renderKeys` object to store previous snapshot key per renderer. Add `_dirtyCheck(name, key)` helper function that returns true if key changed, updating `_renderKeys[name]`. File: `server/html.js`, add before `render()` function
- [x] 2.2 Add dirty-flag checks to each sub-renderer in `render()`: wrap each `[name, fn]` call with `_dirtyCheck(name, computeKey())`. Define key functions for: `renderPills` (activeStep, currentStage, sidebarCodeExpanded, lastStateData?.stages), `renderDetail` (activeStep), `renderSummary` (activeStep, currentStage, lastStateData), `renderReviewPanel` (reviewData, reviewFileIdx, diffMode, diffFileFilter), `renderBanners` (lastStateData?._lastError, lastStateData?._warnings), `renderStuckBanner` (isStuck, isRunning, stuckMinutes), `renderApprovalStatus` (lastStateData, reviewData), `renderTestResults` (lastStateData?._unit_tests_complete, _e2e_tests_complete), `renderEmptyState` (currentStage, isRunning), `renderAgentActivity` (lastStateData?._active_agents). File: `server/html.js` ~line 3167
- [x] 2.3 Add `_invalidateAll()` function that clears all keys in `_renderKeys`, used when switching tickets or on user-triggered navigation to force full re-render. Call from `switchTicket()` and `router.go()`.

## 3. Scroll Guards

- [x] 3.1 Add `_lastScrolledGate` variable. In `renderReviewPanel()`, only call `scrollIntoView()` when `currentStage !== _lastScrolledGate`. Update `_lastScrolledGate = currentStage` after scrolling. Reset on ticket switch. File: `server/html.js` ~line 4319
- [x] 3.2 In `renderReviewPanel()`, save `diffTable.scrollTop` before any innerHTML rebuild of the diff table, restore via `requestAnimationFrame` after. File: `server/html.js` within renderReviewPanel diff table section

## 4. Inline DOM Morph for Stable Trees

- [x] 4.1 Implement `morphDOM(existingEl, newHTML)` function (~120 lines): parse newHTML into DocumentFragment, walk old/new children in parallel, update attributes/text in-place, append/remove extra nodes. File: `server/html.js`, add as utility function
- [x] 4.2 Apply `morphDOM` to `renderPills()` — replace `sidebarNav.innerHTML = html` with `morphDOM(sidebarNav, html)`. File: `server/html.js` within renderPills
- [x] 4.3 Apply `morphDOM` to `renderSummary()` — replace `summaryTable.innerHTML = html` with `morphDOM(summaryTable, html)`. File: `server/html.js` within renderSummary

## 5. Error Boundary

- [x] 5.1 In `render()`, wrap each sub-renderer call in try-catch. On error, log to console and call `showToast("UI render error in " + name, "error")`. Do not re-throw. File: `server/html.js` ~line 3167 (already existed from previous session)

## 6. Verification

- [x] 6.1 Restart server (`node server.js`), open Web UI at localhost:3000. Server starts successfully, JS parses without errors, all smart render functions present in output.
