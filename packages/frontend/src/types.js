// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Frontend Type Definitions
// Local copies matching packages/shared/src/types/index.ts
// ═══════════════════════════════════════════════════════════════
/** Ordered array of all stages */
export const STAGE_ORDER = [
    'fetch_ticket', 'explore_plan', 'generate_code',
    'gate_code_review', 'deploy_qa', 'test_qa',
    'gate_preprod_approval', 'create_preprod_mr',
    'gate_dual_approval', 'deploy_prod', 'done',
];
/** Stage info lookup */
export const STAGE_INFO = [
    { stage: 'fetch_ticket', label: 'Fetch Ticket', icon: 'ticket', who: 'agent' },
    { stage: 'explore_plan', label: 'Explore & Plan', icon: 'compass', who: 'agent' },
    { stage: 'generate_code', label: 'Write Code', icon: 'code', who: 'agent' },
    { stage: 'gate_code_review', label: 'Code Review', icon: 'eye', who: 'you' },
    { stage: 'deploy_qa', label: 'QA Deploy', icon: 'rocket', who: 'agent' },
    { stage: 'test_qa', label: 'QA Testing', icon: 'flask', who: 'agent' },
    { stage: 'gate_preprod_approval', label: 'Pre-Prod Gate', icon: 'shield', who: 'you' },
    { stage: 'create_preprod_mr', label: 'Pre-Prod MR', icon: 'gitMerge', who: 'agent' },
    { stage: 'gate_dual_approval', label: 'Dual Approval', icon: 'users', who: 'both' },
    { stage: 'deploy_prod', label: 'Production', icon: 'globe', who: 'agent' },
    { stage: 'done', label: 'Done', icon: 'checkCircle', who: 'agent' },
];
/** Gate stage names (stages that require human approval) */
export const GATE_STAGES = [
    'explore_plan',
    'gate_code_review',
    'gate_preprod_approval',
    'gate_dual_approval',
];
/** Log level colors */
export const LOG_LEVEL_COLORS = {
    error: 'var(--danger)',
    warn: 'var(--warning)',
    info: 'var(--blue)',
    ok: 'var(--success)',
    step: 'var(--accent)',
    debug: 'var(--text-tertiary)',
};
