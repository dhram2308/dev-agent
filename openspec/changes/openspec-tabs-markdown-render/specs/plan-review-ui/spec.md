## MODIFIED Requirements

### Requirement: Plan Review renders OpenSpec artifacts as rendered markdown
The `explore_plan` gate in the Web UI SHALL render the contents of `data.explore_plan` (the `planContent` preview block) and each tab of `data.explore_openspec` (the `OpenSpecTabs` content body) as rendered markdown using the shared `<Markdown>` component, not as raw text in a `white-space: pre-wrap` `<div>`.

#### Scenario: Plan preview renders markdown
- **WHEN** the Plan Review panel is displayed for a ticket at `explore_plan`
- **AND** `state.data.explore_plan` contains a markdown string with `##` headings, bullet lists, and inline backticks
- **THEN** the `planContent` block above the tabs displays the string as rendered markdown (proper heading tags, indented bullets, styled inline code)
- **AND** no literal `##` or `- ` characters are visible as prose

#### Scenario: OpenSpec tab body renders markdown
- **WHEN** the user clicks the `proposal`, `design`, `specs`, or `tasks` tab
- **THEN** the content body renders the tab value via `<Markdown>`
- **AND** the content area uses `font-family: var(--font-sans)`, not `var(--font-mono)`
- **AND** task lists in `tasks` show styled checkboxes (not literal `- [ ]` text)

### Requirement: Non-markdown tab values render with the correct strategy
`OpenSpecTabs` SHALL apply a per-key rendering strategy that respects the actual runtime type of each value in `data.explore_openspec`.

#### Scenario: `changeName` renders as a mono pill
- **WHEN** the `changeName` tab is active and its value is `"fix-step-gate-advancement"`
- **THEN** the content body renders a single `<code>` element styled as a mono pill
- **AND** the text shows the exact value `fix-step-gate-advancement` (no markdown interpretation)

#### Scenario: `artifactDir` renders as a mono pill
- **WHEN** the `artifactDir` tab is active and its value is `"openspec/changes/fix-step-gate-advancement"`
- **THEN** the content body renders a single `<code>` element styled as a mono pill
- **AND** the text shows the full path verbatim

#### Scenario: `suggestions` renders as a bulleted list
- **WHEN** the `suggestions` tab is active and its value is a `string[]` with 3 items
- **THEN** the content body renders a `<ul>` with exactly 3 `<li>` elements
- **AND** each `<li>` renders its item through `<Markdown>` (so a suggestion that contains inline markdown is itself formatted)
- **AND** no concatenated blob of all items is rendered

### Requirement: `OpenSpecTabs` data prop accepts mixed types
The `data` prop of the `OpenSpecTabs` React component SHALL be typed as `Record<string, string | string[]>` to match the runtime shape of `state.data.explore_openspec` (which includes the `suggestions: string[]` array).

#### Scenario: Type allows string-array values without an assertion
- **WHEN** a caller passes `{ tasks: '…', suggestions: ['a', 'b'] }` to `<OpenSpecTabs>`
- **THEN** the TypeScript compiler accepts the call without `as`-casting

## REMOVED Requirements

### Requirement: Homegrown `renderMarkdownToHtml` regex pipeline
**Reason:** Replaced by `react-markdown` + `remark-gfm` via the shared `<Markdown>` component. The regex pipeline was incomplete (no tables, no nested lists, no task list inputs), unsafe in shape (required `dangerouslySetInnerHTML`), and non-idiomatic. Its correctness properties are now owned by the `react-markdown` library.

### Requirement: `dangerouslySetInnerHTML` usage in `PlanTabs.tsx`
**Reason:** No markdown surface in the frontend requires string-level HTML injection after this change. All markdown rendering flows through `<Markdown>`, which emits React elements directly.
