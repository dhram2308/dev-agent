import type { StageName, ServiceName, ServiceHealth } from './index';
/**
 * Metrics collected for a single pipeline stage execution.
 */
export interface StageMetrics {
    /** Stage name */
    stage: StageName;
    /** ISO timestamp when the stage started */
    startedAt: string;
    /** ISO timestamp when the stage completed */
    completedAt?: string;
    /** Duration of the stage in milliseconds */
    durationMs?: number;
    /** Whether the stage succeeded */
    success: boolean;
    /** Number of retry attempts */
    retries: number;
    /** Error message if the stage failed */
    error?: string;
    /** Number of files changed (for code gen stages) */
    filesChanged?: number;
    /** Claude CLI invocation count within this stage */
    claudeCalls?: number;
    /** Total Claude CLI time in milliseconds */
    claudeTimeMs?: number;
}
/**
 * System-level metrics snapshot (memory, services, progress).
 */
export interface SystemMetrics {
    /** Memory usage */
    memory: {
        /** Resident set size in bytes */
        rss: number;
        /** Used heap size in bytes */
        heapUsed: number;
        /** Total heap size in bytes */
        heapTotal: number;
        /** Memory trend analysis */
        trend: {
            trend: 'growing' | 'stable' | 'shrinking' | 'insufficient_data';
            currentMB: number;
        };
    };
    /** Service health per external dependency */
    services: Record<ServiceName, ServiceHealth>;
    /** Pipeline progress indicators */
    progress: {
        /** Whether the pipeline appears stuck */
        stuck: boolean;
        /** Minutes since the last stage change */
        stuckMinutes: number;
        /** ISO timestamp of the last stage transition */
        lastStageChange: string;
    };
    /** Active warnings */
    warnings: readonly string[];
    /** Total warning count */
    warningCount: number;
}
/**
 * Complete metrics snapshot combining stage and system metrics.
 */
export interface MetricsSnapshot {
    /** ISO timestamp when the snapshot was taken */
    timestamp: string;
    /** Current pipeline ticket */
    ticket: string;
    /** Current pipeline stage */
    currentStage: StageName;
    /** Pipeline elapsed time in milliseconds */
    pipelineElapsedMs: number;
    /** Per-stage metrics (for completed stages) */
    stageMetrics: readonly StageMetrics[];
    /** System-level metrics */
    system: SystemMetrics;
}
//# sourceMappingURL=metrics.d.ts.map