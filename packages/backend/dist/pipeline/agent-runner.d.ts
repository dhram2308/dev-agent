import type { StageName, StageHandler, AppConfig } from '@shared/types';
export { isShuttingDown } from '../lib/graceful-shutdown';
/**
 * Static dispatch table for stages that don't need runtime dependencies.
 * Used as a fallback / reference. The pipeline loop uses the dynamically
 * created registry from createHandlerRegistry().
 */
export declare const HANDLERS: Readonly<Record<StageName, StageHandler>>;
/**
 * Runtime dependencies used by stage factories.
 * Injected into the pipeline at startup via createHandlerRegistry().
 */
export interface PipelineDeps {
    gl: import('../services/gitlab').GitLabService;
    jira: import('../services/jira').JiraService;
    slack: import('../services/slack').SlackService;
    claude?: import('../services/claude').ClaudeService;
}
/**
 * Create a fully-wired handler registry by instantiating all factory
 * stages with their runtime dependencies.
 *
 * Stages that don't need deps (fetch_ticket, generate_code) are wired
 * directly. Factory stages (gate_code_review, deploy_qa, etc.) are
 * instantiated with the provided dependencies.
 */
export declare function createHandlerRegistry(deps: PipelineDeps): Record<StageName, StageHandler>;
/**
 * Run the full pipeline for a single ticket.
 *
 * This is the main entry point that orchestrates the stage machine:
 *   1. Loads or creates pipeline state
 *   2. Validates config, tokens, and environment
 *   3. Captures config snapshot
 *   4. Iterates through stages until "done" or shutdown
 *   5. Each stage is wrapped with timeout + error recovery
 *   6. Checkpoints are saved at every stage transition
 *
 * @param ticket - Jira ticket key (e.g., "AUT-8031")
 * @param config - Application configuration
 * @param deps - Optional runtime dependencies (services). If not provided,
 *               falls back to the static HANDLERS table.
 */
export declare function runPipeline(ticket: string, config: AppConfig, deps?: PipelineDeps, handlersOverride?: Record<StageName, StageHandler>): Promise<void>;
/**
 * Run multiple pipelines in parallel (up to maxConcurrent).
 *
 * Each ticket gets its own isolated pipeline state and execution context.
 * Failures in one pipeline do not halt others.
 *
 * @param tickets - Array of Jira ticket keys
 * @param config - Application configuration
 * @param deps - Runtime dependencies (services)
 * @param maxConcurrent - Maximum parallel pipelines (default from config)
 */
export declare function runMultiplePipelines(tickets: string[], config: AppConfig, deps?: PipelineDeps, maxConcurrent?: number): Promise<Map<string, {
    success: boolean;
    error?: string;
}>>;
