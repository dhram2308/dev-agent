# Design: plan-clarifying-questions

## Context

Today the MI Dev Agent pipeline runs Architect and Developer as one-shot non-interactive Claude calls (`claude -p ...`). When Architect is uncertain about a decision — placement of a UI element, style of a filter, shape of a payload — it either guesses (which the downstream AC Reviewer later catches, triggering a full code-gen + review cycle) or it embeds freeform prose like "Two options to confirm: A or B?" inside its `explore_plan` markdown output. The user reads the prose in the Plan Review tab. The only way to answer is a freeform `POST /api/refine` instruction such as *"pick A, filter style C"* — un-bound to the original question, un-verifiable, not re-playable across a Refine iteration, and brittle if the agent re-runs and re-numbers its options.

Both paths waste iterations. The pipeline already has a human-in-the-loop gate at `explore_plan` (Approve / Reject / Refine). What it lacks is a structured channel for the AI to ask, and for the user to answer, without leaving that gate.

This change adds a first-class "AI asks → user picks → Developer consumes" loop **inside** the existing `explore_plan` gate. It is a capability layered on top of an existing stage. It is NOT a new pipeline stage.

The surface area is small by design: a JSON block in Architect's output, a parser, two new `state.data` fields, one new endpoint, one new Plan Review panel, one prompt addition on Developer. Everything else — stage ordering, approval config, SSE stream, gate UI shell — is unchanged.

```
 Architect run
     |
     v
 stdout with ---QUESTIONS--- JSON block
     |
     v
 parseOpenSpecArtifacts (explore-plan.ts)
     |
     +--> state.data.explore_plan           (existing markdown)
     |
     +--> state.data._pending_questions     (NEW — array of PendingQuestion)
     |
     v
 SSE "state" event
     |
     v
 Plan Review UI
     |
     +-- PendingQuestionsPanel (NEW, above tabs)
     |     - radio group per question, AI pick starred, one-line reason
     |     - "Accept all AI picks" bulk button
     |     - POST /api/answer-questions
     |
     +-- GateApproval
           - Approve DISABLED while _pending_questions is non-empty
           - Reject, Refine remain ENABLED

 POST /api/answer-questions
     |
     v
 state.data._qa_answers += new answers
 state.data._pending_questions = []
 SSE "state" event

 On Approve -> generate_code stage
     |
     v
 Developer prompt includes "## User-confirmed decisions"
 block rendered from _qa_answers (verbatim binding constraints)
```

## Goals / Non-Goals

### Goals

- Give Architect a way to surface uncertainty as a structured, id-bound question list — not prose.
- Let the user answer those questions with one click per question (or one bulk click).
- Bind those answers into the Developer prompt as non-negotiable constraints.
- Make the `Approve` gate button refuse to advance until every pending question has an answer.
- Keep answers alive across `Refine` so a user doesn't re-answer after tweaking a plan.
- Ship with graceful degradation: a malformed `---QUESTIONS---` block logs a warning and the run proceeds as if no questions were asked.
- Zero breaking changes. Pipelines in flight at deploy time continue unaffected.

### Non-Goals

- Mid-run questions during the `generate_code` stage (Developer phase). Deferred — see D3.
- Questions during later stages (`qa_testing`, `open_mr`, etc.). Out of scope.
- Natural-language answer parsing. Users answer via radio picks only; freeform answers still go through `Refine`.
- Multi-turn dialogue with Architect. Each run produces at most one question batch; answers feed the *next* run.
- Using Claude Code's built-in `AskUserQuestion` tool. Rejected — see D4.
- Building an MCP `AskUser` tool server. Rejected — see D5.

## Decisions

### D1. Structured state over embedded-prose.

Questions live in `state.data._pending_questions` as an array of typed `PendingQuestion` objects parsed from a `---QUESTIONS---` JSON block. Answers live in `state.data._qa_answers` as typed `QuestionAnswer` objects.

**Why.** The whole point of the feature is that answers be *bound* to questions. Binding requires an id per question and an option range the UI can validate. Prose can't be validated, can't be re-rendered as a widget, and can't be passed to Developer as a stable constraint block.

**Alternatives considered.** Markdown-only (keep questions in the Architect's explore_plan output, parse nothing, let user type a refine) — rejected. That is the status quo that motivated this change.

### D2. Inline in existing `explore_plan` gate — no new pipeline stage.

The question loop lives entirely inside `explore_plan`. No new stage constant, no change to `STAGE_ORDER`, no new gate config, no new SSE event type. The only new endpoint is `POST /api/answer-questions`, which mutates `state.data` in place and broadcasts the existing `state` SSE event.

**Why.** A new `clarify_questions` stage would require: a new `STAGE_ORDER` entry, a new `STAGE_CLEARS` entry, a new approval gate config, a new UI tab, a new set of SSE transitions, and a new "what does Reject mean here" decision. The work is mechanical but broad. Extending the existing `explore_plan` gate touches one parser, one endpoint, one React panel.

**Alternatives considered.** `clarify_questions` stage between `explore_plan` and `generate_code` — rejected on cost-to-value grounds.

### D3. Tier 1 scope — Architect/Plan phase only.

Only the Architect agent (in `explore_plan`) can emit `---QUESTIONS---`. The Developer agent (in `generate_code`) cannot.

**Why.** A Developer-phase question would fire *after* the approve gate, mid-codegen. Answering it requires either pausing an in-flight `claude -p` subprocess (the CLI does not support that cleanly) or rolling back the git branch and re-running Developer after the answer lands. Both are a large surface. The plan-phase question covers the most common case (placement / shape / style decisions) at a fraction of the complexity.

**Alternatives considered.** Cover Developer phase too — deferred to a future change.

### D4. NOT Claude Code's built-in `AskUserQuestion` tool.

**Why.** `claude -p` runs non-interactively inside a subprocess. Any interactive tool call routes to the CLI's own stdin/stdout, not to the Web UI. The user on localhost:3000 would never see the prompt. Even if we proxied stdin, the gate-based architecture (SSE + `_pending_questions` field + endpoint) is the right primitive for the Web UI — not an interactive CLI prompt.

### D5. NOT an MCP `AskUser` server.

**Why.** MCP pause/wait semantics require a persistent server process, tool-exposure configuration in every Claude invocation, and a roundtrip handshake on every question. A parser that reads a JSON block out of stdout, combined with one new state field, gets 90% of the value at 10% of the complexity. The MCP option remains open if we later need richer dialogue (multi-turn, file references, etc.).

### D6. Answers persist across Refine iterations.

When the user clicks `Refine` from Plan Review, `state.data._qa_answers` is carried forward untouched. `STAGE_CLEARS[explore_plan]` clears `_pending_questions` (the new batch Architect produces replaces the old batch) but preserves `_qa_answers`.

**Why.** A user who has already confirmed "place Ledger View in tab A" should not re-answer that question after tweaking an unrelated aspect of the plan. Re-answering is user-hostile and produces no new signal.

**Alternatives considered.** Wipe `_qa_answers` on every Refine — rejected; wastes user effort and re-introduces the variance the feature exists to eliminate.

### D7. Approve blocks while questions pending; Reject and Refine do not.

The `Approve` button in `GateApproval` becomes `disabled` whenever `_pending_questions.length > 0`. `Reject` and `Refine` remain enabled regardless.

**Why.** `Approve` means "ship this plan to the Developer agent". Shipping a plan with unanswered structural questions defeats the purpose of the feature. `Reject` (abandon the ticket) and `Refine` (ask Architect to redo with different guidance) are both valid responses to a plan the user doesn't like — including a plan that asked questions the user can't answer. Blocking them would trap the user.

### D8. Graceful degradation on malformed JSON.

If `parseOpenSpecArtifacts` finds a `---QUESTIONS---` fence but the inner payload fails `PendingQuestion[]` validation, the parser:

1. Logs a `warn`-level line `"questions-block malformed, ignoring"` with the offending text.
2. Sets `_pending_questions = []`.
3. Lets `explore_plan` markdown render normally.

The pipeline must NOT throw or halt.

**Why.** A parser that can break the pipeline on agent output variance is worse than no parser. Architect output is non-deterministic. The cost of a malformed block is one iteration where the user sees no questions and falls back to the pre-feature workflow — acceptable.

### D9. Cap of 3 questions per Architect run.

The Architect prompt instructs: *"Ask at most 3 questions. More than 3 suggests the ticket itself is ambiguous — recommend the user rewrite the ticket via Refine instead."* The parser accepts up to 10 (soft cap) but logs a warning for any count in `(3, 10]` and truncates anything beyond 10.

**Why.** 3 is the discipline forcing-function. If Architect feels it needs 4+ questions, the ticket is the problem, not the plan. The parser's soft cap of 10 prevents a runaway agent from flooding the UI, without being so strict that a borderline 4-question run breaks entirely.

**Alternatives considered.** Hard cap at 3 in the parser — rejected; a rigid parser is a fragility source when the soft cap in-prompt is already enforceable socially.

### D10. "Accept all AI picks" bulk-answer button.

The `PendingQuestionsPanel` renders a single button that posts one request answering every pending question with `choice = question.recommend`. If any question has no `recommend` field, the button is disabled.

**Why.** The common case is that Architect's recommendations are fine and the user just wants to proceed. Forcing one click per question for that case is friction. The bulk button keeps the per-question radios available for the user who *does* want to override.

**Alternatives considered.** No bulk button, always one click per question — rejected; user-hostile for the common case.

## Payload Shapes

```
PendingQuestion {
  id:         string        // stable within a single Architect run, e.g. "q-ledger-placement"
  text:       string        // one-sentence question
  options:    string[]      // 2..5 entries; order is stable, UI renders in index order
  recommend:  string | null // Architect's pick, MUST match one of options; null means "no preference"
  reason:     string        // one-line justification for recommend (empty if recommend is null)
}

QuestionAnswer {
  id:         string        // matches PendingQuestion.id
  choice:     string        // the selected option string (verbatim match from options[])
  answeredAt: string        // ISO8601 timestamp
}
```

`state.data._pending_questions: PendingQuestion[]` — set by parser, cleared by `POST /api/answer-questions`.
`state.data._qa_answers:       QuestionAnswer[]`   — append-only within a ticket's life; preserved across Refine.

```
---QUESTIONS--- block wire format (Architect output, between fences):

---QUESTIONS---
[
  {
    "id": "q-ledger-placement",
    "text": "Where should the Ledger View button live?",
    "options": ["Sidebar tab", "Top toolbar", "Row-level action"],
    "recommend": "Sidebar tab",
    "reason": "matches existing GST Return nav pattern"
  }
]
---END-QUESTIONS---
```

## State Transitions

```
 [no questions yet]
       |
       | Architect run emits valid QUESTIONS block
       v
 _pending_questions = [q1, q2, q3]
 _qa_answers        = <unchanged>
       |
       | user POST /api/answer-questions with answers for all pending ids
       v
 _pending_questions = []
 _qa_answers        += [a1, a2, a3]
       |
       | user clicks Approve -> generate_code
       v
 Developer prompt sees _qa_answers as binding constraints

 --- alternate path: Refine ---
 from any state, user clicks Refine with instructions
       |
       v
 STAGE_CLEARS[explore_plan] wipes _pending_questions
 _qa_answers survive untouched
 Architect re-runs with _qa_answers as context
       |
       | may emit a new QUESTIONS block
       v
 _pending_questions = [qN...]   // ids may be fresh OR may collide with past answered ids
```

**Collision rule.** When a new Architect run produces a question whose `id` matches an entry already in `_qa_answers`, the old answer is treated as stale: on parse, any `_qa_answers` entry whose `id` is in the new `_pending_questions` id set is removed. This prevents the UI from showing "already answered" state for a question Architect re-raised (which means it is no longer satisfied with the previous answer).

## Affected Files (reference)

- `packages/agent/src/stages/explore-plan.ts` — Architect prompt gains `## When you are uncertain`; `parseOpenSpecArtifacts` gains the `---QUESTIONS---` block extractor and collision-clear logic.
- `packages/agent/src/stages/generate-code/developer.ts` — prompt gains `## User-confirmed decisions` block rendered from `_qa_answers`.
- `packages/agent/src/server/routes.ts` — new `POST /api/answer-questions` handler, body `{ ticket, answers: [{id, choice}] }`, validates id membership in `_pending_questions` and choice membership in `options`.
- `packages/agent/src/lib/constants.ts` — `STAGE_CLEARS[explore_plan]` extended to clear `_pending_questions`; `_qa_answers` is intentionally NOT in any clear set.
- `packages/frontend/src/components/PendingQuestionsPanel.tsx` — new component.
- `packages/frontend/src/components/GateApproval.tsx` — mounts the panel; disables Approve when `_pending_questions.length > 0`.
- `packages/frontend/src/store/pipeline.ts` — new `answerQuestions` action.
- `packages/shared/src/types/` — exports `PendingQuestion`, `QuestionAnswer`.

## Risks / Trade-offs

- **Agent over-uses QUESTIONS for trivia.** Architect asks "should I use camelCase or snake_case for the state key?" — noise. Mitigation: the prompt caps at 3 (D9) and requires a one-line `reason`; trivial questions feel silly to justify. Residual risk is non-zero; Reviewer still catches downstream if the user waves through junk.

- **Agent hallucinates an answer when it should have asked.** Architect confidently picks option A when the ticket didn't specify. The feature cannot force asking. Mitigation: unchanged from today — the AC Reviewer stage remains the backstop. The feature reduces the *frequency* of this failure, does not eliminate it.

- **User clicks "Accept all AI picks" without reading.** Same class of risk as a user clicking Approve on a plan without reading it. Not a new risk introduced by this change.

- **Malformed `---QUESTIONS---` JSON breaks the run.** Addressed by D8: parser logs a warning and proceeds with `_pending_questions = []`. Hard constraint — a parser bug that throws is a regression.

- **Question id collisions across Refine.** A new Architect run may re-use an id the user already answered in a previous iteration. Addressed in the collision rule above: new `_pending_questions` wins; any `_qa_answers` whose id overlaps is dropped. This means a user who already answered `q-ledger-placement` will be asked again if Architect re-raises it — that is the correct behaviour, because Architect re-raising means it's no longer confident in the prior answer.

- **Backward compatibility.** Pipelines in flight at deploy time have no `_pending_questions` field on their state. `undefined` and `[]` must both be treated as "nothing pending". Frontend renders no panel. Developer prompt renders no decisions block. No migration path needed.

- **SSE event volume.** Every answer POST broadcasts a `state` event. For a 3-question plan answered one at a time, that's 3 extra events per ticket. Negligible.

- **Answer audit trail.** `_qa_answers` is append-only within a ticket (except for the collision-clear rule). It serves as an audit log of every binding decision the user made — useful for post-mortem when a generated MR turns out wrong. Not a risk, just an incidental benefit worth noting.

## Migration / Rollout

No migration needed. The two new `state.data` fields are additive. The parser is a no-op when Architect emits no `---QUESTIONS---` fence. The Plan Review panel is absent when `_pending_questions` is empty or undefined. The Developer prompt's `## User-confirmed decisions` block is absent when `_qa_answers` is empty or undefined.

Pipelines in flight at deploy time continue unaffected — they never had the fields, they never see the panel, and their Developer runs never see the decisions block. On the next ticket they pick up, the full loop is available.

No feature flag. No staged rollout. Ship it.
