/**
 * What a turn nobody watched finish is allowed to be told about itself.
 *
 * A pure function over durable summaries that have already been validated by
 * their own readers. It writes nothing, reads nothing, and asks no provider
 * anything — which is what lets the rule it encodes be stated once and checked
 * without a workspace.
 *
 * The rule it encodes is the conservative one. An unresolved turn is finished
 * on the evidence, never re-run: nobody can tell a provider call that never
 * happened from one that happened and whose answer was lost with the process,
 * and running it again on the user's behalf would be a second charge, a second
 * side effect, and a second set of tool calls for work that may already be
 * done. Only the user may ask for that, and when they do it is a new turn.
 */
import type { AgentTurnSummary } from '../agent-execution/agent-turn-journal.js'
import type { ConversationTurnSummary } from './conversation-turn-journal.js'

/**
 * Everything the classification is allowed to look at.
 *
 * Summaries rather than journals: each has already been reduced by the reader
 * that owns its format, so an unreadable stream arrives here as `invalid`
 * rather than as a decision this has to make about raw bytes.
 */
export interface InterruptedTurnEvidence {
  readonly turnId: string
  readonly conversation: ConversationTurnSummary
  /**
   * The assignments the conversation's preparation named, in the state their
   * own journals report. Empty where the turn never named any — which is a
   * fact about the turn, not a missing read.
   */
  readonly assignments: readonly AgentTurnSummary[]
  /** Assistant message ids this turn actually has on the transcript. */
  readonly durableAssistantMessageIds: readonly string[]
  /**
   * Whether a live turn in this process still owns the reply stream.
   *
   * The one thing the journals cannot say. A healthy turn mid-flight looks
   * exactly like a crashed one on disk for its whole duration, so without this
   * recovery would terminalize turns that are still running.
   */
  readonly liveInProcess: boolean
}

export type InterruptedTurnVerdict =
  /** Someone is still running it. Leave it alone. */
  | { readonly kind: 'live' }
  /** Already ended. Nothing to do. */
  | { readonly kind: 'terminal' }
  /**
   * Every claimed reply is durable and only the aggregate terminal is missing.
   * That is the existing replay reconciliation's job, not this one's: it can
   * close the turn as the success it was, and this cannot.
   */
  | { readonly kind: 'reconcilable' }
  /** A provider call was entered and nobody knows how it ended. */
  | {
      readonly kind: 'interrupted'
      /** Assignments still reading as in-flight, which recovery must fail. */
      readonly unresolvedAssignmentIds: readonly string[]
    }
  /** A reply was prepared and never reached the transcript. */
  | {
      readonly kind: 'reply-lost'
      readonly unresolvedAssignmentIds: readonly string[]
    }
  /** The evidence contradicts itself. Fail closed and say so. */
  | { readonly kind: 'indeterminate'; readonly reason: string }

/**
 * Decide what one unresolved turn is.
 *
 * Ordered by how much authority each answer needs. Liveness comes first
 * because it is the only fact that can make every other reading wrong; proven
 * terminals come next, because a settled turn must never be reopened; and the
 * two recoverable shapes are separated last, on the difference between a reply
 * that was never produced and one that was produced and lost.
 */
export function classifyInterruptedTurn(
  evidence: InterruptedTurnEvidence,
): InterruptedTurnVerdict {
  if (evidence.liveInProcess) return { kind: 'live' }

  const { conversation } = evidence
  if (
    conversation.state === 'completed' ||
    conversation.state === 'failed' ||
    conversation.state === 'cancelled'
  ) {
    return { kind: 'terminal' }
  }
  if (conversation.state === 'invalid') {
    return { kind: 'indeterminate', reason: 'conversation_stream_invalid' }
  }
  if (conversation.state === 'absent') {
    // A slot was taken and the activity holds nothing. That is a turn about to
    // begin as much as it is one that never did, and the reservation
    // reconciliation already decides between them on the manifest's age.
    return { kind: 'indeterminate', reason: 'conversation_stream_absent' }
  }
  if (evidence.assignments.some((turn) => turn.state === 'invalid')) {
    return { kind: 'indeterminate', reason: 'assignment_stream_invalid' }
  }

  const durable = new Set(evidence.durableAssistantMessageIds)
  const claimed = conversation.assistantMessageIds
  if (claimed.length > 0 && claimed.every((identity) => durable.has(identity))) {
    return { kind: 'reconcilable' }
  }

  // In-flight beats prepared-but-unstored when a turn holds both. A turn with
  // one speaker still inside the provider has an unknown outcome as a whole,
  // and calling it a lost reply would claim more than the evidence supports.
  const inFlight = evidence.assignments.filter(
    (turn) => turn.state === 'provider_in_progress',
  )
  if (inFlight.length > 0) {
    return {
      kind: 'interrupted',
      unresolvedAssignmentIds: inFlight.map((turn) => turn.assignmentId),
    }
  }

  const preparedButUnstored = evidence.assignments.filter(
    (turn) =>
      turn.state === 'reply_pending' &&
      (turn.assistantMessageId === undefined ||
        !durable.has(turn.assistantMessageId)),
  )
  if (preparedButUnstored.length > 0) {
    return {
      kind: 'reply-lost',
      unresolvedAssignmentIds: preparedButUnstored.map(
        (turn) => turn.assignmentId,
      ),
    }
  }

  // No assignment is unresolved, and yet the aggregate is still open with
  // replies it cannot account for. Either it named no assignment at all — a
  // turn that died before its provider was ever reached — or every assignment
  // has ended and the replies they were meant to publish are not there.
  return evidence.assignments.length === 0
    ? { kind: 'interrupted', unresolvedAssignmentIds: [] }
    : { kind: 'reply-lost', unresolvedAssignmentIds: [] }
}
