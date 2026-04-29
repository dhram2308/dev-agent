## ADDED Requirements

### Requirement: `<Markdown>` component wraps `react-markdown` with a project theme
The frontend SHALL provide a `<Markdown>` component at `packages/frontend/src/components/Markdown.tsx` that is the single source for rendering markdown strings.

The component SHALL use `react-markdown` with `remark-gfm` (for task lists, tables, strikethrough, autolinks) and SHALL override node rendering via a component map (`mdComponents`) that matches the project's visual theme.

The component SHALL NOT use `dangerouslySetInnerHTML` and SHALL NOT accept or render raw inline HTML from the markdown source by default.

#### Scenario: Rendering headings
- **WHEN** `<Markdown># Hello</Markdown>` is rendered
- **THEN** the output contains an `<h1>` element with text content `Hello`
- **AND** the `<h1>` has styles matching the `h1` entry of `mdComponents`

#### Scenario: Rendering inline code
- **WHEN** `` <Markdown>The `x` variable</Markdown> `` is rendered
- **THEN** the output contains exactly one `<code>` element with text `x`
- **AND** that `<code>` element has no `<pre>` ancestor

#### Scenario: Rendering fenced code with language
- **WHEN** a triple-backtick block tagged `ts` is passed to `<Markdown>`
- **THEN** the output contains a `<pre>` wrapping a `<code>` with `className="language-ts"`
- **AND** the code text is preserved verbatim (including whitespace)

#### Scenario: Rendering GFM task lists
- **WHEN** `<Markdown>{'- [x] done\n- [ ] todo'}</Markdown>` is rendered
- **THEN** the output contains two `<li>` elements
- **AND** the first `<li>` contains a styled "done" indicator (checked state)
- **AND** the second `<li>` contains a styled "pending" indicator (unchecked state)
- **AND** neither indicator is an unstyled default-browser `<input type="checkbox">`

#### Scenario: Rendering links safely
- **WHEN** `<Markdown>[click](https://example.com)</Markdown>` is rendered
- **THEN** the output contains an `<a>` with `href="https://example.com"`, `target="_blank"`, and `rel="noopener noreferrer"`

#### Scenario: Rendering GFM tables
- **WHEN** a GFM table source (`| a | b |\n|---|---|\n| 1 | 2 |`) is passed to `<Markdown>`
- **THEN** the output contains a `<table>` with a `<thead>` and a `<tbody>`
- **AND** cells are `<th>` inside `<thead>` and `<td>` inside `<tbody>`

#### Scenario: Suppressing raw HTML
- **WHEN** `<Markdown>{'<script>alert(1)</script>'}</Markdown>` is rendered
- **THEN** the rendered DOM contains no `<script>` element
- **AND** the raw text `<script>` is either displayed as literal characters or dropped, never executed

#### Scenario: No `dangerouslySetInnerHTML` usage
- **WHEN** any markdown source is rendered via `<Markdown>`
- **THEN** the rendered React tree contains zero elements that set `dangerouslySetInnerHTML`

### Requirement: Theme map parity with prior renderer
The `mdComponents` theme map SHALL produce visual output that matches the style values of the prior `renderMarkdownToHtml` helper for every construct both renderers supported (headings h1–h4, inline code, fenced code, links, checkbox lists, blockquote, hr, unordered + numbered lists, bold, italic, strikethrough).

#### Scenario: Visual parity check
- **WHEN** an OpenSpec artifact that rendered cleanly under the old regex renderer is passed to `<Markdown>`
- **THEN** the visible heading sizes, colors, paddings, and list indentation match the old output to within visual inspection tolerance
