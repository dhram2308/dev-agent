## Why

The Web UI (`server/html.js`) re-renders the entire page every 2-3 seconds, destroying scroll position, resetting user scroll to top, and causing visual flicker. Root cause: `pollState()` calls `scheduleRender()` unconditionally every 5 seconds even when nothing changed, `render()` calls all 10 sub-renderers with no dirty checking, every sub-renderer uses `innerHTML` which destroys and recreates the full DOM subtree, and `scrollIntoView()` in `renderReviewPanel()` fires on every render cycle instead of only on first gate arrival. This makes the review experience unusable — users cannot scroll through diffs or read plans without the page jumping back to top.

## What Changes

- **Dirty-flag system**: Snapshot each sub-renderer's input state (specific globals it reads) as a cheap string key; skip the renderer entirely if snapshot matches previous cycle. Eliminates 90%+ of unnecessary DOM work.
- **Inline DOM morph**: For small stable DOM trees (sidebar nav, summary grid, file tabs), patch existing nodes in-place instead of innerHTML rebuild. Preserves scroll position, focus, hover state, and selection.
- **Scroll guards**: Save/restore `scrollTop` on diff table innerHTML rebuilds; guard `scrollIntoView()` to fire once per new gate arrival, not every render; fix unconditional `scheduleRender()` in `pollState()` to only fire when data actually changed.
- **pollState data comparison**: Compare fetched state against previous state before calling `scheduleRender()`, eliminating the primary source of unnecessary 2-3 second re-renders.

## Capabilities

### New Capabilities
- `smart-render`: Dirty-flag render skipping, inline DOM morphing for stable trees, scroll position preservation, and data-change-gated rendering. Covers all 10 sub-renderers in the Web UI.

### Modified Capabilities
<!-- No existing specs to modify -->

## Impact

- **Only file changed**: `server/html.js` (~180 lines added/modified across the 6025-line file)
- **No API changes**: `getHTML(apiToken)` signature unchanged, all SSE/REST endpoints unchanged
- **No dependency additions**: Pure vanilla JS, no external libraries
- **Pipeline stages affected**: None — this is UI-only, no changes to agent orchestration
- **Risk**: Low — all changes are additive guards around existing render functions; existing behavior preserved when dirty flags detect changes
