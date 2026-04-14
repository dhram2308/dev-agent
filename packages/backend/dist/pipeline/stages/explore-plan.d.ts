import type { PipelineState } from '@shared/types';
/** Dependencies injected into the stage */
export interface ExplorePlanDeps {
    /** Project root path (for OpenSpec CLI) */
    projectRoot: string;
    /** Jira service */
    jira: {
        addComment: (ticket: string, body: string) => Promise<void>;
        getComments: (ticket: string, since?: string) => Promise<Array<{
            author?: {
                displayName?: string;
            };
            body: unknown;
            created?: string;
        }>>;
    };
    /** GitLab service */
    gl: {
        getTree: (path: string, branch: string, recursive: boolean) => Promise<Array<{
            path: string;
            type: string;
        }>>;
    };
    /** Slack notification function */
    slack: (message: string, mentions?: string[]) => Promise<void>;
    /** Save pipeline state */
    save: (state: PipelineState) => void;
    /** Check UI approval */
    checkUIApproval: (state: PipelineState, key: string) => {
        approved: boolean;
        feedback?: string;
    } | null;
    /** Agent runner */
    runAgentsTeam: (opts: AgentsTeamOpts) => Promise<string>;
    /** Single agent runner */
    runSingleAgent: (opts: SingleAgentOpts) => Promise<string>;
    /** Local repo tree function */
    localGetTree?: (repoPath: string) => Array<{
        path: string;
        type: string;
    }>;
    /** ADF text extraction */
    adfText: (body: unknown) => string;
    /** ADF to markdown conversion */
    adfToMarkdown: (body: unknown) => string;
    /** URL classifier */
    classifyDocUrl: (url: string) => string;
    /** Doc paste instructions */
    getDocPasteInstructions: (docType: string) => string;
    /** Assess document criticality */
    assessDocCriticality: (docType: string, ticketText: string) => 'CRITICAL' | 'HIGH' | 'MEDIUM';
    /** Jira URL builder */
    jiraUrl: (ticket: string) => string;
    /** Sleep function */
    sleep: (ms: number) => Promise<void>;
    /** Config */
    cfg: {
        ticket: string;
        localRepo?: string;
        branch: {
            ts: string;
        };
        slack: {
            ownerId: string;
        };
        urls?: {
            qa?: string;
        };
    };
    /** Config timeouts */
    pollInterval: number;
    maxApprovalTimeout: number;
    maxContinueWait: number;
    maxPlanRejections: number;
    analysisTimeoutMs: number;
    /** Apply complexity timeout */
    applyComplexityTimeout: (baseMs: number, state: PipelineState) => number;
    /** Monotonic clock */
    monotonicMs: () => number;
}
/** Agent team options */
interface AgentsTeamOpts {
    teamName: string;
    agents: Array<{
        name: string;
        prompt: string;
        timeout: number;
        opts: Record<string, unknown>;
        required: boolean;
        checkpointKey: string;
    }>;
    state: PipelineState;
    merge: (results: Array<{
        name: string;
        output: string | null;
    }>) => string;
}
/** Single agent options */
interface SingleAgentOpts {
    name: string;
    prompt: string;
    timeout: number;
    opts: Record<string, unknown>;
    state: PipelineState;
    checkpointKey: string;
    required: boolean;
}
/**
 * Stage 1b: Explore & Plan -- analyzing ticket with agents team.
 *
 * Performs analysis, builds OpenSpec artifacts, posts plan for approval,
 * and waits for user approval/rejection/refinement.
 */
export declare function stageExplorePlan(state: PipelineState, deps: ExplorePlanDeps): Promise<void>;
export {};
