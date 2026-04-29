# Tasks: plan-clarifying-questions

## 1. Shared types

- [x] \1 In `packages/shared/src/types/codegen.ts`, add `PendingQuestion` interface with fields: `id: string`, `text: string`, `options: string[]`, `recommend?: number`, `reason?: string`, `stage: string`, `ts: number`
- [x] \1 In the same file, add `QuestionAnswer` interface with fields: `id: string`, `choice: number`, `optionText: string`, `via: 'user' | 'ai-default'`, `ts: number`
- [x] \1 In `packages/shared/src/types/state.ts` (or wherever `PipelineData` lives — likely `types/index.ts`), add `_pending_questions?: PendingQuestion[]` and `_qa_answers?: QuestionAnswer[]` to the `PipelineData` interface
- [x] \1 Export `PendingQuestion` + `QuestionAnswer` from the shared barrel
- [x] \1 Run `cd packages/shared && npx tsc --noEmit && npx vitest run` — passes

## 2. Constants — STAGE_CLEARS

- [x] \1 In `packages/agent/src/lib/constants.ts`, add `_pending_questions` and `_qa_answers` to the `explore_plan` entry of `STAGE_CLEARS` so a fresh run of the Architect also clears them. Carefully review: `_qa_answers` should NOT be cleared on Refine, per spec. Add a note that the clear only happens on stage RESTART from `fetch_ticket`, not on Refine
- [x] \1 Verify by grep: `STAGE_CLEARS.explore_plan` includes both new fields
- [x] \1 Wire an explicit "do not clear on refine" check in `stages/explore-plan.ts` where Refine clears other fields — `_qa_answers` is preserved

## 3. Architect prompt — QUESTIONS block format

- [x] \11 In `packages/agent/src/stages/explore-plan.ts`, locate the Architect agent prompt (the main prompt that generates OpenSpec artifacts)
- [x] \12 Append a new `## When you are uncertain` section. Document the `---QUESTIONS---` fenced JSON block format with an example 2-question payload
- [x] \13 Instruct the agent: max 3 questions, only when the answer changes which files/UX/data are touched, not for cosmetic preferences, always include a `recommend` index and a one-line `reason`
- [x] \14 Include guidance that if `_qa_answers` is already populated (prior refine), the agent SHOULD NOT re-ask those questions but MAY ask new ones

## 4. Parser — extract `---QUESTIONS---` block

- [x] \11 In `packages/agent/src/stages/explore-plan.ts` in `parseOpenSpecArtifacts`, extend the regex-set to also capture a `---QUESTIONS---` block ending at `---END---` or end-of-output
- [x] \12 Parse the block with `JSON.parse` inside a try/catch. On parse error, `logWarn('[parser] malformed QUESTIONS block: …'); return []`
- [x] \13 Validate each entry: must have non-empty string `id`, non-empty string `text`, `options` array length ≥ 2 with all-string entries. Entries failing validation are dropped with a warning. Optional fields `recommend` (coerce to number if present), `reason` (string)
- [x] \14 Log a warning when the accepted-entry count exceeds 3 (soft cap)
- [x] \15 Annotate each accepted question with `stage: 'explore_plan'` and `ts: Date.now()` before returning
- [x] \16 In the caller, after artifacts are parsed, assign `state.data._pending_questions = parsedQuestions || []`
- [x] \17 On refine entry (where `_refine_instructions` is set), for each entry in `parsedQuestions`, if `state.data._qa_answers` already has a matching `id`, REMOVE that stale answer so the user re-answers — per spec Requirement "Answers persist across Refine iterations"

## 5. API endpoint — `POST /api/answer-questions`

- [x] \11 In `packages/agent/src/server/routes.ts`, add a new handler for `POST /api/answer-questions` near the other `/api/*` endpoints
- [x] \12 Validate `ticket` via `safeTicket`; return 400 on invalid
- [x] \13 Parse body (using the existing `parseBody` helper with a reasonable byte limit — suggest 10 KB)
- [x] \14 Validate `answers` is an array of `{id, choice}`. Each `id` must exist in `state.data._pending_questions`; each `choice` must be `>= 0` and `< options.length` for that question. Return 400 with a precise error message naming the offending entry on failure
- [x] \15 On success: for each answer, lookup the pending question, compute `optionText = question.options[choice]`, append `{id, choice, optionText, via: 'user', ts: Date.now()}` to `state.data._qa_answers`
- [x] \16 Remove answered entries from `state.data._pending_questions` (keep unanswered ones — partial answer is allowed per spec)
- [x] \17 Save state and broadcast `state` SSE event
- [x] \18 Return 200 with `{ok: true, remaining: state.data._pending_questions.length}`

## 6. Developer prompt — binding decisions

- [x] \11 In `packages/agent/src/stages/generate-code/developer.ts`, at the top of each prompt-building branch (parallel group agents + single agent + retry), compute a `decisionsBlock` string from `state.data._qa_answers`
- [x] \12 If empty, `decisionsBlock = ''`. If non-empty, format as:
```
## User-confirmed decisions
- <question text>: "<chosen option text>"  (AI's original reason: <reason>)
- ...
Use these decisions as binding constraints. Do not re-derive them.
```
- [x] \13 Append `decisionsBlock` to every Developer prompt (parallel + single + retry)
- [x] \14 Also append `decisionsBlock` to Reviewer, AC-Verifier, and any Fixer prompts that re-derive implementation choices — they should see user decisions too, so they don't flag correctly-answered items as wrong

## 7. Frontend — store action

- [x] \11 In `packages/frontend/src/store/pipeline.ts`, add an `answerQuestions(ticket, answers)` action that `POST`s to `/api/answer-questions` and relies on the trailing SSE `state` event to refresh
- [x] \12 Add a selector `usePendingQuestions(ticket)` that reads `state.data._pending_questions` for the active (or passed) ticket
- [x] \13 Add `acceptAllAIPicks(ticket)` — convenience that calls `answerQuestions` with `pending.filter(q => q.recommend != null).map(q => ({id: q.id, choice: q.recommend}))`

## 8. Frontend — `<PendingQuestionsPanel>` component

- [x] \11 Create `packages/frontend/src/components/PendingQuestionsPanel.tsx`
- [x] \12 Read pending questions via `usePendingQuestions(ticket)`. Return `null` if zero
- [x] \13 Render a styled container (warning-muted background, similar to existing `styles.suggestions` in GateApproval)
- [x] \14 Title: "Decisions needed (N)" with a warning color
- [x] \15 For each question: label = `text`; choices = `options` rendered as a radio group (native `<input type="radio" name="q_<id>">`); the `recommend` index is decorated with `⭐ AI suggests`; `reason` shown below the options in italic
- [x] \16 Per-question "Save" button sends a single-answer request; whole-panel "Accept all AI picks" button sends bulk via `acceptAllAIPicks`. If any question has `recommend: undefined`, the bulk button footer shows `(skips N questions without a suggestion)`
- [x] \17 After submit, the trailing SSE `state` event naturally re-renders — the question(s) disappear when answered. No local state needed

## 9. Frontend — wire panel into GateApproval

- [x] \11 In `packages/frontend/src/components/GateApproval.tsx`, import `PendingQuestionsPanel` and mount it ABOVE the Plan content block when `config.showPlan === true` and active ticket's `_pending_questions?.length > 0`
- [x] \12 Compute `hasPendingQuestions = (data._pending_questions?.length ?? 0) > 0`
- [x] \13 Disable the Approve button when `hasPendingQuestions === true`. Leave Reject and Refine enabled
- [x] \14 Add an inline hint under the Approve button when disabled: "Answer pending questions to approve"

## 10. Tests

- [x] \1 Unit test the parser in a new `packages/agent/tests/explore-plan-questions.test.ts`:
  - Well-formed block with 2 questions → returns 2 entries with correct fields
  - Malformed JSON → returns `[]` + warning logged
  - Missing required fields → entry dropped with warning
  - No `---QUESTIONS---` block → returns `[]`
  - 5 questions → all 5 returned, 1 warning for soft cap
- [ ] 10.2 Unit test the `/api/answer-questions` endpoint (can co-locate in `packages/agent/tests/routes-answer-questions.test.ts` or extend an existing routes test file):
  - Valid full-answer payload → 200, state updated, pending cleared
  - Unknown id → 400 naming the bad id
  - Out-of-range choice → 400
  - Partial answers → 200, remaining reflects unanswered
  - Missing ticket → 400
- [x] \1 Frontend test `packages/frontend/tests/PendingQuestionsPanel.test.tsx`:
  - Renders one radio group per question
  - Shows "AI suggests" marker on the `recommend` option
  - Clicking "Accept all AI picks" POSTs with correct body shape
  - Skip-count footer appears when any question lacks a `recommend`
- [ ] 10.4 Frontend test extension `packages/frontend/tests/GateApproval.test.tsx` (new cases):
  - Approve disabled when pending questions exist
  - Approve re-enabled when all answered

## 11. Docs

- [x] \1 Update `memory/MEMORY.md` with a one-line pointer: Plan phase now supports structured AI→user questions
- [ ] 11.2 Add a section to `memory/webui-diff-viewer.md` (or a new `memory/clarifying-questions.md` referenced from MEMORY.md) describing the QUESTIONS block format, state fields, and UI flow
- [ ] 11.3 Add a paragraph to `memory/openspec-workflow.md` noting that Architect agent may now emit a `---QUESTIONS---` block that renders as choice widgets in the Plan Review gate

## 12. Verification

- [x] \1 `cd packages/shared && npx vitest run` — all pass
- [x] \1 `cd packages/agent && npx vitest run` — new parser + endpoint tests pass, no regressions
- [x] \1 `cd packages/frontend && npx vitest run` — new panel tests pass, no regressions
- [x] \1 All packages: `npx tsc --noEmit` clean
- [ ] 12.5 Manual: start pipeline on a ticket; inject a prompt that forces the Architect to emit a QUESTIONS block; open Web UI; verify the panel renders above the tabs, Approve is disabled, radio groups work, "Accept all AI picks" sends correct payload, answering re-enables Approve, Developer prompt in logs shows the decisions block
- [ ] 12.6 Manual: click Refine after answering questions; observe that `_qa_answers` persist across the re-run; new Architect run with same-id question clears the stale answer; new Architect run with different ids keeps the old answers visible

## 13. Archive

- [ ] 13.1 After manual sign-off on 12.5 and 12.6, run `openspec archive plan-clarifying-questions`
