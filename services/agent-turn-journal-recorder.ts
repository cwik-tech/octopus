import {
  AGENT_TURN_CANCELLED_EVENT_TYPE,
  AGENT_TURN_COMPLETED_EVENT_TYPE,
  AGENT_TURN_PASSED_EVENT_TYPE,
  AGENT_TURN_FAILED_EVENT_TYPE,
  AGENT_TURN_PAYLOAD_SCHEMA_VERSION,
  AGENT_TURN_PREPARED_EVENT_TYPE,
  AGENT_TURN_STARTED_EVENT_TYPE,
  AGENT_TURN_STREAM_KIND,
  agentTurnEventId,
  buildAgentTurnCancelledPayload,
  buildAgentTurnCompletedPayload,
  buildAgentTurnPassedPayload,
  buildAgentTurnFailedPayload,
  buildAgentTurnPreparedPayload,
  buildAgentTurnStartedPayload,
  reduceAgentTurnStream,
  type AgentTurnEventStage,
  type AgentTurnFailureIdentity,
  type AgentTurnFailurePhase,
  type AgentTurnPreparedResolution,
  type AgentTurnPassedPayload,
  type AgentTurnRoute,
  type AgentTurnSummary,
  type AgentTurnTokenUsage,
} from '../domains/agent-execution/agent-turn-journal.js'
import type { CapabilityAssignmentScope } from '../contracts/capability-dispatch.js'
import type { CanonicalJsonObject } from '../contracts/canonical-json.js'
import type { ExecutionJournalEvent } from '../contracts/execution-journal.js'
import type { ExecutionJournal } from '../core/execution-journal.js'
import { appendJournalStreamEvent } from '../core/journal-stream-append.js'
import type { WorkspaceExecutionJournalRegistry } from './workspace-execution-journal-registry.js'

/**
 * Puts one selected-agent chat turn onto its assignment's canonical journal.
 *
 * Thin by design: the domain owns the payloads and the reduction, the registry
 * owns the journal handle and its lock, and this owns only the ordering
 * between them. It never opens a journal of its own — the registry's cached
 * handle is the same one the capability dispatcher writes through, so a turn's
 * lifecycle and the tool calls it caused share one history and one lock
 * (journal ADR §1).
 */

export interface AgentTurnStartedInput {
  readonly turnId: string
  readonly replyId: string
  readonly speakerOrdinal: number
  readonly agentPath: string
  readonly requestedProvider?: string | undefined
  readonly requestedModel?: string | undefined
}

/**
 * The outcome and its explanation arrive together, so a caller cannot record
 * a failure with nothing to explain it — which a reconciliation reading only
 * the outcome would finish as a success.
 */
export type AgentTurnPreparedInput = AgentTurnPreparedResolution & {
  readonly turnId: string
  readonly replyId: string
  readonly assistantMessageId: string
  readonly route: AgentTurnRoute
  readonly resolvedModel?: string | undefined
  readonly declaredToolCount?: number | undefined
  readonly executedToolCount?: number | undefined
  readonly outputByteLength: number
  readonly usage?: AgentTurnTokenUsage | undefined
}

export interface AgentTurnCompletedInput {
  readonly turnId: string
  readonly replyId: string
  readonly assistantMessageId: string
  readonly route: AgentTurnRoute
}

export interface AgentTurnFailedInput {
  readonly turnId: string
  readonly replyId: string
  readonly assistantMessageId?: string | undefined
  readonly route?: AgentTurnRoute | undefined
  readonly failure: AgentTurnFailureIdentity
}

export interface AgentTurnCancelledInput {
  readonly turnId: string
  readonly replyId: string
  readonly assistantMessageId?: string | undefined
  readonly route?: AgentTurnRoute | undefined
  readonly phase: AgentTurnFailurePhase
}

/**
 * The narrow view the chat service holds. Deliberately an interface: the chat
 * service must be testable without a workspace, and nothing here should tempt
 * it into reaching for the registry itself.
 */
export interface AgentTurnJournalRecorder {
  readonly assignmentId: string
  recordStarted(input: AgentTurnStartedInput): Promise<void>
  recordPrepared(input: AgentTurnPreparedInput): Promise<void>
  recordCompleted(input: AgentTurnCompletedInput): Promise<void>
  recordPassed(input: AgentTurnPassedPayload): Promise<void>
  recordFailed(input: AgentTurnFailedInput): Promise<void>
  recordCancelled(input: AgentTurnCancelledInput): Promise<void>
  /** The turn's durable state, as an operator or a retry would read it. */
  readSummary(): Promise<AgentTurnSummary | null>
  /**
   * Give the journal back.
   *
   * A chat assignment never reaches the terminal transition that closes a
   * task's journal, so the turn that borrowed the handle has to return it or
   * the process accumulates one open journal, index, and file descriptor per
   * reply. Idempotent, and non-terminal: the assignment stays reopenable.
   */
  release(): Promise<void>
}

/** Bounds journal resolution for one chat turn. */
const AGENT_TURN_RECORDER_RESOLVE_BUDGET_MS = 30_000

/**
 * Resolve the recorder for one selected-agent reply.
 *
 * `undefined` means this workspace records no agent turns at all — there is no
 * registry, or the assignment is unenrolled under a mode that forbids new
 * enrollment. A registry that *throws* means the authority is enrolled but
 * unreachable, and that propagates: a turn whose start cannot be recorded must
 * not proceed to ask a provider (journal ADR §7).
 */
export async function resolveAgentTurnJournalRecorder(input: {
  readonly registry?: WorkspaceExecutionJournalRegistry | undefined
  readonly scope: CapabilityAssignmentScope
  readonly agentPath: string
  readonly requestId: string
  readonly processIdentity: string
  readonly signal?: AbortSignal | undefined
  /** Derives a view from what this turn records. Optional; never authoritative. */
  readonly observer?: AgentTurnJournalEventObserver | undefined
}): Promise<AgentTurnJournalRecorder | undefined> {
  const { registry } = input
  if (!registry) return undefined
  // A lease rather than the long-lived handle: a chat reply has no terminal
  // transition, so nothing else would ever close this journal.
  const lease = await registry.acquireJournalHandle({
    context: {
      contractVersion: 1,
      requestId: input.requestId,
      sessionId: input.scope.sessionId,
      runId: input.scope.runId,
      assignmentId: input.scope.assignmentId,
      agentPath: input.agentPath,
      authority: {
        kind: 'runtime-assignment',
        processIdentity: input.processIdentity,
      },
    },
    signal: input.signal ?? new AbortController().signal,
    deadlineMs: Date.now() + AGENT_TURN_RECORDER_RESOLVE_BUDGET_MS,
  })
  return lease
    ? createJournalBackedAgentTurnRecorder(
        lease.journal,
        input.scope.assignmentId,
        () => lease.release(),
        input.observer,
      )
    : undefined
}

/**
 * `releaseHandle` is optional so a caller that already owns the journal's
 * lifecycle — an operator report, a test holding its own handle — can record
 * without borrowing anything to give back.
 */
export function createJournalBackedAgentTurnRecorder(
  journal: ExecutionJournal,
  assignmentId: string,
  releaseHandle?: () => Promise<void>,
  observer?: AgentTurnJournalEventObserver,
): AgentTurnJournalRecorder {
  return new JournalBackedAgentTurnRecorder(
    journal,
    assignmentId,
    releaseHandle,
    observer,
  )
}

/**
 * Something that derives a view from agent-turn events as they are appended.
 *
 * Deliberately one method taking the durable event: an observer can read only
 * what the journal accepted, and can add nothing the journal does not hold.
 */
export interface AgentTurnJournalEventObserver {
  observe(event: ExecutionJournalEvent): Promise<void>
}

class JournalBackedAgentTurnRecorder implements AgentTurnJournalRecorder {
  constructor(
    private readonly journal: ExecutionJournal,
    readonly assignmentId: string,
    private readonly releaseHandle?: () => Promise<void>,
    private readonly observer?: AgentTurnJournalEventObserver,
  ) {}

  async release(): Promise<void> {
    await this.releaseHandle?.()
  }

  async recordStarted(input: AgentTurnStartedInput): Promise<void> {
    await this.append('started', 0, AGENT_TURN_STARTED_EVENT_TYPE, input.turnId,
      buildAgentTurnStartedPayload(input),
    )
  }

  async recordPrepared(input: AgentTurnPreparedInput): Promise<void> {
    await this.append('prepared', 1, AGENT_TURN_PREPARED_EVENT_TYPE, input.turnId,
      buildAgentTurnPreparedPayload(input),
    )
  }

  async recordCompleted(input: AgentTurnCompletedInput): Promise<void> {
    await this.appendTerminal(
      AGENT_TURN_COMPLETED_EVENT_TYPE,
      input.turnId,
      buildAgentTurnCompletedPayload(input),
    )
  }

  async recordFailed(input: AgentTurnFailedInput): Promise<void> {
    await this.appendTerminal(
      AGENT_TURN_FAILED_EVENT_TYPE,
      input.turnId,
      buildAgentTurnFailedPayload(input),
    )
  }

  async recordPassed(input: AgentTurnPassedPayload): Promise<void> {
    await this.append('terminal', 1, AGENT_TURN_PASSED_EVENT_TYPE, input.turnId,
      buildAgentTurnPassedPayload(input),
    )
  }

  async recordCancelled(input: AgentTurnCancelledInput): Promise<void> {
    await this.appendTerminal(
      AGENT_TURN_CANCELLED_EVENT_TYPE,
      input.turnId,
      buildAgentTurnCancelledPayload(input),
    )
  }

  async readSummary(): Promise<AgentTurnSummary | null> {
    const stream = await this.scanStream()
    return stream.length === 0
      ? null
      : reduceAgentTurnStream(this.assignmentId, stream)
  }

  /**
   * A terminal sits at revision 2 when a response was prepared and at 1 when
   * the turn exited before preparing one.
   *
   * Read from the stream rather than from memory, because the handle that
   * appends the terminal is not always the handle that appended the start: a
   * retry after a crash reconciles the terminal from what is on disk.
   */
  private async appendTerminal(
    type: string,
    turnId: string,
    payload: CanonicalJsonObject,
  ): Promise<void> {
    const prepared = (await this.scanStream()).some(
      (event) => event.type === AGENT_TURN_PREPARED_EVENT_TYPE,
    )
    await this.append('terminal', prepared ? 2 : 1, type, turnId, payload)
  }

  /**
   * The expected revision is fixed per stage, not derived from the stream.
   *
   * It is part of the append digest, so a replay that recomputed it from a
   * stream the first attempt already advanced would hash differently and be
   * rejected as an identity conflict — turning idempotent recovery into a
   * hard failure.
   */
  private async append(
    stage: AgentTurnEventStage,
    expectedStreamRevision: number,
    type: string,
    turnId: string,
    payload: CanonicalJsonObject,
  ): Promise<void> {
    const event = await appendJournalStreamEvent(this.journal, {
      eventId: agentTurnEventId(this.assignmentId, stage),
      streamKind: AGENT_TURN_STREAM_KIND,
      streamId: this.assignmentId,
      expectedStreamRevision,
      type,
      payloadSchemaVersion: AGENT_TURN_PAYLOAD_SCHEMA_VERSION,
      payload,
      correlationId: turnId,
    })
    // Strictly after the journal accepted it, and from the event the journal
    // returned. The projection derives from what is durable, never from what
    // this recorder intended to write.
    await this.observer?.observe(event)
  }

  private async scanStream() {
    return (
      await this.journal.scanStream(AGENT_TURN_STREAM_KIND, this.assignmentId)
    ).events
  }
}
