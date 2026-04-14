// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Frontend Type Definitions
// Local copies matching packages/shared/src/types/index.ts
// ═══════════════════════════════════════════════════════════════

/** All pipeline stage names as a literal union */
export type StageName =
  | 'fetch_ticket'
  | 'explore_plan'
  | 'generate_code'
  | 'gate_code_review'
  | 'deploy_qa'
  | 'test_qa'
  | 'gate_preprod_approval'
  | 'create_preprod_mr'
  | 'gate_dual_approval'
  | 'deploy_prod'
  | 'done';

/** Ordered array of all stages */
export const STAGE_ORDER: readonly StageName[] = [
  'fetch_ticket', 'explore_plan', 'generate_code',
  'gate_code_review', 'deploy_qa', 'test_qa',
  'gate_preprod_approval', 'create_preprod_mr',
  'gate_dual_approval', 'deploy_prod', 'done',
] as const;

/** Stage display metadata */
export interface StageInfo {
  stage: StageName;
  label: string;
  icon: string;
  who: 'agent' | 'you' | 'both';
}

/** Stage info lookup */
export const STAGE_INFO: readonly StageInfo[] = [
  { stage: 'fetch_ticket',          label: 'Fetch Ticket',     icon: 'ticket',      who: 'agent' },
  { stage: 'explore_plan',          label: 'Explore & Plan',   icon: 'compass',     who: 'agent' },
  { stage: 'generate_code',         label: 'Write Code',       icon: 'code',        who: 'agent' },
  { stage: 'gate_code_review',      label: 'Code Review',      icon: 'eye',         who: 'you' },
  { stage: 'deploy_qa',             label: 'QA Deploy',        icon: 'rocket',      who: 'agent' },
  { stage: 'test_qa',               label: 'QA Testing',       icon: 'flask',       who: 'agent' },
  { stage: 'gate_preprod_approval', label: 'Pre-Prod Gate',    icon: 'shield',      who: 'you' },
  { stage: 'create_preprod_mr',     label: 'Pre-Prod MR',      icon: 'gitMerge',    who: 'agent' },
  { stage: 'gate_dual_approval',    label: 'Dual Approval',    icon: 'users',       who: 'both' },
  { stage: 'deploy_prod',           label: 'Production',       icon: 'globe',       who: 'agent' },
  { stage: 'done',                  label: 'Done',             icon: 'checkCircle', who: 'agent' },
] as const;

/** Gate stage names (stages that require human approval) */
export const GATE_STAGES: readonly StageName[] = [
  'explore_plan',
  'gate_code_review',
  'gate_preprod_approval',
  'gate_dual_approval',
] as const;

/** Pipeline state data object */
export interface PipelineData {
  _pipeline_start?: number;
  _lastActivity?: string;
  _retries?: Record<string, number>;
  _lastError?: {
    stage: string;
    message: string;
    classification: string;
    attempt: number;
    timestamp: string;
    stack?: string;
  };
  _completedGates?: string[];
  _warnings?: Array<{ stage: string; message: string; timestamp: string }>;
  _ui_approve_gate?: string;
  _ui_approve_preprod?: string;
  _ui_approve_dual?: string;
  _active_agents?: Array<{ name: string; status: string }>;
  _stage_timings?: Record<string, { start: number; end?: number }>;
  code_mr_url?: string;
  code_mr_iid?: string | number;
  preprod_mr_url?: string;
  preprod_mr_iid?: string | number;
  explore_plan?: string;
  explore_openspec?: Record<string, string>;
  _agent_suggestions?: string[];
  [key: string]: unknown;
}

/** Core pipeline state */
export interface PipelineState {
  ticket: string;
  stage: StageName;
  data: PipelineData;
  _seq?: number;
  _hmac?: string;
  _v?: number;
}

/** Per-ticket UI state for multi-ticket support */
export interface PipelineTicketState {
  ticket: string;
  state: PipelineState | null;
  isRunning: boolean;
  stage: StageName;
  stageStartedAt: number | null;
  pipelineStartedAt: number | null;
  logs: LogEntry[];
  error: string | null;
  /** Whether a gate approval is pending */
  gateWaiting: StageName | null;
}

/** Log entry from SSE stream */
export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  source?: string;
  ticket?: string;
}

/** Log levels matching the backend */
export type LogLevel = 'error' | 'warn' | 'info' | 'ok' | 'step' | 'debug';

/** Log level colors */
export const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  error: 'var(--danger)',
  warn:  'var(--warning)',
  info:  'var(--blue)',
  ok:    'var(--success)',
  step:  'var(--accent)',
  debug: 'var(--text-tertiary)',
};

/** API error */
export interface ApiError {
  status: number;
  message: string;
  code?: string;
}

/** Review data from the backend */
export interface ReviewData {
  gate: string;
  changes?: Array<{
    file: string;
    action: 'create' | 'update' | 'delete';
    diff?: string;
    content?: string;
  }>;
  plan?: Record<string, string>;
  mrUrl?: string;
  mrIid?: number;
  qaResults?: Array<{
    module: string;
    status: 'pass' | 'fail' | 'inconclusive';
    details?: string;
  }>;
  suggestions?: string[];
  _ts?: number;
}

/** Pipeline status from /api/pipelines */
export type PipelineStatus = 'running' | 'paused' | 'gate_waiting' | 'done' | 'expired';

/** Pipeline summary from /api/pipelines */
export interface PipelineSummary {
  ticket: string;
  stage: string;
  startedAt: string | null;
  lastActivity: string | null;
  running: boolean;
  resumable: boolean;
  daysRemaining: number;
  needsApproval: boolean;
  gateStage: string | null;
  progress: number;
  status: PipelineStatus;
  resumeCount: number;
}

/** SSE event types */
export type SSEEventType =
  | 'state'
  | 'log'
  | 'review'
  | 'pipelines'
  | 'connected'
  | 'heartbeat'
  | 'error';

/** SSE event payload */
export interface SSEEvent {
  type: SSEEventType;
  data: unknown;
  ticket?: string;
}
