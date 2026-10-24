/**
 * Team Runtime — Shared Error Classes
 *
 * Common error types used across the runtime system.
 */

/**
 * Generic application error with a stable name for instanceof checks.
 */
export class AppError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppError'
    // Fix prototype chain for instanceof checks across module boundaries
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Contextual marker used when an error originates from context compression
 * or context-management boundaries.
 */
export const ERR_CONTEXT = 'CONTEXT'
