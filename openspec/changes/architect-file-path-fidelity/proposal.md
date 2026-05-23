# Proposal: architect-file-path-fidelity

## Problem

The OpenSpec Architect Agent produces `tasks.md` that references file paths the Architect imagined rather than verified against the repo. The Developer Agent then burns its turn budget on filesystem exploration trying to locate (or fail to locate) those paths, leaving no turns for actual implementation. The same unverified plan is then handed to the Reviewer Agent for its "Plan Compliance" check (reviewer.ts:51), which forces the reviewer to reconcile architect-fiction with developer-reality — burning its own turn budget on disambiguation.

**Observed on AUT-7121 (2026-05-21) — Developer Agent side:**

- Architect produced 12-section `tasks.md`. Sample referenced paths:
  - `EditInvoiceDrawer/index.tsx` — does NOT exist anywhere in the repo.
  - `AddLineItem.tsx` — exists in 3 different locations (ambiguous).
  - `libs/constants/src/models/invoiceCorrectionContract.ts` — does NOT exist (to be created, but not flagged as CREATE).
  - `libs/constants/src/models/invoiceFieldConfig.ts` — does NOT exist (to be created, not flagged).
- 4 parallel Developer Agents ran 6+ minutes each at `maxTurns: 75` (300 total turn budget).
- **0 files modified, 0 files created** at exit. Every agent hit max-turns without writing anything.
- Strong inference: agents spent turns on Grep / Glob / Read trying to locate non-existent files and disambiguate between candidates.

**Observed on AUT-8648 (2026-05-22) — Reviewer Agent side:**

- Stage `generate_code` failed during the Review Team phase, not the Developer phase. The Developer wrote files successfully; the Reviewer then hit `maxTurns: 15` (now raised to 50 via `REVIEWER_MAX_TURNS`).
- Reviewer prompt at `reviewer.ts:42-58` includes both:
  - `## Approved Plan` (truncated to 8000 chars) — contains the architect's unverified paths.
  - `## Changed files` — the actual files the Developer modified (verified, from git diff).
- For check #6 "Plan Compliance" (line 51), the reviewer must map architect-imagined paths to developer-actual paths. When those don't line up, the reviewer Greps/Globs the repo trying to figure out what corresponds to what — same exploration churn as the Developer.
- Same root cause, different agent.

## Root cause

The Architect prompt does not require:
1. Verifying that each referenced path actually exists in the local repo (via Grep / Glob during architect's own run).
2. Annotating each path as `[MODIFY]` vs `[CREATE]` so the Developer doesn't waste turns reading files that don't exist yet.
3. Using fully-qualified repo-relative paths (no bare `EditInvoiceDrawer/index.tsx` — must be `libs/<lib>/src/lib/<feature>/EditInvoiceDrawer/index.tsx`).

The Developer prompt then trusts the plan literally and burns turns reconciling fiction with filesystem reality. The Reviewer downstream inherits the same fiction — its "Plan Compliance" check (reviewer.ts:51) compels it to map plan paths to actual paths, which it can't do without filesystem exploration when paths don't match.

## Solution sketch (not yet designed in detail)

Modify the Architect prompt and/or post-processing step to:
1. **Path verification pass** — before emitting `tasks.md`, the Architect resolves each referenced path: exists / does not exist / ambiguous (multiple matches).
2. **Path annotations** — each file reference in `tasks.md` carries `[CREATE]` (new file), `[MODIFY: <full-path>]` (existing file with verified path), or `[CHOOSE: <path1> | <path2>]` (ambiguous — explicit choice required).
3. **Folder anchor requirement** — every path is repo-relative from project root (e.g., `libs/entp/src/lib/...`), never bare filenames.
4. Optional: pre-build a small "repo map" (lib + entry-point listing) and inject into the Architect prompt as ground truth.

The Developer side then gets unambiguous instructions and can go directly to Write / Edit without exploration. The Reviewer side gets two aligned inputs (architect's verified paths AND developer's `changedFilesList`) — Plan Compliance becomes a set-comparison instead of a Grep hunt.

5. **Optional reviewer-side hardening** — once architect emits verified paths, augment the reviewer prompt with an explicit mapping section (e.g., `## Plan → Implementation map: <path-from-plan> → <path-in-changed-files>`) computed at prompt-build time in `reviewer.ts`. This eliminates the reconciliation step entirely. Defer until the architect-side fix is validated; if architect output is clean, this may be unnecessary.

## Scope

- One file edited: `packages/agent/src/stages/explore-plan.ts` (Architect prompt section that emits tasks.md).
- Possibly one helper added: a path-verification step the Architect runs before sealing the plan.
- No changes to Developer prompt — it consumes the new annotations automatically.
- No changes to Reviewer prompt initially; revisit only if check #6 still produces exploration churn after architect-side fix lands.

## Out of scope

- Bumping `DEVELOPER_MAX_TURNS` / `REVIEWER_MAX_TURNS` / `FIXER_MAX_TURNS` further as a workaround. The root issue is plan fidelity, not budget — these env knobs are stop-gaps and were raised to 75 / 50 / 50 respectively while this proposal is pending.
- Reducing parallel cap or task-group size. Bundling already works (`developer.ts` bundles 12 → 4 groups for AUT-7121).
- Vision/screenshot-based plan generation.

## Evidence trail

- AUT-7121 (Developer side): `agent-AUT-7121.log` runs at `2026-05-21T11:14:49Z`, `11:57:08Z`, `12:22:46Z` — all 4 Dev Agents hit max-turns 75 with 0 file changes.
- AUT-7121 plan artifacts: `packages/agent/openspec/changes/aut-7121/tasks.md` (12 H2 sections, paths listed above).
- AUT-7121 repo cache state at time of failure: `cd packages/agent/dist/.repo-cache && git status -s` returned empty.
- AUT-8648 (Reviewer side, 2026-05-22): stage `generate_code` failed with `[Review Team] Required agent(s) failed: Reviewer Agent. Claude CLI error (1): Error: Reached max turns (15)`. Recovery exhausted 2 retries. The Developer succeeded; the Reviewer ran against the architect's plan + the developer's changed files and burned its budget.

## Acceptance criteria

- For any ticket the Architect runs against, ≥95% of paths in `tasks.md` either resolve to an existing file or carry `[CREATE]`.
- Bare filenames (no `/`) appear in `tasks.md` only inside prose, never as a target path.
- Re-running AUT-7121 with the new Architect output produces ≥1 file change per Dev Agent within the default `DEVELOPER_MAX_TURNS=25` budget (i.e., the env override should no longer be necessary).
- Re-running AUT-8648 with the new Architect output completes the Review Team phase within the default `REVIEWER_MAX_TURNS=15` budget.
