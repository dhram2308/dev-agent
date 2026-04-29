// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Code Generation Type Definitions
// ═══════════════════════════════════════════════════════════════
//
// Derived from: stages/generate-code/index.js, developer.js,
//   reviewer.js, build-check.js, runtime-tests.js,
//   browser-verify.js, ac-verification.js, local-repo.js
// Describes data shapes produced during the code generation pipeline.
// ═══════════════════════════════════════════════════════════════

/**
 * A single file change produced by the developer agent or local repo diff.
 * Returned by localGetChanges() in lib/local-repo.js and used throughout
 * the code generation pipeline.
 */
export interface FileChange {
  /** Action type: "create" for new files, "update" for modified, "delete" for removed */
  action: 'create' | 'update' | 'delete';
  /** File path relative to the repository root */
  file_path: string;
  /** File content (empty string for deletions) */
  content: string;
}

/**
 * The full code changes object built by stageGenerateCode() and passed
 * to pushCodeToGitLab(). Also stored in state.data.codeChanges.
 */
export interface CodeChange {
  /** Array of individual file changes */
  changes: FileChange[];
  /** Developer's summary of what was changed and why */
  summary: string;
  /** Test notes from the developer agent */
  test_notes: string;
}

/**
 * Dev server state tracked during browser verification.
 * The dev server is started in stages/generate-code/dev-server.js.
 */
export interface DevServerResult {
  /** Whether the dev server is ready to accept connections */
  ready: boolean;
  /** Local URL of the running dev server (e.g., "http://localhost:4200") */
  url?: string;
  /** Port the dev server is listening on */
  port?: number;
  /** PID of the dev server process */
  pid?: number;
  /** Error message if the server failed to start */
  error?: string;
}

/**
 * Build check result from Q5: tsc + eslint verification.
 * Produced by runBuildCheck() in stages/generate-code/build-check.js.
 */
export interface BuildCheckResult {
  /** TypeScript check result: "PASS" or "FAIL" */
  tsc: 'PASS' | 'FAIL';
  /** ESLint check result: "PASS" or "FAIL" */
  eslint: 'PASS' | 'FAIL';
  /** Array of build errors found */
  errors: ReadonlyArray<BuildError>;
  /** Whether a fixer agent was invoked to correct build issues */
  fixerInvoked: boolean;
}

/** An individual build error (TypeScript or ESLint) */
export interface BuildError {
  /** Error type: "typescript" or "eslint" */
  type: 'typescript' | 'eslint';
  /** Raw output from tsc or eslint */
  output: string;
}

/**
 * Runtime test results from unit tests and e2e smoke tests.
 * Produced by runRuntimeTests() in stages/generate-code/runtime-tests.js.
 */
export interface RuntimeTestResult {
  /** Unit test completion status */
  unitTests: 'PASS' | 'FAIL' | 'SKIP' | 'TIMEOUT' | 'ERROR';
  /** Unit test counts */
  unitTestCounts?: TestCounts;
  /** E2E smoke test completion status */
  e2eTests?: 'PASS' | 'FAIL' | 'SKIP' | 'TIMEOUT' | 'ERROR';
  /** E2E test counts */
  e2eTestCounts?: TestCounts;
  /** Console errors captured during e2e tests */
  consoleErrors?: ReadonlyArray<ConsoleError>;
  /** Whether a fixer agent was invoked to correct test failures */
  fixerInvoked: boolean;
}

/** Test count summary */
export interface TestCounts {
  /** Total number of tests */
  total: number;
  /** Number of passed tests */
  passed: number;
  /** Number of failed tests */
  failed: number;
  /** Number of skipped tests */
  skipped?: number;
  /** Number of flaky tests (passed on retry) */
  flaky?: number;
}

/** A console error captured during browser/e2e testing */
export interface ConsoleError {
  /** Severity level */
  severity: 'error' | 'warning' | 'info';
  /** Error text */
  text?: string;
  /** Error message */
  message?: string;
  /** Source URL where the error occurred */
  url?: string;
  /** Line number */
  lineNumber?: number;
}

/**
 * Browser verification result from Part 2: Playwright-based testing.
 * Produced by runBrowserVerification() in stages/generate-code/browser-verify.js.
 */
export interface BrowserVerifyResult {
  /** Overall verification status */
  status: 'PASS' | 'FAIL' | 'SKIP' | 'PARTIAL';
  /** Reason for skipping (if status is "SKIP") */
  skipReason?: string;
  /** Detected feature routes */
  routes?: readonly string[];
  /** Whether login to the app succeeded */
  loginSuccess?: boolean;
  /** Gap analysis agent output */
  gapAnalysis?: string;
  /** Evidence collected (accessibility tree, network, console, screenshots) */
  evidence?: BrowserEvidence;
}

/** Evidence collected during browser verification */
export interface BrowserEvidence {
  /** Accessibility tree text */
  accessibilityTree?: string;
  /** Visible text content */
  textContent?: string;
  /** Network request summary */
  networkSummary?: string;
  /** Console log summary */
  consoleSummary?: string;
  /** Screenshot paths */
  screenshots?: readonly string[];
  [key: string]: unknown;
}

/**
 * AC (Acceptance Criteria) verification result.
 * Produced by runACVerification() in stages/generate-code/ac-verification.js.
 */
export interface ACVerificationResult {
  /** Overall AC verification verdict */
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
  /** Per-criterion results */
  criteria: ReadonlyArray<ACCriterionResult>;
  /** Raw agent output */
  rawOutput?: string;
  /** Whether a fixer agent was invoked for unmet criteria */
  fixerInvoked: boolean;
}

/** Result for a single acceptance criterion */
export interface ACCriterionResult {
  /** The acceptance criterion text */
  criterion: string;
  /** Verification verdict */
  verdict: 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT_ADDRESSED';
  /** Brief reason for the verdict */
  reason: string;
}

/**
 * Reviewer feedback from the code review gate (gate_code_review stage).
 * Stored in state.data.feedback when the reviewer or human rejects code.
 */
export interface ReviewerFeedback {
  /** The feedback text (from MR comments, reviewer agent, or human) */
  feedback: string;
  /** Timestamp when the feedback was recorded (ISO 8601) */
  ts: string;
}

/**
 * Payload broadcast via SSE on `codegen:live` while `runAgentsTeam` runs a
 * team that writes files to disk. Mirrors the shape returned by the
 * on-demand `/api/codegen/live?ticket=…` snapshot endpoint (minus the
 * `live: true` envelope). Produced by the poller inside
 * `packages/agent/src/lib/agents-team.ts`.
 */
export interface CodegenLivePayload {
  /** Ticket id, e.g. "AUT-8457" */
  ticket: string;
  /** Team name, e.g. "Developer Team" */
  team: string;
  /** Names of agents currently in-flight (copied from state.data._active_agents) */
  activeAgents: string[];
  /** Current working-tree changes relative to HEAD, capped at MAX_FILES_LIVE */
  changes: FileChange[];
  /** HEAD content for each `update`-action path, same cap applied */
  original_files: Record<string, string>;
  /** Timestamp of tick (Date.now()) */
  ts: number;
  /** Set only when caps were applied during this tick */
  truncated?: {
    /** Number of change entries dropped past MAX_FILES_LIVE */
    files?: number;
    /** File paths whose `content` exceeded MAX_FILE_BYTES_LIVE */
    bytes?: string[];
  };
}

/**
 * Payload broadcast via SSE on `codegen:live-stop` exactly once per
 * `runAgentsTeam` invocation where the live poller was started, emitted
 * in the finally block of Phase 2.
 */
export interface CodegenLiveStopPayload {
  ticket: string;
  team: string;
  /** 'success' when failures.length === 0 after Phase 3's required-agent check */
  outcome: 'success' | 'failure';
  ts: number;
}

/**
 * A single clarifying question raised by the Architect agent when it
 * encounters an ambiguity that MATERIALLY changes the implementation.
 * Parsed out of the `---QUESTIONS---` JSON block that the agent appends
 * to its output. Stored in `state.data._pending_questions` until the
 * user answers via `POST /api/answer-questions`.
 */
export interface PendingQuestion {
  /** Short slug, unique within the current Architect run (e.g. "ledger-placement") */
  id: string;
  /** The full question sentence shown to the user */
  text: string;
  /** 2–5 mutually exclusive option texts — rendered as a radio group */
  options: string[];
  /** Index into `options` the AI recommends (if it has an opinion) */
  recommend?: number;
  /** One-sentence rationale for the AI's recommendation */
  reason?: string;
  /** Which stage raised the question (always `'explore_plan'` in Tier 1) */
  stage: string;
  /** Timestamp when the parser admitted this question (Date.now()) */
  ts: number;
}

/**
 * A user's (or AI-default) answer to a `PendingQuestion`. Populated by
 * the `POST /api/answer-questions` handler. Persists in `state.data._qa_answers`
 * across Refine iterations so the Architect and downstream agents can
 * treat already-confirmed decisions as binding constraints.
 */
export interface QuestionAnswer {
  /** Matches `PendingQuestion.id` */
  id: string;
  /** Index into the original `options` array the user picked */
  choice: number;
  /** Snapshot of the option text at answer time (survives plan re-renders) */
  optionText: string;
  /** 'user' = explicit pick; 'ai-default' = bulk "Accept all AI picks" action */
  via: 'user' | 'ai-default';
  /** Timestamp when the answer was recorded */
  ts: number;
}

/**
 * Issue category produced by categorizeIssues() in lib/jira.js.
 * Used by the fixer agent to prioritize fixes.
 */
export interface IssueCategory {
  /** Priority order (lower = more urgent) */
  priority: number;
  /** Issue type category */
  type: 'COMPILATION' | 'SECURITY' | 'CODE_REVIEW' | 'LINT';
  /** Display label (e.g., "[COMPILATION-ERROR]") */
  label: string;
  /** Raw content from the reviewer/security agent */
  content: string;
}
