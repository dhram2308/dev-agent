import type { PipelineState } from '@shared/types';
/**
 * Fetch Ticket stage handler.
 *
 * Gathers all context from Jira and external sources:
 *   1. Pre-flight validation (status, existing branch/MR, parent task)
 *   2. Issue fields with retry on transient errors
 *   3. Parent epic context
 *   4. All comments (paginated, capped)
 *   5. Linked issues (parallel batched)
 *   6. Downloadable attachments (text + images with vision)
 *   7. URLs extracted from ADF (description, AC, comments)
 *   8. External URL content (parallel batched, capped)
 *   9. Auth-required URL detection
 *   10. Ticket complexity classification
 *
 * Advances state to "explore_plan" on completion.
 */
export declare function stageFetchTicket(state: PipelineState): Promise<void>;
