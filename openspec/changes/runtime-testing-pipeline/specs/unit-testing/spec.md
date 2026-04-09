# Spec: Unit Testing (Phase 2)

## QA Test Engineer Agent

### ADDED: QA Test Engineer Agent prompt and execution

**WHEN** Phase 2 begins AND change type is not STYLE
**THEN** spawn a new Claude agent (via `callClaude()`) with role "QA Test Engineer"

**WHEN** constructing the QA Test Engineer prompt
**THEN** include:
- Acceptance criteria from Jira ticket (verbatim)
- Component public API: exported function signatures, prop types, hook return types (extracted from changed files via regex — NOT full implementation)
- 3-5 existing *.spec.tsx files from the same directory or nearby directories (as pattern examples)
- Relevant tsconfig path aliases for the changed module
- The generated `test-providers.tsx` content
- Ant Design Form interaction guidance (use `fireEvent.change` on input, `fireEvent.click` on submit)
- Explicit instruction: "You must write tests for EACH acceptance criterion. Include at least 1 negative test and 1 edge case per AC."

**WHEN** constructing the QA Test Engineer prompt
**THEN** do NOT include:
- Implementation code of changed files
- Developer Agent's output or reasoning
- Reviewer feedback or security findings
- The Architect's plan

**WHEN** QA Test Engineer generates test files
**THEN** write them to `.repo-cache/{project}/` alongside the source files, using `*.spec.tsx` naming convention

## Test Execution

### ADDED: runUnitTests()

**WHEN** test files are generated
**THEN** run Jest with:
```
npx jest --config jest.config.override.ts
         --testPathPattern='<generated-test-files>'
         --testTimeout=10000
         --forceExit
         --json
         --outputFile=.test-artifacts/{TICKET}/jest-results.json
```
- Total timeout: `UNIT_TESTS_TIMEOUT` (default 3 min)
- `NODE_OPTIONS=--max_old_space_size=8192`

**WHEN** Jest produces JSON output
**THEN** parse and extract:
- `numTotalTests`, `numPassedTests`, `numFailedTests`
- For each failed test: `ancestorTitles`, `title`, `failureMessages`
- Store summary in `state.data._unit_tests_count = { total, passed, failed, flaky }`

## Retry Logic

### ADDED: Flaky test detection and retry

**WHEN** Jest reports failures AND retry count < `MAX_UNIT_TEST_RETRIES` (default 2)
**THEN** re-run Jest with same configuration

**WHEN** a test fails on run N but passes on run N+1
**THEN** mark that test as "flaky" (exclude from failure count)

**WHEN** a test fails consistently across all retries
**THEN** classify as "real failure"

**WHEN** all retries exhausted AND real failures exist
**THEN** proceed to failure handling (not halt)

## Failure Handling

### ADDED: Test failure classification and response

**WHEN** test failure is a compile error (cannot find module, type error, syntax error)
**THEN** send to Test Fixer Agent (single pass):
- Input: test file content + error message
- Instruction: "Fix only import paths and type errors. Do NOT change test logic."
- Re-run Jest after fix
- If still fails → mark test as INCONCLUSIVE

**WHEN** test failure is a logic/assertion error (expect(...).toBe(...) failed)
**THEN** feed failure details to Developer Agent for ONE code fix attempt:
- Input: test assertion + expected vs actual values
- Instruction: "Unit test expected {X} but got {Y}. Review your implementation for this AC: {ac_text}"
- Re-run Developer → re-run tests
- If still fails → mark as INCONCLUSIVE
- Set `state.data._unit_test_dev_retry = true` (prevent infinite loop — only one retry)

**WHEN** test failure is a timeout (test exceeded 10s)
**THEN** mark as INCONCLUSIVE (likely async issue in generated test, not code bug)

**WHEN** all tests pass (after retries)
**THEN** `state.data._unit_tests_complete = "PASS"`

**WHEN** some tests fail but are all flaky
**THEN** `state.data._unit_tests_complete = "PASS"` with `_unit_tests_count.flaky > 0`

**WHEN** real failures exist after all retries and fix attempts
**THEN** `state.data._unit_tests_complete = "INCONCLUSIVE"` (report in MR, do not block pipeline)

## Anti-Tautology Safeguards

### ADDED: Test quality requirements in QA Test Engineer prompt

**WHEN** generating the QA Test Engineer prompt
**THEN** include these mandatory rules:
1. "For each acceptance criterion, write at least ONE test that would FAIL if the feature is not implemented"
2. "Include at least 1 negative test per AC (what happens with invalid input, empty state, error response)"
3. "Include at least 1 edge case per AC (boundary values, empty arrays, null fields, very long strings)"
4. "Do NOT test implementation details (internal state, private functions). Test observable behavior only."
5. "Mock API responses at the hook level (jest.mock the custom hook), NOT at the axios level"
6. "Use `renderWithWrapper()` from `@mi/core` for all component renders"
7. "Assert using accessible queries: `getByRole`, `getByLabelText`, `getByText` — NOT `getByTestId`"

**WHEN** QA Test Engineer output contains fewer tests than acceptance criteria count
**THEN** log warning "Only {N} tests for {M} acceptance criteria — coverage may be incomplete"
