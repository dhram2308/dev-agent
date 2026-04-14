import type { PipelineState } from '@shared/types';
/** File change entry */
export interface FileChange {
    action: string;
    file_path: string;
    content?: string;
}
/** Route info detected from changed files */
interface RouteInfo {
    route: string;
    source?: string;
}
/** Route evidence from verification */
interface RouteEvidence {
    route: string;
    error?: string;
    consoleErrors?: Array<{
        severity: string;
        text?: string;
        message?: string;
    }>;
    networkSummary?: Record<string, unknown>;
    screenshotPath?: string;
}
/** Aggregated evidence */
interface AggregatedEvidence {
    overallHealth: {
        allRoutesLoaded: boolean;
        authFailures: number;
        highSeverityErrors: number;
        networkHealthy: boolean;
    };
    [key: string]: unknown;
}
/** Context passed from generate-code orchestrator */
export interface BrowserVerifyContext {
    state: PipelineState;
    approvedPlan: string;
    devFullContext: string;
    extraDocs: string;
    extraFeedback: string;
    feedback: string;
}
/** Dependencies for browser verification */
export interface BrowserVerifyDeps {
    cfg: {
        localRepo: string;
        ticket: string;
        urls?: {
            qa?: string;
        };
        qa?: {
            main?: {
                user?: string;
                pass?: string;
            };
        };
    };
    /** Feature flag */
    browserVerify: boolean;
    /** Max verification retries */
    maxVerifyRetries: number;
    /** Verification timeout */
    verificationTimeout: number;
    /** Developer timeout */
    developerTimeoutMs: number;
    /** Max evidence size */
    evidenceMaxSize: number;
    /** Apply complexity timeout */
    applyComplexityTimeout: (baseMs: number, state: PipelineState) => number;
    /** Save state */
    save: (state: PipelineState) => void;
    /** Run a single agent */
    runSingleAgent: (opts: {
        name: string;
        prompt: string;
        timeout: number;
        opts: Record<string, unknown>;
        state: PipelineState;
        checkpointKey: string;
        required: boolean;
    }) => Promise<string | null>;
    /** Get local repo changes */
    localGetChanges: (repoPath: string) => FileChange[];
    /** Dev server controls */
    startDevServer: (repoPath: string, state: PipelineState) => Promise<{
        port: number;
        pid: number;
    } | null>;
    stopDevServer: (state: PipelineState) => void;
    isProcessAlive: (pid: number) => boolean;
    /** Route detection */
    detectRoutes: (changedFiles: FileChange[], repoPath: string, ac: string) => RouteInfo[];
    /** Evidence collection */
    collectEvidence: (page: unknown, route: string, ac: string) => Promise<RouteEvidence>;
    setupNetworkCapture: (page: unknown) => {
        reset: () => void;
        summary: () => Record<string, unknown>;
    };
    setupConsoleCapture: (page: unknown) => {
        reset: () => void;
        errors: () => Array<{
            severity: string;
            text?: string;
            message?: string;
        }>;
    };
    captureScreenshot: (page: unknown, route: string, ticket: string) => Promise<string | null>;
    aggregateEvidence: (evidences: RouteEvidence[]) => AggregatedEvidence;
    /** Health check + login */
    checkQAHealth: (url: string) => Promise<{
        healthy: boolean;
        reason?: string;
    }>;
    loginToApp: (page: unknown, port: number, credentials: {
        email: string;
        pass: string;
    }) => Promise<{
        success: boolean;
        reason?: string;
    }>;
}
/**
 * Part 2: Browser-based verification of generated code.
 *
 * Launches Playwright, logs into the running dev server, navigates to feature routes,
 * collects evidence, and runs Gap Analysis Agent.
 */
export declare function runBrowserVerification(state: PipelineState, ctx: BrowserVerifyContext, deps: BrowserVerifyDeps): Promise<void>;
/**
 * Build MR description section for browser verification results.
 */
export declare function buildBrowserVerifyMRSection(state: PipelineState): string;
export {};
