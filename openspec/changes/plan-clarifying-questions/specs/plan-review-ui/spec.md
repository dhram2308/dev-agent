## MODIFIED Requirements

### Requirement: Plan Review renders `_pending_questions` as a choice widget
When `state.data._pending_questions` is a non-empty array and the current stage is `explore_plan`, the Plan Review panel SHALL mount a `<PendingQuestionsPanel>` component ABOVE the existing plan tabs. Each pending question SHALL render as a labeled radio group: the question's `text` is the group label, each entry of `options` is a radio choice, the AI's `recommend` option is marked with a distinguishing star or indicator, and the question's `reason` (when present) is displayed underneath the options.

When `state.data._pending_questions` is empty or absent, the panel SHALL NOT render and the Plan Review UI SHALL behave exactly as it did prior to this change.

#### Scenario: Two pending questions render two radio groups
- **WHEN** `state.data._pending_questions` contains 2 entries and the stage is `explore_plan`
- **THEN** the panel renders 2 radio groups
- **AND** each radio group's label is the question's `text`
- **AND** each radio group's options correspond to the question's `options` array

#### Scenario: AI recommendation shown with indicator
- **WHEN** a pending question has `recommend` set
- **THEN** the corresponding option renders with a distinguishing indicator (e.g. star)

#### Scenario: Reason rendered under options
- **WHEN** a pending question has a non-empty `reason` string
- **THEN** the reason text is displayed directly below that question's options

#### Scenario: No pending questions, panel hidden
- **WHEN** `state.data._pending_questions` is empty or absent
- **THEN** the `<PendingQuestionsPanel>` is not rendered
- **AND** the existing Plan Review tabs render as before

### Requirement: "Accept all AI picks" bulk-answer button
The `<PendingQuestionsPanel>` SHALL include an "Accept all AI picks" button. Clicking it SHALL issue a single `POST /api/answer-questions` request with `answers = pending.map(q => ({ id: q.id, choice: q.recommend }))` for every pending question that has a defined `recommend` index.

If any pending question has `recommend` undefined, those questions SHALL be skipped (they stay in `_pending_questions`), and the button label SHALL append ` (skips N questions without a suggestion)` where `N` is the count of skipped questions.

#### Scenario: All AI picks applied in one click
- **WHEN** all pending questions have `recommend` defined and the user clicks "Accept all AI picks"
- **THEN** a single `POST /api/answer-questions` is sent with one `{id, choice}` per pending question using each question's `recommend`
- **AND** on success all pending questions move to `_qa_answers`

#### Scenario: Questions without a recommendation are skipped
- **WHEN** 2 of 5 pending questions have `recommend` undefined
- **THEN** the button label includes ` (skips 2 questions without a suggestion)`
- **AND** clicking the button sends answers only for the 3 recommended questions
- **AND** the 2 un-recommended questions remain in `_pending_questions`

### Requirement: Approve button disabled while questions pending
The `Approve` button inside `GateApproval` for the `explore_plan` gate SHALL be disabled whenever `state.data._pending_questions.length > 0`. The `Reject` and `Refine` buttons on the same gate SHALL remain enabled regardless of whether questions are pending.

#### Scenario: Pending questions disable Approve only
- **WHEN** `state.data._pending_questions.length > 0`
- **THEN** the `Approve` button is disabled
- **AND** the `Reject` button is enabled
- **AND** the `Refine` button is enabled

#### Scenario: Approve re-enabled when all questions answered
- **WHEN** every pending question has been answered and `state.data._pending_questions.length === 0`
- **THEN** the `Approve` button is enabled

#### Scenario: Reject works with pending questions
- **WHEN** questions are pending and the user clicks `Reject`
- **THEN** the reject flow runs normally as specified elsewhere in `plan-review-ui`

#### Scenario: Refine works with pending questions and preserves answers
- **WHEN** questions are pending and the user clicks `Refine`
- **THEN** the refine flow runs normally
- **AND** previously accepted answers persist in `state.data._qa_answers` per the `clarifying-questions` capability
