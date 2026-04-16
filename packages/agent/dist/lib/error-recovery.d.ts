/**
 * error-recovery.ts -- Stage-Level Error Recovery
 *
 * Converted from lib/error-recovery.js (zero functional changes).
 * Uses shared types from @mi/shared for ErrorClass, RecoveryAction, etc.
 *
 * Solves problems #3, #11, #12:
 * - Classifies errors: TRANSIENT, AUTH, PERMANENT, TIMEOUT
 * - Auto-retry with exponential backoff for transient errors
 * - Auth re-validation on auth errors
 * - Saves state and notifies on permanent errors (no process.exit)
 * - Timeout extension if under pipeline max
 */
export {};
//# sourceMappingURL=error-recovery.d.ts.map