## ADDED Requirements

### Requirement: Architect agent emits structured QUESTIONS block when uncertain
The Architect agent prompt SHALL include a "When you are uncertain" section documenting a `---QUESTIONS---` JSON block format. The block contents SHALL be a valid JSON array of `{id, text, options, recommend, reason}` objects where `id` is a stable string, `text` is the question text, `options` is an array of at least two string choices, `recommend` is an index into `options`, and `reason` is a short justification string.

The agent SHOULD cap the block at 3 questions per run and SHOULD only emit a question when the answer would materially change the implementation. When the agent has no uncertainty, it SHALL omit the `---QUESTIONS---` block entirely.

#### Scenario: Valid 2-question block parsed into state
- **WHEN** the Architect emits a `---QUESTIONS---` block containing a JSON array of 2 well-formed entries
- **THEN** the parser extracts both entries
- **AND** both appear in `state.data._pending_questions`

#### Scenario: Agent emits no questions
- **WHEN** the Architect output contains no `---QUESTIONS---` block
- **THEN** `state.data._pending_questions` is `[]`
- **AND** the pipeline proceeds without gating on answers

#### Scenario: Agent emits more than 3 questions
- **WHEN** the Architect emits a `---QUESTIONS---` block with 5 entries
- **THEN** the parser accepts all 5 entries
- **AND** a warning is logged noting that the cap of 3 was exceeded

### Requirement: Parser extracts `---QUESTIONS---` block into state
`packages/agent/src/stages/explore-plan.ts` `parseOpenSpecArtifacts` SHALL locate the fenced `---QUESTIONS---` JSON block in the Architect agent's output and parse it as JSON. On successful parse, each entry SHALL be validated for shape (`id: string`, `text: string`, `options: string[]` with length >= 2, `recommend?: number` within `options` bounds, `reason?: string`). Valid entries SHALL be written to `state.data._pending_questions`. Invalid entries SHALL be dropped with a warning logged.

On malformed JSON anywhere in the block, the parser SHALL log a warning, treat the run as having no questions, and allow the pipeline to continue without throwing.

#### Scenario: Valid JSON populates pending questions
- **WHEN** the Architect output contains a well-formed `---QUESTIONS---` JSON array
- **THEN** `state.data._pending_questions` is populated with the parsed entries

#### Scenario: Malformed JSON degrades gracefully
- **WHEN** the `---QUESTIONS---` block contains invalid JSON
- **THEN** a warning is logged
- **AND** `state.data._pending_questions` is `[]`
- **AND** the pipeline continues without throwing

#### Scenario: Entry missing id is dropped
- **WHEN** one entry in the JSON array lacks an `id` field
- **THEN** that entry is dropped from the output
- **AND** a warning is logged naming the offending entry
- **AND** other valid entries still land in `_pending_questions`

#### Scenario: Entry with too few options is dropped
- **WHEN** an entry has `options.length < 2`
- **THEN** that entry is dropped
- **AND** a warning is logged

#### Scenario: No block present
- **WHEN** the Architect output contains no `---QUESTIONS---` fence at all
- **THEN** `state.data._pending_questions` is `[]`

### Requirement: `POST /api/answer-questions` endpoint
The server SHALL expose `POST /api/answer-questions` that accepts a request body of the shape `{ ticket: string, answers: Array<{ id: string, choice: number }> }`. Each `answer.id` SHALL match an entry currently in `state.data._pending_questions`. Each `answer.choice` SHALL be a valid integer index into that question's `options` array.

On success, the endpoint SHALL append the accepted answers to `state.data._qa_answers`, remove the answered ids from `state.data._pending_questions`, and broadcast a `state` SSE event reflecting the updated state. The endpoint SHALL return `400` on missing ticket, unknown `id`, or out-of-range `choice`.

#### Scenario: Valid answers for all pending questions
- **WHEN** the client posts valid answers covering every pending question
- **THEN** the endpoint returns `200 OK`
- **AND** `state.data._qa_answers` contains the new answers
- **AND** `state.data._pending_questions` is `[]`
- **AND** a `state` SSE event is broadcast

#### Scenario: Missing ticket rejected
- **WHEN** the request body has no `ticket` field
- **THEN** the endpoint returns `400`

#### Scenario: Unknown id rejected
- **WHEN** an `answer.id` does not match any entry in `_pending_questions`
- **THEN** the endpoint returns `400`
- **AND** the error message names the bad id

#### Scenario: Out-of-range choice rejected
- **WHEN** an `answer.choice` is not a valid index into that question's `options`
- **THEN** the endpoint returns `400`

#### Scenario: Partial answers accepted
- **WHEN** the client posts answers covering only some pending questions
- **THEN** the endpoint returns `200`
- **AND** only the named ids move from `_pending_questions` to `_qa_answers`
- **AND** the unanswered questions remain in `_pending_questions`

### Requirement: Developer agent receives `_qa_answers` as binding context
The Developer agent prompt SHALL include a `## User-confirmed decisions` section populated from `state.data._qa_answers` at run time. For each answer, the section SHALL render the original question text, the chosen option's text, and the AI's original `reason` (if any). The prompt copy SHALL instruct the Developer agent to treat these decisions as binding constraints and SHALL NOT re-derive them.

#### Scenario: Empty answers renders nothing binding
- **WHEN** `state.data._qa_answers` is empty at Developer run time
- **THEN** the `## User-confirmed decisions` section is omitted, or shows a placeholder such as "No prior user decisions"

#### Scenario: Non-empty answers rendered with binding language
- **WHEN** `state.data._qa_answers` has 2 entries
- **THEN** the Developer prompt's `## User-confirmed decisions` section renders both entries with question text, chosen option text, and reason
- **AND** the section instructs the agent to use the decisions as binding constraints

### Requirement: Answers persist across Refine iterations
When the user clicks Refine and the Architect agent re-runs, entries already in `state.data._qa_answers` SHALL NOT be cleared by the stage reset. If the new Architect run emits a question whose `id` is already present in `_qa_answers`, that stale answer SHALL be removed from `_qa_answers` so the user can answer it again in light of the refine context.

#### Scenario: Refine preserves unrelated answers
- **WHEN** the user answers Q1
- **AND** clicks Refine
- **AND** the new Architect run emits no question with id `Q1`
- **THEN** `Q1` remains in `state.data._qa_answers`

#### Scenario: Refine re-raises a question and drops stale answer
- **WHEN** the user answers Q1
- **AND** clicks Refine
- **AND** the new Architect run re-emits a question with id `Q1`
- **THEN** the old `Q1` entry is removed from `_qa_answers`
- **AND** `Q1` appears again in `_pending_questions` for re-answering

### Requirement: Shared types for pending questions and answers
`packages/shared/src/types/codegen.ts` (or an adjacent module within `packages/shared/src/types/`) SHALL export `PendingQuestion` and `QuestionAnswer` TypeScript interfaces. The `PipelineData` type SHALL include optional fields `_pending_questions?: PendingQuestion[]` and `_qa_answers?: QuestionAnswer[]`.

#### Scenario: Types exported from shared package
- **WHEN** another package imports from `@mi/shared`
- **THEN** both `PendingQuestion` and `QuestionAnswer` are available as named exports

#### Scenario: State round-trips both arrays
- **WHEN** state containing `_pending_questions` and `_qa_answers` is serialized to JSON and then deserialized
- **THEN** both arrays survive the round-trip with all fields intact
