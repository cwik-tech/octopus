/**
 * When a delegated run may report, and whether it may clean up.
 *
 * Three facts decide it and nothing else: whether the child process has closed,
 * whether termination has been asked for, and what forcing the group to
 * terminate came back with. The middle one is not redundant — between asking
 * and hearing back, a close says less than it appears to — and leaving it out
 * is how an early version reported a finished cancellation while the group was
 * still being killed.
 *
 * No processes, no timers, no filesystem — which is the point. A group that
 * survives SIGKILL cannot be produced on demand, so a decision that only ever
 * ran inside the process code could never be shown to handle one.
 *
 * The rule the whole thing turns on is about the private Pi agent directory.
 * It holds a copy of the user's credentials and is the agent directory the
 * whole group was started with, so it may only be removed once nothing in that
 * group can still be using it. A termination that could not be confirmed is
 * exactly the case where that is unknown, and unknown is not good enough.
 */

/** How a delegated child's process ended, as the shell observed it. */
export interface DelegatedChildClose {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly spawnError?: Error
}

/** Result of the delegated group's force-cleanup. */
export type DelegatedTerminationOutcome =
  | { readonly terminated: true }
  | { readonly terminated: false; readonly reason: string }

/** Result of closing the child's subtree of owned processes. */
export type DelegatedSubtreeClosure =
  | { readonly closed: true }
  | { readonly closed: false; readonly reason: string }

/**
 * What the shell should do next.
 *
 * `releaseResources` is stated on both outcomes rather than inferred from the
 * kind, because it is the safety property and a reader should not have to
 * derive it.
 */
export type DelegatedSettlementDecision =
  | { readonly kind: 'wait' }
  | {
      readonly kind: 'report'
      readonly close: DelegatedChildClose
      readonly releaseResources: true
    }
  | {
      readonly kind: 'abandon'
      /** Why: the group's termination was not confirmed, or a descendant could not be verified gone. */
      readonly cause: 'unconfirmed_termination' | 'held_subtree'
      readonly message: string
      readonly releaseResources: false
    }

/**
 * A delegated run abandoned because a descendant of its child could not be
 * verified gone. A step that ends this way fails, as the owner decided (T5):
 * it is not offered a retry that would run beside processes that may still
 * be running.
 */
export class HeldSubtreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeldSubtreeError'
  }
}

/**
 * Say what a run has been told, and it will say what may happen.
 *
 * Facts arrive in any order and at most one decision is ever handed out, so a
 * shell that asks again after acting cannot release or report twice.
 */
export class DelegatedSettlement {
  private childClose: DelegatedChildClose | null = null
  private terminationRequested = false
  private termination: DelegatedTerminationOutcome | null = null
  private decided = false
  private readonly closesSubtree: boolean
  private subtreeClosure: DelegatedSubtreeClosure | null = null

  /**
   * `closesSubtree`: the child is an owned process, so the run also waits for
   * its subtree to be closed once it has exited, and a held subtree fails the
   * run the way an unconfirmed termination does.
   */
  constructor(options: { readonly closesSubtree?: boolean } = {}) {
    this.closesSubtree = options.closesSubtree === true
  }

  recordSubtreeClosure(closure: DelegatedSubtreeClosure): void {
    this.subtreeClosure ??= closure
  }

  recordChildClose(close: DelegatedChildClose): void {
    this.childClose ??= close
  }

  /**
   * Cancellation has begun and its outcome is not known yet.
   *
   * Between this and the outcome, a close means less than it looks: the direct
   * child obeying SIGTERM is the ordinary shape of cancellation, and says
   * nothing about the grandchildren sharing its group.
   */
  recordTerminationRequested(): void {
    this.terminationRequested = true
  }

  recordTermination(outcome: DelegatedTerminationOutcome): void {
    this.terminationRequested = true
    this.termination ??= outcome
  }

  decide(): DelegatedSettlementDecision {
    if (this.decided) return { kind: 'wait' }

    // First, because it is the one answer that does not need a close. A
    // survivor can hold the child's stdout open, so waiting for `close` here
    // would hang the caller on a run that has already failed. A close that did
    // arrive proves only that the direct child is gone, which is not the
    // question.
    if (this.termination && !this.termination.terminated) {
      this.decided = true
      return {
        kind: 'abandon',
        cause: 'unconfirmed_termination',
        message: describeUnconfirmedTermination(this.termination.reason),
        releaseResources: false,
      }
    }

    // A cancellation that has started but not come back is not something a
    // close can answer. The direct child obeying SIGTERM is the ordinary shape
    // of cancellation and says nothing about the rest of its group.
    if (this.terminationRequested && !this.termination) return { kind: 'wait' }

    // Otherwise the close is what completes the run: it carries the exit status
    // and it is the point at which the child's output is all in.
    if (!this.childClose) return { kind: 'wait' }

    // The child's nested Teams and file-parser runs live in their own groups,
    // so its close says nothing about them. A descendant that could not be
    // verified gone may be using the same private directory.
    if (this.closesSubtree) {
      if (!this.subtreeClosure) return { kind: 'wait' }
      if (!this.subtreeClosure.closed) {
        this.decided = true
        return {
          kind: 'abandon',
          cause: 'held_subtree',
          message: describeHeldSubtree(this.subtreeClosure.reason),
          releaseResources: false,
        }
      }
    }
    this.decided = true
    return {
      kind: 'report',
      close: this.childClose,
      releaseResources: true,
    }
  }
}

/**
 * Say what was observed, and that the leftover directory is deliberate.
 *
 * A directory nobody removed reads as a leak unless the run says otherwise, and
 * whoever finds it needs to know a process may still be writing to it.
 */
function describeUnconfirmedTermination(reason: string): string {
  return (
    `${reason} Cancellation cannot be reported as complete. ` +
    `The run's private Pi agent directory was intentionally retained: ` +
    `a process in that group may still be using it.`
  )
}

function describeHeldSubtree(reason: string): string {
  return (
    `A descendant of this child could not be verified gone: ${reason} ` +
    `The step cannot be reported as settled. ` +
    `The run's private Pi agent directory was intentionally retained: ` +
    `a process in that subtree may still be using it.`
  )
}
