# Design: OpenSpec Tabs Markdown Render

## Context

Two markdown-rendering code paths exist in the frontend:

1. **`GateApproval.tsx > OpenSpecTabs`** — renders `data.explore_openspec` per tab. Currently plain-text in `font-mono` / `white-space: pre-wrap`. No transformation.
2. **`review/PlanTabs.tsx`** — renders `plan` keys per tab using a homegrown `renderMarkdownToHtml(md)` regex pipeline → `dangerouslySetInnerHTML`.

Consumers of `PlanTabs`: the `<DiffViewer>` frozen-review screen.
Consumers of `OpenSpecTabs`: `<GateApproval>` only, at the `explore_plan` gate.

We need one consistent, correct, safe markdown path.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   packages/frontend/src/components/Markdown.tsx   (NEW)             │
│                                                                      │
│     import ReactMarkdown from 'react-markdown';                     │
│     import remarkGfm from 'remark-gfm';                             │
│                                                                      │
│     const mdComponents = {                                          │
│       h1/h2/h3/h4 — headings with themed sizes + colors             │
│       p             — body text                                      │
│       ul/ol/li      — bulleted / numbered lists                     │
│       code          — inline vs block split via `inline` prop       │
│       pre           — fenced-code wrapper styling                   │
│       a             — opens new tab, rel="noopener noreferrer"       │
│       blockquote    — accent-colored left border                    │
│       hr            — subtle divider                                │
│       strong / em / del                                             │
│       table / thead / tbody / tr / th / td — GFM tables             │
│       input        — task-list checkbox (disabled, styled)          │
│     };                                                               │
│                                                                      │
│     export function Markdown({ children: string })                  │
│                                                                      │
└────────────────┬────────────────────────────────────┬────────────────┘
                 │                                    │
                 ▼                                    ▼
  ┌───────────────────────────────┐  ┌────────────────────────────────┐
  │ review/PlanTabs.tsx           │  │ GateApproval.tsx                │
  │                                │  │                                 │
  │  -<div dangerouslySetInnerHtml│  │ planContent block:              │
  │   ={{__html: renderMd(c)}}/>  │  │  -<div>{explore_plan}</div>     │
  │  +<Markdown>{content}</Markdown│  │  +<Markdown>{explore_plan}</M> │
  │                                │  │                                 │
  │  DELETE: renderMarkdownToHtml │  │ OpenSpecTabs:                   │
  │  DELETE: dangerouslySetInnerH │  │   per-key strategy →            │
  └───────────────────────────────┘  │     proposal/design/specs/tasks │
                                      │        → <Markdown>{v}</M>     │
                                      │     changeName/artifactDir     │
                                      │        → <code class=mono>v</>│
                                      │     suggestions (string[])     │
                                      │        → <ul>{map(<li>Markdown│
                                      │                                 │
                                      └────────────────────────────────┘
```

## Key Decisions

### D1 — `react-markdown` over `marked`/`markdown-it` + DOMPurify

**Why:**
- Emits React elements, not HTML strings — removes the need for `dangerouslySetInnerHTML` entirely
- Component map is React-idiomatic (override any node type with a React component of your choice)
- Plays well with React DevTools — users inspecting the tree see meaningful nodes, not an opaque `<div>`
- MIT-licensed, actively maintained, widely used
- No user-controlled HTML executes by default

**Trade:** ~40 KB gz bundle cost (includes `unified`/`remark`/`rehype` chain). Accepted.

**Why not `marked` + DOMPurify (15 KB):** Still produces HTML strings, still requires `dangerouslySetInnerHTML`, sanitizer is a runtime surface we own. Smaller bundle, worse architecture.

**Why not `markdown-it`:** Same shape as `marked`. No reason to prefer.

### D2 — Single `<Markdown>` wrapper, not an inline `<ReactMarkdown>` at every use-site

**Why:** Theme map is long (~15 components × styling). Centralising it in one file means:
- Consistent look everywhere
- One place to add new node types (e.g. `rehype-highlight` later)
- Every consumer is a clean `<Markdown>{content}</Markdown>`

### D3 — Per-key strategy in `OpenSpecTabs`

Because `explore_openspec` mixes markdown, plain strings, and an array. Blind markdown-rendering of `changeName: "fix-step-gate-advancement"` would drop the hyphens. Blind markdown-rendering of `suggestions: ["foo", "bar"]` would concatenate the array.

```ts
function renderTabBody(key: string, value: string | string[]): JSX.Element {
  if (key === 'suggestions' && Array.isArray(value)) {
    return (
      <ul>{value.map((item, i) => (
        <li key={i}><Markdown>{item}</Markdown></li>
      ))}</ul>
    );
  }
  if (key === 'changeName' || key === 'artifactDir') {
    return <code className="mono-pill">{String(value)}</code>;
  }
  return <Markdown>{String(value)}</Markdown>;
}
```

### D4 — Keep `planContent` preview, render it as markdown

User chose option B: keep the preview block above the tabs. Apply `<Markdown>` so the preview and the `tasks` tab look identical. The block stays as a glance-able summary; tabs are the authoritative view.

### D5 — Task-list checkbox rendering

`remark-gfm` turns `- [x] Foo` into `<li><input type="checkbox" disabled checked /> Foo</li>`. Default browser checkbox styling is small and gray.

Override `input` in the component map:
```ts
input: ({ checked, ...rest }) =>
  checked
    ? <span style={checkStyle.done}>☑</span>
    : <span style={checkStyle.pending}>☐</span>
```

Preserves the green-check / empty-box affordance today's regex renderer shows, but routed through the real GFM parser.

### D6 — No syntax highlighting yet

`react-markdown` emits `<pre><code className="language-ts">…</code></pre>` for fenced code with a language. Styling the `<pre>`/`<code>` as a mono block is enough — matches today. If highlighting becomes important, add `rehype-highlight` (~8 KB) to the `rehypePlugins` array; the theme-map component for `pre` doesn't need to change.

### D7 — Drop regex renderer entirely (don't "extract to shared")

The earlier draft of this design suggested extracting `renderMarkdownToHtml` into `lib/markdown.ts` so both consumers could share it. That would have propagated technical debt. The right move is delete-and-replace.

Lines removed: ~100 (regex renderer) + ~1 (`dangerouslySetInnerHTML`).
Lines added: ~50 (component map) + ~5 (wrapper). Net: fewer lines, safer, more capable.

### D8 — Styling parity

The theme map mirrors current styles:

| Node | Current (regex) | New (`<Markdown>` component map) |
|------|-----------------|----------------------------------|
| h1 | 18px/700/primary | 18px/700/primary |
| h2 | 15px/700/primary | 15px/700/primary |
| h3 | 14px/700/primary | 14px/700/primary |
| h4 | 13px/700/primary | 13px/700/primary |
| inline code | bg-elevated pill, 11px mono | same |
| fenced code | bg-elevated box, 11px mono | same |
| link | accent color, underline | same |
| checkbox ✓ | green | same |
| checkbox ☐ | ghost | same |
| blockquote | accent left border | same |
| hr | subtle top border | same |

### D9 — Testing

New `packages/frontend/tests/Markdown.test.tsx`:

- Headings h1–h4 render with correct tag and style props
- `- [x] done` renders a styled `☑` (via input override)
- `- [ ] pending` renders a styled `☐`
- Unordered lists render a `<ul>` with `<li>` children
- Triple-backtick fenced code with a language renders `<pre><code className="language-ts">…</code></pre>`
- Inline backtick code renders `<code>` with mono styling
- `[text](url)` renders an anchor with `target="_blank"` and `rel="noopener noreferrer"`
- A `| col1 | col2 |` GFM table renders as `<table>`
- `~~strike~~` renders as `<del>`
- The component does NOT set `dangerouslySetInnerHTML` on any child (assert via `.container.innerHTML` lacks unescaped script tags when a `<script>` is in the input)

## Alternative considered (and rejected)

**Use a markdown-to-JSX transformer that runs at build time (static MDX).**
Rejected: OpenSpec artifacts are generated per-pipeline-run and streamed to the UI at runtime. They're not known at build time. MDX is the wrong tool.

**Let the backend pre-render markdown to HTML and send HTML over the wire.**
Rejected: adds a server-side renderer + sanitizer, duplicates what the UI does, and we lose the ability to style per-component in React. The data contract stays as markdown strings; the UI handles rendering.

## Data Shapes

```ts
// Existing — unchanged
interface ExploreOpenSpec {
  proposal: string;     // markdown
  design: string;       // markdown
  specs: string;        // markdown (joined blob)
  tasks: string;        // markdown (checkbox lists)
  changeName: string;   // id
  artifactDir: string;  // path
  suggestions: string[];// array of markdown-able strings
}

// New
interface MarkdownProps {
  children: string;     // markdown source
}
```

## Risks & Edge Cases

- **Empty string input** — `react-markdown` renders nothing. Component map not invoked. Safe.
- **Very large markdown (50 KB+)** — `react-markdown` parses on each render. Memoise at call sites if profiling shows cost. Unlikely for OpenSpec content (usually 2–10 KB per artifact).
- **Malformed markdown** — `remark-parse` is tolerant; produces best-effort AST. Users see approximate rendering, not an error.
- **User pastes HTML into markdown source** — `react-markdown` does not render inline HTML by default (`rehype-raw` is required to opt in, and we are not adding it). This is a feature for us, not a bug.
- **Component-map forgetting a node type** — `react-markdown` falls back to the default tag. Style inheritance from the surrounding `<div style={styles.markdown}>` keeps it legible. Add to the map in a follow-up.
