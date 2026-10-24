/**
 * Finishing the turns whose process never came back.
 *
 * Nothing in the live path can close these. A turn records that it began, asks
 * a provider, and records its ending when the answer arrives — so a process
 * that dies inside that call leaves a record with a beginning, no ending, an
 * admission slot held open, and a user looking at a question with no answer
 * under it. The promise that would have recorded the ending died with the
 * process, and no later request goes anywhere near it.
 *
 * So the next process to open the session finishes them, on the evidence
 * alone. Two rules bound what that is allowed to mean:
 *
 * - It never asks a provider anything. An abandoned call may have run and may
 *   not have; re-running it would double whatever it did. Only the user may
 *   ask for that, and their retry is a new turn with a new identity.
 * - It never invents a reply. An interruption is recorded as an outcome beside
 *   the transcript, never as assistant prose inside it, because prose in the
 *   transcript becomes context for every later turn.
 *
 * Bounded on purpose. The unresolved set is read from the conversation's own
 * admission document rather than by scanning its history, and the number of
 * turns examined per pass is fixed — so opening a session costs the same
 * whether it holds three turns or three thousand.
 */
import type { ChatMessage, ConversationTurnOutcome } from '../contracts/sessions.js'
import type { AgentTurnSummary } from '../domains/agent-execution/agent-turn-journal.js'
import {
  reduceConversationTurnStream,
  type ConversationTurnSummary,
} from '../domains/conversations/conversation-turn-journal.js'
import {
  classifyInterruptedTurn,
  type InterruptedTurnVerdict,
} from '../domains/conversations/interrupted-turn-classification.js'
import { logProcessWarning } from '../domains/runtime/logger.js'
import type { AgentTextStreamHub } from '../domains/runtime/agent-text-stream-hub.js'
import type { ConversationOwner } from '../core/conversation-activity-location.js'
import {
  conversationRetentionRoot,
  readRetentionDocument,
} from './conversation-terminal-ledger.js'
import { resolveAgentTurnJournalRecorder } from './agent-turn-journal-recorder.js'
import { resolveConversationTurnJournalRecorder } from './conversation-turn-journal-recorder.js'
import type { WorkspaceConversationJournalRegistry } from './workspace-conversation-journal-registry.js'
import type { WorkspaceExecutionJournalRegistry } from './workspace-execution-journal-registry.js'

/**
 * How many unresolved turns one pass examines.
 *
 * A session load is a live request, and the admission cap keeps the unresolved
 * set small, so this only has to be large enough that a session opened after a
 * crash is not left with a visible backlog. Successive loads cover the rest.
 */
const RECOVERY_BUDGET_PER_PASS = 8

/**
 * How many replyless user turns one transcript read explains.
 *
 * Separate from the budget above because it answers a different question: not
 * "what still needs finishing" but "what does the user see". Bounded for the
 * same reason — a long conversation must not make opening it cost more than a
 * short one. The most recent turns are the ones on screen, so they are the
 * ones explained.
 */
const OUTCOME_PROJECTION_LIMIT = 20

export interface InterruptedAgentChatRecoveryInput {
  readonly workspacePath: string
  readonly sessionId: string
  readonly conversationRegistry: WorkspaceConversationJournalRegistry
  /** Absent where this composition records no agent-turn evidence. */
  readonly executionRegistry?: WorkspaceExecutionJournalRegistry | undefined
  /** The transcript as it stands, already validated by the store. */
  readonly messages: readonly ChatMessage[]
  /** Live stream ownership, so a turn still running is left alone. */
  readonly hub?: AgentTextStreamHub | undefined
  readonly limit?: number | undefined
}

/**
 * Finish what can be finished, then say what every replyless turn became.
 *
 * The two halves are deliberately one call. Recovery changes the answer to the
 * second question, and a caller that ran them separately would have to know
 * the ordering — which is exactly the kind of knowledge that stops being true
 * when somebody adds a third caller.
 */
export async function recoverInterruptedAgentChatTurns(
  input: InterruptedAgentChatRecoveryInput,
): Promise<readonly ConversationTurnOutcome[]> {
  const owner: ConversationOwner = {
    kind: 'run-session',
    conversationId: input.sessionId,
    sessionId: input.sessionId,
  }

  for (const turnId of await unresolvedTurnIds(input, owner)) {
    // Every failure here is swallowed on purpose. Recovery is housekeeping laid
    // over a read the user is waiting on: a session that cannot be repaired
    // must still open, showing the turn as unresolved, rather than refusing to
    // load at all.
    await recoverOneTurn(input, owner, turnId).catch((error: unknown) => {
      logProcessWarning(
        'interrupted-chat-recovery',
        `Turn ${turnId} in session ${input.sessionId} could not be recovered ` +
          `this pass (${error instanceof Error ? error.name : 'unknown fault'}).`,
      )
    })
  }

  return projectOutcomes(input, owner)
}

/**
 * The turns holding an admission slot, bounded and newest-first.
 *
 * Read from the admission document rather than by listing activities: the
 * document is the one place that already knows, and listing would make opening
 * a session cost its whole history.
 */
async function unresolvedTurnIds(
  input: InterruptedAgentChatRecoveryInput,
  owner: ConversationOwner,
): Promise<readonly string[]> {
  const root = conversationRetentionRoot({
    workspacePath: input.workspacePath,
    owner,
  })
  if (!root) return []
  const stored = await readRetentionDocument(root).catch(
    () => 'damaged' as const,
  )
  // A damaged document is not proof that nothing is open. It is proof that
  // this pass cannot tell, and repairing state on a reading it does not trust
  // is how a cache becomes an authority.
  //
  // Reported, though. Nothing above this sees it — the pass absorbs its own
  // faults so a session still opens — so without a line here a conversation
  // whose admission record cannot be read would leave every turn `pending`
  // forever with no diagnostic anywhere.
  if (stored === 'damaged') {
    logProcessWarning(
      'interrupted-chat-recovery',
      `Session ${input.sessionId} has an unreadable admission record; no turn ` +
        'was recovered this pass.',
    )
    return []
  }
  const open = [...stored.openTurnIds]
  if (open.length === 0) return []
  // The turns the user is most likely looking at. A conversation over the cap
  // still gets the rest on later loads.
  const ordering = new Map(
    input.messages.map((message, index) => [message.turnId, index] as const),
  )
  return open
    .sort((left, right) => (ordering.get(right) ?? -1) - (ordering.get(left) ?? -1))
    .slice(0, input.limit ?? RECOVERY_BUDGET_PER_PASS)
}

async function recoverOneTurn(
  input: InterruptedAgentChatRecoveryInput,
  owner: ConversationOwner,
  turnId: string,
): Promise<void> {
  // Asked before anything is opened. A turn still running in this process owns
  // its own journals, and a recovery that took a lease out from under it would
  // race the live path for the same terminal.
  if (input.hub?.isOpen(turnId)) return

  const conversation = await readConversationSummary(input, owner, turnId)
  if (!conversation) return

  const evidence = await readAssignmentSummaries(input, turnId, conversation)
  if (evidence.kind === 'unreadable') {
    // Fail closed. The classifier reads "no assignment named" as a turn that
    // died before its provider was reached and terminalizes it — so a read
    // that merely failed must never arrive looking like one that succeeded and
    // found nothing.
    logProcessWarning(
      'interrupted-chat-recovery',
      `Turn ${turnId} in session ${input.sessionId} names an assignment this ` +
        'pass could not read; its slot is kept.',
    )
    return
  }
  const verdict = classifyInterruptedTurn({
    turnId,
    conversation,
    assignments: evidence.summaries,
    durableAssistantMessageIds: durableRepliesFor(input.messages, turnId),
    // Re-checked, because opening the journals above is real time in which a
    // new turn carrying this identity could have claimed the channel.
    liveInProcess: input.hub?.isOpen(turnId) === true,
  })

  if (verdict.kind === 'indeterminate') {
    // Named, never quoted. The reason is a closed diagnostic identifier and
    // this line goes to the process log.
    logProcessWarning(
      'interrupted-chat-recovery',
      `Turn ${turnId} in session ${input.sessionId} holds evidence this build ` +
        `cannot act on (${verdict.reason}); its slot is kept.`,
    )
    return
  }
  if (verdict.kind === 'live' || verdict.kind === 'terminal') return

  if (verdict.kind === 'reconcilable') {
    // A turn that succeeded and lost the process before either terminal
    // landed. Nothing else closes it: the replay path only runs when the same
    // turn id is submitted again, and for a turn whose answer the user can
    // already read that never happens — so its admission slot would be held
    // for a conversation that finished.
    await reconcileDurableTurn(input, owner, turnId, evidence.summaries)
    return
  }

  // The aggregate is a claim about every assignment beneath it, so it may only
  // be closed once each of them is proven ended. Closing it over an assignment
  // still reading as in flight would leave a record contradicting itself — and
  // release the slot, so nothing would come back to finish the job.
  if (!(await terminalizeAssignments(input, turnId, verdict))) {
    logProcessWarning(
      'interrupted-chat-recovery',
      `Turn ${turnId} in session ${input.sessionId} kept its slot: an ` +
        'assignment it names could not be ended this pass.',
    )
    return
  }
  await terminalizeConversation(input, owner, turnId, verdict)
}

/**
 * Fail every assignment the turn left in flight.
 *
 * The assignments come first. Their journals are the authority for what each
 * reply did, and the aggregate above them is a claim about all of them: an
 * aggregate closed while an assignment still read as in-flight would be a
 * record contradicting itself, and the contradiction would survive whichever
 * of the two writes failed.
 */
async function terminalizeAssignments(
  input: InterruptedAgentChatRecoveryInput,
  turnId: string,
  verdict: Extract<
    InterruptedTurnVerdict,
    { kind: 'interrupted' } | { kind: 'reply-lost' }
  >,
): Promise<boolean> {
  const registry = input.executionRegistry
  // Nothing to end. A turn that named no assignment has no execution record
  // for the aggregate to contradict.
  if (verdict.unresolvedAssignmentIds.length === 0) return true
  if (!registry) return false
  for (const assignmentId of verdict.unresolvedAssignmentIds) {
    const recorder = await resolveAgentTurnJournalRecorder({
      registry,
      scope: { sessionId: input.sessionId, runId: turnId, assignmentId },
      agentPath: 'agents/unknown',
      requestId: `chat-recovery-${assignmentId}`,
      processIdentity: `chat-recovery-${input.sessionId}`,
    }).catch(() => undefined)
    // No handle, no proof. `undefined` here means the journal could not be
    // borrowed — held elsewhere, unenrolled, unreachable — and treating that as
    // a completed job is what would let the aggregate close over it.
    if (!recorder) return false
    try {
      // Read again under the lease. The summary the verdict was formed from was
      // taken without one, and a turn that reached its own terminal in between
      // must not have a second, contradicting one written over it.
      const summary = await recorder.readSummary()
      // Contradictory, not empty. This assignment is in the verdict precisely
      // because a read a moment ago found it in flight, and an append-only
      // journal cannot lose that. `null` here means the handle is not the one
      // that was read, and proving a terminal from it is not possible.
      if (summary === null) {
        logProcessWarning(
          'interrupted-chat-recovery',
          `Assignment ${assignmentId} for turn ${turnId} reads as empty after ` +
            'being seen in flight; its slot is kept.',
        )
        return false
      }
      if (
        summary.state !== 'provider_in_progress' &&
        summary.state !== 'reply_pending'
      ) {
        // Already ended, by this pass or by the process that owned it.
        continue
      }
      await recorder.recordFailed({
        turnId,
        replyId: summary.replyId,
        // No reply id, whatever the preparation intended. A terminal naming a
        // message means that message is durable, and the whole reason this
        // turn is here is that it is not.
        ...(summary.route === undefined ? {} : { route: summary.route }),
        failure:
          verdict.kind === 'interrupted'
            ? {
                layer: 'chat-delivery',
                phase: 'provider-request',
                serviceCode: 'provider_interrupted',
                retryable: true,
              }
            : {
                layer: 'chat-persistence',
                phase: 'assistant-persistence',
                serviceCode: 'assistant_message_not_stored',
                retryable: true,
              },
      })
    } catch (error) {
      logProcessWarning(
        'interrupted-chat-recovery',
        `Assignment ${assignmentId} for turn ${turnId} could not be ended ` +
          `(${error instanceof Error ? error.name : 'unknown fault'}).`,
      )
      return false
    } finally {
      await recorder.release()
    }
  }
  return true
}

/**
 * Close the aggregate and, in the same step, give the admission slot back.
 *
 * The recorder owns that pairing already: recording a terminal is what
 * releases the slot, so recovery cannot end a turn and forget to release it,
 * or release one it never ended.
 */
async function terminalizeConversation(
  input: InterruptedAgentChatRecoveryInput,
  owner: ConversationOwner,
  turnId: string,
  verdict: Extract<
    InterruptedTurnVerdict,
    { kind: 'interrupted' } | { kind: 'reply-lost' }
  >,
): Promise<void> {
  const recorder = await resolveConversationTurnJournalRecorder({
    registry: input.conversationRegistry,
    owner,
    turnId,
    workspacePath: input.workspacePath,
  })
  if (!recorder) return
  try {
    const summary = await recorder.readSummary()
    if (summary.state !== 'started' && summary.state !== 'prepared') return
    await recorder.recordFailed(
      verdict.kind === 'interrupted'
        ? { failure: { code: 'provider_interrupted', phase: 'provider' } }
        : {
            failure: { code: 'reply_not_published', phase: 'publication' },
            assistantMessageIds: durableRepliesFor(input.messages, turnId),
          },
    )
  } finally {
    await recorder.release()
  }
}

/**
 * Explain the user turns that have no answer under them.
 *
 * Only those: a turn with its replies on the transcript explains itself, and
 * emitting an outcome for it would put a second account of the same turn on
 * screen beside the first.
 */
async function projectOutcomes(
  input: InterruptedAgentChatRecoveryInput,
  owner: ConversationOwner,
): Promise<readonly ConversationTurnOutcome[]> {
  const answered = new Set(
    input.messages
      .filter((message) => message.role === 'assistant' && message.turnId)
      .map((message) => message.turnId),
  )
  const unanswered = input.messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.turnId !== undefined &&
        !answered.has(message.turnId),
    )
    .slice(-OUTCOME_PROJECTION_LIMIT)

  const outcomes: ConversationTurnOutcome[] = []
  for (const message of unanswered) {
    const turnId = message.turnId
    if (turnId === undefined) continue
    if (input.hub?.isOpen(turnId)) {
      outcomes.push({ turnId, state: 'pending' })
      continue
    }
    const summary = await readConversationSummary(input, owner, turnId)
    const outcome = outcomeOf(turnId, summary)
    if (!outcome) continue
    if (outcome.state === 'pending' || !outcome.retryable) {
      outcomes.push(outcome)
      continue
    }
    // Only for an outcome the user can act on. Reading the assignment journals
    // costs a file open each, and an outcome nobody may retry has no use for
    // the addressee it would find.
    const agentNames = summary
      ? await readAddressees(input, turnId, summary)
      : []
    outcomes.push(
      agentNames.length > 0 ? { ...outcome, agentNames } : outcome,
    )
  }
  return outcomes
}

/**
 * One turn's durable state, as the user is told it.
 *
 * `undefined` where there is nothing to say. A turn with no conversation
 * record at all predates journaling or belongs to a build that had none, and
 * inventing an outcome for it would report a failure nobody observed.
 */
function outcomeOf(
  turnId: string,
  summary: ConversationTurnSummary | undefined,
): ConversationTurnOutcome | undefined {
  if (!summary || summary.state === 'absent') return undefined
  if (summary.state === 'started' || summary.state === 'prepared') {
    // Unresolved, and this pass could not or would not settle it. Pending is
    // the honest answer: claiming a failure for a turn that may still be
    // running elsewhere would be the fail-open this whole path avoids.
    return { turnId, state: 'pending' }
  }
  if (summary.state === 'completed') {
    // Every reply it claimed is durable, so the transcript disagreeing with it
    // is a transcript problem, not this turn's outcome to report.
    return undefined
  }
  if (summary.state === 'cancelled') {
    return { turnId, state: 'cancelled', code: 'cancelled', retryable: true }
  }
  if (summary.state === 'invalid') {
    return {
      turnId,
      state: 'failed',
      code: 'evidence_unreadable',
      retryable: false,
    }
  }
  switch (summary.failure?.code) {
    case 'provider_interrupted':
      return {
        turnId,
        state: 'interrupted',
        code: 'provider_interrupted',
        retryable: true,
      }
    case 'reply_not_published':
      return {
        turnId,
        state: 'reply-lost',
        code: 'reply_not_published',
        retryable: true,
      }
    case 'provider_failed':
      return {
        turnId,
        state: 'failed',
        code: 'provider_failed',
        retryable: true,
      }
    case 'preparation_failed':
      return {
        turnId,
        state: 'failed',
        code: 'preparation_failed',
        retryable: true,
      }
    case 'plan_conflict':
      return {
        turnId,
        state: 'failed',
        code: 'plan_conflict',
        retryable: false,
      }
    default:
      // A terminal this build cannot name. Saying so is better than picking a
      // neighbouring code and offering a retry the record does not support.
      return {
        turnId,
        state: 'failed',
        code: 'evidence_unreadable',
        retryable: false,
      }
  }
}

/**
 * Read one turn's aggregate without touching it.
 *
 * A snapshot rather than a lease: acquiring the activity the way a writer does
 * would create a journal that was never there and truncate a torn tail, so the
 * act of asking what happened would destroy part of the answer.
 */
async function readConversationSummary(
  input: InterruptedAgentChatRecoveryInput,
  owner: ConversationOwner,
  turnId: string,
): Promise<ConversationTurnSummary | undefined> {
  const snapshot = await input.conversationRegistry
    .snapshot({ owner, activityId: turnId, activityKind: 'turn' })
    .catch((error: unknown) => {
      // A read that failed says nothing about the turn, so it must not be
      // reported as one that ended — but it is still something an operator
      // should be able to find, because a conversation whose activities cannot
      // be read will silently stop being explained.
      logProcessWarning(
        'interrupted-chat-recovery',
        `Turn ${turnId} in session ${input.sessionId} could not be read ` +
          `(${error instanceof Error ? error.name : 'unknown fault'}).`,
      )
      return 'unreadable' as const
    })
  if (snapshot === 'unreadable') {
    return { turnId, state: 'invalid', assistantMessageIds: [] }
  }
  if (snapshot.kind === 'absent') return undefined
  if (snapshot.kind !== 'read') {
    return {
      turnId,
      state: 'invalid',
      assistantMessageIds: [],
    }
  }
  return reduceConversationTurnStream(
    turnId,
    snapshot.events.map((event) => ({
      type: event.type,
      payload: event.payload,
    })),
  )
}

/**
 * What every assignment the conversation named says about itself.
 *
 * Reports whether the whole set could be read, not just what it found. The
 * difference decides an outcome: a turn that named no assignment died before
 * reaching a provider and can be terminalized, while a turn whose assignments
 * could not be opened is one nobody can judge — and reporting the second as
 * the first releases an admission slot and writes a terminal on evidence this
 * pass never saw.
 */
async function readAssignmentSummaries(
  input: InterruptedAgentChatRecoveryInput,
  turnId: string,
  conversation: ConversationTurnSummary,
): Promise<
  | { readonly kind: 'read'; readonly summaries: readonly AgentTurnSummary[] }
  | { readonly kind: 'unreadable' }
> {
  const registry = input.executionRegistry
  const links = conversation.assignments ?? []
  if (links.length === 0) return { kind: 'read', summaries: [] }
  // Links exist and there is nothing to read them with. Not an empty set: this
  // build cannot see the evidence the record points at.
  if (!registry) return { kind: 'unreadable' }
  const summaries: AgentTurnSummary[] = []
  for (const link of links) {
    let recorder
    try {
      recorder = await resolveAgentTurnJournalRecorder({
        registry,
        scope: {
          sessionId: input.sessionId,
          runId: turnId,
          assignmentId: link.assignmentId,
        },
        agentPath: 'agents/unknown',
        requestId: `chat-recovery-read-${link.assignmentId}`,
        processIdentity: `chat-recovery-${input.sessionId}`,
      })
    } catch (error) {
      logProcessWarning(
        'interrupted-chat-recovery',
        `Assignment ${link.assignmentId} for turn ${turnId} could not be ` +
          `opened (${error instanceof Error ? error.name : 'unknown fault'}).`,
      )
      return { kind: 'unreadable' }
    }
    // A named assignment with no journal to open is evidence this build cannot
    // account for, in a record that plainly expected one.
    if (!recorder) return { kind: 'unreadable' }
    try {
      const summary = await recorder.readSummary()
      // `null` is a journal holding no `agent.turn` stream at all: the
      // assignment was created and the turn never began on it. That is a fact,
      // not a failed read, and the classifier is entitled to act on it.
      if (summary) summaries.push(summary)
    } catch (error) {
      logProcessWarning(
        'interrupted-chat-recovery',
        `Assignment ${link.assignmentId} for turn ${turnId} could not be ` +
          `read (${error instanceof Error ? error.name : 'unknown fault'}).`,
      )
      return { kind: 'unreadable' }
    } finally {
      await recorder.release()
    }
  }
  return { kind: 'read', summaries }
}

/**
 * Close a turn that finished, from the evidence that it finished.
 *
 * Only on proof, and only what the preparation already decided. Recovery does
 * not judge whether a reply was good — the preparation recorded that, and a
 * completion here restates it. What it must never do is invent a success for a
 * reply the transcript cannot show.
 */
async function reconcileDurableTurn(
  input: InterruptedAgentChatRecoveryInput,
  owner: ConversationOwner,
  turnId: string,
  assignments: readonly AgentTurnSummary[],
): Promise<void> {
  const registry = input.executionRegistry
  const durable = new Set(durableRepliesFor(input.messages, turnId))
  // Narrowed into its own shape rather than filtered in place: the two fields
  // the append needs are optional on the summary, and a filter does not carry
  // that knowledge to the loop below.
  const needsClosing = assignments.flatMap((summary) =>
    summary.state === 'reply_pending' &&
    summary.assistantMessageId !== undefined &&
    durable.has(summary.assistantMessageId) &&
    summary.route !== undefined
      ? [
          {
            assignmentId: summary.assignmentId,
            replyId: summary.replyId,
            assistantMessageId: summary.assistantMessageId,
            route: summary.route,
            ...(summary.failureAtPreparation === undefined
              ? {}
              : { failureAtPreparation: summary.failureAtPreparation }),
          },
        ]
      : [],
  )
  if (needsClosing.length > 0) {
    // The aggregate's completion is a claim about every assignment beneath it.
    // Closing it while one of them still reads as `reply_pending` would leave a
    // record contradicting itself, and release the slot that is the only thing
    // bringing a later pass back to finish the job.
    if (!registry) return
    for (const summary of needsClosing) {
      const recorder = await resolveAgentTurnJournalRecorder({
        registry,
        scope: {
          sessionId: input.sessionId,
          runId: turnId,
          assignmentId: summary.assignmentId,
        },
        agentPath: 'agents/unknown',
        requestId: `chat-recovery-close-${summary.assignmentId}`,
        processIdentity: `chat-recovery-${input.sessionId}`,
      }).catch(() => undefined)
      // No handle, no proof, no completion. An unavailable journal is not a
      // finished one.
      if (!recorder) {
        logProcessWarning(
          'interrupted-chat-recovery',
          `Turn ${turnId} in session ${input.sessionId} kept its slot: the ` +
            `terminal for assignment ${summary.assignmentId} could not be ` +
            'appended this pass.',
        )
        return
      }
      try {
        // The preparation's own verdict, not a fresh one. A reply prepared as a
        // provider failure is still a failure once it is durable, and closing
        // it as a completion would turn an honest record into a false one.
        if (summary.failureAtPreparation) {
          await recorder.recordFailed({
            turnId,
            replyId: summary.replyId,
            assistantMessageId: summary.assistantMessageId,
            route: summary.route,
            failure: summary.failureAtPreparation,
          })
        } else {
          await recorder.recordCompleted({
            turnId,
            replyId: summary.replyId,
            assistantMessageId: summary.assistantMessageId,
            route: summary.route,
          })
        }
      } catch (error) {
        logProcessWarning(
          'interrupted-chat-recovery',
          `Turn ${turnId} in session ${input.sessionId} kept its slot ` +
            `(${error instanceof Error ? error.name : 'unknown fault'}).`,
        )
        return
      } finally {
        await recorder.release()
      }
    }
  }

  const recorder = await resolveConversationTurnJournalRecorder({
    registry: input.conversationRegistry,
    owner,
    turnId,
    workspacePath: input.workspacePath,
  })
  if (!recorder) return
  try {
    const summary = await recorder.readSummary()
    if (summary.state !== 'prepared') return
    if (!summary.assistantMessageIds.every((identity) => durable.has(identity))) {
      return
    }
    await recorder.recordCompleted({
      assistantMessageIds: summary.assistantMessageIds,
    })
  } finally {
    await recorder.release()
  }
}

/**
 * Who this turn asked, as names a router will accept.
 *
 * Read from the assignments' own `started` events, which are the only durable
 * record of the addressee. Anything that is not a plain agent path is dropped
 * rather than repaired: this value becomes a routing instruction, and a name
 * this build cannot vouch for is one it must not send anybody to.
 */
async function readAddressees(
  input: InterruptedAgentChatRecoveryInput,
  turnId: string,
  conversation: ConversationTurnSummary,
): Promise<readonly string[]> {
  const evidence = await readAssignmentSummaries(input, turnId, conversation)
  if (evidence.kind !== 'read') return []
  const names: string[] = []
  for (const summary of evidence.summaries) {
    const name = agentNameOf(summary.agentPath)
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** The trailing segment of `agents/<name>`, when it is one. */
function agentNameOf(agentPath: string | undefined): string | undefined {
  if (agentPath === undefined) return undefined
  const prefix = 'agents/'
  if (!agentPath.startsWith(prefix)) return undefined
  const name = agentPath.slice(prefix.length)
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(name) ? name : undefined
}

function durableRepliesFor(
  messages: readonly ChatMessage[],
  turnId: string,
): readonly string[] {
  return messages
    .filter(
      (message) => message.role === 'assistant' && message.turnId === turnId,
    )
    .map((message) => message.id)
}
