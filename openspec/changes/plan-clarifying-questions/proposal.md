## Why

The pipeline has no mechanism for the AI to ask a structured question mid-run. Today, if Claude's Architect agent produces prose like `"Two things to confirm: 1) Ledger View placement — A or B? 2) Filter style — C or D?"`, the question text lands inside `state.data.explore_plan` as raw markdown. The user reads it in the Plan Review tab, but the only way to answer is to type a freeform `/api/refine` instruction like *"pick A and D"* — un-bound to the original question, un-verifiable, un-auditable, and brittle when the agent re-runs.

Result today: either Claude is prompted to never ask (forces best-guess — and the AC Reviewer catches the wrong assumption downstream, costing a full code-gen + review cycle) or the user has to spot embedded prose questions and hand-translate answers into refine text. Both paths waste iterations.

This change adds a first-class "AI asks a question → user picks an option → agent uses the answer" loop inside the existing `explore_plan` gate.

## What Changes

- **New state shape** `state.data._pending_questions: PendingQuestion[]` (id, text, options, recommend, reason) populated by parsing a `---QUESTIONS---` block out of the Architect agent's output.
- **New state shape** `state.data._qa_answers: QuestionAnswer[]` populated by a new `POST /api/answer-questions` endpoint.
- **Prompt addition** for the Architect agent: a `## When you are uncertain` section that documents the `---QUESTIONS---` JSON block format, caps at 3 questions per run, and scopes it to decisions that MATERIALLY change implementation.
- **Parser addition** in `stages/explore-plan.ts:parseOpenSpecArtifacts` — extracts + validates the JSON block; malformed input is logged and ignored (graceful degradation).
- **New API endpoint** `POST /api/answer-questions` with body `{ ticket, answers: [{id, choice}] }`. Validates IDs + option ranges, appends to `_qa_answers`, clears `_pending_questions`, broadcasts a `state` SSE event.
- **New UI** `<PendingQuestionsPanel>` inside the Plan Review gate. Shows each question as a radio group with the AI's pick starred + one-line reason. Includes an "Accept all AI picks" one-click bulk-answer button.
- **MODIFIED**: the `Approve` button in `GateApproval` is disabled while `_pending_questions` has unanswered entries. `Reject` and `Refine` remain enabled.
- **MODIFIED**: the Developer agent prompt gains a `## User-confirmed decisions` section that appends `_qa_answers` verbatim as binding constraints — "Use these decisions. Do not re-derive them."
- **Refine semantics**: answers persist in `_qa_answers` across a Refine iteration. The re-run Architect receives them as context AND is free to raise new questions.

No breaking changes. When `_pending_questions` is absent (legacy plans, agents that don't emit blocks, old tickets in flight at deploy time), the gate panel behaves exactly as today.

## Capabilities

### New Capabilities
- `clarifying-questions`: the AI→user question loop — structured question format, state shape, answer API, Plan Review panel, Developer prompt context injection.

### Modified Capabilities
- `plan-review-ui`: `Approve` button gains a disabled-when-questions-pending condition. `PendingQuestionsPanel` mounts above the tabs when `_pending_questions` is non-empty.

## Impact

- **Backend**: `packages/agent/src/stages/explore-plan.ts` (Architect prompt + parser), `packages/agent/src/stages/generate-code/developer.ts` (prompt gains decisions block), `packages/agent/src/server/routes.ts` (new endpoint), `packages/agent/src/lib/constants.ts` (STAGE_CLEARS extended to include `_pending_questions` and `_qa_answers`).
- **Frontend**: `packages/frontend/src/components/GateApproval.tsx` (mount new panel, disable Approve when pending), new component `packages/frontend/src/components/PendingQuestionsPanel.tsx`, `packages/frontend/src/store/pipeline.ts` (answer-questions action).
- **Shared types**: new `PendingQuestion` and `QuestionAnswer` exports in `packages/shared/src/types/`.
- **Pipeline stages affected**: `explore_plan` (questions raised + answered there) and `generate_code` (answers consumed by Developer).
- **No external dependency changes**. No new npm packages. No GitLab / Jira / Slack contract changes.
- **Rollout safe**: empty `_pending_questions` = current behaviour. Pipelines in flight at deploy time are unaffected because the parser only adds data; it never removes.
