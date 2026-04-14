// ===================================================================
// MI Dev Agent -- Shared Constants (TypeScript port of lib/constants.js)
// ===================================================================

import type { StageName } from './types';

// -- Pipeline stages (ordered) ------------------------------------

export const STAGES = [
  'fetch_ticket',
  'explore_plan',
  'generate_code',
  'gate_code_review',
  'deploy_qa',
  'test_qa',
  'gate_preprod_approval',
  'create_preprod_mr',
  'gate_dual_approval',
  'deploy_prod',
  'done',
] as const;

// -- W1: Stage entry requirements map -----------------------------
// Maps each stage to the data fields that must exist before entry.

export const STAGE_REQUIREMENTS: Readonly<Record<StageName, readonly string[]>> = {
  fetch_ticket:          [],
  explore_plan:          ['ticket'],
  generate_code:         ['ticket', 'explore_plan'],
  gate_code_review:      ['code_mr_iid'],
  deploy_qa:             ['code_mr_iid'],
  test_qa:               ['qa_merged'],
  gate_preprod_approval: ['qa_test'],
  create_preprod_mr:     ['code_branch'],
  gate_dual_approval:    ['preprod_mr_iid'],
  deploy_prod:           ['preprod_mr_iid'],
  done:                  [],
} as const;

// -- W2: Required gates for production deploy ---------------------

export const REQUIRED_GATES: readonly StageName[] = [
  'fetch_ticket',
  'explore_plan',
  'generate_code',
  'gate_code_review',
  'deploy_qa',
  'test_qa',
  'gate_preprod_approval',
  'create_preprod_mr',
  'gate_dual_approval',
] as const;

// -- O11: Stage downstream data clears ----------------------------
// When a stage is re-entered, all downstream data fields listed here
// are wiped from state to prevent stale data pollution.

export const STAGE_CLEARS: Readonly<Record<StageName, readonly string[]>> = {
  fetch_ticket: [
    'ticket', 'explore_plan', 'explore_plan_posted', 'explore_plan_at',
    '_agent_analysis', '_agent_requirements', '_agent_explorer', '_agent_risk',
    'explore_agents', 'explore_openspec', '_agent_suggestions',
    '_refine_instructions', '_prev_openspec',
    'codeChanges', 'code_branch', 'code_committed',
    'code_mr_iid', 'code_mr_url', 'code_slack_sent', 'gate1_at', 'qa_merged', 'qa_ci',
    'qa_test', 'preprod_mr_iid', 'preprod_mr_url', 'prod_mr_iid', 'prod_mr_url',
    '_dev_complete', '_dev_summary', '_reviewed', '_fixed',
    '_dev_group_0', '_dev_group_1', '_dev_group_2', '_dev_group_3', '_dev_group_4',
  ],
  explore_plan: [
    'explore_plan', 'explore_plan_posted', 'explore_plan_at',
    '_agent_analysis', '_agent_requirements', '_agent_explorer', '_agent_risk',
    'explore_agents', 'explore_openspec', '_agent_suggestions',
    '_refine_instructions', '_prev_openspec', '_architect_result',
    '_active_agents',
    'codeChanges', 'code_branch', 'code_committed',
    'code_mr_iid', 'code_mr_url', 'code_slack_sent', 'gate1_at',
    '_dev_complete', '_dev_summary', '_reviewed', '_fixed',
    '_dev_group_0', '_dev_group_1', '_dev_group_2', '_dev_group_3', '_dev_group_4',
  ],
  generate_code: [
    'codeChanges', 'code_branch', 'code_committed',
    'code_mr_iid', 'code_mr_url', 'code_slack_sent', 'gate1_at',
    'original_files', 'plan', 'previousAttemptSummary',
    '_conflict_check_done', '_divergence_checked', '_last_commit_sha',
    '_dev_complete', '_dev_summary', '_dev_failed', '_reviewed', '_fixed', '_fixer_failed',
    '_reviewer_result', '_security_result',
    '_codegen_rejections', '_codegen_mode', '_claude_pid',
    '_active_agents',
    '_dev_group_0', '_dev_group_1', '_dev_group_2', '_dev_group_3', '_dev_group_4',
    '_build_checked', '_build_tsc', '_build_eslint', '_build_fix_attempted',
    '_vite_build_done', '_playwright_install_failed',
    '_env_bootstrapped', '_env_bootstrap_failed',
    '_unit_tests_complete', '_unit_tests_count', '_unit_test_dev_retry',
    '_e2e_tests_complete', '_e2e_tests_count', '_e2e_console_errors',
    '_test_artifacts_path', '_vite_preview_pid', '_vite_preview_port',
    '_ac_verified', '_ac_verification', '_ac_retry_count', '_ac_known_gaps',
    '_ac_agent_result', '_ac_fix_attempt_1', '_ac_fix_attempt_2',
    '_gap_analysis_attempt_1', '_gap_analysis_attempt_2', '_gap_analysis_attempt_3',
    '_gap_fix_attempt_1', '_gap_fix_attempt_2', '_gap_fix_attempt_3',
    '_unit_test_gen_result', '_e2e_test_gen_result', '_test_fixer_result', '_test_fix_dev_result',
    '_build_fix_result', '_fixer_result', '_dev_single_result', '_dev_retry_result',
    '_test_phase_complete', '_browser_verify_skip_reason',
    '_env_setup_complete', '_npm_install_hash', '_nx_serve_pid', '_nx_serve_port',
    '_dev_server_ready', '_routes_detected', '_login_complete', '_verify_attempt',
    '_verify_known_gaps', '_browser_verified', '_verify_evidence',
    '_verify_api_summary', '_verify_console_summary', '_browser_verify_available',
    'gate1_ui_approved', 'gate1_ui_rejected', 'gate1_ui_feedback',
  ],
  gate_code_review: ['gate1_at', 'qa_merged', 'qa_ci', 'qa_test'],
  deploy_qa:        ['qa_merged', 'qa_ci', 'qa_test'],
  test_qa:          ['qa_test', 'gate2a_posted', 'gate2a_at'],
  gate_preprod_approval: ['gate2a_posted', 'gate2a_at', 'preprod_mr_iid', 'preprod_mr_url'],
  create_preprod_mr:     ['preprod_mr_iid', 'preprod_mr_url', 'gate2b_posted', 'gate2b_at'],
  gate_dual_approval:    ['gate2b_posted', 'gate2b_at', 'preprod_merged', 'prod_mr_iid', 'prod_mr_url'],
  deploy_prod: [
    'preprod_merged', 'prod_mr_iid', 'prod_mr_url', 'prod_merged',
    'preprod_ci', 'preprod_smoke_passed', 'prod_ci',
    '_prod_pre_merge_sha', '_prod_smoke_checked',
  ],
  done: [],
} as const;

// -- S5: MR target branch whitelist -------------------------------

export const ALLOWED_MR_TARGETS = [
  'enterprise-qa',
  'enterprise-pre-pro',
  'enterprise-master',
] as const;

export type AllowedMRTarget = typeof ALLOWED_MR_TARGETS[number];

// -- L1: Binary content detection ---------------------------------
// File extensions that should be treated as binary (not diffable).

export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.ico',
  '.pdf', '.bmp', '.webp',
  '.mp3', '.mp4',
  '.zip', '.tar', '.gz', '.rar',
]);

// -- W8: Claude safety refusal detection --------------------------
// Basic refusal patterns checked against the first 500 chars of output.

export const REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bI can'?t\b/i,
  /\bI cannot\b/i,
  /\bI'm unable\b/i,
  /\bI am unable\b/i,
  /\bunable to (assist|help|generate|create|write|provide)\b/i,
  /\bI must (refuse|decline)\b/i,
];

// -- Pipeline duration default ------------------------------------

/** Default maximum pipeline duration in milliseconds (4 hours). */
export const MAX_PIPELINE_DURATION_DEFAULT = 4 * 60 * 60 * 1000;

// -- Prompt size default ------------------------------------------

/** Default maximum prompt tokens (estimated at ~4 chars per token). */
export const MAX_PROMPT_TOKENS_DEFAULT = 180_000;

// -- Log level hierarchy ------------------------------------------

export const LEVEL_ORDER = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
} as const;

export type LogLevel = keyof typeof LEVEL_ORDER;
