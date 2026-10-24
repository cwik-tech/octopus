/**
 * A delegated child team that did not succeed.
 *
 * A sub-team failure is not a provider failure, so it must not be dressed up as
 * one: the parent's attempt loop classifies on error identity, and conflating
 * the two loses the distinction between a model that misbehaved and a whole
 * delegated team that ended without a usable result.
 *
 * This lives in its own module rather than beside `HaltError` in
 * `failure-policy.ts` because that module already imports
 * `dispatchToAgentOrTeam` from `agent-runner`, and `agent-runner` raises this
 * error — putting it there would close a runtime import cycle.
 */

/** The child terminal statuses a parent can be handed. */
export type SubTeamFailureStatus = 'blocked' | 'failed'

/**
 * Retryability is derived from the child's status, never supplied alongside it.
 *
 * - `blocked` means the child needs new input before it can proceed. Retrying
 *   the identical brief cannot supply that, so it is not retryable.
 * - `failed` may be transient — a crashed process, an exhausted provider — so
 *   it stays retryable under the parent's existing failure policy.
 *
 * The mapping is exhaustive rather than a negation, so adding a status is a
 * compile error here instead of a silent default.
 */
export function isSubTeamStatusRetryable(status: SubTeamFailureStatus): boolean {
  switch (status) {
    case 'blocked':
      return false
    case 'failed':
      return true
  }
}

export class SubTeamFailedError extends Error {
  /** Derived from `childStatus`; the two can never disagree. */
  readonly retryable: boolean

  constructor(
    readonly teamName: string,
    /** The child's own terminal status, preserved rather than flattened. */
    readonly childStatus: SubTeamFailureStatus,
    message?: string,
  ) {
    super(
      message ??
        `Delegated team '${teamName}' ended with status '${childStatus}'.`,
    )
    this.name = 'SubTeamFailedError'
    this.retryable = isSubTeamStatusRetryable(childStatus)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
