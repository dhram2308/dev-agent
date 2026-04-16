# Pipeline UI Spec

## ADDED Requirements

### Requirement: AgentStatus SHALL render live agent activity when available

A new `AgentActivityBar` component under `AgentStatus` SHALL read `state.data._agent_action` (string) and display it as a single line beneath the stage strip. When absent or empty, nothing renders (no layout shift).

#### Scenario: Backend populates agent action

- **WHEN** the current stage is `generate_code` and `state.data._agent_action` = `"Writing packages/agent/src/stages/fetch-ticket.ts"`
- **THEN** the activity bar displays that string with a pulsing dot prefix

#### Scenario: No agent action set

- **WHEN** `state.data._agent_action` is missing or empty
- **THEN** the activity bar component returns null and does not reserve vertical space

### Requirement: AgentStatus SHALL render sub-stage progress during `generate_code`

A new `SubStageProgress` component SHALL read `state.data._sub_stage` and render a three-pill strip (`write → review → fix`). The current sub-stage is highlighted; completed ones are solid; future ones are faded.

#### Scenario: Agent is writing

- **WHEN** the main stage is `generate_code` and `_sub_stage` = `'write'`
- **THEN** the three pills render with `write` highlighted and `review`/`fix` faded

#### Scenario: Agent is in fixer loop

- **WHEN** `_sub_stage` = `'fix'`
- **THEN** `write` and `review` are solid (completed) and `fix` is highlighted

#### Scenario: Sub-stage not tracked (resumed pipeline)

- **WHEN** `_sub_stage` is undefined
- **THEN** `SubStageProgress` returns null and `AgentStatus` renders only the main stage strip

### Requirement: Pipeline store SHALL guard against out-of-order and duplicate `state` events

The `updateState` action in `packages/frontend/src/store/pipeline.ts` MUST:
1. Ignore state payloads whose `stage` index is strictly less than the currently recorded stage index, UNLESS the ticket's active pipeline has been reset (detected via `resetAt` timestamp bump or `running: false` transition)
2. Avoid updating `stageStartedAt` when the incoming state's `(stage, updatedAt)` matches the existing record (duplicate delivery)

#### Scenario: Late-arriving state for prior stage

- **WHEN** the store currently holds stage `gate_code_review` for AUT-8500 and a `state` SSE event arrives carrying stage `generate_code`
- **THEN** the store drops the late event, logs a `warn` in dev, and does not reset `stageStartedAt`

#### Scenario: Duplicate state delivery

- **WHEN** two identical `state` events for AUT-8500 (same `stage` and `updatedAt`) arrive back-to-back
- **THEN** the store processes the first one, drops the second, and does not re-emit subscriber updates

#### Scenario: Explicit reset

- **WHEN** a client calls `resetAgent(ticket)` and a follow-up `state` event carries an earlier stage
- **THEN** the store accepts it (reset path bumps `resetAt`) and updates as a fresh run

### Requirement: Keyboard shortcut `f` SHALL open the refine form on explore_plan gate

`useGlobalKeyboardShortcuts` MUST bind `f` to opening the refine form when the active ticket is paused at `explore_plan`. The binding is a no-op when the active ticket is not at `explore_plan` or no ticket is active.

#### Scenario: User presses `f` at plan gate

- **WHEN** the pipeline is paused at `explore_plan` and the user presses `f` with no input focused
- **THEN** the refine form opens and the textarea receives focus

#### Scenario: User presses `f` while typing in a comment

- **WHEN** any `<input>`, `<textarea>`, or `contenteditable` element has focus
- **THEN** the shortcut handler returns early and the `f` key inserts normally
