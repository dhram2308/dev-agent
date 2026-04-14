## Context

The Web UI is a single 6025-line file (`server/html.js`) that returns a complete HTML document via `getHTML(apiToken)`. All JavaScript runs in the browser as vanilla JS inside a template literal. The UI uses a polling architecture with 4 staggered `setInterval` timers (5-10s each) plus SSE events, all feeding into a central `render()` function that calls 10 sub-renderers unconditionally. Every sub-renderer rebuilds its DOM target via `innerHTML`, destroying the entire subtree on each cycle.

**Current render chain:**
```
pollState (5s) → scheduleRender() → requestAnimationFrame → render()
  → renderPills()           → #sidebarNav.innerHTML
  → renderDetail()          → #detailCard.innerHTML
  → renderSummary()         → #summaryTable.innerHTML
  → renderReviewPanel()     → ~15 elements via innerHTML + scrollIntoView()
  → renderBanners()         → #errorBanner + #warningBanner innerHTML
  → renderStuckBanner()     → #stuckBanner innerHTML
  → renderApprovalStatus()  → #approvalStatus innerHTML
  → renderTestResults()     → #testResults innerHTML
  → renderAgentActivity()   → #agentActivity innerHTML
  → renderEmptyState()      → display toggle only (no innerHTML)
```

**Constraints:**
- Single file only — cannot extract modules or use build tools
- No external libraries — must be vanilla JS
- Template literal context — all JS is inside backtick string, requiring double-escape for backslashes
- Must preserve all existing functionality: SSE, polling, cross-tab sync, keyboard shortcuts, diff viewer, plan tabs

## Goals / Non-Goals

**Goals:**
- Eliminate unnecessary DOM rebuilds when polled data has not changed
- Preserve scroll position during renders (especially diff table and log terminal)
- Fire `scrollIntoView()` only once per new gate arrival, not every render cycle
- Keep the fix minimal (~180 lines) with zero risk to existing features

**Non-Goals:**
- Converting to a reactive framework (React, Vue, etc.)
- Implementing a full virtual DOM
- Restructuring the file into modules or components
- Changing the polling/SSE architecture
- Adding new UI features

## Decisions

### Decision 1: Three-layer approach over alternatives

**Chosen:** Dirty flags + inline DOM morph + scroll guards (3 complementary layers)

**Alternatives considered:**
1. **Full virtual DOM** — Too heavy (~500+ lines), overkill for 10 renderers, complex to debug in template literal
2. **morphdom library** — Would require vendoring 400+ lines of external code, adds maintenance burden
3. **Targeted updates only** — Just fixing pollState and scrollIntoView would address symptoms but not root cause; innerHTML would still destroy DOM unnecessarily
4. **Snapshot + JSON.stringify comparison** — Cheap for dirty checking but doesn't help with DOM preservation

**Rationale:** The three layers address distinct problems:
- Dirty flags prevent unnecessary render calls (90%+ elimination)
- DOM morph preserves scroll/focus for the remaining renders
- Scroll guards fix the two specific scroll-breaking code paths

### Decision 2: Dirty flags via string snapshot, not deep comparison

Each sub-renderer has specific global variables it reads (mapped during exploration). The dirty-flag system creates a cheap string key from those inputs:

```
renderPills: key = activeStep + "|" + currentStage + "|" + sidebarCodeExpanded + "|" + JSON.stringify(lastStateData?.stages)
renderDetail: key = activeStep
renderReviewPanel: key = reviewData?._hash + "|" + reviewFileIdx + "|" + diffMode + "|" + diffFileFilter
```

If key matches previous render's key, skip entirely. ~40 lines total.

**Why string keys:** `JSON.stringify` on targeted sub-objects is fast enough (< 1ms for our data sizes) and avoids the complexity of structural comparison. The key only includes the specific globals each renderer reads, not the entire state.

### Decision 3: Inline DOM morph for small stable trees only

Apply morphing to sidebar nav (`renderPills`), summary grid (`renderSummary`), and file tabs in review panel. These are small, structurally stable trees where node count and order rarely change.

**Not applied to:** diff table (large, complex, variable structure), log terminal (append-only, already optimized with 500-line cap), review panel body (complex conditional rendering with multiple modes).

The morph algorithm (~120 lines):
1. Parse new HTML into a DocumentFragment via `template.innerHTML`
2. Walk old and new children in parallel
3. Same tag → update attributes + recurse into children
4. Different tag or missing → replace/append/remove
5. Text nodes → update `textContent` if changed

### Decision 4: pollState data comparison before scheduleRender

Current line 4875 calls `scheduleRender()` unconditionally. Fix: compare `JSON.stringify(newData)` against `JSON.stringify(previousPollData)`. Only call `scheduleRender()` when they differ. This eliminates the primary source of the 2-3 second re-render cycle.

### Decision 5: scrollIntoView gate tracking

Add a variable `_lastScrolledGate` that stores the stage name of the last gate we scrolled to. In `renderReviewPanel()`, only call `scrollIntoView()` when `currentStage !== _lastScrolledGate`. Reset on ticket change.

## Risks / Trade-offs

- **[Risk] Dirty flag key misses a dependency** → Mitigation: Each renderer's dependencies were exhaustively mapped during exploration. If a new global is added to a renderer in the future, the dirty key must be updated. Add a comment at each renderer listing its tracked inputs.
- **[Risk] DOM morph mishandles edge cases** → Mitigation: Only apply to small, structurally stable trees (sidebar, summary). Complex trees (diff viewer, review panel) keep innerHTML with scroll position save/restore.
- **[Risk] JSON.stringify comparison in pollState is too slow** → Mitigation: State object is small (~2-5KB JSON). Stringify takes <1ms. If it ever becomes an issue, can switch to a hash or selective field comparison.
- **[Risk] Template literal escaping** → Mitigation: All new code will be tested via `node -e` evaluation of the rendered HTML before committing. Regex patterns must use `\\\\` for literal backslash in output.
