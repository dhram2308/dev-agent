# MI Dev Agent — Complete Pipeline Flow Diagram

> Generated 2026-04-07. Covers every stage, condition, branch, retry, and external call in `run-agent.js`.

---

## Master Pipeline Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        STARTUP / main()                         │
├─────────────────────────────────────────────────────────────────┤
│  1. --reset flag? ──yes──▶ Delete state file                   │
│  2. claude CLI installed? ──no──▶ EXIT(1)                      │
│  3. validateConfig() — JIRA_TOKEN, GITLAB_TOKEN etc.           │
│  4. .env file perms check (S2)                                 │
│  5. Init HMAC secret (CR5)                                     │
│  6. Validate Jira token ──401/403──▶ EXIT(1)                   │
│  7. Validate GitLab token ──401/403──▶ EXIT(1)                 │
│  8. Warn if owner==anshit (E7)                                 │
│  9. Resolve email-based Jira IDs (C4)                          │
│ 10. Clone/update local repo cache                              │
│ 11. Lock file (D2) ──already locked──▶ EXIT(1)                 │
│ 12. loadState() — HMAC verify (Fix 7)                          │
│ 13. Ticket mismatch check (R4)                                 │
│ 14. Invalid stage? ──yes──▶ Reset to fetch_ticket              │
│                                                                 │
│  ┌──────── MAIN LOOP (while stage != "done") ────────┐        │
│  │  Pipeline duration > 24h? ──yes──▶ Slack + EXIT(1) │        │
│  │  Unknown handler? ──yes──▶ EXIT(1)                  │        │
│  │  W1: Validate required state fields (warn-only)     │        │
│  │  W2: deploy_prod? Validate ALL 9 gates completed    │        │
│  │  try { await handler(state) }                       │        │
│  │  catch → log error, save, EXIT(1)                   │        │
│  │  finally → record metrics, add to _completedGates   │        │
│  └─────────────────────────────────────────────────────┘        │
│  await stageDone(state)                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Stage 1: `fetch_ticket`

```
┌─────────────────── STAGE 1: fetch_ticket ───────────────────┐
│                                                              │
│  ┌─ Phase A: Pre-flight (Q3) ─── guard: !_preflight_done    │
│  │                                                           │
│  │  Fetch ticket from Jira                                   │
│  │  │                                                        │
│  │  ├─ status == done/closed/cancelled?                      │
│  │  │  └─ YES ──▶ Slack alert + THROW (halt)                │
│  │  │                                                        │
│  │  ├─ Check GitLab for existing branch                      │
│  │  │   enterprise-ts-{TICKET}                               │
│  │  │  └─ exists? → _preflight_existing_branch = true        │
│  │  │                                                        │
│  │  ├─ Check GitLab for existing open MR                     │
│  │  │  └─ exists? → _preflight_existing_mr = {iid, url}     │
│  │  │                                                        │
│  │  ├─ Check parent task (Q4)                                │
│  │  │  └─ parent has feature branch?                         │
│  │  │     → parentBranch = enterprise-ts-{parentKey}         │
│  │  │                                                        │
│  │  ├─ Fetch Jira transitions (X3)                           │
│  │  │                                                        │
│  │  └─ _preflight_done = true                                │
│  │                                                           │
│  ├─ Phase B: Full Context Gathering                          │
│  │  Re-fetch issue                                           │
│  │  Extract: summary, description (ADF→MD), type, priority  │
│  │  Try 3 custom fields for AC                               │
│  │  │                                                        │
│  │  └─ AC missing? → ac_missing = true, warn                 │
│  │                                                           │
│  ├─ Phase C: Parent epic context (Layer 4)                   │
│  │  issue.fields.parent exists?                              │
│  │  └─ YES → fetch parent, store in ticket.parent            │
│  │                                                           │
│  ├─ Phase D: Comments (Layer 2)                              │
│  │  Fetch all comments → ADF→MD + extract URLs               │
│  │  Cap at MAX_TOTAL_COMMENTS (100)                          │
│  │                                                           │
│  ├─ Phase E: Linked issues (Layer 3)                         │
│  │  Fetch in parallel batches of 5                           │
│  │  Store: key, relationship, direction, summary, desc       │
│  │                                                           │
│  ├─ Phase F: Attachments (Layer 5)                           │
│  │  Cap at MAX_TOTAL_ATTACHMENTS (20)                        │
│  │  ├─ Text/JSON/XML < 500KB? → download + truncate 100K    │
│  │  ├─ Binary? → skip (L1)                                   │
│  │  └─ Image + ANTHROPIC_API_KEY? → Vision API (Q2, max 5)  │
│  │                                                           │
│  ├─ Phase G: URL Extraction (Layer 6)                        │
│  │  Walk ADF tree for desc, AC, comments                     │
│  │  Deduplicate, filter internal Jira URLs                   │
│  │                                                           │
│  ├─ Phase H: Fetch External URLs (Layer 7)                   │
│  │  Filter: Figma/GDocs/private IPs → skip (SSRF)           │
│  │  Parallel batches, 2min timeout, 500KB total cap          │
│  │  Q1: Detect 401/403 auth-required URLs                    │
│  │                                                           │
│  └─ Phase I: Final                                           │
│     X7: Classify ticket complexity                           │
│     state.stage = "explore_plan"                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Stage 1b: `explore_plan`

```
┌────────────────── STAGE 1b: explore_plan ───────────────────┐
│  Required: ticket                                            │
│                                                              │
│  ┌─ Phase A: Missing AC (F5) ── guard: ac_missing &&        │
│  │                                      !_ac_wait_done       │
│  │  Post Jira comment + Slack asking for AC                  │
│  │  ┌─ POLL LOOP (every 30s) ──────────────────────┐        │
│  │  │  "continue" comment found?                    │        │
│  │  │  ├─ YES → re-fetch ticket                     │        │
│  │  │  │   ├─ AC now exists → update ticket.ac      │        │
│  │  │  │   └─ Still empty → warn, proceed anyway    │        │
│  │  │  │                                             │        │
│  │  │  └─ TIMEOUT (2h) → proceed without AC, warn   │        │
│  │  └──────────────────────────────────────────────┘        │
│  │  _ac_wait_done = true                                     │
│  │                                                           │
│  ┌─ Phase B: Inaccessible Docs (Q1) ── guard:              │
│  │                                !explore_docs_checked      │
│  │  Classify URLs: Figma, GDocs, auth-required, etc.        │
│  │  Check unparseable attachments (pdf, docx...)             │
│  │  Sort by criticality (CRITICAL > HIGH > MEDIUM)           │
│  │  │                                                        │
│  │  └─ Inaccessible docs found?                              │
│  │     ├─ NO → skip                                          │
│  │     └─ YES → Post Jira (paste instructions) + Slack      │
│  │        ┌─ POLL LOOP ──────────────────────────┐           │
│  │        │  "continue" found?                    │           │
│  │        │  ├─ YES → collect new comments        │           │
│  │        │  │   ├─ G11: comments but no content? │           │
│  │        │  │   │   └─ re-prompt, resume waiting │           │
│  │        │  │   └─ has content → store in         │           │
│  │        │  │       ticket.supplementaryDocs      │           │
│  │        │  └─ TIMEOUT (2h) → proceed anyway      │           │
│  │        └──────────────────────────────────────┘           │
│  │  explore_docs_checked = true                              │
│  │                                                           │
│  ┌─ Phase C: Agent Exploration ── guard: !explore_plan       │
│  │                                                           │
│  │  Build repo tree (local or GitLab API)                    │
│  │  Filter source files → keyword match                      │
│  │  ├─ 0 matches? (H17) → fallback: first 50 files          │
│  │  └─ GQ6: Always include tsconfig, vite.config, eslint    │
│  │                                                           │
│  │  ┌─ Agent 1: Analysis ── guard: !_agent_analysis          │
│  │  │  Claude CLI: maxTurns=20, tools=[Read,Grep,Glob]      │
│  │  │  Timeout: 5 min                                        │
│  │  │  Validate: H15 (min 50 chars), W7 (non-empty)         │
│  │  │  → _agent_analysis = result                            │
│  │  │                                                        │
│  │  └─ Agent 2: Architect                                    │
│  │     Input: analysis (cap 16K) + ticket summary + AC       │
│  │     Timeout: 5 min                                        │
│  │     Validate: H15, W7                                     │
│  │     → explore_plan = result                               │
│  │                                                           │
│  ┌─ Phase D: Plan Rejection Tracking (Z7) ──────────────    │
│  │  planFeedback exists AND _plan_was_posted_before?         │
│  │  ├─ NO → skip                                             │
│  │  └─ YES → _plan_rejections++                              │
│  │     └─ >= MAX_PLAN_REJECTIONS (5)?                        │
│  │        └─ YES → Slack + THROW (halt)                      │
│  │                                                           │
│  ┌─ Phase E: Post Plan ── guard: !explore_plan_posted        │
│  │  → Jira comment + Slack notification                      │
│  │  → explore_plan_posted, explore_plan_at,                  │
│  │    _plan_was_posted_before = true                         │
│  │                                                           │
│  ┌─ Phase F: Wait for Approval ── POLL LOOP                 │
│  │                                                           │
│  │  Timeout > 8h? → EXIT(1)                                  │
│  │  │                                                        │
│  │  ├─ Web UI check ─────────────────────────────────        │
│  │  │  ├─ APPROVED → stage = "generate_code", return         │
│  │  │  └─ REJECTED                                           │
│  │  │     → Clear ALL STAGE_CLEARS.explore_plan fields       │
│  │  │       (includes _agent_analysis, explore_plan,         │
│  │  │        explore_plan_posted, codeChanges, etc.)         │
│  │  │     → ticket.planFeedback = feedback                   │
│  │  │     → RECURSIVE: stageExplorePlan(state)               │
│  │  │                                                        │
│  │  ├─ Jira comment check ───────────────────────────        │
│  │  │  ├─ "approved" → collect extra comments as context     │
│  │  │  │   → stage = "generate_code", return                 │
│  │  │  └─ "rejected"                                         │
│  │  │     → Clear ALL STAGE_CLEARS.explore_plan fields       │
│  │  │     → ticket.planFeedback = feedback                   │
│  │  │     → RECURSIVE: stageExplorePlan(state)               │
│  │  │                                                        │
│  │  └─ Sleep 30s                                             │
│  │                                                           │
└──────────────────────────────────────────────────────────────┘
```

---

## Stage 2-3: `generate_code` (THE BIG ONE — ~1700 lines)

```
┌────────────── STAGE 2-3: generate_code ─────────────────────┐
│  Required: ticket, explore_plan                              │
│                                                              │
│  ┌─ GUARDS ──────────────────────────────────────────────    │
│  │  _codegen_rejections >= 3? → Slack + THROW                │
│  │  R6: mode changed (local↔legacy)? → clear previous code  │
│  │  Skip shortcut: codeChanges && !feedback && plan?         │
│  │  └─ YES → jump to pushCodeToGitLab()                     │
│  │                                                           │
│  ═══════════════ LOCAL REPO PATH ════════════════════════    │
│  │                                                           │
│  ┌─ Phase B: Checkpoint Recovery (D10) ─────────────────    │
│  │  _dev_complete && _reviewed && _fixed?                    │
│  │  └─ YES → extract git changes → push → reset → return    │
│  │                                                           │
│  ┌─ Phase C: Developer Agent ── guard: !_dev_complete        │
│  │  Reset local repo to enterprise-ts                        │
│  │  Claude: maxTurns=25, tools=[Read,Write,Edit,Grep,Glob]  │
│  │  Timeout: 7 min                                           │
│  │  │                                                        │
│  │  ├─ W7: Empty output? → error                             │
│  │  ├─ W8: Safety refusal? → error                           │
│  │  ├─ GQ7: Validate all relative imports resolve            │
│  │  ├─ F3: Forbidden paths? (.git, node_modules, etc.)       │
│  │  │   └─ YES → THROW                                      │
│  │  │                                                        │
│  │  ├─ _dev_complete = true                                  │
│  │  ├─ Extract changes via git diff                          │
│  │  │                                                        │
│  │  └─ 0 changes?                                            │
│  │     ├─ Retry with simplified prompt                       │
│  │     └─ Still 0? (F6) → Slack + Jira + EXIT(1)            │
│  │                                                           │
│  ┌─ Phase D: Reviewer + Security ── guard: !_reviewed        │
│  │  ┌──────────────────────────────────────────┐             │
│  │  │         Promise.all (PARALLEL)           │             │
│  │  │  ┌──────────┐    ┌──────────────┐       │             │
│  │  │  │ Reviewer  │    │  Security    │       │             │
│  │  │  │ Agent     │    │  Agent       │       │             │
│  │  │  │ maxT=10   │    │  maxT=10     │       │             │
│  │  │  │ 5min      │    │  5min        │       │             │
│  │  │  │ PASS/FAIL │    │  PASS/FAIL   │       │             │
│  │  │  └──────────┘    └──────────────┘       │             │
│  │  └──────────────────────────────────────────┘             │
│  │  _reviewed = true                                         │
│  │                                                           │
│  ┌─ Phase E: Fixer Agent ── condition: review OR             │
│  │                          security FAILED                  │
│  │  X5: Categorize by type + priority                        │
│  │  Claude: maxTurns=20, tools=[Read,Write,Edit,Grep,Glob]  │
│  │  Timeout: 7 min                                           │
│  │  ├─ F7: Fixer fails? → THROW (never use unfixed code)    │
│  │  ├─ _fixed = true                                         │
│  │  └─ Re-extract changes                                    │
│  │  (if both passed → _fixed = true, skip Fixer)            │
│  │                                                           │
│  ┌─ Phase F: Build Verification (Q5) ── guard:              │
│  │               RUN_BUILD_CHECK && !_build_checked          │
│  │                                                           │
│  │  Ensure node_modules (npm install)                        │
│  │  ├─ npx tsc --noEmit → _build_tsc (PASS/FAIL)            │
│  │  ├─ ESLint on changed files → _build_eslint              │
│  │  │                                                        │
│  │  └─ Build errors AND !_build_fix_attempted?               │
│  │     └─ YES → Build Fixer Agent → re-extract changes      │
│  │  _build_checked = true                                    │
│  │                                                           │
│  ┌─ Phase G: Runtime Testing ── guard:                       │
│  │    RUN_RUNTIME_TESTS && cfg.localRepo                     │
│  │                                                           │
│  │  Kill stale Claude/Vite processes                         │
│  │  Classify: API_INTEGRATION│COMPONENT│UTILITY│STYLE        │
│  │                                                           │
│  │  ┌─ G.0: Env Bootstrap ── guard: !_env_bootstrapped      │
│  │  │        && !_env_bootstrap_failed && type!=STYLE        │
│  │  │  npm install, jest setup, playwright install            │
│  │  │  Generate configs + shims                              │
│  │  │  Validate with 1 test file                             │
│  │  │  ├─ OK → _env_bootstrapped = true                      │
│  │  │  └─ FAIL → _env_bootstrap_failed = true (graceful)    │
│  │  │                                                        │
│  │  ┌─ G.1: Vite Build ── guard: _build_checked &&           │
│  │  │        !_vite_build_done && type!=STYLE                │
│  │  │  npx nx build enterprise                               │
│  │  │  → _vite_build_done (true or "FAIL")                   │
│  │  │                                                        │
│  │  ┌─ G.2: Unit Tests ── guard: _env_bootstrapped &&        │
│  │  │  !_env_bootstrap_failed && !_unit_tests_complete       │
│  │  │  && type!=STYLE                                        │
│  │  │                                                        │
│  │  │  QA Test Engineer Agent writes Jest tests              │
│  │  │  ┌─ RETRY LOOP (max 2) ────────────────────┐          │
│  │  │  │  Run Jest                                 │          │
│  │  │  │  ├─ total==0 (compile err)?               │          │
│  │  │  │  │   └─ Test Fixer Agent → re-run         │          │
│  │  │  │  ├─ failed>0 && !_unit_test_dev_retry?    │          │
│  │  │  │  │   └─ Dev Agent fixes code → re-run     │          │
│  │  │  │  │      _unit_test_dev_retry = true        │          │
│  │  │  │  └─ all pass → break                      │          │
│  │  │  └──────────────────────────────────────────┘          │
│  │  │  → _unit_tests_complete, _unit_tests_count             │
│  │  │                                                        │
│  │  ┌─ G.3: Browser Smoke ── guard: _env_bootstrapped &&     │
│  │  │  !_e2e_tests_complete && !_playwright_install_failed   │
│  │  │  && (COMPONENT│API_INTEGRATION)                        │
│  │  │  && _vite_build_done === true                          │
│  │  │                                                        │
│  │  │  Find free port 4300-4399                              │
│  │  │  ├─ No free port → INCONCLUSIVE                        │
│  │  │  └─ Start Vite preview (detached)                      │
│  │  │     Health check loop (30s timeout)                    │
│  │  │     ├─ Not ready → INCONCLUSIVE                        │
│  │  │     └─ Ready:                                          │
│  │  │        E2E Test Engineer Agent writes tests            │
│  │  │        ┌─ RETRY LOOP (max 3) ──────────┐              │
│  │  │        │  Run Playwright                │              │
│  │  │        │  Parse results                 │              │
│  │  │        └────────────────────────────────┘              │
│  │  │     FINALLY: Kill Vite (-pid SIGTERM → SIGKILL)        │
│  │  │  → _e2e_tests_complete, _e2e_tests_count               │
│  │  │                                                        │
│  │  └─ Cleanup: Revert test files (**/*.spec.tsx),            │
│  │     delete shims, re-extract production changes           │
│  │                                                           │
│  ┌─ Phase H: AC Verification (Q6) ── guard:                 │
│  │    !_ac_verified && !ac_missing && ac exists              │
│  │                                                           │
│  │  AC Verification Agent                                    │
│  │  Parse: PASS / PARTIAL / FAIL counts                      │
│  │  │                                                        │
│  │  └─ FAIL items AND _ac_retry_count < 2?                   │
│  │     ├─ YES → Dev Agent fixes → re-extract                 │
│  │     │        _ac_retry_count++                             │
│  │     └─ NO → store known gaps for MR description           │
│  │                                                           │
│  ┌─ Phase I: Push to GitLab ─────────────────────────────    │
│  │  pushCodeToGitLab() — see sub-flow below                  │
│  │  Reset local repo                                         │
│  │                                                           │
│  └─ stage = "gate_code_review"                               │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### `pushCodeToGitLab()` sub-flow:

```
┌──────────── pushCodeToGitLab() ─────────────────────────────┐
│                                                              │
│  L3: Validate entries (non-empty path, content for non-del) │
│  L2: Deduplicate by file_path (keep last)                   │
│                                                              │
│  ┌─ Create Branch ── guard: !code_branch                     │
│  │  Source: parentBranch || "enterprise-ts"                   │
│  │  Name: enterprise-ts-{TICKET}                             │
│  │  → code_branch = branch name                              │
│  │                                                           │
│  ┌─ Commit ── guard: !code_committed                         │
│  │  GQ2: Filter files > MAX_COMMIT_FILE_SIZE (500KB)         │
│  │  GitLab API commit                                        │
│  │  → code_committed = true                                  │
│  │                                                           │
│  ┌─ Merge Conflict Check (GQ4) ── guard: !_conflict_check    │
│  ┌─ Divergence Check (GQ8) ── guard: !_divergence_checked    │
│  │                                                           │
│  ┌─ Create MR ── guard: !code_mr_iid                         │
│  │  S5: Validate target = enterprise-qa                      │
│  │  Includes: quality report, test results, known gaps       │
│  │  → code_mr_iid, code_mr_url                              │
│  │                                                           │
│  ┌─ Slack ── guard: !code_slack_sent                          │
│  │  (NO Jira comment in this step)                           │
│  │                                                           │
└──────────────────────────────────────────────────────────────┘
```

---

## Stage 4: `gate_code_review`

```
┌──────────── STAGE 4: gate_code_review ──────────────────────┐
│  Required: code_mr_iid                                       │
│                                                              │
│  Set gate1_at timestamp (if not set)                         │
│                                                              │
│  ┌─ POLL LOOP (every 30s) ──────────────────────────────    │
│  │                                                           │
│  │  Timeout > 8h? → EXIT(1) + Slack                         │
│  │                                                           │
│  │  ┌─ Web UI ──────────────────────────────────────        │
│  │  │  APPROVED → stage = "deploy_qa", return                │
│  │  │  REJECTED ──▶ [REJECTION FLOW]                         │
│  │  │                                                        │
│  │  ┌─ GitLab MR State ─────────────────────────────        │
│  │  │  mr.state == "merged"?                                 │
│  │  │  └─ YES → (E14 branch mismatch warn)                  │
│  │  │         → stage = "deploy_qa", return                  │
│  │  │                                                        │
│  │  │  mr.state == "closed"?                                 │
│  │  │  └─ YES ──▶ [REJECTION FLOW] (feedback from MR notes) │
│  │  │                                                        │
│  │  ┌─ MR Approvals ────────────────────────────────        │
│  │  │  approvals.approved == true?                           │
│  │  │  └─ YES → stage = "deploy_qa", return                  │
│  │  │                                                        │
│  │  ┌─ MR Notes ────────────────────────────────────        │
│  │  │  Contains "rejected" keyword?                          │
│  │  │  └─ YES ──▶ [REJECTION FLOW]                           │
│  │  │                                                        │
│  │  └─ Sleep 30s                                             │
│  │                                                           │
│  ┌─ [REJECTION FLOW] ──────────────────────────────────     │
│  │  _gate_rejections.gate1++                                 │
│  │  │                                                        │
│  │  ├─ count >= MAX_REJECTIONS (3)? → THROW (halt)           │
│  │  │                                                        │
│  │  ├─ Store feedback                                        │
│  │  ├─ P9: Preserve previousAttemptSummary                   │
│  │  ├─ Clear: code artifacts + MR + dev checkpoints          │
│  │  │  (Web UI: full clear incl. build/test/AC)              │
│  │  │  (MR closed: clear dev checkpoints)                    │
│  │  │  (MR note: lighter clear)                              │
│  │  └─ stage = "generate_code", return                       │
│  │                                                           │
└──────────────────────────────────────────────────────────────┘
```

---

## Stage 5: `deploy_qa`

```
┌──────────────── STAGE 5: deploy_qa ─────────────────────────┐
│  Required: code_mr_iid                                       │
│                                                              │
│  ┌─ Post Notification ── guard: !deploy_qa_posted            │
│  │  Slack: "Review & approve merge to QA"                    │
│  │                                                           │
│  ┌─ Wait for Merge ── guard: !qa_merged                      │
│  │                                                           │
│  │  ┌─ POLL LOOP (every 30s) ─────────────────────┐         │
│  │  │  Timeout > 8h? → EXIT(1)                     │         │
│  │  │                                               │         │
│  │  │  Web UI:                                      │         │
│  │  │  ├─ APPROVED → Merge MR via API               │         │
│  │  │  │  ├─ Success → qa_merged = true             │         │
│  │  │  │  └─ E2: Fail → Slack, set _merge_poll_start│         │
│  │  │  │         (fall through to auto-detect)      │         │
│  │  │  │                                             │         │
│  │  │  └─ REJECTED ──▶ [REJECTION FLOW]             │         │
│  │  │     H5: Keep code_branch, codeChanges, plan   │         │
│  │  │     Clear: commit/MR flags + dev checkpoints  │         │
│  │  │     stage = "generate_code", return            │         │
│  │  │                                               │         │
│  │  │  Auto-detect (GitLab poll):                   │         │
│  │  │  ├─ mr.state == "merged"? → qa_merged = true  │         │
│  │  │  └─ _merge_poll_start > 30min? → EXIT(1)     │         │
│  │  │                                               │         │
│  │  └──────────────────────────────────────────────┘         │
│  │                                                           │
│  ┌─ Wait for CI ── guard: !qa_ci                             │
│  │  gl.waitPipeline("enterprise-qa")                         │
│  │  Polls every 60s, timeout 30min                           │
│  │                                                           │
│  └─ stage = "test_qa"                                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Stage 6: `test_qa`

```
┌──────────────── STAGE 6: test_qa ───────────────────────────┐
│  Required: qa_merged                                         │
│                                                              │
│  ┌──────────────── PARALLEL (5min timeout) ────────────┐    │
│  │                                                      │    │
│  │  ┌─ QA Main ──────────┐  ┌─ QA1 ────────────────┐  │    │
│  │  │ URL: qa-enterprise │  │ URL: qa1-enterprise   │  │    │
│  │  │ User: prateekrai   │  │ User: aman            │  │    │
│  │  │ Pass: sandboxtwo   │  │ Pass: entp            │  │    │
│  │  │                    │  │                        │  │    │
│  │  │ 5 modules:         │  │ 2 modules:            │  │    │
│  │  │  - Dashboard       │  │  - IMS (Inventory)    │  │    │
│  │  │  - GST Return      │  │  - Reconcile          │  │    │
│  │  │  - Reports         │  │                        │  │    │
│  │  │  - Configurations  │  └────────────────────────┘  │    │
│  │  │  - Import          │                              │    │
│  │  └────────────────────┘                              │    │
│  │                                                      │    │
│  │  QA_SMOKE_LEVEL determines depth:                    │    │
│  │  - basic: GET only                                   │    │
│  │  - auth: POST login + GET with session               │    │
│  │  - full: auth + DOM checks                           │    │
│  │                                                      │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Results:                                                    │
│  ├─ All PASS → qa_test = results                             │
│  │            → stage = "gate_preprod_approval"              │
│  │                                                           │
│  └─ Any FAIL:                                                │
│     ├─ E1: Classify ENV_DOWN vs TEST_FAIL                    │
│     ├─ All ENV_DOWN → Jira: "QA Env Down" + Slack            │
│     └─ Otherwise → Jira: "QA Test Failed" + Slack            │
│     → THROW (pipeline halts, must re-run)                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Stages 7-10: Approval → Production

```
┌──────── STAGE 7: gate_preprod_approval ─────────────────────┐
│  Required: qa_test                                           │
│                                                              │
│  Post Jira + Slack (guard: !gate2a_posted)                   │
│  waitForApproval(count=1, anyUser, ui="gate2a")             │
│  ├─ APPROVED → stage = "create_preprod_mr"                   │
│  └─ REJECTED → THROW (halt)                                  │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────── STAGE 8: create_preprod_mr ─────────────────────────┐
│  Required: code_branch                                       │
│                                                              │
│  guard: !preprod_mr_iid                                      │
│  S5: Validate target = enterprise-pre-pro                    │
│  Create MR: enterprise-ts-{TICKET} → enterprise-pre-pro     │
│  → preprod_mr_iid, preprod_mr_url                            │
│  → stage = "gate_dual_approval"                              │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────── STAGE 9: gate_dual_approval ────────────────────────┐
│  Required: preprod_mr_iid                                    │
│                                                              │
│  Post Jira + Slack to BOTH (guard: !gate2b_posted)           │
│  waitForApproval(count=2, [owner, anshit], ui="gate2b")     │
│  ├─ E8: Unauthorized approver → Jira notify (once)          │
│  ├─ E5: Revocation support (edit to "revoked")              │
│  ├─ 2 APPROVED → stage = "deploy_prod"                       │
│  └─ REJECTED → THROW (halt)                                  │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────── STAGE 10: deploy_prod ──────────────────────────────┐
│  Required: preprod_mr_iid                                    │
│  W2: ALL 9 gates must be in _completedGates                 │
│                                                              │
│  ┌─ 1. Merge Pre-Prod MR ── guard: !preprod_merged          │
│  │  ├─ Success → preprod_merged = true                       │
│  │  └─ E3: Error → check if merged externally                │
│  │     ├─ YES → preprod_merged = true                        │
│  │     └─ NO → Slack (405=conflict, 406=pipeline) + THROW    │
│  │                                                           │
│  ┌─ 2. Wait Pre-Prod CI ── guard: !preprod_ci                │
│  │  gl.waitPipeline("enterprise-pre-pro")                    │
│  │                                                           │
│  ┌─ 3. Pre-Prod Smoke (E4) ── guard: !preprod_smoke_passed  │
│  │  SKIP_SMOKE_CHECK? → skip                                 │
│  │  HTTP GET cfg.urls.preProd (2 attempts, 30s gap)          │
│  │  ├─ PASS → preprod_smoke_passed = true                    │
│  │  └─ FAIL → Slack + THROW (HARD STOP before prod)          │
│  │                                                           │
│  ┌─ 4. Record SHA (X8) ── guard: !_prod_pre_merge_sha       │
│  │  Fetch HEAD of enterprise-master for rollback ref         │
│  │                                                           │
│  ┌─ 5. Create Prod MR ── guard: !prod_mr_iid                │
│  │  S5: Validate target = enterprise-master                  │
│  │  MR: enterprise-pre-pro → enterprise-master               │
│  │                                                           │
│  ┌─ 6. Merge Prod MR ── guard: !prod_merged                 │
│  │  5s delay, then merge. Same E3 error handling.            │
│  │                                                           │
│  ┌─ 7. Wait Prod CI ── guard: !prod_ci                       │
│  │  gl.waitPipeline("enterprise-master")                     │
│  │                                                           │
│  ┌─ 8. Prod Smoke (X8) ── guard: !_prod_smoke_checked       │
│  │  HTTP GET cfg.urls.prod (2 attempts, 30s gap)             │
│  │  ├─ PASS → OK                                             │
│  │  └─ FAIL → Slack with rollback instructions               │
│  │     !! Does NOT throw — continues to "done"               │
│  │                                                           │
│  └─ stage = "done"                                           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Stage 11: `done`

```
┌──────────────── STAGE 11: done ─────────────────────────────┐
│  (All wrapped in try/catch — errors are non-fatal)           │
│                                                              │
│  1. P12: Log warning summary                                 │
│  2. Transition Jira → "Done" (guard: !jira_closed)           │
│  3. Final Jira comment (guard: !final_comment)               │
│     Summary: MRs, environments, elapsed time, limitations   │
│  4. Final Slack (guard: !final_slack)                         │
│     Success message with prod URL + elapsed time            │
│  5. E9: Archive state file                                   │
│     Copy → state-{TICKET}.done.{ts}.json                    │
│     Delete active state file + lock file                     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Retry & Limits Summary

| What | Max | On Exhaust |
|------|-----|------------|
| Plan rejection | 5 | Slack + THROW |
| Code gen rejection | 3 | Slack + THROW |
| Gate1 review rejection | 3 | THROW |
| Deploy QA rejection | 3 | THROW |
| Developer retry (0 changes) | 1 | Slack + EXIT(1) |
| AC fix retry | 2 | Proceed with known gaps |
| Unit test retry | 2 | Store as INCONCLUSIVE |
| Unit test dev fix | 1 | No further retry |
| E2E test retry | 3 | Store as INCONCLUSIVE |
| Build fix retry | 1 | Proceed with build errors |
| Pre-prod smoke | 2 attempts | THROW (hard stop) |
| Production smoke | 2 attempts | Slack + rollback info (continues) |
| AC wait (no criteria) | 2h | Proceed without AC |
| Doc wait (inaccessible) | 2h | Proceed with available ctx |
| Any approval gate | 8h | EXIT(1) |
| Total pipeline | 24h | EXIT(1) |
| Merge poll (E2 fallback) | 30min | EXIT(1) |
| CI pipeline wait | 30min | timeout in waitPipeline |

---

## External Call Map

| Stage | Jira | GitLab | Slack | Claude CLI | HTTP (other) |
|-------|------|--------|-------|------------|--------------|
| fetch_ticket | getIssue, getComments, transitions | getBranch, getMRs | on halt | Vision API (optional) | URL fetches, attachments |
| explore_plan | addComment, getComments, getIssue | getTree (if no local) | Yes | Analysis, Architect | -- |
| generate_code | addComment (on failure) | createBranch, commit, createMR, compare | Yes | Dev, Reviewer, Security, Fixer, Build Fixer, QA Test, Test Fixer, E2E Test, AC Verify | -- |
| gate_code_review | -- | getMR, Approvals, Notes | timeout | -- | -- |
| deploy_qa | -- | mergeMR, getMR, waitPipeline | Yes | -- | -- |
| test_qa | addComment | -- | Yes | -- | QA env HTTP GETs |
| gate_preprod_approval | addComment, getComments | -- | Yes | -- | -- |
| create_preprod_mr | -- | createMR | -- | -- | -- |
| gate_dual_approval | addComment, getComments | -- | Yes | -- | -- |
| deploy_prod | -- | mergeMR, getMR, waitPipeline, getBranch, createMR | Yes | -- | Smoke HTTP GETs |
| done | transition, addComment | -- | Yes | -- | -- |

---

## Branch Flow (GitLab)

```
enterprise-ts (read-only source)
    │
    ├──▶ enterprise-ts-{TICKET}  (feature branch)
    │         │
    │         ├──▶ MR → enterprise-qa        (Stage 5)
    │         │              │
    │         │              └── CI pipeline
    │         │              └── QA smoke tests (Stage 6)
    │         │
    │         ├──▶ MR → enterprise-pre-pro   (Stage 8)
    │         │              │
    │         │              └── CI pipeline
    │         │              └── Smoke test (Stage 10)
    │         │
    │         └── (source for both MRs)
    │
    └── OR: enterprise-ts-{parentKey} (Q4: branch from parent)
               │
               └──▶ enterprise-ts-{TICKET}
```

---

## State Guard Codes Reference

| Code | Purpose |
|------|---------|
| Q1-Q6 | Quality gates (AC, docs, build, tests, verification) |
| W1-W8 | Workflow validation (stage entry, gates, refusals) |
| H1-H17 | Hardening (rejections, fallbacks, validation) |
| E1-E14 | Error handling (env detection, merge errors, branch mismatch) |
| F1-F7 | Forbidden actions (paths, unfixed code, empty changes) |
| S1-S10 | Security (target branch, permissions, HTTP warnings) |
| D1-D10 | Defense (prompt injection, locks, checkpoints) |
| P1-P12 | Performance (prompt size, state size, parallelism) |
| G11, GQ2-GQ8 | GitLab quality (conflict, divergence, file size, imports) |
| X1-X10 | Extensions (approval escalation, smoke, transitions, complexity) |
| O1-O11 | Operations (heartbeat, debug, stage resets, stuck detection) |
| R4-R6 | Resilience (ticket mismatch, mode switch) |
| L1-L3 | Limits (binary detection, dedup, file validation) |
| T7 | Timing (reject priority over approve in race condition) |
| CR1-CR5 | Critical reliability (cleanup, state merge, HMAC) |
| Z6-Z7 | Business rules (product ID enforcement, plan rejection count) |