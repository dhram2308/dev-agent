## ADDED Requirements

### Requirement: Development Mode preset for gate auto-approval
The system SHALL provide a "Development Mode" setting with values `auto` and `plan` that, when changed, writes the existing `AUTO_APPROVE_EXPLORE_PLAN` and `AUTO_APPROVE_GATE_CODE_REVIEW` configuration keys to `always` or `manual` respectively, and SHALL NOT modify `AUTO_APPROVE_GATE_PREPROD_APPROVAL` or `AUTO_APPROVE_GATE_DUAL_APPROVAL` under any Development Mode value.

#### Scenario: Setting Development Mode to auto
- **WHEN** the operator sets Development Mode to `auto` and saves
- **THEN** `AUTO_APPROVE_EXPLORE_PLAN` and `AUTO_APPROVE_GATE_CODE_REVIEW` are set to `always`, and the two production gate keys are left unchanged

#### Scenario: Setting Development Mode to plan
- **WHEN** the operator sets Development Mode to `plan` and saves
- **THEN** `AUTO_APPROVE_EXPLORE_PLAN` and `AUTO_APPROVE_GATE_CODE_REVIEW` are set to `manual`, and the two production gate keys are left unchanged

#### Scenario: Production gates remain independently configurable
- **WHEN** Development Mode is set to `auto`
- **THEN** the operator can still independently set `AUTO_APPROVE_GATE_PREPROD_APPROVAL` or `AUTO_APPROVE_GATE_DUAL_APPROVAL` to any of their existing values without Development Mode overriding that choice

### Requirement: Development Advance Mode selects the planning path
The system SHALL provide a global `DEVELOPMENT_ADVANCE_MODE` setting with values `direct` and `openspec`, defaulting to `openspec`, that determines whether the `explore_plan` stage scaffolds formal OpenSpec artifacts or produces a plain-text plan.

#### Scenario: Default behavior is unchanged
- **WHEN** `DEVELOPMENT_ADVANCE_MODE` has never been explicitly set
- **THEN** the pipeline behaves exactly as it did before this feature: `explore_plan` unconditionally scaffolds OpenSpec artifacts

#### Scenario: OpenSpec mode produces the four structured artifacts
- **WHEN** a ticket's `advanceMode` resolves to `openspec`
- **THEN** the `explore_plan` stage scaffolds an OpenSpec change and produces proposal, design, specs, and tasks artifacts as it does today

#### Scenario: Direct mode skips OpenSpec scaffolding
- **WHEN** a ticket's `advanceMode` resolves to `direct`
- **THEN** the `explore_plan` stage does not invoke the OpenSpec scaffold, produces a plain-text implementation plan via the existing planning agent, and records no OpenSpec artifacts for that ticket

### Requirement: Advance Mode is seeded once per ticket and is immutable thereafter
The system SHALL determine a ticket's advance mode exactly once, during that ticket's `fetch_ticket` stage, and SHALL NOT re-evaluate or change it for that ticket on subsequent stages, resumes, or restarts, even if the global setting changes afterward.

#### Scenario: Global setting change does not affect an in-flight ticket
- **GIVEN** a ticket has already passed its `fetch_ticket` stage with `advanceMode` set to `openspec`
- **WHEN** the global `DEVELOPMENT_ADVANCE_MODE` setting is later changed to `direct`
- **THEN** the in-flight ticket continues to use `openspec` mode for the remainder of its run, including across any resume

#### Scenario: Pre-existing tickets default safely
- **GIVEN** a ticket's state was created before this feature existed and has no advance-mode value recorded
- **WHEN** that ticket reaches `explore_plan`
- **THEN** it is treated as `openspec` mode, matching its original unconditional behavior

### Requirement: Downstream stages are unaffected by Advance Mode
The system SHALL ensure that no pipeline stage other than `explore_plan` behaves differently based on Advance Mode; all stages from `generate_code` through `done` SHALL treat the plan produced by `explore_plan` identically regardless of which mode produced it.

#### Scenario: Code generation proceeds identically from either plan
- **WHEN** `generate_code` begins with a plan produced under either `direct` or `openspec` mode
- **THEN** it reads the plan as plain text and proceeds without requiring OpenSpec-specific structure to be present

#### Scenario: Code generation falls back gracefully when structure is absent
- **WHEN** a `direct`-mode plan does not contain the heading structure normally used to split work across parallel code-generation agents
- **THEN** code generation proceeds via its existing single-agent fallback path rather than failing

### Requirement: UI reflects the active mode at the point of decision
The system SHALL visibly indicate the active Development Mode and Advance Mode at each gate where a human decision is made, and SHALL NOT display OpenSpec-specific content (tabs, artifact references) for a ticket running in Direct mode.

#### Scenario: Governance indicator shown on every gate
- **WHEN** any gate is awaiting approval
- **THEN** the gate view displays whether that gate's approval policy is currently automatic or manual

#### Scenario: Plan-mode indicator shown at the explore_plan gate
- **WHEN** the `explore_plan` gate is awaiting approval
- **THEN** the gate view displays whether the ticket is running in Direct or OpenSpec mode, and the gate's description text accurately reflects which artifacts (if any) were produced

#### Scenario: OpenSpec tabs do not render for a Direct-mode ticket
- **WHEN** the `explore_plan` gate is awaiting approval for a ticket running in Direct mode
- **THEN** no OpenSpec proposal/design/specs/tasks tabs are rendered
