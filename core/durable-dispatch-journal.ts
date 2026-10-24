import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  CanonicalJsonError,
  canonicalizeJson,
  toCanonicalJsonObject,
  type CanonicalJsonObject,
  type CanonicalJsonValue,
} from '../contracts/canonical-json.js'
import type {
  CapabilityAssignmentScope,
  CapabilityApprovalOutcome,
  CapabilityDispatchResult,
  CapabilityInvocationIdentity,
  CapabilitySourceKind,
} from '../contracts/capability-dispatch.js'
import type { CapabilityEffect } from '../contracts/capability-effect.js'
import type {
  CapabilityDispatchResolutionPort,
  CapabilityDurableDispatchPort,
  CapabilityRecoveryPolicy,
  DurableDispatchInspection,
  DurableDispatchRecovery,
  DurableDispatchState,
  DurableDispatchStreamEvent,
  DurableInvocationIdentityBinding,
  OperatorResolutionDecision,
  OperatorResolutionOutcome,
  OperatorResolutionPrincipal,
  OperatorSuppliedResult,
  CapabilityResultContentReceipt,
  CapabilityResultContentStore,
  CapabilityResultRetentionForm,
  CapabilityResultRetentionSummary,
} from '../contracts/durable-dispatch.js'
import {
  CAPABILITY_RESULT_CONTENT_SCHEMA_VERSION,
  CAPABILITY_RESULT_MEDIA_TYPE,
} from '../contracts/durable-dispatch.js'
import {
  ExecutionJournalError,
  type ExecutionJournalEvent,
} from '../contracts/execution-journal.js'
import {
  DURABLE_DISPATCH_STREAM_KIND,
  narrowRecoveryPolicy,
  reduceDurableDispatchState,
  resolveDurableRecovery,
  resolveRecoveryAfterStarted,
} from './durable-dispatch.js'
import type { ExecutionJournal } from './execution-journal.js'
import { appendJournalStreamEvent } from './journal-stream-append.js'
import {
  applyCapabilityEvidenceProjection,
  CAPABILITY_EVIDENCE_PROJECTION_ID,
  catchUpCapabilityEvidenceProjection,
  createCapabilityEvidenceProjectionStore,
  lastDispatchSequence,
} from './capability-dispatch-projection.js'
import type { JournalJsonlProjectionStore } from './journal-projection.js'

export { DURABLE_DISPATCH_STREAM_KIND }

/**
 * The envelope version of a dispatch lifecycle payload. `requested`,
 * `prepared`, `started`, `committed` and the terminal records did not change
 * shape in Phase 3, and bumping them would tell every reader the whole stream
 * is new when only one payload is.
 */
const DISPATCH_PAYLOAD_SCHEMA_VERSION = 1

/**
 * The envelope version of a payload that carries a retained result.
 *
 * Version 1 carried the result: an inline `resultValue`, or a `receipt` naming
 * a file below the journal directory. Version 2 carries only a content
 * identity for the assignment's own store. A reader dispatches on this before
 * it looks at the payload, so the change is declared here rather than inferred
 * from which fields happen to be present.
 */
const DISPATCH_RESULT_PAYLOAD_SCHEMA_VERSION = 2

const INVOCATION_BINDING_STREAM_KIND = 'capability.invocation'
const INVOCATION_BINDING_EVENT_TYPE = 'capability.invocation.bound'
const INVOCATION_BINDING_PAYLOAD_SCHEMA_VERSION = 1

/**
 * The payload v1 retained-result forms, which are read and never written.
 *
 * `inline` put the result value in the event; `receipt` put it in a file below
 * the journal directory. Both are content inside an execution journal, which
 * is what Phase 3 removes; both stay readable, because rewriting an
 * acknowledged journal would break its hash chain
 * (`docs/adr/2026-08-26-Execution-Journal-Content-Separation.md`).
 */
const LEGACY_RESULTS_DIRECTORY_NAME = 'results'
const LEGACY_RESULT_RECEIPT_SCHEMA_VERSION = 1
const LEGACY_RECEIPT_RELATIVE_PATH_PATTERN = /^results\/[a-f0-9]{64}\.json$/

/** A content identity is the lowercase SHA-256 hex of the bytes it names. */
const CONTENT_ID_PATTERN = /^[a-f0-9]{64}$/

interface InvocationIdentityBindingRecord {
  readonly invocation: CapabilityInvocationIdentity
  readonly argumentDigest: string
}

function invocationIdentityBindingPayload(input: {
  readonly invocation: CapabilityInvocationIdentity
  readonly argumentDigest: string
}): CanonicalJsonObject {
  return {
    capabilityId: input.invocation.capabilityId,
    sourceKind: input.invocation.source.kind,
    sourceId: input.invocation.source.id,
    ...(input.invocation.source.version
      ? { sourceVersion: input.invocation.source.version }
      : {}),
    toolCallId: input.invocation.toolCallId,
    argumentDigest: input.argumentDigest,
  }
}

function readInvocationIdentityBindingEvent(
  event: ExecutionJournalEvent | undefined,
): InvocationIdentityBindingRecord | undefined {
  if (
    !event ||
    event.type !== INVOCATION_BINDING_EVENT_TYPE ||
    event.payloadSchemaVersion !== INVOCATION_BINDING_PAYLOAD_SCHEMA_VERSION
  ) {
    return undefined
  }
  const capabilityId = readPayloadString(event, 'capabilityId')
  const sourceKind = readPayloadString(event, 'sourceKind')
  const sourceId = readPayloadString(event, 'sourceId')
  const sourceVersion = readPayloadString(event, 'sourceVersion')
  const toolCallId = readPayloadString(event, 'toolCallId')
  const argumentDigest = readPayloadString(event, 'argumentDigest')
  if (
    !capabilityId ||
    !isCapabilitySourceKind(sourceKind) ||
    !sourceId ||
    !toolCallId ||
    !argumentDigest ||
    !/^[a-f0-9]{64}$/.test(argumentDigest)
  ) {
    return undefined
  }
  return {
    invocation: {
      capabilityId,
      source: {
        kind: sourceKind,
        id: sourceId,
        ...(sourceVersion ? { version: sourceVersion } : {}),
      },
      toolCallId,
    },
    argumentDigest,
  }
}

function compareInvocationIdentityBinding(
  stored: InvocationIdentityBindingRecord,
  requested: {
    readonly invocation: CapabilityInvocationIdentity
    readonly argumentDigest: string
  },
): DurableInvocationIdentityBinding {
  const sameOperation =
    stored.invocation.capabilityId === requested.invocation.capabilityId &&
    stored.invocation.source.kind === requested.invocation.source.kind &&
    stored.invocation.source.id === requested.invocation.source.id &&
    stored.invocation.source.version === requested.invocation.source.version
  return sameOperation && stored.argumentDigest === requested.argumentDigest
    ? { kind: 'bound', invocation: stored.invocation }
    : { kind: 'conflict', invocation: stored.invocation }
}

function isCapabilitySourceKind(
  value: string | undefined,
): value is CapabilitySourceKind {
  return value === 'builtin' || value === 'mcp' || value === 'pi-host' ||
    value === 'engine'
}

function invalidInvocationIdentityBinding(): ExecutionJournalError {
  return new ExecutionJournalError(
    'corrupt',
    'Durable invocation identity binding is invalid.',
  )
}

/** The canonical event type each operator decision is recorded as (ADR §7). */
const RESOLUTION_EVENT_TYPES = {
  not_committed: 'capability.dispatch.resolved.not_committed',
  committed: 'capability.dispatch.resolved.committed',
  abandon: 'capability.dispatch.resolved.abandoned',
} as const satisfies Record<OperatorResolutionDecision, string>

/**
 * The event types whose payload may carry a retained result, and therefore the
 * only ones for which version 2 means anything.
 *
 * The version is a property of a payload shape, not of a stream. A
 * `requested` event at version 2 is not an old record and not a new one — it
 * is a shape nothing in this build ever wrote, and reading it as though the
 * result rules applied would accept a record no writer produced.
 */
const RESULT_BEARING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'capability.dispatch.accepted',
  RESOLUTION_EVENT_TYPES.committed,
])

function isSupportedDispatchPayload(event: ExecutionJournalEvent): boolean {
  if (event.payloadSchemaVersion === DISPATCH_PAYLOAD_SCHEMA_VERSION) return true
  return (
    event.payloadSchemaVersion === DISPATCH_RESULT_PAYLOAD_SCHEMA_VERSION &&
    RESULT_BEARING_EVENT_TYPES.has(event.type)
  )
}

/**
 * Whether a retained form is the one this payload version defines.
 *
 * Version 1 carried the result: `inline` or a journal-owned `receipt`.
 * Version 2 names it: `content`. `unserializable` retains nothing and is
 * legal under both. A record that mixes them is not one this build wrote, and
 * is refused rather than read on the strength of whichever field is present.
 */
function retainedFormMatchesVersion(
  event: ExecutionJournalEvent,
  resultKind: string | undefined,
): boolean {
  if (resultKind === 'unserializable' || resultKind === undefined) return true
  const isResultVersion =
    event.payloadSchemaVersion === DISPATCH_RESULT_PAYLOAD_SCHEMA_VERSION
  return isResultVersion
    ? resultKind === 'content'
    : resultKind === 'inline' || resultKind === 'receipt'
}

/**
 * Fields a payload v2 record must not carry. Their whole purpose was to hold
 * the result, so one appearing beside a content identity means the record is
 * not the content-free shape it claims to be.
 */
const FORBIDDEN_RESULT_PAYLOAD_FIELDS = ['resultValue', 'receipt'] as const

function carriesForbiddenResultFields(event: ExecutionJournalEvent): boolean {
  return FORBIDDEN_RESULT_PAYLOAD_FIELDS.some(
    (field) => event.payload[field] !== undefined,
  )
}
/** The same three decisions as the reducer names them. */
const RESOLUTION_STREAM_EVENT_TYPES = {
  not_committed: 'resolved_not_committed',
  committed: 'resolved_committed',
  abandon: 'resolved_abandoned',
} as const satisfies Record<
  OperatorResolutionDecision,
  DurableDispatchStreamEvent['type']
>

/** The dispatch result an abandoned identity returns from then on. */
const OPERATOR_ABANDONED_CODE = 'durable_operator_abandoned'

/**
 * The event types the operator report reads to explain a dispatch (AC11b).
 *
 * Exported so the report names the same strings the writer above appends,
 * rather than a copy of them that can drift.
 */
export const DISPATCH_EVENT_TYPES = Object.freeze({
  prepared: 'capability.dispatch.prepared',
  operatorRetryAuthorized: RESOLUTION_EVENT_TYPES.not_committed,
})

/**
 * How many times a resolution re-reads and re-decides before giving up.
 *
 * Small on purpose. Contention here is two operators acting on the same wedged
 * dispatch at the same moment, which is rare and self-limiting: the first
 * decision usually makes the second inadmissible, so the retry settles rather
 * than repeating. A larger bound would only lengthen the pathological case.
 */
const MAX_RESOLUTION_ATTEMPTS = 3

interface OperatorResolutionRequest {
  readonly dispatchId: string
  readonly scope: CapabilityAssignmentScope
  readonly decision: OperatorResolutionDecision
  readonly principal: OperatorResolutionPrincipal
  readonly reason: string
  readonly recordedAtMs: number
  readonly result?: OperatorSuppliedResult
  readonly signal?: AbortSignal
}

/**
 * What one pass over the stream concluded: either an answer, or the exact
 * appends to make and the revision they are conditional on.
 */
type OperatorResolutionPlan =
  | { readonly kind: 'settled'; readonly outcome: OperatorResolutionOutcome }
  | {
      readonly kind: 'proceed'
      readonly revision: number
      readonly attemptId: string
      /** False when the decision is already recorded and only needs finishing. */
      readonly recordDecision: boolean
      readonly accepted?: CanonicalJsonObject
      readonly state: DurableDispatchState
    }

/** A value the journal may retain, or why it may not. */
type OperatorResultRead =
  | { readonly kind: 'value'; readonly value: CanonicalJsonObject }
  | { readonly kind: 'invalid'; readonly reason: string }

/**
 * The durable record of one operator decision: who, why, where, when — and,
 * for `committed`, what the effect produced.
 *
 * The result is sealed into the decision rather than left to the acceptance
 * that follows it. The two are separate appends and a process can die between
 * them, so a decision that did not carry its own result could only be finished
 * from whatever a later caller offered — which would put the first operator's
 * principal, reason and time behind a value they never supplied.
 */
function operatorResolutionPayload(
  attemptId: string,
  input: OperatorResolutionRequest,
  retained?: CanonicalJsonObject,
): CanonicalJsonObject {
  return {
    attemptId,
    decision: input.decision,
    reason: input.reason,
    recordedAtMs: input.recordedAtMs,
    principal: { ...input.principal },
    scope: { ...input.scope },
    ...(retained ?? {}),
    // An abandoned dispatch is terminal, so this event is the terminal record
    // every later replay reads its outcome from.
    ...(input.decision === 'abandon'
      ? {
          dispatchId: input.dispatchId,
          status: 'cancelled',
          code: OPERATOR_ABANDONED_CODE,
        }
      : {}),
  }
}

/** Identity of a retained value, for comparing one against another. */
function canonicalDigest(value: CanonicalJsonObject): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex')
}

function isCanonicalJsonObject(
  value: CanonicalJsonValue | undefined,
): value is CanonicalJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Journal-backed durable dispatch authority (Phase 8 ADR §6-7). The port
 * records one canonical stream per dispatchId and rebuilds recovery
 * decisions from the journal, never from in-process memory alone.
 */
export interface JournalBackedDurableDispatchOptions {
  /**
   * When set, every canonical append also derives the legacy capability
   * evidence view at this path (ADR §9). The journal stays the authority.
   */
  readonly capabilityEvidenceProjectionPath?: string
  /**
   * Where exact capability results are kept.
   *
   * There is no default. The port holds no opinion about where an owner keeps
   * its content, so a port constructed without a store cannot retain a result
   * at all: the acceptance append fails and the dispatch reports
   * `indeterminate`. `WorkspaceExecutionJournalRegistry` is the production
   * composition root that supplies it, because it is what knows the
   * assignment's own root.
   */
  readonly resultContentStore?: CapabilityResultContentStore
}

export function createJournalBackedDurableDispatch(
  journal: ExecutionJournal,
  options?: JournalBackedDurableDispatchOptions,
): CapabilityDurableDispatchPort & CapabilityDispatchResolutionPort {
  return new JournalBackedDurableDispatch(
    journal,
    options?.capabilityEvidenceProjectionPath,
    options?.resultContentStore,
  )
}

class JournalBackedDurableDispatch
  implements CapabilityDurableDispatchPort, CapabilityDispatchResolutionPort
{
  private readonly streamRevisions = new Map<string, number>()
  /** Serialises deferred projection work; see `append`. */
  private projectionQueue: Promise<void> = Promise.resolve()
  /** Events appended since the last drain, applied as one projection. */
  private readonly pendingProjection: ExecutionJournalEvent[] = []
  /**
   * Drift catch-up cannot repair, and only that. A transient write failure is
   * recorded durably by the watermark not advancing, which is what both this
   * port and the inspection service classify from; it needs no flag here.
   */
  private projectionRebuildRequired = false
  /** Set once catch-up has *succeeded*; see `catchUpProjection`. */
  private projectionCaughtUp = false
  /**
   * One store per port: derives are serialised on the instance, so a store
   * rebuilt per call would leave concurrent derives racing each other.
   */
  private evidenceProjection: JournalJsonlProjectionStore | undefined

  constructor(
    private readonly journal: ExecutionJournal,
    private readonly capabilityEvidenceProjectionPath?: string,
    private readonly resultContentStore?: CapabilityResultContentStore,
  ) {}

  get derivesCapabilityEvidence(): boolean {
    return this.capabilityEvidenceProjectionPath !== undefined
  }

  async bindInvocationIdentity(input: {
    readonly operationId: string
    readonly invocation: CapabilityInvocationIdentity
    readonly argumentDigest: string
    readonly signal?: AbortSignal
  }): Promise<DurableInvocationIdentityBinding> {
    const existing = await this.readInvocationIdentityBinding(input.operationId)
    if (existing) return compareInvocationIdentityBinding(existing, input)

    try {
      const event = await appendJournalStreamEvent(this.journal, {
        eventId: `${input.operationId}:bound`,
        streamKind: INVOCATION_BINDING_STREAM_KIND,
        streamId: input.operationId,
        expectedStreamRevision: 0,
        type: INVOCATION_BINDING_EVENT_TYPE,
        payloadSchemaVersion: INVOCATION_BINDING_PAYLOAD_SCHEMA_VERSION,
        payload: invocationIdentityBindingPayload(input),
        correlationId: input.operationId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      const binding = readInvocationIdentityBindingEvent(event)
      if (!binding) throw invalidInvocationIdentityBinding()
      return compareInvocationIdentityBinding(binding, input)
    } catch (error) {
      if (
        !(error instanceof ExecutionJournalError) ||
        (error.code !== 'event_identity_conflict' &&
          error.code !== 'revision_conflict')
      ) {
        throw error
      }
      // Another process won the first-write race. Its durable identity is the
      // authority; re-read it rather than retrying with this process's id.
      const winner = await this.readInvocationIdentityBinding(input.operationId)
      if (!winner) throw error
      return compareInvocationIdentityBinding(winner, input)
    }
  }

  async projectionStatus(
    projectionId: string,
  ): Promise<'absent' | 'current' | 'lagging' | 'rebuild-required'> {
    if (
      projectionId !== CAPABILITY_EVIDENCE_PROJECTION_ID ||
      this.capabilityEvidenceProjectionPath === undefined
    ) {
      return 'absent'
    }
    // Deferred derives are settled before the view is judged, so a scheduled
    // apply is never reported as lag.
    await this.flushProjections()
    // Only drift catch-up cannot fix — a reducer version change, or a view
    // whose history is gone. A transient write fault is not that: the
    // watermark did not move, so the comparison below reports it as behind
    // and reading forward from it repairs the view (ADR §11).
    if (this.projectionRebuildRequired) return 'rebuild-required'
    const scan = await this.journal.scan()
    const store = this.evidenceProjectionStore()
    if (!store) return 'absent'
    // Against the dispatch stream's maximum, not the journal's. This view
    // derives nothing from workflow events, which share the journal and its
    // counter, so the journal-wide value reports permanent lag (N31).
    return store.classifyLag(lastDispatchSequence(scan.events))
  }

  async recover(input: {
    readonly dispatchId: string
    readonly argumentDigest: string
  }): Promise<DurableDispatchRecovery> {
    const stream = (
      await this.journal.scanStream(
        DURABLE_DISPATCH_STREAM_KIND,
        input.dispatchId,
      )
    ).events
    if (stream.length === 0) return { kind: 'unknown' }
    const last = stream[stream.length - 1]
    if (last) this.streamRevisions.set(input.dispatchId, last.streamRevision)

    const prepared = stream.find(
      (event) => event.type === 'capability.dispatch.prepared',
    )
    const sealedDigest = readPayloadString(prepared, 'argumentDigest')
    if (sealedDigest !== undefined && sealedDigest !== input.argumentDigest) {
      // Reusing a dispatch identity with different arguments is an identity
      // conflict, never a new call (ADR §6).
      return { kind: 'conflict' }
    }

    const streamEvents = stream
      .map(toStreamEvent)
      .filter(isDurableStreamEvent)
    const reduction = reduceDurableDispatchState(streamEvents)
    if (reduction.kind === 'invalid') {
      return { kind: 'blocked', state: 'indeterminate' }
    }
    const decision = resolveDurableRecovery(reduction.state)
    switch (decision.kind) {
      case 'retriable':
        return { kind: 'retriable' }
      case 'retained': {
        const accepted = findLast(stream, 'capability.dispatch.accepted')
        const result = accepted
          ? await this.readAcceptedResult(accepted)
          : undefined
        return result
          ? { kind: 'retained', result }
          : { kind: 'blocked', state: 'indeterminate' }
      }
      case 'terminal': {
        const terminal = findTerminalEvent(stream)
        const result = terminal ? readTerminalResult(terminal) : undefined
        return result
          ? { kind: 'terminal', result }
          : { kind: 'blocked', state: 'indeterminate' }
      }
      case 'reconcile':
        return { kind: 'reconcile', state: reduction.state }
      case 'blocked':
        return this.resolveBlockedByPolicy(stream, reduction.state)
    }
  }

  private async readInvocationIdentityBinding(
    operationId: string,
  ): Promise<InvocationIdentityBindingRecord | undefined> {
    const events = (
      await this.journal.scanStream(
        INVOCATION_BINDING_STREAM_KIND,
        operationId,
      )
    ).events
    if (events.length === 0) return undefined
    if (events.length !== 1) throw invalidInvocationIdentityBinding()
    const binding = readInvocationIdentityBindingEvent(events[0])
    if (!binding) throw invalidInvocationIdentityBinding()
    return binding
  }

  /**
   * An attempt whose outcome is unproven is blocked by default. The adapter's
   * recorded recovery policy (ADR §7) can soften that: a read-only effect is
   * safe to repeat, and a reconcilable one asks for reconciliation instead.
   * Anything else — including a missing or unrecognized policy — fails closed.
   */
  private resolveBlockedByPolicy(
    stream: readonly ExecutionJournalEvent[],
    state: DurableDispatchState,
  ): DurableDispatchRecovery {
    const prepared = findLast(stream, 'capability.dispatch.prepared')
    const policy = readRecoveryPolicy(prepared)
    switch (resolveRecoveryAfterStarted(policy)) {
      case 'retry':
        return { kind: 'retriable' }
      case 'reconcile':
        return { kind: 'reconcile', state }
      case 'blocked':
        return { kind: 'blocked', state }
    }
  }

  /**
   * Safe read-path (Phase 8 ADR §16): expose the validated terminal outcome
   * of one dispatch from the canonical journal only. Never reads a legacy
   * authoritative log. Reports unsupported_version rather than guessing when
   * the stream carries an unrecognized payload schema.
   */
  async inspectOutcome(input: {
    readonly dispatchId: string
  }): Promise<DurableDispatchInspection> {
    const stream = (
      await this.journal.scanStream(
        DURABLE_DISPATCH_STREAM_KIND,
        input.dispatchId,
      )
    ).events
    if (stream.length === 0) return { kind: 'not_found' }
    const lastAppliedSequence =
      stream[stream.length - 1]?.sequence ?? 0
    for (const event of stream) {
      if (!isSupportedDispatchPayload(event)) {
        return { kind: 'unsupported_version', lastAppliedSequence }
      }
    }
    const streamEvents = stream
      .map(toStreamEvent)
      .filter(isDurableStreamEvent)
    const reduction = reduceDurableDispatchState(streamEvents)
    const state: DurableDispatchState =
      reduction.kind === 'valid' ? reduction.state : 'indeterminate'

    let result: CapabilityDispatchResult | undefined
    const accepted = findLast(stream, 'capability.dispatch.accepted')
    if (accepted) result = await this.readAcceptedResult(accepted)
    if (!result) {
      const terminal = findTerminalEvent(stream)
      if (terminal) result = readTerminalResult(terminal)
    }
    return {
      kind: 'outcome',
      state,
      ...(result === undefined ? {} : { result }),
      lastAppliedSequence,
    }
  }

  async recordRequested(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void> {
    await this.append(input.dispatchId, {
      eventId: eventIdFor(input.dispatchId, 'requested', input.attemptId),
      type: 'capability.dispatch.requested',
      payload: {
        attemptId: input.attemptId,
        ...(input.identity === undefined ? {} : { identity: input.identity }),
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }

  async recordApprovalRequested(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly interactionId: string
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void> {
    await this.recordApproval('approval_requested', input)
  }

  async recordApprovalResolved(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly interactionId: string
    readonly approvalOutcome: CapabilityApprovalOutcome
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void> {
    await this.recordApproval('approval_resolved', input)
  }

  private async recordApproval(
    stage: 'approval_requested' | 'approval_resolved',
    input: {
      readonly dispatchId: string
      readonly attemptId: string
      readonly interactionId: string
      readonly approvalOutcome?: CapabilityApprovalOutcome
      readonly identity?: CanonicalJsonObject
      readonly signal?: AbortSignal
    },
  ): Promise<void> {
    await this.append(input.dispatchId, {
      eventId: eventIdFor(input.dispatchId, stage, input.attemptId),
      type: `capability.dispatch.${stage}`,
      payload: {
        attemptId: input.attemptId,
        interactionId: input.interactionId,
        ...(input.approvalOutcome === undefined
          ? {}
          : { approvalOutcome: input.approvalOutcome }),
        ...(input.identity === undefined ? {} : { identity: input.identity }),
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }

  async recordPrepared(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly argumentDigest: string
    readonly capabilityId: string
    readonly effect: CapabilityEffect
    readonly recoveryPolicy: CapabilityRecoveryPolicy
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void> {
    await this.append(input.dispatchId, {
      eventId: eventIdFor(input.dispatchId, 'prepared', input.attemptId),
      type: 'capability.dispatch.prepared',
      payload: {
        attemptId: input.attemptId,
        argumentDigest: input.argumentDigest,
        capabilityId: input.capabilityId,
        effectKind: input.effect.kind,
        effectConcurrency: input.effect.concurrency,
        recoveryPolicy: input.recoveryPolicy,
        ...(input.identity === undefined ? {} : { identity: input.identity }),
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }

  async recordStarted(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void> {
    await this.append(input.dispatchId, {
      eventId: eventIdFor(input.dispatchId, 'started', input.attemptId),
      type: 'capability.dispatch.started',
      payload: {
        attemptId: input.attemptId,
        ...(input.identity === undefined ? {} : { identity: input.identity }),
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    // The last barrier before the executor, so the view is brought current
    // here as well as at the terminal. Otherwise a dispatch that starts and
    // then wedges leaves its evidence unprojected, and projection lag would
    // read "lagging" for every in-flight dispatch — making the one signal an
    // operator uses to tell a stalled derive from normal traffic useless.
    await this.flushProjections()
  }

  async recordCommitted(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly receipt?: CanonicalJsonObject
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void> {
    await this.append(input.dispatchId, {
      eventId: eventIdFor(input.dispatchId, 'committed', input.attemptId),
      type: 'capability.dispatch.committed',
      payload: {
        attemptId: input.attemptId,
        ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
        ...(input.identity === undefined ? {} : { identity: input.identity }),
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }

  async recordAccepted(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly result: CapabilityDispatchResult
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void> {
    const payload = await this.buildAcceptedPayload(
      input.attemptId,
      input.result,
      input.identity,
    )
    await this.append(input.dispatchId, {
      eventId: eventIdFor(input.dispatchId, 'accepted', input.attemptId),
      type: 'capability.dispatch.accepted',
      payload,
      payloadSchemaVersion: DISPATCH_RESULT_PAYLOAD_SCHEMA_VERSION,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    // The dispatch has settled, so the derived view is brought current here
    // rather than at each of the five barriers that produced it.
    await this.flushProjections()
  }

  async recordIndeterminate(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly code: string
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void> {
    await this.append(input.dispatchId, {
      eventId: eventIdFor(input.dispatchId, 'indeterminate', input.attemptId),
      type: 'capability.dispatch.indeterminate',
      payload: {
        attemptId: input.attemptId,
        code: input.code,
        ...(input.identity === undefined ? {} : { identity: input.identity }),
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    await this.flushProjections()
  }

  async recordTerminal(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly result: CapabilityDispatchResult
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void> {
    if (input.result.status === 'completed') {
      throw new Error('Completed results require the durable acceptance path.')
    }
    await this.append(input.dispatchId, {
      eventId: eventIdFor(
        input.dispatchId,
        input.result.status,
        input.attemptId,
      ),
      type: `capability.dispatch.${input.result.status}`,
      payload: terminalPayload(input.attemptId, input.result, input.identity),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    await this.flushProjections()
  }

  /**
   * Record an authorized operator's resolution of an unproven dispatch.
   *
   * The decision is a durable fact in the same stream the dispatcher writes,
   * carrying the principal, the reason, the scope and the time. It is never a
   * deletion or an edit: what the runtime recorded stays, and the resolution
   * is appended after it, which is what makes the audit trail readable
   * afterwards.
   *
   * Admissibility is decided by the reducer rather than a second table here.
   * The candidate event is reduced onto the stream it would join, so a
   * resolution the state machine forbids — denying a recorded commit, or
   * resolving a dispatch that already settled — is refused by the same rule
   * that governs every other transition.
   */
  async recordOperatorResolution(
    input: OperatorResolutionRequest,
  ): Promise<OperatorResolutionOutcome> {
    // Read, reduce, and append are three steps, and the stream can move
    // between any two of them. Nothing here holds a lock across all three —
    // the journal's lock is per commit, and another *process* can resolve the
    // same dispatch, so an in-process mutex would read as protection that is
    // not there. Instead each append is conditional on the exact revision the
    // decision was made against, and losing that condition sends the whole
    // decision back to be made again against what the stream now says.
    for (let attempt = 0; attempt < MAX_RESOLUTION_ATTEMPTS; attempt += 1) {
      const plan = await this.planOperatorResolution(input)
      if (plan.kind === 'settled') return plan.outcome
      const applied = await this.applyOperatorResolution(plan, input)
      if (applied.kind === 'settled') return applied.outcome
    }
    // Contention that outlasts the retries. Distinct from a refusal: nothing
    // was decided against, and the same request may succeed later.
    return { kind: 'conflict' }
  }

  /**
   * Decide what this resolution should append, against the stream as it is now.
   *
   * The whole judgement lives here — including whether the decision is already
   * a durable fact. A decision that is recorded is never restated: a retry
   * finishes whatever is unfinished and keeps the provenance of the attempt
   * that made it, because the operator named in the journal is the operator
   * who decided, not whoever asked again afterwards.
   */
  private async planOperatorResolution(
    input: OperatorResolutionRequest,
  ): Promise<OperatorResolutionPlan> {
    const stream = (
      await this.journal.scanStream(
        DURABLE_DISPATCH_STREAM_KIND,
        input.dispatchId,
      )
    ).events
    const last = stream[stream.length - 1]
    if (!last) return { kind: 'settled', outcome: { kind: 'not_found' } }
    this.streamRevisions.set(input.dispatchId, last.streamRevision)

    const streamEvents = stream.map(toStreamEvent).filter(isDurableStreamEvent)
    const reduction = reduceDurableDispatchState(streamEvents)
    if (reduction.kind === 'invalid') {
      // A stream the reducer cannot read is not made readable by appending to
      // it, and guessing an attempt to resolve would invent one.
      return {
        kind: 'settled',
        outcome: { kind: 'not_resolvable', state: 'indeterminate' },
      }
    }
    const state = reduction.state

    const decided = findLast(stream, RESOLUTION_EVENT_TYPES[input.decision])
    const attemptId = readPayloadString(decided ?? last, 'attemptId')
    if (attemptId === undefined) {
      return { kind: 'settled', outcome: { kind: 'not_resolvable', state } }
    }
    // Only a `committed` decision has a second append to finish; the other two
    // are complete the moment they are recorded.
    if (decided && (input.decision !== 'committed' || state === 'accepted')) {
      // Complete, but still not a licence to agree with whatever a later
      // caller sends. A retry that supplies a result has it checked against
      // the one the decision recorded, because answering "recorded" to
      // someone who supplied a different value tells them their evidence is
      // what the journal holds — and it is not.
      if (input.decision === 'committed' && input.result !== undefined) {
        const checked = await this.resumeRetainedResult(decided, input.result)
        if (checked.kind === 'invalid') {
          return {
            kind: 'settled',
            outcome: { kind: 'invalid_result', reason: checked.reason },
          }
        }
      }
      return { kind: 'settled', outcome: { kind: 'recorded', state } }
    }

    const candidates: DurableDispatchStreamEvent[] = []
    if (!decided) {
      candidates.push({
        type: RESOLUTION_STREAM_EVENT_TYPES[input.decision],
        attemptId,
      })
    }
    if (input.decision === 'committed') {
      candidates.push({ type: 'accepted', attemptId })
    }
    const after = reduceDurableDispatchState([...streamEvents, ...candidates])
    if (after.kind === 'invalid') {
      return { kind: 'settled', outcome: { kind: 'not_resolvable', state } }
    }

    // Validated before anything is appended, so a rejected result leaves the
    // dispatch exactly as blocked as it was.
    let accepted: CanonicalJsonObject | undefined
    if (input.decision === 'committed') {
      const retained = decided
        ? await this.resumeRetainedResult(decided, input.result)
        : await this.readOperatorResult(input.result)
      if (retained.kind === 'invalid') {
        return {
          kind: 'settled',
          outcome: { kind: 'invalid_result', reason: retained.reason },
        }
      }
      accepted = retained.value
    }
    return {
      kind: 'proceed',
      revision: last.streamRevision,
      attemptId,
      recordDecision: !decided,
      ...(accepted === undefined ? {} : { accepted }),
      state: after.state,
    }
  }

  /** Write the plan, or report that the stream moved out from under it. */
  private async applyOperatorResolution(
    plan: Extract<OperatorResolutionPlan, { readonly kind: 'proceed' }>,
    input: OperatorResolutionRequest,
  ): Promise<
    | { readonly kind: 'settled'; readonly outcome: OperatorResolutionOutcome }
    | { readonly kind: 'contended' }
  > {
    let revision = plan.revision
    if (plan.recordDecision) {
      // The decision carries the result it attests to, so the acceptance that
      // follows can be finished from the journal alone. That makes it a
      // result-bearing payload, and it declares the version to match.
      const retained =
        plan.accepted === undefined
          ? undefined
          : await this.retainResult(plan.accepted)
      const appended = await this.appendDecidedEvent(
        input.dispatchId,
        revision,
        {
          eventId: eventIdFor(
            input.dispatchId,
            `resolved.${input.decision}`,
            plan.attemptId,
          ),
          type: RESOLUTION_EVENT_TYPES[input.decision],
          payload: operatorResolutionPayload(plan.attemptId, input, retained),
          ...(retained === undefined
            ? {}
            : {
                payloadSchemaVersion: DISPATCH_RESULT_PAYLOAD_SCHEMA_VERSION,
              }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      )
      if (appended.kind === 'contended') return { kind: 'contended' }
      revision = appended.revision
    }
    if (plan.accepted !== undefined) {
      // The decision is recorded; the acceptance that follows is what makes
      // the result retained rather than merely reconcilable. Losing this
      // append leaves the dispatch `committed`, which honestly reads as still
      // awaiting reconciliation — and which the next attempt finishes.
      const appended = await this.appendDecidedEvent(input.dispatchId, revision, {
        eventId: eventIdFor(input.dispatchId, 'accepted', plan.attemptId),
        type: 'capability.dispatch.accepted',
        payload: await this.buildAcceptedPayload(plan.attemptId, {
          status: 'completed',
          dispatchId: input.dispatchId,
          value: plan.accepted,
          // No budget was reserved or settled for an operator's assertion, and
          // saying otherwise would put a number in the ledger nobody spent.
          costTracked: false,
          budgetOverrun: false,
        }),
        payloadSchemaVersion: DISPATCH_RESULT_PAYLOAD_SCHEMA_VERSION,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (appended.kind === 'contended') return { kind: 'contended' }
    }
    await this.flushProjections()
    return { kind: 'settled', outcome: { kind: 'recorded', state: plan.state } }
  }

  /**
   * Append at exactly the revision the caller decided against.
   *
   * The shared recorder path retries a revision conflict against whatever the
   * journal now holds, which is right for the dispatcher: its barriers follow
   * one another, and a concurrent writer cannot make `started` stop being the
   * right thing to record after `prepared`. It is wrong for a resolution,
   * whose entire content is a judgement about the state that was read —
   * retrying it blindly writes that judgement onto a state nobody judged, and
   * two contradictory resolutions then land one after the other and leave a
   * stream the reducer cannot read at all.
   */
  private async appendDecidedEvent(
    dispatchId: string,
    expectedStreamRevision: number,
    input: {
      readonly eventId: string
      readonly type: string
      readonly payload: CanonicalJsonObject
      /** Only a result-bearing payload declares a version of its own. */
      readonly payloadSchemaVersion?: number
      readonly signal?: AbortSignal
    },
  ): Promise<
    | { readonly kind: 'appended'; readonly revision: number }
    | { readonly kind: 'contended' }
  > {
    const outcome = await this.journal.append({
      eventId: input.eventId,
      streamKind: DURABLE_DISPATCH_STREAM_KIND,
      streamId: dispatchId,
      expectedStreamRevision,
      type: input.type,
      payloadSchemaVersion:
        input.payloadSchemaVersion ?? DISPATCH_PAYLOAD_SCHEMA_VERSION,
      payload: input.payload,
      correlationId: dispatchId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    switch (outcome.kind) {
      case 'appended':
      // An identical request that already landed. Idempotent by construction:
      // the event id is derived from the dispatch, the decision and the
      // attempt, so this is the same decision arriving twice.
      case 'already-accepted':
        this.noteAppended(dispatchId, outcome.event)
        return { kind: 'appended', revision: outcome.event.streamRevision }
      // Both say the stream is not what it was when the decision was made. An
      // identity conflict says more — another writer recorded this very
      // decision with its own provenance — and re-reading finds exactly that.
      case 'revision-conflict':
      case 'event-identity-conflict':
        return { kind: 'contended' }
    }
  }

  /**
   * The result a retry must finish the acceptance with: the one the recorded
   * decision carries, never the one this caller offers.
   *
   * A `committed` resolution asserts that a named effect committed and hands
   * over what it produced, and the principal, reason and time recorded beside
   * it attest to exactly that. Deriving the acceptance from a later caller's
   * value would make the first operator's attestation cover evidence they
   * never supplied. So the durable record decides, and a supplied result is
   * only ever checked against it — an identical one is a harmless repeat, and
   * a different one is refused rather than quietly ignored, because a caller
   * who believes they supplied the result must not be told it was recorded.
   */
  private async resumeRetainedResult(
    decided: ExecutionJournalEvent,
    supplied: OperatorSuppliedResult | undefined,
  ): Promise<OperatorResultRead> {
    const durable = await this.readRetainedValue(decided)
    if (!durable) {
      return {
        kind: 'invalid',
        reason:
          'The recorded resolution no longer holds a readable result, so its acceptance cannot be finished.',
      }
    }
    if (supplied === undefined) return { kind: 'value', value: durable }
    const offered = await this.readOperatorResult(supplied)
    if (offered.kind === 'invalid') return offered
    if (canonicalDigest(offered.value) !== canonicalDigest(durable)) {
      return {
        kind: 'invalid',
        reason:
          'The recorded resolution retained a different result; a retry finishes that decision and cannot replace what it attested to.',
      }
    }
    return { kind: 'value', value: durable }
  }

  /**
   * Narrow an operator-supplied result to something the journal may retain.
   *
   * Held to the adapter's own rules (ADR §6): an inline value must be a plain
   * record that canonicalises, and a receipt must name content this assignment
   * already holds whose digest and length match — either the v2 content store
   * or a v1 file below the journal, since an operator may be resolving a
   * dispatch older than Phase 3. Anything else is refused rather than written,
   * because a result an operator can shape freely is a result the replay path
   * would hand back as the effect's.
   *
   * Whichever shape arrives, what is *recorded* is payload v2: the value is
   * re-retained through the content store, so an operator resolution never
   * puts result content back into the journal.
   */
  private async readOperatorResult(
    result: OperatorSuppliedResult | undefined,
  ): Promise<OperatorResultRead> {
    if (!result) {
      return {
        kind: 'invalid',
        reason: 'A committed resolution must supply the retained result.',
      }
    }
    if (result.kind === 'receipt') {
      const value =
        (await this.loadContentValue(result.receipt)) ??
        (await this.loadLegacyReceiptValue(result.receipt))
      return value
        ? { kind: 'value', value }
        : {
            kind: 'invalid',
            reason: 'The supplied receipt does not describe a retained result.',
          }
    }
    const serialization = serializeResultForRetention(result.value)
    if (serialization.kind === 'unserializable') {
      return {
        kind: 'invalid',
        reason: 'The supplied result is not a canonical JSON object.',
      }
    }
    return { kind: 'value', value: toCanonicalJsonObject(result.value) }
  }

  private async buildAcceptedPayload(
    attemptId: string,
    result: CapabilityDispatchResult,
    identity?: CanonicalJsonObject,
  ): Promise<CanonicalJsonObject> {
    if (result.status !== 'completed') {
      throw new Error('Durable acceptance requires a completed result.')
    }
    const base: Record<string, CanonicalJsonValue> = {
      attemptId,
      dispatchId: result.dispatchId,
      status: 'completed',
      costTracked: result.costTracked,
      budgetOverrun: result.budgetOverrun,
      ...(result.actualCostUsd === undefined
        ? {}
        : { actualCostUsd: result.actualCostUsd }),
      ...(identity === undefined ? {} : { identity }),
    }
    return { ...base, ...(await this.retainResult(result.value)) }
  }

  /**
   * The payload fields that name the retained result without carrying it.
   *
   * Payload v2: a content identity, its digest, its length, its media type and
   * its schema version — enough to fetch the exact bytes from the assignment's
   * own content store and prove they are the ones this dispatch accepted, and
   * nothing that says what the capability returned.
   *
   * Shared by the acceptance record and by an operator's `committed`
   * resolution, so both retain a result the same way and either can be read
   * back by the same reader.
   */
  private async retainResult(value: unknown): Promise<CanonicalJsonObject> {
    const serialization = serializeResultForRetention(value)
    if (serialization.kind === 'unserializable') {
      // Arbitrary non-canonical values are never serialized into the
      // journal; retained reuse is unavailable for them (ADR §6).
      return { resultKind: 'unserializable' }
    }
    if (!this.resultContentStore) {
      // Fails the append rather than inlining. An acceptance that could not
      // store its result is not an acceptance, and the caller is told
      // `indeterminate` — which is what the journal will say on replay.
      throw new ExecutionJournalError(
        'append_invalid',
        'A retained capability result needs an assignment content store.',
      )
    }
    const written = await this.resultContentStore.write(serialization.canonical)
    if (written.kind !== 'stored') {
      throw new ExecutionJournalError(
        'append_invalid',
        `The capability result could not be retained: ${written.kind}.`,
      )
    }
    return {
      resultKind: 'content',
      resultContent: { ...written.receipt },
    }
  }

  /**
   * Read back a value retained by `retainResult`, or `undefined` when this
   * event retains none that can still be read.
   *
   * Three arms because three retained forms exist on disk across the two
   * payload versions this reads. `undefined` is
   * the fail-closed answer for every way the content cannot be produced
   * exactly — absent, changed, unreadable, or reached through a path that is
   * no longer the store's own — and recovery turns it into `blocked`.
   */
  private async readRetainedValue(
    event: ExecutionJournalEvent,
  ): Promise<CanonicalJsonObject | undefined> {
    const resultKind = readPayloadString(event, 'resultKind')
    if (
      !isSupportedDispatchPayload(event) ||
      !retainedFormMatchesVersion(event, resultKind)
    ) {
      return undefined
    }
    if (
      event.payloadSchemaVersion === DISPATCH_RESULT_PAYLOAD_SCHEMA_VERSION &&
      carriesForbiddenResultFields(event)
    ) {
      return undefined
    }
    switch (resultKind) {
      case 'inline': {
        const value = event.payload['resultValue']
        return isCanonicalJsonObject(value) ? value : undefined
      }
      case 'receipt':
        return this.loadLegacyReceiptValue(event.payload['receipt'])
      case 'content':
        return this.loadContentValue(event.payload['resultContent'])
      default:
        return undefined
    }
  }

  /**
   * `unknown` rather than a typed receipt: the same validation guards one this
   * port sealed and one an operator supplied, and the second arrives as parsed
   * request JSON that has proved nothing about itself yet.
   */
  private async loadContentValue(
    rawReceipt: unknown,
  ): Promise<CanonicalJsonObject | undefined> {
    const receipt = parseContentReceipt(rawReceipt)
    if (!receipt || !this.resultContentStore) return undefined
    const read = await this.resultContentStore.read(receipt)
    if (read.kind !== 'content') return undefined
    try {
      const parsed: unknown = JSON.parse(read.canonical)
      return isPlainRecord(parsed) ? toCanonicalJsonObject(parsed) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the legacy results directory for reading. A read path never
   * provisions storage, so a missing directory simply means the receipt is
   * unavailable. Nothing writes here any more.
   */
  private async resolveLegacyResultsDirectory(): Promise<string> {
    const journalDirectory = this.journal.journalDirectoryPath
    const resultsDirectory = path.join(
      journalDirectory,
      LEGACY_RESULTS_DIRECTORY_NAME,
    )
    const stat = await fs.lstat(resultsDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ExecutionJournalError(
        'path_unsafe',
        'Durable result receipts directory is unsafe.',
      )
    }
    if ((Number(stat.mode) & 0o077) !== 0) {
      throw new ExecutionJournalError(
        'permissions_unsafe',
        'Durable result receipts directory permissions are relaxed.',
      )
    }
    const canonicalResults = await fs.realpath(resultsDirectory)
    const canonicalJournal = await fs.realpath(journalDirectory)
    if (
      canonicalResults !==
      path.join(canonicalJournal, LEGACY_RESULTS_DIRECTORY_NAME)
    ) {
      throw new ExecutionJournalError(
        'path_unsafe',
        'Durable result receipts directory escapes the journal.',
      )
    }
    return canonicalResults
  }

  private async readAcceptedResult(
    event: ExecutionJournalEvent,
  ): Promise<CapabilityDispatchResult | undefined> {
    const dispatchId = readPayloadString(event, 'dispatchId')
    const status = readPayloadString(event, 'status')
    if (dispatchId === undefined || status !== 'completed') return undefined
    const costTracked = readPayloadBoolean(event, 'costTracked')
    const budgetOverrun = readPayloadBoolean(event, 'budgetOverrun')
    if (costTracked === undefined || budgetOverrun === undefined) return undefined
    const actualCostUsd = event.payload['actualCostUsd']
    const completion = {
      dispatchId,
      costTracked,
      budgetOverrun,
      ...(typeof actualCostUsd === 'number' && Number.isFinite(actualCostUsd)
        ? { actualCostUsd }
        : {}),
    }
    const value = await this.readRetainedValue(event)
    return value ? { status: 'completed', value, ...completion } : undefined
  }

  /**
   * Read a payload v1 receipt: a file below the journal directory, named by a
   * relative path this port once wrote. Nothing writes these any more; they
   * are read so an assignment enrolled before Phase 3 still replays.
   *
   * `unknown` rather than a typed receipt for the same reason the v2 reader
   * takes one: an operator may supply a receipt with a `committed` resolution,
   * and it arrives as parsed request JSON that has proved nothing yet.
   */
  private async loadLegacyReceiptValue(
    rawReceipt: unknown,
  ): Promise<CanonicalJsonObject | undefined> {
    if (!isPlainRecord(rawReceipt)) return undefined
    const relativePath = rawReceipt['relativePath']
    const contentSha256 = rawReceipt['contentSha256']
    const byteLength = rawReceipt['byteLength']
    const mediaType = rawReceipt['mediaType']
    const resultSchemaVersion = rawReceipt['resultSchemaVersion']
    if (
      typeof relativePath !== 'string' ||
      !LEGACY_RECEIPT_RELATIVE_PATH_PATTERN.test(relativePath) ||
      typeof contentSha256 !== 'string' ||
      !CONTENT_ID_PATTERN.test(contentSha256) ||
      typeof byteLength !== 'number' ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      mediaType !== CAPABILITY_RESULT_MEDIA_TYPE ||
      resultSchemaVersion !== LEGACY_RESULT_RECEIPT_SCHEMA_VERSION
    ) {
      return undefined
    }
    try {
      const resultsDirectory = await this.resolveLegacyResultsDirectory()
      const filePath = path.join(
        resultsDirectory,
        relativePath.slice(LEGACY_RESULTS_DIRECTORY_NAME.length + 1),
      )
      const stat = await fs.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined
      const canonicalFile = await fs.realpath(filePath)
      if (canonicalFile !== filePath) return undefined
      const content = await fs.readFile(filePath, 'utf8')
      if (Buffer.byteLength(content, 'utf8') !== byteLength) return undefined
      const digest = createHash('sha256').update(content, 'utf8').digest('hex')
      if (digest !== contentSha256) return undefined
      const parsed: unknown = JSON.parse(content)
      return isPlainRecord(parsed) ? toCanonicalJsonObject(parsed) : undefined
    } catch {
      return undefined
    }
  }

  private async append(
    dispatchId: string,
    input: {
      readonly eventId: string
      readonly type: string
      readonly payload: CanonicalJsonObject
      /** Only a result-bearing payload declares a version of its own. */
      readonly payloadSchemaVersion?: number
      readonly signal?: AbortSignal
    },
  ): Promise<void> {
    const expectedStreamRevision = this.streamRevisions.get(dispatchId) ?? 0
    const event = await appendJournalStreamEvent(this.journal, {
      eventId: input.eventId,
      streamKind: DURABLE_DISPATCH_STREAM_KIND,
      streamId: dispatchId,
      expectedStreamRevision,
      type: input.type,
      payloadSchemaVersion:
        input.payloadSchemaVersion ?? DISPATCH_PAYLOAD_SCHEMA_VERSION,
      payload: input.payload,
      correlationId: dispatchId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    this.noteAppended(dispatchId, event)
  }

  /** What this port records about an append the journal has accepted. */
  private noteAppended(dispatchId: string, event: ExecutionJournalEvent): void {
    this.streamRevisions.set(dispatchId, event.streamRevision)
    // The derived view is not awaited here. ADR §8 makes projections
    // disposable and allows them to lag, and everything this defers is
    // recoverable: the watermark only advances after a view append succeeds,
    // so catch-up reads back whatever is missing, and it skips lines the view
    // already holds — which is what makes a crash between the view append and
    // the metadata publish survivable rather than a source of duplicates.
    // Deferring therefore widens a window that is already handled rather than
    // opening a new one.
    //
    // Awaiting it per append put two fsyncs on the critical path of each of a
    // dispatch's five barriers: 37% of measured dispatch latency, spent
    // keeping a view current that no production code reads mid-dispatch. The
    // work is coalesced instead and flushed when the dispatch settles, so the
    // view is complete at every boundary a reader can observe.
    // Buffered only. Scheduling a drain per append defeats the coalescing:
    // the five appends of a dispatch are separated by awaits, so each would
    // drain alone and pay its own two fsyncs. The batch is applied when the
    // dispatch settles, or when a reader asks for the view.
    this.pendingProjection.push(event)
  }

  /**
   * Apply everything buffered since the last drain as one projection.
   *
   * Coalescing is the point, not just deferral. `applySerialized` costs two
   * fsyncs per call regardless of how many events it carries, so five appends
   * that each drove their own apply paid ten; batching them pays two. Deferral
   * alone only overlaps that cost with the next journal append, and both
   * contend for the same disk.
   */
  private async drainProjection(): Promise<void> {
    if (this.pendingProjection.length === 0) return
    // Read without removing: the batch stays buffered until its apply
    // succeeds, so a failure does not depend on the recovery path to notice
    // it. Dropping it afterwards is safe either way — the watermark did not
    // move, so `catchUp` can still read those events back from the journal.
    const batch = [...this.pendingProjection]
    const applied = await this.applyProjections(batch)
    if (applied) {
      this.pendingProjection.splice(0, batch.length)
      return
    }
    this.pendingProjection.length = 0
    // This batch wrote nothing, so the view is behind again and the earlier
    // catch-up no longer describes it. Without this a port that was once
    // current never looks back: the next batch that succeeds would advance the
    // watermark over this gap and put it out of reach for good.
    this.projectionCaughtUp = false
  }

  /**
   * Recover whatever the view is missing, then apply what this port buffered.
   *
   * Called before every read of the derived view and when a dispatch reaches a
   * terminal state, so "lagging" never means "lagging behind a settled
   * dispatch" — and by the registry at teardown, which is why it is public.
   * Never rejects: every failure inside is classified rather than raised.
   */
  flushProjections(): Promise<void> {
    // Chained, not merely awaited. The field used to be declared and awaited
    // and never assigned, so two concurrent callers both saw a resolved
    // promise, both drained, and the second returned while the first apply was
    // still running — reporting a view current that was not (N2).
    const flushed = this.projectionQueue.then(async () => {
      await this.catchUpProjection()
      if (this.projectionRebuildRequired) {
        // Nothing will derive from this port again: only a deliberate rebuild
        // repairs drift, and until then the canonical journal is the record.
        // The buffer is dropped rather than held, because holding it would
        // grow without bound for an assignment that keeps dispatching.
        this.pendingProjection.length = 0
        return
      }
      // Otherwise, only once the view is known to hold everything below the
      // watermark. The watermark moves forward only, so applying this batch
      // over a gap catch-up has not closed would advance it past those events
      // and put them out of reach for good. Waiting costs nothing here — the
      // fault is transient, the journal still holds the events, and the next
      // flush recovers the gap and this batch together.
      if (this.projectionCaughtUp) await this.drainProjection()
    })
    this.projectionQueue = flushed.then(
      () => undefined,
      () => undefined,
    )
    return flushed
  }

  /**
   * Recover anything the view is missing from the canonical journal.
   *
   * On the port's first flush, and again after a transient apply failure has
   * put the view behind. A batch whose apply failed is gone from memory — in
   * this process or one that has since exited — but the watermark did not
   * move, so the journal still says exactly what is missing. That is what
   * makes recovery survive a restart rather than depending on a buffer.
   *
   * Bounded deliberately. `ExecutionJournal` exposes no range read, so this
   * costs a full scan; running it per status call would put an O(journal) scan
   * on a read path. So it runs when the view is known to be behind, and never
   * for drift, which scanning cannot repair.
   */
  private async catchUpProjection(): Promise<void> {
    // Already recovered, or past recovering: drift needs a deliberate rebuild,
    // and re-scanning for it would cost a full journal read to learn nothing.
    if (this.projectionCaughtUp || this.projectionRebuildRequired) return
    const store = this.evidenceProjectionStore()
    if (!store) {
      this.projectionCaughtUp = true
      return
    }
    try {
      const outcome = await catchUpCapabilityEvidenceProjection(
        this.journal,
        store,
      )
      // Drift is terminal for this port, so catch-up is finished either way:
      // scanning again cannot repair a reducer change or a lost history, and
      // a full scan per status read is a cost on a path that only reports.
      // The drain is gated on the flag below rather than on this one.
      this.projectionCaughtUp = true
      if (outcome === 'rebuild-required') this.projectionRebuildRequired = true
    } catch {
      // Transient, and deliberately not marked done: the fault may clear, and
      // remembering this attempt as finished would leave the view behind for
      // the life of the port. Nothing else to record — the watermark already
      // says what is missing, and the next flush tries again.
    }
  }

  /**
   * Derive the legacy compatibility views from the canonical append. The
   * journal remains the authority: projection failure is classified as lag,
   * never surfaced as an append failure and never silently dropped
   * (ADR §11).
   *
   * @returns whether the batch was actually applied.
   */
  private async applyProjections(
    newEvents: readonly ExecutionJournalEvent[],
  ): Promise<boolean> {
    const store = this.evidenceProjectionStore()
    if (!store) return true
    try {
      const outcome = await applyCapabilityEvidenceProjection(store, newEvents)
      if (outcome === 'rebuild-required') {
        this.projectionRebuildRequired = true
        return false
      }
      return true
    } catch {
      // The canonical record has already returned, so this must not fail the
      // dispatch. It is not swallowed either: the watermark did not advance,
      // so the view reports itself behind until catch-up repairs it.
      return false
    }
  }

  private evidenceProjectionStore(): JournalJsonlProjectionStore | undefined {
    if (this.capabilityEvidenceProjectionPath === undefined) return undefined
    this.evidenceProjection ??= createCapabilityEvidenceProjectionStore(
      this.journal,
      this.capabilityEvidenceProjectionPath,
    )
    return this.evidenceProjection
  }
}

/**
 * Classify how this journal's result-bearing records retain their results.
 *
 * Counted per record, not per dispatch. An operator-resolved dispatch writes
 * two — the decision that attests to the result and the acceptance that
 * follows it — and a decision whose acceptance never landed writes only the
 * first. Counting records rather than dispatches is what keeps that stranded
 * decision visible, which matters most for exactly the legacy content this
 * summary exists to find.
 *
 * Derived from the events on every read rather than from a projection: the
 * classification is one pass over payload discriminants the writer already
 * validated, and a stored index would have to be rebuilt before it could be
 * trusted.
 */
export function summarizeCapabilityResultRetention(
  events: readonly ExecutionJournalEvent[],
): CapabilityResultRetentionSummary {
  const counts: Record<CapabilityResultRetentionForm, number> = {
    content_reference_v2: 0,
    legacy_inline_v1: 0,
    legacy_journal_receipt_v1: 0,
    unretained: 0,
  }
  for (const event of events) {
    if (event.streamKind !== DURABLE_DISPATCH_STREAM_KIND) continue
    const form = retentionFormOf(event)
    if (form) counts[form] += 1
  }
  const legacyContentBearing =
    counts.legacy_inline_v1 > 0 || counts.legacy_journal_receipt_v1 > 0
  return {
    counts,
    legacyContentBearing,
    ...(legacyContentBearing
      ? { legacyReason: 'capability_result_v1' as const }
      : {}),
    ...(counts.content_reference_v2 > 0
      ? { contentOwner: 'assignment-capability-results' as const }
      : {}),
  }
}

/**
 * The retained form this event holds, or nothing when it retains none.
 *
 * Decided by the fields that are present rather than by the version the record
 * claims. The summary answers "does this journal still hold result content",
 * and a payload carrying a result value holds one whatever it says about
 * itself — so a mislabelled record is reported as content-bearing rather than
 * as the content-free shape its own version asserts.
 */
function retentionFormOf(
  event: ExecutionJournalEvent,
): CapabilityResultRetentionForm | undefined {
  if (event.payload['resultValue'] !== undefined) return 'legacy_inline_v1'
  if (event.payload['receipt'] !== undefined) {
    return 'legacy_journal_receipt_v1'
  }
  switch (readPayloadString(event, 'resultKind')) {
    case 'content':
      return 'content_reference_v2'
    case 'unserializable':
      return 'unretained'
    default:
      return undefined
  }
}

function eventIdFor(
  dispatchId: string,
  stage: string,
  attemptId: string,
): string {
  return `${dispatchId}:${stage}:${attemptId}`
}

/** Maps one canonical journal event onto the reducer's stream-event shape. */
export function toStreamEvent(
  event: ExecutionJournalEvent,
): DurableDispatchStreamEvent | undefined {
  const stage = event.type.startsWith('capability.dispatch.')
    ? event.type.slice('capability.dispatch.'.length)
    : undefined
  if (!stage) return undefined
  const attemptId = readPayloadString(event, 'attemptId') ?? 'unknown-attempt'
  switch (stage) {
    case 'requested':
    case 'prepared':
    case 'started':
    case 'committed':
    case 'accepted':
    case 'rejected':
    case 'cancelled':
    case 'indeterminate':
      return { type: stage, attemptId }
    case 'resolved.not_committed':
      return { type: 'resolved_not_committed', attemptId }
    case 'resolved.committed':
      return { type: 'resolved_committed', attemptId }
    case 'resolved.abandoned':
      return { type: 'resolved_abandoned', attemptId }
    case 'failed': {
      const effectCommitted = readPayloadBoolean(event, 'effectCommitted')
      return effectCommitted === undefined
        ? { type: 'failed', attemptId }
        : { type: 'failed', attemptId, effectCommitted }
    }
    default:
      return undefined
  }
}

export function isDurableStreamEvent(
  event: DurableDispatchStreamEvent | undefined,
): event is DurableDispatchStreamEvent {
  return event !== undefined
}

function findLast(
  stream: readonly ExecutionJournalEvent[],
  type: string,
): ExecutionJournalEvent | undefined {
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const event = stream[index]
    if (event && event.type === type) return event
  }
  return undefined
}

const TERMINAL_EVENT_TYPES = [
  // First, so an operator's abandonment outranks an earlier in-flight
  // cancellation that left the effect unproven rather than settled.
  RESOLUTION_EVENT_TYPES.abandon,
  'capability.dispatch.rejected',
  'capability.dispatch.cancelled',
  'capability.dispatch.failed',
] as const

function findTerminalEvent(
  stream: readonly ExecutionJournalEvent[],
): ExecutionJournalEvent | undefined {
  for (const type of TERMINAL_EVENT_TYPES) {
    const event = findLast(stream, type)
    if (event) return event
  }
  return undefined
}

function readPayloadString(
  event: ExecutionJournalEvent | undefined,
  key: string,
): string | undefined {
  if (!event) return undefined
  const value = event.payload[key]
  return typeof value === 'string' ? value : undefined
}

/** Unrecognized or absent policies fail closed as `unknown` (ADR §7). */
function readRecoveryPolicy(
  event: ExecutionJournalEvent | undefined,
): CapabilityRecoveryPolicy {
  return narrowRecoveryPolicy(readPayloadString(event, 'recoveryPolicy'))
}

function readPayloadBoolean(
  event: ExecutionJournalEvent | undefined,
  key: string,
): boolean | undefined {
  if (!event) return undefined
  const value = event.payload[key]
  return typeof value === 'boolean' ? value : undefined
}

function terminalPayload(
  attemptId: string,
  result: Exclude<CapabilityDispatchResult, { readonly status: 'completed' }>,
  identity?: CanonicalJsonObject,
): CanonicalJsonObject {
  return {
    attemptId,
    dispatchId: result.dispatchId,
    status: result.status,
    code: result.code,
    ...(identity === undefined ? {} : { identity }),
  }
}

/**
 * A result the journal may retain, or the reason it may not.
 *
 * Two arms since Phase 3. The size threshold that used to choose between an
 * inline value and a journal-owned file is gone with the forms it chose
 * between: every retained result is canonical bytes handed to the assignment's
 * content store, whatever its length.
 */
type ResultSerialization =
  | { readonly kind: 'canonical'; readonly canonical: string }
  | { readonly kind: 'unserializable' }

export function serializeResultForRetention(value: unknown): ResultSerialization {
  if (!isPlainRecord(value)) return { kind: 'unserializable' }
  try {
    return { kind: 'canonical', canonical: canonicalizeJson(value) }
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      return { kind: 'unserializable' }
    }
    throw error
  }
}

/**
 * Narrow an untrusted value to a payload v2 content receipt.
 *
 * Used for both a receipt this port sealed and one an operator supplied. The
 * content identity has to be a digest before it is allowed to name a file, so
 * a value that is not one is refused here rather than sanitized into one.
 */
function parseContentReceipt(
  raw: unknown,
): CapabilityResultContentReceipt | undefined {
  if (!isPlainRecord(raw)) return undefined
  const contentId = raw['contentId']
  const contentSha256 = raw['contentSha256']
  const byteLength = raw['byteLength']
  if (
    typeof contentId !== 'string' ||
    !CONTENT_ID_PATTERN.test(contentId) ||
    contentSha256 !== contentId ||
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    raw['mediaType'] !== CAPABILITY_RESULT_MEDIA_TYPE ||
    raw['resultSchemaVersion'] !== CAPABILITY_RESULT_CONTENT_SCHEMA_VERSION
  ) {
    return undefined
  }
  return {
    contentId,
    contentSha256,
    byteLength,
    mediaType: CAPABILITY_RESULT_MEDIA_TYPE,
    resultSchemaVersion: CAPABILITY_RESULT_CONTENT_SCHEMA_VERSION,
  }
}

function readTerminalResult(
  event: ExecutionJournalEvent,
): CapabilityDispatchResult | undefined {
  const dispatchId = readPayloadString(event, 'dispatchId')
  const status = readPayloadString(event, 'status')
  const code = readPayloadString(event, 'code')
  if (
    dispatchId === undefined ||
    code === undefined ||
    (status !== 'rejected' && status !== 'cancelled' && status !== 'failed')
  ) {
    return undefined
  }
  return { status, dispatchId, code }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
