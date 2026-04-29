# Proposal: Render OpenSpec Tabs with `react-markdown`

## Problem

On the `explore_plan` gate (Plan Review), the Web UI shows OpenSpec artifacts as raw markdown source instead of rendered content. The user sees literal `##` headings, `- [ ]` checkboxes, inline backticks, and markdown bullets as plain text in a monospace, `white-space: pre-wrap` `<div>`.

Two render sites are involved inside `packages/frontend/src/components/GateApproval.tsx`:

1. **`styles.planContent` block (line 387–391)** — renders `data.explore_plan` (the tasks-md string) as raw text.
2. **`<OpenSpecTabs>` sub-component (line 532)** — renders each tab of `data.explore_openspec` via `{data[activeTab]}` inside a `font-mono` + `pre-wrap` `<div>`. No markdown transformation.

A nearby component, `packages/frontend/src/components/review/PlanTabs.tsx`, has a ~100-line homegrown `renderMarkdownToHtml` regex pipeline used with `dangerouslySetInnerHTML`. It is:
- Incomplete — no tables, no nested lists, no multi-line list items, no proper fenced-code-with-language, no task-list input, fragile inline-element disambiguation.
- Unsafe by shape — builds HTML strings and hands them to the DOM via `dangerouslySetInnerHTML`; any escape-ordering bug becomes an XSS surface.
- Not React-idiomatic — bypasses the component tree, hostile to DevTools, hostile to theming, duplicated knowledge of every style.

The prior "extract the regex renderer to a shared lib" plan would have propagated this debt across two consumers. Better: replace it.

## Solution

Adopt `react-markdown` + `remark-gfm` as the project's single markdown renderer. Create a thin `<Markdown>` wrapper in `packages/frontend/src/components/Markdown.tsx` that owns the theme component map. Use it everywhere markdown is rendered. Delete the homegrown regex renderer and its `dangerouslySetInnerHTML` call-site.

Apply a **per-key rendering strategy** in `OpenSpecTabs` because `explore_openspec` is heterogeneous:

| Key | Type | Render as |
|-----|------|-----------|
| `proposal`, `design`, `specs`, `tasks` | markdown string | `<Markdown>` |
| `changeName`, `artifactDir` | plain identifier / path | mono `<code>` pill |
| `suggestions` | `string[]` | `<ul>` with each item rendered via `<Markdown>` |

Preserve the `planContent` preview block above the tabs but switch it from raw text to `<Markdown>` — keeps the "at-a-glance tasks preview" above the "full tabs" layout the user is familiar with (user decision B over drop-it decision A).

### What Changes

| Layer | Change |
|-------|--------|
| `packages/frontend/package.json` | Add `react-markdown` + `remark-gfm` to dependencies |
| `packages/frontend/src/components/Markdown.tsx` (new) | Single `<Markdown>` wrapper + theme component map |
| `packages/frontend/src/components/GateApproval.tsx` | `planContent` block → `<Markdown>`; `OpenSpecTabs` → per-key strategy (Markdown / mono pill / bullet list) |
| `packages/frontend/src/components/review/PlanTabs.tsx` | Delete `renderMarkdownToHtml` (~100 lines); delete `dangerouslySetInnerHTML`; use `<Markdown>` |
| `packages/frontend/tests/Markdown.test.tsx` (new) | Unit tests: headings, lists, task-list checkboxes, fenced code, inline code, links, tables, strikethrough; assert zero `dangerouslySetInnerHTML` in output |

### What Doesn't Change

- Backend `stages/explore-plan.ts` continues to produce `explore_openspec = { proposal, design, specs, tasks, changeName, artifactDir, suggestions }` in its current shape.
- `/api/review` response shape — unchanged.
- Tab order, tab labels, tab behavior — unchanged.
- Approve / Reject / Refine flow — unchanged.
- The `<DiffViewer>` consumer of `<PlanTabs>` (frozen review screen) — unchanged except the renderer under it is now react-markdown.
- No syntax highlighting for code fences (deferred to follow-up; current view has none either).

## Scope

- **In scope**: dep addition, `<Markdown>` wrapper, three consumers switched, tests, one theme component map
- **Out of scope**: syntax highlighting for code fences (`rehype-highlight` / `react-syntax-highlighter`), markdown in non-Plan-Review surfaces (Jira comments, Slack previews), server-side markdown rendering, a markdown editor

## Risks

| Risk | Mitigation |
|------|------------|
| Bundle size +~40 KB gzipped (react-markdown + remark-gfm + transitive unified/remark-* chain) | Accepted. The app ships React + zustand + Vite already; a proper renderer is worth the trade vs. regex-based HTML string injection. If it ever mattered, `marked` + `DOMPurify` is a 15 KB fallback — still better than current. |
| A valid but unusual markdown construct renders differently than the regex pipeline did (e.g. bold-inside-link) | This is a feature, not a regression — the regex renderer was wrong on these cases. We surface the fix in the change description so reviewers know to compare against *real* markdown semantics, not the regex's output. |
| `react-markdown` default sanitization differs from the regex's escape-then-inject | Default `react-markdown` output is React elements — there is no HTML string to sanitize. Inline HTML in source markdown is not rendered by default (library default). This is safer than today. |
| Existing `PlanTabs` callers depend on specific styling (font-size, line-height, colors) | Theme component map in `<Markdown>` mirrors the current styles exactly for h1..h4, ul/ol/li, code, pre, a, blockquote, hr, strong, em, del. Visual diff should be near-zero on content that the regex handled. |
| `remark-gfm` enables task lists that render `<input type="checkbox" disabled>` — default browser styling | Map `input` in the component table to the styled checkbox used today (green check for `[x]`, empty box for `[ ]`). Preserves current visual affordance. |
| OpenSpec content contains a construct `react-markdown` handles but our theme forgot to style (e.g. `<table>`) | Include tables in the theme map from day one so new content types render reasonably. Unit tests cover tables, strikethrough, task lists explicitly. |
| Build breaks in CI because `@types/react-markdown` is now bundled with the package | `react-markdown` v9+ ships types. No separate `@types` package needed. |

## Success Criteria

1. Opening Plan Review in the Web UI shows rendered markdown: proper H2/H3 headings, indented bullets, rendered task-list checkboxes, inline code styled as pills, fenced code inside a mono block — matching what GitHub shows for the same source.
2. The `suggestions` tab renders as a bulleted list (not as a concatenated blob of all strings joined together, which is the current bug).
3. `changeName` and `artifactDir` tabs show a single mono pill (not wrapped as if they were markdown).
4. `grep -r "dangerouslySetInnerHTML" packages/frontend/src` returns zero results after the change.
5. `grep -r "renderMarkdownToHtml" packages/frontend/src` returns zero results.
6. `npx tsc --noEmit` passes in `packages/frontend`; `npx vitest run` passes including the new `<Markdown>` test file.
7. Bundle size delta measured via `vite build` is ≤ 60 KB gzipped (react-markdown + remark-gfm + transitives).
