/**
 * escalation.ts -- Alert Escalation Engine for MI Dev Agent
 *
 * Converted from lib/escalation.js (zero functional changes).
 * Uses shared types from @mi/shared for EscalationRecord.
 *
 * Rules-based escalation system that monitors pipeline health and
 * triggers appropriate alerts when critical events occur.
 *
 * Escalation Rules:
 * 1. Pipeline stuck: no stage change in 30 min -> escalate to Slack
 * 2. 3 consecutive notification failures -> log prominently, set UI banner
 * 3. Auth failure (401 from any service) -> immediate alert with fix guidance
 * 4. Pipeline timeout approaching (80% of MAX_PIPELINE_DURATION) -> warning alert
 */
export {};
//# sourceMappingURL=escalation.d.ts.map