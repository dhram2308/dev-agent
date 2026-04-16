// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — QA Testing Type Definitions
// ═══════════════════════════════════════════════════════════════

/**
 * QA smoke test level controlling test depth.
 */
export type QASmokeLevel = 'basic' | 'auth' | 'full';

/**
 * A single QA module to test (e.g. Dashboard, GST Return).
 */
export interface QAModule {
  /** Human-readable module name */
  name: string;

  /** URL path to test (e.g. "/dashboard") */
  path: string;
}

/**
 * QA environment identifiers.
 */
export type QAEnvironment = 'QA Main' | 'QA1';

/**
 * Configuration for a QA test environment.
 */
export interface QAEnvironmentConfig {
  /** Base URL of the QA environment */
  url: string;

  /** Login username */
  user: string;

  /** Login password */
  pass: string;

  /** Modules to test in this environment */
  modules: readonly QAModule[];
}

/**
 * Result of a single QA smoke test for one module.
 */
export interface QATestResult {
  /** Module name */
  name: string;

  /** URL path tested */
  path: string;

  /** Environment where the test ran */
  env: QAEnvironment;

  /** HTTP status code (0 if network error) */
  status: number;

  /** Whether the test passed */
  ok: boolean;

  /** Error message (on failure) */
  error?: string;

  /**
   * Error classification:
   * - ENV_DOWN: Network-level failure (ECONNREFUSED, ETIMEDOUT, etc.)
   * - TEST_FAIL: HTTP error or DOM check failure
   */
  errorType?: 'ENV_DOWN' | 'TEST_FAIL';
}

/**
 * A basic smoke test definition (HTTP health check).
 */
export interface SmokeTest {
  /** Test name */
  name: string;

  /** URL path to check */
  path: string;

  /** Expected HTTP status range (default: 200-399) */
  expectedStatusMin?: number;
  expectedStatusMax?: number;

  /** Whether login is required before this test */
  requiresAuth: boolean;

  /** Optional DOM markers to verify (for "full" smoke level) */
  domMarkers?: readonly string[];
}

/**
 * A regression test case (future: beyond smoke tests).
 */
export interface RegressionCase {
  /** Test case name */
  name: string;

  /** Module being tested */
  module: string;

  /** Test steps description */
  steps: string;

  /** Expected result */
  expectedResult: string;

  /** Actual result (populated after execution) */
  actualResult?: string;

  /** Whether the test passed */
  passed?: boolean;

  /** Duration of the test in milliseconds */
  durationMs?: number;
}

/**
 * Aggregate QA test results for a pipeline run.
 */
export interface QATestSummary {
  /** All individual test results */
  results: readonly QATestResult[];

  /** Number of passed tests */
  passed: number;

  /** Number of failed tests */
  failed: number;

  /** Number of env-down failures (subset of failed) */
  envDown: number;

  /** Total test duration in milliseconds */
  durationMs: number;

  /** Whether all tests passed */
  allPassed: boolean;
}
