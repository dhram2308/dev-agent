// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Automation policy helpers
// Shared between GateApproval.tsx and the Dashboard's automation
// status strip so the gate → config-key mapping isn't duplicated.
// ═══════════════════════════════════════════════════════════════

import type { StageName } from '../types';

/** Gates that actually block on human input and carry an auto-approve policy. */
export const AUTOMATION_GATES: readonly StageName[] = [
  'explore_plan',
  'gate_code_review',
  'gate_preprod_approval',
  'gate_dual_approval',
];

/** Maps each gate to the CONFIG_SCHEMA key that carries its auto-approve policy. */
export const AUTO_APPROVE_CONFIG_KEY: Partial<Record<StageName, string>> = {
  explore_plan: 'AUTO_APPROVE_EXPLORE_PLAN',
  gate_code_review: 'AUTO_APPROVE_GATE_CODE_REVIEW',
  gate_preprod_approval: 'AUTO_APPROVE_GATE_PREPROD_APPROVAL',
  gate_dual_approval: 'AUTO_APPROVE_GATE_DUAL_APPROVAL',
};

export type AutoApprovePolicy = 'manual' | 'playground_validated' | 'always';

export function getGatePolicy(config: Record<string, unknown>, gate: StageName): AutoApprovePolicy {
  const key = AUTO_APPROVE_CONFIG_KEY[gate];
  const value = key ? (config[key] as string | undefined) : undefined;
  return (value as AutoApprovePolicy) || 'manual';
}
