/**
 * The narrow port a conversation turn writes its lifecycle through.
 *
 * The lifecycle writer should not know about leases, expected revisions or
 * append outcomes; it should know that a turn starts before the provider is
 * called, prepares before the assistant message is written, and terminates
 * after. Everything else belongs here.
 *
 * One turn is one activity, so the activity id *is* the turn id. That keeps a
 * replay locatable from the request alone — given a turn id, its journal is at
 * a derivable path — and keeps each activity bounded, which is the whole reason
 * the physical journal is per-activity rather than per-session.
 *
 * Ordering is enforced by the journal itself rather than by this class: each
 * stage appends at a fixed expected stream revision, so a stage arriving out of
 * order is a revision conflict rather than a silently accepted event.
 */
import type { ExecutionJournalAppendOutcome } from '../contracts/execution-journal.js'
import {
  CONVERSATION_TURN_CANCELLED_EVENT_TYPE,
  CONVERSATION_TURN_COMPLETED_EVENT_TYPE,
  CONVERSATION_TURN_FAILED_EVENT_TYPE,
  CONVERSATION_TURN_PAYLOAD_SCHEMA_VERSION,
  CONVERSATION_TURN_PREPARED_EVENT_TYPE,
  CONVERSATION_TURN_STARTED_EVENT_TYPE,
  CONVERSATION_TURN_STREAM_KIND,
  buildConversationTurnCancelledPayload,
  buildConversationTurnCompletedPayload,
  buildConversationTurnFailedPayload,
  buildConversationTurnPreparedPayload,
  buildConversationTurnStartedPayload,
  conversationTurnEventId,
  reduceConversationTurnStream,
  type ConversationTurnFailurePhase,
  type ConversationTurnSummary,
} from '../domains/conversations/conversation-turn-journal.js'
import { logProcessWarning } from '../domains/runtime/logger.js'
import { sweepConversationActivities } from './conversation-activity-sweeper.js'
import {
  reconcileConversationReservations,
  releaseConversationActivity,
  reserveConversationActivity,
} from './conversation-admission-reservation.js'
import { ConversationJournalUnavailableError } from './workspace-conversation-journal-registry.js'
import type {
  ConversationJournalLease,
  ConversationOwner,
  WorkspaceConversationJournalRegistry,
} from './workspace-conversation-journal-registry.js'

/**
 * How many activities one turn will spend on housekeeping.
 *
 * Deliberately tiny. Deletion is not urgent and the sweep's window rotates, so
 * the set is covered across turns rather than in one; the cost that matters is
 * what a single turn pays, and it must not grow with the conversation.
 */
const SWEEP_BUDGET_PER_TURN = 4

/** How many reserved ids one turn re-checks. Fixed cost, rotating coverage. */
const RECONCILE_BUDGET_PER_TURN = 4

/** Fixed per stage, so an out-of-order append is refused by the journal. */
const STARTED_REVISION = 0
const PREPARED_REVISION = 1

export interface ConversationTurnJournalRecorder {
  recordStarted(input: {
    readonly surface: string
    readonly userMessageId: string
    readonly requestDigest: string
    readonly expectedResponseCount: number
    readonly origin: string
    readonly requestedProvider?: string | undefined
    readonly requestedModel?: string | undefined
  }): Promise<void>
  recordPrepared(input: {
    readonly assistantMessageIds: readonly string[]
    /** Where each claimed reply is executed, for the turns that delegate. */
    readonly assignments?: readonly {
      readonly assignmentId: string
      readonly assistantMessageId: string
    }[]
    readonly decision?: unknown
    readonly provider?: unknown
  }): Promise<void>
  recordCompleted(input: {
    readonly assistantMessageIds: readonly string[]
  }): Promise<void>
  recordFailed(input: {
    readonly failure: { readonly code: string; readonly phase: string }
    readonly assistantMessageIds?: readonly string[] | undefined
    readonly provider?: unknown
  }): Promise<void>
  recordCancelled(input: {
    readonly phase: ConversationTurnFailurePhase
    readonly provider?: unknown
  }): Promise<void>
  /** What the durable stream says about this turn right now. */
  readSummary(): Promise<ConversationTurnSummary>
  /**
   * Give back what a turn that never began is holding.
   *
   * Evidence, not error handling: it releases only what a scan proves is empty.
   * An activity that holds anything is the record of a turn that may well have
   * started, and discarding it because a later step failed is how an operator
   * loses the thing they needed most.
   */
  abandon(): Promise<void>
  release(): Promise<void>
}

/**
 * Borrow this turn's journal, or `undefined` when conversation journaling is
 * switched off. A throw means the journal is enrolled but unreachable, which
 * must fail the turn closed rather than publish without evidence.
 */
export async function resolveConversationTurnJournalRecorder(input: {
  readonly registry: WorkspaceConversationJournalRegistry
  readonly owner: ConversationOwner
  readonly turnId: string
  /** Enables retention; omitted leaves the limits unenforced. */
  readonly workspacePath?: string
  /** Injected so the cap is testable without seeding a hundred turns. */
  readonly maxUnresolved?: number
}): Promise<ConversationTurnJournalRecorder | undefined> {
  // Enrollment is settled before anything else happens. Sweeping, reconciling
  // and reserving all write to the conversation's sidecars, and a build with
  // journalling switched off has no business creating an admission document or
  // a retention record for a conversation it is not journalling. Deciding this
  // after the housekeeping would mean a disabled restart mutates the
  // conversation on disk and only then discovers it had nothing to do.
  const scope = {
    owner: input.owner,
    activityId: input.turnId,
    activityKind: 'turn' as const,
  }
  const journalling = input.registry.journalMode === 'authoritative'
  if (!journalling) {
    const enrollment = await input.registry.classifyActivityEnrollment(scope)
    // Nothing enrolled: the turn runs without a durability barrier, exactly as
    // switching journalling off is supposed to mean.
    if (enrollment === 'absent') return undefined
    // Evidence this build cannot read is never absence. An activity that
    // plainly exists without a journal to continue has to fail the turn rather
    // than run it with no authority over a record that already exists.
    if (enrollment === 'indeterminate') {
      throw new ConversationJournalUnavailableError(input.turnId)
    }
  }

  if (journalling && input.workspacePath !== undefined) {
    // Two different obligations, deliberately not sharing a code path.
    //
    // Deletion is housekeeping: if it cannot run, chat keeps working and an old
    // activity survives to the next sweep. Failing every conversation in the
    // workspace because a directory could not be read would be the worse
    // outcome, so the fault is surfaced and swallowed.
    await sweepConversationActivities({
      workspacePath: input.workspacePath,
      owner: input.owner,
      registry: input.registry,
      // A small budget, because this runs on a live request. The window rotates,
      // so successive turns still cover the whole set; what must not happen is
      // one turn paying to read the conversation's entire history.
      limit: SWEEP_BUDGET_PER_TURN,
    }).catch((error: unknown) => {
      // Named, not quoted. A sweep failure is an errno about a path inside the
      // workspace, and this line goes to the process log.
      logProcessWarning(
        'conversation-retention',
        `Retention sweep failed for conversation ${input.owner.conversationId}; ` +
          'old activities were not deleted this turn.',
      )
      return undefined
    })

    // A reservation whose turn died before opening its activity would otherwise
    // hold a slot forever. Bounded and rotating: a few reserved ids are checked
    // per turn, so the cost is fixed and every id is eventually revisited.
    await reconcileConversationReservations({
      workspacePath: input.workspacePath,
      owner: input.owner,
      registry: input.registry,
      limit: RECONCILE_BUDGET_PER_TURN,
    }).catch(() => undefined)

    // Admission is authority, and fails closed. A reservation rather than a
    // count: taking the slot and checking for one are the same locked step, so
    // two turns cannot both take the last one, and the cost does not grow with
    // the conversation's history.
    const reservation = await reserveConversationActivity({
      workspacePath: input.workspacePath,
      owner: input.owner,
      turnId: input.turnId,
      ...(input.maxUnresolved === undefined
        ? {}
        : { maxUnresolved: input.maxUnresolved }),
    })
    if (reservation.kind === 'refused') {
      throw new ConversationAdmissionError(
        input.owner.conversationId,
        reservation.unresolvedCount,
      )
    }
    if (reservation.kind === 'indeterminate') {
      throw new ConversationAdmissionError(input.owner.conversationId, -1)
    }
  }

  // Narrowed once and closed over, so the release path needs no assertion about
  // a value that may legitimately be absent.
  const reservedWorkspacePath = input.workspacePath
  const releaseSlot =
    reservedWorkspacePath === undefined || !journalling
      ? undefined
      : async (terminalAtMs?: number) => {
          await releaseConversationActivity({
            workspacePath: reservedWorkspacePath,
            owner: input.owner,
            turnId: input.turnId,
            ...(terminalAtMs === undefined ? {} : { terminalAtMs }),
          })
        }

  // Between taking a slot and opening the activity is a window where the turn
  // can die holding a reservation for a journal that never existed. A failure
  // we can see is given back immediately; a crash is healed by the rotating
  // reconciliation, which is why that exists rather than being decoration.
  let lease
  try {
    lease = await input.registry.acquire(scope)
  } catch (error) {
    await releaseSlot?.()
    throw error
  }
  if (!lease) {
    await releaseSlot?.()
    return undefined
  }

  // The slot was taken before anything could look at whether this turn is
  // already finished. Resolving a turn that reached a terminal is a replay: the
  // caller will return the stored answer without recording anything, so nothing
  // would give the slot back, and enough replays would refuse a healthy
  // conversation all new work.
  //
  // Released on a *proven* terminal only. `absent` is a turn about to begin and
  // `started`/`prepared` are genuinely unresolved, so both keep the slot. So
  // does `invalid`: a stream this build cannot understand is not proof the turn
  // finished, and releasing on it would be the fail-open this rule exists to
  // avoid.
  const recorder = new LeasedConversationTurnRecorder(
    lease,
    input.turnId,
    input.registry,
    scope,
    releaseSlot,
  )
  if (releaseSlot) {
    const summary = await recorder.readSummary().catch(() => undefined)
    if (
      summary?.state === 'completed' ||
      summary?.state === 'failed' ||
      summary?.state === 'cancelled'
    ) {
      await releaseSlot()
    }
  }
  return recorder
}

class LeasedConversationTurnRecorder implements ConversationTurnJournalRecorder {
  constructor(
    private readonly lease: ConversationJournalLease,
    private readonly turnId: string,
    private readonly registry: WorkspaceConversationJournalRegistry,
    private readonly scope: {
      readonly owner: ConversationOwner
      readonly activityId: string
      readonly activityKind: 'turn'
    },
    /** Returns this turn's admission slot once it reaches a terminal. */
    private readonly releaseSlot?: (terminalAtMs?: number) => Promise<void>,
  ) {}

  async recordStarted(input: {
    readonly surface: string
    readonly userMessageId: string
    readonly requestDigest: string
    readonly expectedResponseCount: number
    readonly origin: string
    readonly requestedProvider?: string | undefined
    readonly requestedModel?: string | undefined
  }): Promise<void> {
    // `started` is a claim, not a note. Elsewhere `already-accepted` means a
    // safe replay, but here it means another request got there first: a genuine
    // crash retry never reaches this line, because a stream that already holds
    // `started` is classified before the turn begins. Treating it as success
    // let two concurrent requests both walk on to the provider.
    try {
      await this.append(
        'started',
        STARTED_REVISION,
        CONVERSATION_TURN_STARTED_EVENT_TYPE,
        buildConversationTurnStartedPayload(input),
        { requireAppended: true },
      )
    } catch (error) {
      // The turn is over and the caller is about to see why. Its slot was taken
      // before the activity was opened, so leaving it held means a turn that
      // never began keeps admission pressure until the abandoned-age sweep
      // notices — thirty days later.
      //
      // Except for one failure, which is not this turn's to clean up. When
      // another request already claimed `started` for this identity, that
      // request is live and holds the same slot: reservation is idempotent per
      // turn, so giving it back here would take it out from under a turn that
      // is still running, and that turn's terminal would then find no slot to
      // release and never be projected.
      if (!isLostConversationTurnClaim(error)) await this.abandon()
      throw error
    }
  }

  async recordPrepared(input: {
    readonly assistantMessageIds: readonly string[]
    readonly assignments?: readonly {
      readonly assignmentId: string
      readonly assistantMessageId: string
    }[]
    readonly decision?: unknown
    readonly provider?: unknown
  }): Promise<void> {
    await this.append(
      'prepared',
      PREPARED_REVISION,
      CONVERSATION_TURN_PREPARED_EVENT_TYPE,
      buildConversationTurnPreparedPayload(input),
    )
  }

  async recordCompleted(input: {
    readonly assistantMessageIds: readonly string[]
  }): Promise<void> {
    const atMs = await this.appendTerminal(
      CONVERSATION_TURN_COMPLETED_EVENT_TYPE,
      buildConversationTurnCompletedPayload(input),
    )
    // No time, no release. Giving the slot back without a projection is how a
    // finished turn stops being findable: nothing else remembers it needs
    // projecting, and reconciliation only revisits turns that still hold one.
    if (atMs !== undefined) await this.releaseSlot?.(atMs)
  }

  async recordFailed(input: {
    readonly failure: { readonly code: string; readonly phase: string }
    readonly assistantMessageIds?: readonly string[] | undefined
    readonly provider?: unknown
  }): Promise<void> {
    const atMs = await this.appendTerminal(
      CONVERSATION_TURN_FAILED_EVENT_TYPE,
      buildConversationTurnFailedPayload(input),
    )
    // No time, no release. Giving the slot back without a projection is how a
    // finished turn stops being findable: nothing else remembers it needs
    // projecting, and reconciliation only revisits turns that still hold one.
    if (atMs !== undefined) await this.releaseSlot?.(atMs)
  }

  async recordCancelled(input: {
    readonly phase: ConversationTurnFailurePhase
    readonly provider?: unknown
  }): Promise<void> {
    const atMs = await this.appendTerminal(
      CONVERSATION_TURN_CANCELLED_EVENT_TYPE,
      buildConversationTurnCancelledPayload(input),
    )
    // No time, no release. Giving the slot back without a projection is how a
    // finished turn stops being findable: nothing else remembers it needs
    // projecting, and reconciliation only revisits turns that still hold one.
    if (atMs !== undefined) await this.releaseSlot?.(atMs)
  }

  async readSummary(): Promise<ConversationTurnSummary> {
    const scan = await this.lease.journal.scanStream(
      CONVERSATION_TURN_STREAM_KIND,
      this.turnId,
    )
    return reduceConversationTurnStream(
      this.turnId,
      scan.events.map((event) => ({ type: event.type, payload: event.payload })),
    )
  }

  async abandon(): Promise<void> {
    // The whole journal, not one stream: an activity holding anything at all is
    // not one this turn may forget on its own account.
    const scan = await this.lease.journal.scan().catch(() => undefined)
    if (!scan || scan.events.length > 0) return
    // The lease first, because the registry refuses to remove an activity
    // somebody is holding — and this holder is the one asking.
    await this.lease.release()
    const outcome = await this.registry
      .deleteActivity(this.scope)
      .catch(() => 'busy' as const)
    // Only on proof that nothing is there. Another request for the same turn
    // shares this slot — reservation is idempotent per turn — so a `busy`
    // deletion means the winner is still holding the activity, and releasing
    // anyway would take the slot out from under it and leave its terminal with
    // nothing to release, so it would never be recorded.
    if (outcome !== 'deleted' && outcome !== 'absent') return
    await this.releaseSlot?.()
  }

  async release(): Promise<void> {
    await this.lease.release()
  }

  /**
   * A terminal may follow preparation or replace it, because a turn can fail
   * before it ever produces a reply. Its expected revision is therefore
   * whatever the stream already holds, not a fixed number.
   */
  private async appendTerminal(
    type: string,
    payload: Awaited<ReturnType<typeof buildConversationTurnCompletedPayload>>,
  ): Promise<number | undefined> {
    const scan = await this.lease.journal.scanStream(
      CONVERSATION_TURN_STREAM_KIND,
      this.turnId,
    )
    const outcome = await this.append('terminal', scan.events.length, type, payload)
    // Taken from the append's own outcome, not from a second read of the file.
    // Reading it back was a step that could fail on its own, and a failed
    // readback used to mean the slot was released with no projection at all —
    // which loses the finished turn for good, because reconciliation only ever
    // looks at turns that still hold a slot.
    //
    // The time comes from the journal rather than the clock so that a replay of
    // an old terminal keeps the age it actually has instead of being handed a
    // fresh one.
    const recordedAt =
      outcome.kind === 'appended' || outcome.kind === 'already-accepted'
        ? Date.parse(outcome.event.recordedAt)
        : Number.NaN
    return Number.isFinite(recordedAt) ? recordedAt : undefined
  }

  private async append(
    stage: 'started' | 'prepared' | 'terminal',
    expectedStreamRevision: number,
    type: string,
    payload: Awaited<ReturnType<typeof buildConversationTurnStartedPayload>>,
    options: { readonly requireAppended?: boolean } = {},
  ): Promise<ExecutionJournalAppendOutcome> {
    const outcome = await this.lease.journal.append({
      eventId: conversationTurnEventId(this.turnId, this.turnId, stage),
      streamKind: CONVERSATION_TURN_STREAM_KIND,
      streamId: this.turnId,
      expectedStreamRevision,
      type,
      payloadSchemaVersion: CONVERSATION_TURN_PAYLOAD_SCHEMA_VERSION,
      payload,
      correlationId: this.turnId,
    })
    if (outcome.kind === 'appended') return outcome
    // `already-accepted` is normally the replay case and is success: the same
    // stage with the same content is already durable. A stage that is a claim
    // asks for more than that.
    if (outcome.kind === 'already-accepted' && !options.requireAppended) {
      return outcome
    }
    throw new ConversationTurnRecordingError(this.turnId, stage, outcome.kind)
  }
}

/**
 * Whether this failure means another request already claimed the turn.
 *
 * Exported because the journal is the authority on who is running a turn, and
 * the caller that loses the claim has to answer for it. Narrow on purpose: it
 * is one stage and one outcome, so no other recording failure can be mistaken
 * for a duplicate request.
 */
export function isLostConversationTurnClaim(error: unknown): boolean {
  return (
    error instanceof ConversationTurnRecordingError &&
    error.stage === 'started' &&
    error.outcome === 'already-accepted'
  )
}

export class ConversationTurnRecordingError extends Error {
  readonly turnId: string
  readonly stage: string
  readonly outcome: string

  constructor(turnId: string, stage: string, outcome: string) {
    super(
      `Conversation turn ${turnId} could not record its ${stage} stage: ${outcome}.`,
    )
    this.turnId = turnId
    this.stage = stage
    this.outcome = outcome
    this.name = 'ConversationTurnRecordingError'
  }
}

/**
 * Too many unresolved turns to take another.
 *
 * Not a failure of this turn so much as a report about the conversation: a
 * backlog of turns that started and never finished is a problem to surface, and
 * accepting more work would bury it under the noise.
 */
export class ConversationAdmissionError extends Error {
  readonly conversationId: string
  /** -1 when the count could not be established at all. */
  readonly unresolvedCount: number

  constructor(conversationId: string, unresolvedCount: number) {
    // Two fixed messages, and no room for a third. The reason a count could not
    // be established is an errno message about a path, and this error's text
    // reaches a caller — so it says which conversation and which of the two
    // situations, and nothing it was handed.
    super(
      unresolvedCount < 0
        ? `Conversation ${conversationId} cannot admit a turn because its unresolved count could not be established.`
        : `Conversation ${conversationId} has ${unresolvedCount} unresolved turns and cannot admit another.`,
    )
    this.conversationId = conversationId
    this.unresolvedCount = unresolvedCount
    this.name = 'ConversationAdmissionError'
  }
}
