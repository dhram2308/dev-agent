# React Diff Viewer Spec

## Domain: packages/frontend/src/pages/Review/DiffViewer/

## Status: ADDED

## Overview
Code review diff viewer with split/unified modes, character-level highlighting,
inline comments, file tree navigation, and collapsible context sections.

## Requirements

### ADDED: View Mode Toggle
- WHEN reviewing code changes THEN the diff viewer renders with a split/unified mode toggle in the toolbar.
- WHEN in split mode THEN old code renders on the left panel and new code on the right panel, each with independent line numbers.
- WHEN in unified mode THEN a single column renders with `+`/`-` markers and line numbers for both old and new files.
- WHEN the mode toggle is clicked THEN the view switches without losing scroll position.

### ADDED: Character-Level Highlighting
- WHEN consecutive add/remove line pairs exist (a removal immediately followed by an addition) THEN character-level diff highlighting shows exactly which characters changed within the line.
- WHEN a character is added THEN it has a darker green background within the green addition line.
- WHEN a character is removed THEN it has a darker red background within the red deletion line.
- WHEN an entire line is added or removed with no paired counterpart THEN no character-level highlighting is applied (full-line color only).

### ADDED: Inline Comments
- WHEN the user hovers over a line number gutter THEN a `+` button appears on that line.
- WHEN the `+` button is clicked THEN an inline comment form expands below that line.
- WHEN the comment form is submitted THEN the comment is saved and displayed below the line with author and timestamp.
- WHEN a comment already exists on a line THEN it is visible without hovering.

### ADDED: File Tree Navigation
- WHEN a diff contains multiple files THEN a file tree sidebar renders on the left.
- WHEN a file in the tree is clicked THEN the diff view scrolls to or switches to that file's diff.
- WHEN a file has additions THEN it shows a green dot indicator in the tree.
- WHEN a file has deletions THEN it shows a red dot indicator in the tree.
- WHEN a file has both additions and deletions THEN it shows an orange dot indicator.

### ADDED: Diff Stats Bar
- WHEN the diff stats bar renders THEN it shows `+N` additions (green) and `-N` deletions (red) counts.
- WHEN the diff stats bar renders THEN it shows total files changed count.
- WHEN a specific file is selected THEN the stats bar updates to show that file's individual stats.

### ADDED: New and Deleted File Handling
- WHEN a new file is created (no old version) THEN all lines show as additions with green background.
- WHEN a file is deleted (no new version) THEN all lines show as deletions with red background.
- WHEN a file is renamed THEN the header shows `old_path -> new_path`.

### ADDED: Data Loading
- WHEN `GET /api/review` returns data THEN the diff viewer populates with the `changes` array from the response.
- WHEN the API call is loading THEN a skeleton placeholder renders in the diff area.
- WHEN the changes array is empty THEN a "No changes to review" empty state renders.
