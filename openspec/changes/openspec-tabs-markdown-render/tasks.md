# Tasks: OpenSpec Tabs Markdown Render

## Phase 1: Dependencies

- [x] 1.1 Add `"react-markdown": "^9.0.1"` to `packages/frontend/package.json` dependencies
- [x] 1.2 Add `"remark-gfm": "^4.0.0"` to `packages/frontend/package.json` dependencies
- [x] 1.3 Run `npm install` from repo root to install + update `package-lock.json`
- [x] 1.4 Verify `npx tsc --noEmit` from `packages/frontend/` still passes before touching any code

## Phase 2: `<Markdown>` component

- [x] 2.1 Create `packages/frontend/src/components/Markdown.tsx`
- [x] 2.2 Import `ReactMarkdown` from `react-markdown` and `remarkGfm` from `remark-gfm`
- [x] 2.3 Define the `mdComponents` theme map at module scope with overrides for: `h1`, `h2`, `h3`, `h4`, `p`, `ul`, `ol`, `li`, `code` (split inline vs block via `inline` prop), `pre`, `a` (target="_blank" + rel="noopener noreferrer"), `blockquote`, `hr`, `strong`, `em`, `del`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, `input` (task-list checkbox → styled `☑` / `☐`)
- [x] 2.4 Match every style byte-for-byte to the current `renderMarkdownToHtml` output so the visual diff is near-zero on existing content (see design.md §D8 table)
- [x] 2.5 Export a default-exported `<Markdown children: string>` wrapper that returns `<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{children}</ReactMarkdown>`
- [x] 2.6 Also export `mdComponents` for advanced consumers that want to wrap `ReactMarkdown` themselves (future-proofing only)

## Phase 3: Migrate `PlanTabs.tsx`

- [x] 3.1 In `packages/frontend/src/components/review/PlanTabs.tsx`, remove the `renderMarkdownToHtml` function (~100 lines)
- [x] 3.2 Remove the `useMemo(() => renderMarkdownToHtml(content), [content])` call
- [x] 3.3 Replace the `<div dangerouslySetInnerHTML={{ __html: htmlContent }} />` with `<Markdown>{content}</Markdown>`
- [x] 3.4 Import `Markdown` from `../Markdown`
- [x] 3.5 Keep the outer `<div style={styles.content}>` wrapper (padding, maxHeight, overflow) so layout is unchanged
- [x] 3.6 Verify no other file imports `renderMarkdownToHtml` (grep should return 0 hits)

## Phase 4: Migrate `GateApproval.tsx` — `planContent` block

- [x] 4.1 In `packages/frontend/src/components/GateApproval.tsx`, locate the `styles.planContent` block (around line 387)
- [x] 4.2 Replace `<div style={styles.planContent}>{typeof planContent === 'string' ? planContent : JSON.stringify(planContent, null, 2)}</div>` with a conditional: if string → render via `<Markdown>` inside the same styled wrapper; if object → keep `<pre>{JSON.stringify(...)}</pre>` fallback
- [x] 4.3 Keep the outer `<div style={styles.planContent}>` styles (border, background, padding) but remove `white-space: pre-wrap` and `font-family: mono` because the content is now rendered markdown with proportional fonts
- [x] 4.4 Import `Markdown` from `./Markdown`

## Phase 5: Migrate `GateApproval.tsx` — `OpenSpecTabs`

- [x] 5.1 In `GateApproval.tsx`, in the inner `OpenSpecTabs` function (around line 532), replace the content body `<div style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', ... }}>{data[activeTab] ?? ''}</div>` with a call to a new `renderTabBody(activeTab, data[activeTab])` helper
- [x] 5.2 Implement `renderTabBody(key, value)` with the per-key strategy:
  - `suggestions` + `Array.isArray(value)` → `<ul>{value.map((item, i) => <li key={i}><Markdown>{item}</Markdown></li>)}</ul>`
  - `changeName` or `artifactDir` → `<code style={monoPill}>{String(value)}</code>`
  - else → `<Markdown>{String(value)}</Markdown>`
- [x] 5.3 Update the `data` prop type on `OpenSpecTabs` from `Record<string, string>` to `Record<string, string | string[]>` so `suggestions` can legitimately be an array (it currently is at runtime; the type was wrong)
- [x] 5.4 Switch the outer wrapper style: drop `font-mono` + `pre-wrap`, keep `background: var(--bg-elevated)`, `border-radius`, `padding`, `maxHeight: 400`, `overflowY: auto`, `font-family: var(--font-sans)`, `font-size: 13`, `line-height: 1.7` (parity with `PlanTabs.markdown`)
- [x] 5.5 The mono-pill style for `changeName`/`artifactDir` is a new inline style:
  `{ fontFamily: 'var(--font-mono)', fontSize: 11, padding: '4px 8px', background: 'var(--bg-elevated)', borderRadius: 4, color: 'var(--text-secondary)' }`

## Phase 6: Tests

- [x] 6.1 Create `packages/frontend/tests/Markdown.test.tsx` using `@testing-library/react`
- [x] 6.2 Test: `<Markdown># Hello</Markdown>` renders an `<h1>` containing `"Hello"`
- [x] 6.3 Test: `## Sub` renders `<h2>`; `### Sub-sub` renders `<h3>`; `#### Sub-sub-sub` renders `<h4>`
- [x] 6.4 Test: `- [x] done\n- [ ] todo` renders two `<li>` elements, the first containing a checked indicator, the second containing an empty one
- [x] 6.5 Test: `` `inline` `` renders a `<code>` element with no `<pre>` ancestor
- [x] 6.6 Test: triple-backtick fenced code with language renders `<pre><code class="language-ts">…</code></pre>`
- [x] 6.7 Test: `[click](https://example.com)` renders `<a target="_blank" rel="noopener noreferrer" href="https://example.com">click</a>`
- [x] 6.8 Test: GFM table ``| a | b |\n|---|---|\n| 1 | 2 |`` renders a `<table>` with `<thead>` + `<tbody>`
- [x] 6.9 Test: `~~strike~~` renders a `<del>`
- [x] 6.10 Test: `<script>alert(1)</script>` in source markdown does NOT produce a `<script>` element in the rendered output (inline HTML is suppressed by default)
- [x] 6.11 Test: `container.innerHTML` does not contain the string `dangerouslySetInnerHTML` or any escape artifacts — this is a spot-check that no raw HTML-string injection is occurring

## Phase 7: Cleanup + verification

- [x] 7.1 Grep check: `grep -r "dangerouslySetInnerHTML" packages/frontend/src` returns 0 hits
- [x] 7.2 Grep check: `grep -r "renderMarkdownToHtml" packages/frontend/src` returns 0 hits
- [x] 7.3 `cd packages/frontend && npx tsc --noEmit` passes
- [x] 7.4 `cd packages/frontend && npx vitest run` passes with the new `Markdown.test.tsx` green
- [x] 7.5 `cd packages/frontend && npm run build` succeeds; record the bundle size delta (must be ≤ 60 KB gzipped)
- [ ] 7.6 Manual: open Web UI on a ticket at `explore_plan` gate. Confirm each tab renders correctly:
  - `proposal` → rendered headings + paragraphs + lists
  - `design` → same + any code fences are styled
  - `specs` → headings + nested structure preserved
  - `tasks` → rendered task list with styled checkboxes
  - `changeName` → mono pill
  - `artifactDir` → mono pill
  - `suggestions` → bulleted list (not a concatenated blob)
- [ ] 7.7 Manual: confirm the `planContent` preview block above the tabs also renders as markdown (matches the `tasks` tab visually)

## Phase 8: Docs

- [x] 8.1 Add a paragraph to `memory/webui-diff-viewer.md` noting the new `<Markdown>` component lives at `packages/frontend/src/components/Markdown.tsx` and is the single source for markdown rendering
- [x] 8.2 Note in `memory/MEMORY.md` that the homegrown regex renderer was replaced with `react-markdown` + `remark-gfm`
- [ ] 8.3 Archive this change via OpenSpec after Phase 7 manual sign-off
