import {
  toCanonicalJsonObject,
  type CanonicalJsonObject,
} from '../../contracts/canonical-json.js'
import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'

/**
 * The `agent.turn` domain stream on the canonical execution journal.
 *
 * The journal foundation owns the envelope, sequencing, hashing, and append
 * rules; a domain owns its payloads and its reduction. This module is that
 * domain half for one selected-agent chat reply, and it is deliberately pure:
 * no filesystem, no registry, no journal handle. `services/` owns those.
 *
 * What it records is lifecycle and diagnostic *identity*. Prompts, provider
 * response text, raw HTTP bodies, headers, and credentials are excluded by the
 * journal ADR and are excluded here — a failure keeps its layer, phase, stable
 * service code, provider kind/code, HTTP status, and retryability, and nothing
 * that could carry the words the provider or the user actually wrote.
 */

export const AGENT_TURN_STREAM_KIND = 'agent.turn'
export const AGENT_TURN_PAYLOAD_SCHEMA_VERSION = 1

export const AGENT_TURN_STARTED_EVENT_TYPE = 'agent.turn.started'
export const AGENT_TURN_PREPARED_EVENT_TYPE = 'agent.turn.prepared'
export const AGENT_TURN_COMPLETED_EVENT_TYPE = 'agent.turn.completed'
export const AGENT_TURN_PASSED_EVENT_TYPE = 'agent.turn.passed'
export const AGENT_TURN_FAILED_EVENT_TYPE = 'agent.turn.failed'
export const AGENT_TURN_CANCELLED_EVENT_TYPE = 'agent.turn.cancelled'

/**
 * Which client actually produced the reply. `no-tools` and `unavailable` MCP
 * outcomes fall through to the direct provider, so the route a turn *took* is
 * not derivable from the route it intended.
 */
export const AGENT_TURN_ROUTES = [
  'mcp-native',
  'mcp-cli',
  'direct-provider',
] as const
export type AgentTurnRoute = (typeof AGENT_TURN_ROUTES)[number]

/** Which layer converted the fault into the outcome the user saw. */
export const AGENT_TURN_FAILURE_LAYERS = [
  'provider-adapter',
  'provider-tool-loop',
  'mcp-service',
  'direct-provider',
  'chat-delivery',
  'chat-persistence',
] as const
export type AgentTurnFailureLayer = (typeof AGENT_TURN_FAILURE_LAYERS)[number]

/** What the turn was doing when it failed. */
export const AGENT_TURN_FAILURE_PHASES = [
  'provider-resolution',
  'tool-discovery',
  'provider-request',
  'tool-execution',
  'artifact-publication',
  'assistant-persistence',
] as const
export type AgentTurnFailurePhase = (typeof AGENT_TURN_FAILURE_PHASES)[number]

/**
 * A failure's durable identity, carried outward from whichever layer produced
 * it. Data, not an exception message: every field is either a closed union or
 * a value the provider states about itself.
 */
export interface AgentTurnFailureIdentity {
  readonly layer: AgentTurnFailureLayer
  readonly phase: AgentTurnFailurePhase
  /** The runtime's own stable code, e.g. `provider_failed`, `timeout`. */
  readonly serviceCode: string
  /** The normalized provider error kind, when one was recognized. */
  readonly providerKind?: string
  /** The provider's own error code, when it stated one. */
  readonly providerCode?: string
  /**
   * Which provider and model the turn was asking when it failed.
   *
   * Recorded because `providerKind` alone cannot answer the question a health
   * badge asks: an exhausted key belongs to one account and one model, and
   * without naming them a reader can only say that *something* ran out.
   * Identifiers only — never a key, a URL, or a request.
   */
  readonly provider?: string
  readonly model?: string
  readonly httpStatus?: number
  /**
   * When this failure stops being true, if the provider stated it.
   *
   * Only a usage limit has one, and only when the provider said so. An exact
   * instant, derived once when the failure happened — never the sentence it
   * came from. That sentence is display text and this record holds none, which
   * is precisely why the moment may travel here when the message may not.
   *
   * Resolved against the clock of the machine that read it, because a provider
   * states a wall-clock time and often omits the year. Storing the result is
   * what keeps a later replay from re-resolving the same ambiguity against a
   * "now" that has moved.
   */
  readonly resetsAt?: string
  readonly retryable: boolean
  /**
   * Whether the attempt had sent anything when it failed.
   *
   * `false` is the adapter's own claim that it refused before making the
   * request. Recorded because the failure *phase* cannot answer it, and
   * neither can the persona's tool list: the MCP worker route chooses its own
   * grants and can run a native tool loop whatever the persona declares.
   */
  readonly dispatched?: boolean
}

export interface AgentTurnTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

export interface AgentTurnStartedPayload {
  readonly turnId: string
  readonly replyId: string
  readonly speakerOrdinal: number
  readonly agentPath: string
  readonly requestedProvider?: string
  readonly requestedModel?: string
  /**
   * Constant for now, and named rather than implied: a selected-agent reply is
   * always attempted tool-capable, and a later route (a persona-only reply, a
   * title generation) would need its own value rather than reusing this one.
   */
  readonly routeIntent: 'tool-capable'
}

/**
 * What a preparation may say happened.
 *
 * `cancelled` is deliberately absent. Cancellation is its own terminal event,
 * reached through `recordCancelled`, and it happens before a reply is ever
 * prepared — nothing was constructed to store. Admitting it here as well would
 * give one fact two representations, and because a prepared outcome other than
 * `success` must carry a failure identity, the cancellation would then be
 * reduced as a provider failure. A user stopping a turn is not a provider
 * failing one.
 */
export const AGENT_TURN_PREPARED_OUTCOMES = [
  'success',
  'provider-failure',
  'truncated',
] as const
export type AgentTurnPreparedOutcome =
  (typeof AGENT_TURN_PREPARED_OUTCOMES)[number]

/**
 * Prepared outcomes that must be accompanied by a failure identity.
 *
 * The two halves used to be independent, so a preparation could say
 * `provider-failure` and carry nothing to explain it — which a reconciliation
 * reading only the outcome would then finish as a success. Pairing them makes
 * that stream unrepresentable on write and invalid on read.
 */
const AGENT_TURN_FAILED_OUTCOMES: ReadonlySet<AgentTurnPreparedOutcome> =
  new Set(['provider-failure', 'truncated'])

interface AgentTurnPreparedSuccess {
  readonly outcome: 'success'
  readonly failure?: undefined
}

interface AgentTurnPreparedFailure {
  readonly outcome: Exclude<AgentTurnPreparedOutcome, 'success'>
  readonly failure: AgentTurnFailureIdentity
}

/** A preparation's outcome and its explanation, as one indivisible fact. */
export type AgentTurnPreparedResolution =
  | AgentTurnPreparedSuccess
  | AgentTurnPreparedFailure

export type AgentTurnPreparedPayload = AgentTurnPreparedResolution & {
  readonly turnId: string
  readonly replyId: string
  readonly assistantMessageId: string
  readonly route: AgentTurnRoute
  readonly resolvedModel?: string
  readonly declaredToolCount?: number
  readonly executedToolCount?: number
  /** The reply's size, never its text. */
  readonly outputByteLength: number
  readonly usage?: AgentTurnTokenUsage
}

export interface AgentTurnCompletedPayload {
  readonly turnId: string
  readonly replyId: string
  readonly assistantMessageId: string
  readonly route: AgentTurnRoute
}

/** A successful dialogue turn that publishes no message. */
export interface AgentTurnPassedPayload {
  readonly turnId: string
  readonly replyId: string
  readonly route: AgentTurnRoute
  readonly resolvedModel?: string
  readonly declaredToolCount?: number
  readonly executedToolCount?: number
  readonly usage?: AgentTurnTokenUsage
}

export interface AgentTurnFailedPayload {
  readonly turnId: string
  readonly replyId: string
  /** Absent when no safe failure message reached the transcript. */
  readonly assistantMessageId?: string
  readonly route?: AgentTurnRoute
  readonly failure: AgentTurnFailureIdentity
}

export interface AgentTurnCancelledPayload {
  readonly turnId: string
  readonly replyId: string
  readonly assistantMessageId?: string
  readonly route?: AgentTurnRoute
  readonly phase: AgentTurnFailurePhase
}

/** The three appends one turn may make, in the order it may make them. */
export type AgentTurnEventStage = 'started' | 'prepared' | 'terminal'

/**
 * One turn owns one stream, so its event identity is derived rather than
 * minted. A retry that re-appends the same stage with the same payload is
 * accepted by the journal as already-accepted; one that re-appends it with
 * different content fails closed.
 */
export function agentTurnEventId(
  assignmentId: string,
  stage: AgentTurnEventStage,
): string {
  return `${assignmentId}:agent-turn:${stage}`
}

export class AgentTurnPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentTurnPayloadError'
  }
}

export function buildAgentTurnStartedPayload(input: {
  readonly turnId: string
  readonly replyId: string
  readonly speakerOrdinal: number
  readonly agentPath: string
  readonly requestedProvider?: string | undefined
  readonly requestedModel?: string | undefined
}): CanonicalJsonObject {
  requireIdentity(input.turnId, 'turnId')
  requireIdentity(input.replyId, 'replyId')
  requireIdentity(input.agentPath, 'agentPath')
  requireOrdinal(input.speakerOrdinal, 'speakerOrdinal')
  return toCanonicalJsonObject({
    turnId: input.turnId,
    replyId: input.replyId,
    speakerOrdinal: input.speakerOrdinal,
    agentPath: input.agentPath,
    ...(input.requestedProvider === undefined
      ? {}
      : { requestedProvider: input.requestedProvider }),
    ...(input.requestedModel === undefined
      ? {}
      : { requestedModel: input.requestedModel }),
    routeIntent: 'tool-capable',
  })
}

export function buildAgentTurnPreparedPayload(input: {
  readonly turnId: string
  readonly replyId: string
  readonly assistantMessageId: string
  readonly outcome: AgentTurnPreparedOutcome
  readonly route: AgentTurnRoute
  readonly resolvedModel?: string | undefined
  readonly declaredToolCount?: number | undefined
  readonly executedToolCount?: number | undefined
  readonly outputByteLength: number
  readonly usage?: AgentTurnTokenUsage | undefined
  readonly failure?: AgentTurnFailureIdentity | undefined
}): CanonicalJsonObject {
  requireIdentity(input.turnId, 'turnId')
  requireIdentity(input.replyId, 'replyId')
  requireIdentity(input.assistantMessageId, 'assistantMessageId')
  // Named separately from the other members so the refusal says what is
  // wrong: cancellation is a terminal, not something a reply was prepared as.
  if (String(input.outcome) === 'cancelled') {
    throw new AgentTurnPayloadError(
      'a cancelled turn is recorded as a cancellation terminal, never as a prepared outcome',
    )
  }
  requireMember(input.outcome, AGENT_TURN_PREPARED_OUTCOMES, 'outcome')
  requireMember(input.route, AGENT_TURN_ROUTES, 'route')
  requireOrdinal(input.outputByteLength, 'outputByteLength')
  requireResolvedOutcome(input.outcome, input.failure)
  if (input.declaredToolCount !== undefined) {
    requireOrdinal(input.declaredToolCount, 'declaredToolCount')
  }
  if (input.executedToolCount !== undefined) {
    requireOrdinal(input.executedToolCount, 'executedToolCount')
  }
  return toCanonicalJsonObject({
    turnId: input.turnId,
    replyId: input.replyId,
    assistantMessageId: input.assistantMessageId,
    outcome: input.outcome,
    route: input.route,
    ...(input.resolvedModel === undefined
      ? {}
      : { resolvedModel: input.resolvedModel }),
    ...(input.declaredToolCount === undefined
      ? {}
      : { declaredToolCount: input.declaredToolCount }),
    ...(input.executedToolCount === undefined
      ? {}
      : { executedToolCount: input.executedToolCount }),
    outputByteLength: input.outputByteLength,
    ...(input.usage === undefined ? {} : { usage: canonicalUsage(input.usage) }),
    ...(input.failure === undefined
      ? {}
      : { failure: canonicalFailure(input.failure) }),
  })
}

export function buildAgentTurnCompletedPayload(
  input: AgentTurnCompletedPayload,
): CanonicalJsonObject {
  requireIdentity(input.turnId, 'turnId')
  requireIdentity(input.replyId, 'replyId')
  requireIdentity(input.assistantMessageId, 'assistantMessageId')
  requireMember(input.route, AGENT_TURN_ROUTES, 'route')
  return toCanonicalJsonObject({
    turnId: input.turnId,
    replyId: input.replyId,
    assistantMessageId: input.assistantMessageId,
    route: input.route,
  })
}

export function buildAgentTurnPassedPayload(input: AgentTurnPassedPayload): CanonicalJsonObject {
  requireIdentity(input.turnId, 'turnId')
  requireIdentity(input.replyId, 'replyId')
  requireMember(input.route, AGENT_TURN_ROUTES, 'route')
  if (input.resolvedModel !== undefined) requireIdentity(input.resolvedModel, 'resolvedModel')
  if (input.declaredToolCount !== undefined) requireOrdinal(input.declaredToolCount, 'declaredToolCount')
  if (input.executedToolCount !== undefined) requireOrdinal(input.executedToolCount, 'executedToolCount')
  return toCanonicalJsonObject({
    turnId: input.turnId,
    replyId: input.replyId,
    route: input.route,
    ...(input.resolvedModel === undefined ? {} : { resolvedModel: input.resolvedModel }),
    ...(input.declaredToolCount === undefined ? {} : { declaredToolCount: input.declaredToolCount }),
    ...(input.executedToolCount === undefined ? {} : { executedToolCount: input.executedToolCount }),
    ...(input.usage === undefined ? {} : { usage: canonicalUsage(input.usage) }),
  })
}

export function buildAgentTurnFailedPayload(input: {
  readonly turnId: string
  readonly replyId: string
  readonly assistantMessageId?: string | undefined
  readonly route?: AgentTurnRoute | undefined
  readonly failure: AgentTurnFailureIdentity
}): CanonicalJsonObject {
  requireIdentity(input.turnId, 'turnId')
  requireIdentity(input.replyId, 'replyId')
  if (input.assistantMessageId !== undefined) {
    requireIdentity(input.assistantMessageId, 'assistantMessageId')
  }
  if (input.route !== undefined) {
    requireMember(input.route, AGENT_TURN_ROUTES, 'route')
  }
  return toCanonicalJsonObject({
    turnId: input.turnId,
    replyId: input.replyId,
    ...(input.assistantMessageId === undefined
      ? {}
      : { assistantMessageId: input.assistantMessageId }),
    ...(input.route === undefined ? {} : { route: input.route }),
    failure: canonicalFailure(input.failure),
  })
}

export function buildAgentTurnCancelledPayload(input: {
  readonly turnId: string
  readonly replyId: string
  readonly assistantMessageId?: string | undefined
  readonly route?: AgentTurnRoute | undefined
  readonly phase: AgentTurnFailurePhase
}): CanonicalJsonObject {
  requireIdentity(input.turnId, 'turnId')
  requireIdentity(input.replyId, 'replyId')
  if (input.assistantMessageId !== undefined) {
    requireIdentity(input.assistantMessageId, 'assistantMessageId')
  }
  if (input.route !== undefined) {
    requireMember(input.route, AGENT_TURN_ROUTES, 'route')
  }
  requireMember(input.phase, AGENT_TURN_FAILURE_PHASES, 'phase')
  return toCanonicalJsonObject({
    turnId: input.turnId,
    replyId: input.replyId,
    ...(input.assistantMessageId === undefined
      ? {}
      : { assistantMessageId: input.assistantMessageId }),
    ...(input.route === undefined ? {} : { route: input.route }),
    phase: input.phase,
  })
}

function requireResolvedOutcome(
  outcome: AgentTurnPreparedOutcome,
  failure: AgentTurnFailureIdentity | undefined,
): void {
  const shouldExplain = AGENT_TURN_FAILED_OUTCOMES.has(outcome)
  if (shouldExplain && failure === undefined) {
    throw new AgentTurnPayloadError(
      `outcome '${outcome}' must carry a failure identity`,
    )
  }
  if (!shouldExplain && failure !== undefined) {
    throw new AgentTurnPayloadError(
      `outcome '${outcome}' must not carry a failure identity`,
    )
  }
}

export function readAgentTurnStartedPayload(
  value: unknown,
): AgentTurnStartedPayload | null {
  const record = asRecord(value)
  if (!record) return null
  const turnId = identity(record.turnId)
  const replyId = identity(record.replyId)
  const agentPath = identity(record.agentPath)
  const speakerOrdinal = ordinal(record.speakerOrdinal)
  if (!turnId || !replyId || !agentPath || speakerOrdinal === undefined) {
    return null
  }
  if (record.routeIntent !== 'tool-capable') return null
  const requestedProvider = identity(record.requestedProvider)
  const requestedModel = identity(record.requestedModel)
  return {
    turnId,
    replyId,
    speakerOrdinal,
    agentPath,
    ...(requestedProvider === undefined ? {} : { requestedProvider }),
    ...(requestedModel === undefined ? {} : { requestedModel }),
    routeIntent: 'tool-capable',
  }
}

export function readAgentTurnPreparedPayload(
  value: unknown,
): AgentTurnPreparedPayload | null {
  const record = asRecord(value)
  if (!record) return null
  const turnId = identity(record.turnId)
  const replyId = identity(record.replyId)
  const assistantMessageId = identity(record.assistantMessageId)
  // A stored `cancelled` preparation is refused here, not translated: it is a
  // shape this domain never writes, and reading it as a failure would report a
  // user's decision as a provider fault.
  const outcome = member(record.outcome, AGENT_TURN_PREPARED_OUTCOMES)
  const route = member(record.route, AGENT_TURN_ROUTES)
  const outputByteLength = ordinal(record.outputByteLength)
  if (
    !turnId ||
    !replyId ||
    !assistantMessageId ||
    !outcome ||
    !route ||
    outputByteLength === undefined
  ) {
    return null
  }
  const failure =
    record.failure === undefined
      ? undefined
      : (readFailureIdentity(record.failure) ?? undefined)
  if (record.failure !== undefined && failure === undefined) return null
  // A stored preparation whose outcome and explanation disagree is a stream
  // nobody can reconcile: reading only the outcome would finish a failure as a
  // success. It is reported as invalid rather than guessed at.
  if (AGENT_TURN_FAILED_OUTCOMES.has(outcome) !== (failure !== undefined)) {
    return null
  }
  const usage = record.usage === undefined ? undefined : readUsage(record.usage)
  if (record.usage !== undefined && !usage) return null
  const resolvedModel = identity(record.resolvedModel)
  const declaredToolCount = ordinal(record.declaredToolCount)
  const executedToolCount = ordinal(record.executedToolCount)
  const common = {
    turnId,
    replyId,
    assistantMessageId,
    route,
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
    ...(declaredToolCount === undefined ? {} : { declaredToolCount }),
    ...(executedToolCount === undefined ? {} : { executedToolCount }),
    outputByteLength,
    ...(usage ? { usage } : {}),
  }
  return failure === undefined
    ? { ...common, outcome: 'success' }
    : { ...common, outcome: failedOutcome(outcome), failure }
}

/** Narrowing without an assertion; membership was decided above. */
function failedOutcome(
  outcome: AgentTurnPreparedOutcome,
): Exclude<AgentTurnPreparedOutcome, 'success'> {
  return outcome === 'provider-failure' || outcome === 'truncated'
    ? outcome
    : 'provider-failure'
}

export function readAgentTurnCompletedPayload(
  value: unknown,
): AgentTurnCompletedPayload | null {
  const record = asRecord(value)
  if (!record) return null
  const turnId = identity(record.turnId)
  const replyId = identity(record.replyId)
  const assistantMessageId = identity(record.assistantMessageId)
  const route = member(record.route, AGENT_TURN_ROUTES)
  if (!turnId || !replyId || !assistantMessageId || !route) return null
  return { turnId, replyId, assistantMessageId, route }
}

export function readAgentTurnPassedPayload(value: unknown): AgentTurnPassedPayload | null {
  const record = asRecord(value)
  if (!record || record.assistantMessageId !== undefined || record.failure !== undefined) return null
  const turnId = identity(record.turnId)
  const replyId = identity(record.replyId)
  const route = member(record.route, AGENT_TURN_ROUTES)
  if (!turnId || !replyId || !route) return null
  const resolvedModel = identity(record.resolvedModel)
  const declaredToolCount = ordinal(record.declaredToolCount)
  const executedToolCount = ordinal(record.executedToolCount)
  const usage = record.usage === undefined ? undefined : readUsage(record.usage)
  if (record.resolvedModel !== undefined && resolvedModel === undefined) return null
  if (record.declaredToolCount !== undefined && declaredToolCount === undefined) return null
  if (record.executedToolCount !== undefined && executedToolCount === undefined) return null
  if (record.usage !== undefined && !usage) return null
  return {
    turnId, replyId, route,
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
    ...(declaredToolCount === undefined ? {} : { declaredToolCount }),
    ...(executedToolCount === undefined ? {} : { executedToolCount }),
    ...(usage ? { usage } : {}),
  }
}

export function readAgentTurnFailedPayload(
  value: unknown,
): AgentTurnFailedPayload | null {
  const record = asRecord(value)
  if (!record) return null
  const turnId = identity(record.turnId)
  const replyId = identity(record.replyId)
  const failure = readFailureIdentity(record.failure)
  if (!turnId || !replyId || !failure) return null
  const route = member(record.route, AGENT_TURN_ROUTES)
  if (record.route !== undefined && !route) return null
  const assistantMessageId = identity(record.assistantMessageId)
  return {
    turnId,
    replyId,
    ...(assistantMessageId === undefined ? {} : { assistantMessageId }),
    ...(route === undefined ? {} : { route }),
    failure,
  }
}

export function readAgentTurnCancelledPayload(
  value: unknown,
): AgentTurnCancelledPayload | null {
  const record = asRecord(value)
  if (!record) return null
  const turnId = identity(record.turnId)
  const replyId = identity(record.replyId)
  const phase = member(record.phase, AGENT_TURN_FAILURE_PHASES)
  if (!turnId || !replyId || !phase) return null
  const route = member(record.route, AGENT_TURN_ROUTES)
  if (record.route !== undefined && !route) return null
  const assistantMessageId = identity(record.assistantMessageId)
  return {
    turnId,
    replyId,
    ...(assistantMessageId === undefined ? {} : { assistantMessageId }),
    ...(route === undefined ? {} : { route }),
    phase,
  }
}

/**
 * What an operator is told about one turn.
 *
 * `provider_in_progress` and `reply_pending` are the two states a crash can
 * leave behind, and they answer different questions: the first has no answer
 * yet, the second may already have one stored under `assistantMessageId`.
 */
export type AgentTurnState =
  | 'provider_in_progress'
  | 'reply_pending'
  | 'completed'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'invalid'

export interface AgentTurnSummary {
  /** The assignment whose journal holds this turn; also the stream id. */
  readonly assignmentId: string
  readonly turnId: string
  readonly replyId: string
  readonly state: AgentTurnState
  /**
   * Who was asked, from `started`.
   *
   * Kept because it is the only durable record of the turn's addressee. A user
   * offered a retry for an interrupted turn must be able to send it to the
   * agent they originally asked, and nothing on screen still knows who that
   * was by the time they see the offer.
   */
  readonly agentPath?: string
  readonly route?: AgentTurnRoute
  /**
   * What the preparation recorded about the turn's outcome. Present from
   * `prepared` onwards, and the one field a reconciliation needs: it decides
   * whether the missing terminal is a completion or a failure.
   */
  readonly outcome?: AgentTurnPreparedOutcome
  readonly failureAtPreparation?: AgentTurnFailureIdentity
  readonly model?: string
  /** The reply this turn stored, or intended to store once prepared. */
  readonly assistantMessageId?: string
  readonly failure?: AgentTurnFailureIdentity
  readonly startedSequence?: number
  readonly startedAt?: string
  readonly terminalSequence?: number
  readonly terminalAt?: string
}

/**
 * Reduce every `agent.turn` stream among a journal's events.
 *
 * A journal holds one assignment and a selected-agent reply currently owns one
 * assignment, so in practice this returns one summary. It is written for many
 * because the stream key is the assignment id, not the journal, and a future
 * assignment carrying more than one turn must not silently merge them.
 */
export function summarizeAgentTurnStreams(
  events: readonly ExecutionJournalEvent[],
): readonly AgentTurnSummary[] {
  const streams = new Map<string, ExecutionJournalEvent[]>()
  for (const event of events) {
    if (event.streamKind !== AGENT_TURN_STREAM_KIND) continue
    const existing = streams.get(event.streamId)
    if (existing) existing.push(event)
    else streams.set(event.streamId, [event])
  }
  return [...streams].map(([streamId, stream]) =>
    reduceAgentTurnStream(streamId, stream),
  )
}

export function reduceAgentTurnStream(
  streamId: string,
  events: readonly ExecutionJournalEvent[],
): AgentTurnSummary {
  const ordered = [...events].sort(
    (left, right) => left.streamRevision - right.streamRevision,
  )
  const invalid = (turnId = '', replyId = ''): AgentTurnSummary => ({
    assignmentId: streamId,
    turnId,
    replyId,
    state: 'invalid',
  })

  // Stored revisions are one-based: the journal stamps `expected + 1`, so the
  // start of a stream is revision 1 even though it was appended expecting 0.
  const first = ordered[0]
  if (!first || first.streamRevision !== 1) return invalid()
  if (first.type !== AGENT_TURN_STARTED_EVENT_TYPE) return invalid()
  const started = readAgentTurnStartedPayload(first.payload)
  if (!started) return invalid()

  let summary: AgentTurnSummary = {
    assignmentId: streamId,
    turnId: started.turnId,
    replyId: started.replyId,
    state: 'provider_in_progress',
    agentPath: started.agentPath,
    ...(started.requestedModel === undefined
      ? {}
      : { model: started.requestedModel }),
    startedSequence: first.sequence,
    startedAt: first.recordedAt,
  }
  let preparation: AgentTurnPreparedPayload | undefined
  let prepared = false
  let terminal = false
  // Every later event must be about the same turn and the same reply the
  // start named. Each payload validates on its own, so without this a
  // terminal describing a different reply — or a different turn entirely —
  // would parse cleanly and be reduced as this turn's outcome.
  const belongsToThisTurn = (payload: {
    readonly turnId: string
    readonly replyId: string
  }): boolean =>
    payload.turnId === started.turnId && payload.replyId === started.replyId

  for (const [index, event] of ordered.slice(1).entries()) {
    if (terminal || event.streamRevision !== index + 2) {
      return invalid(started.turnId, started.replyId)
    }
    if (event.type === AGENT_TURN_PREPARED_EVENT_TYPE) {
      if (prepared) return invalid(started.turnId, started.replyId)
      const payload = readAgentTurnPreparedPayload(event.payload)
      if (!payload || !belongsToThisTurn(payload)) {
        return invalid(started.turnId, started.replyId)
      }
      preparation = payload
      prepared = true
      const model = payload.resolvedModel ?? summary.model
      summary = {
        ...summary,
        state: 'reply_pending',
        route: payload.route,
        outcome: payload.outcome,
        assistantMessageId: payload.assistantMessageId,
        ...(model === undefined ? {} : { model }),
        ...(payload.failure
          ? { failure: payload.failure, failureAtPreparation: payload.failure }
          : {}),
      }
      continue
    }
    if (event.type === AGENT_TURN_COMPLETED_EVENT_TYPE) {
      // A completion claims the reply was stored, and only the prepared event
      // carries the identity of the reply that was meant to be.
      if (!preparation) return invalid(started.turnId, started.replyId)
      const payload = readAgentTurnCompletedPayload(event.payload)
      if (
        !payload ||
        !belongsToThisTurn(payload) ||
        // A completion is a claim about the reply the preparation named, on
        // the route it named. Either disagreeing means the two events describe
        // different work, and reducing them together would invent a history.
        payload.assistantMessageId !== preparation.assistantMessageId ||
        payload.route !== preparation.route
      ) {
        return invalid(started.turnId, started.replyId)
      }
      terminal = true
      summary = {
        ...summary,
        state: 'completed',
        route: payload.route,
        assistantMessageId: payload.assistantMessageId,
        terminalSequence: event.sequence,
        terminalAt: event.recordedAt,
      }
      continue
    }
    if (event.type === AGENT_TURN_PASSED_EVENT_TYPE) {
      const payload = readAgentTurnPassedPayload(event.payload)
      if (preparation || !payload || !belongsToThisTurn(payload)) {
        return invalid(started.turnId, started.replyId)
      }
      terminal = true
      summary = {
        ...summary,
        state: 'passed',
        route: payload.route,
        ...(payload.resolvedModel === undefined ? {} : { model: payload.resolvedModel }),
        terminalSequence: event.sequence,
        terminalAt: event.recordedAt,
      }
      continue
    }
    if (event.type === AGENT_TURN_FAILED_EVENT_TYPE) {
      const payload = readAgentTurnFailedPayload(event.payload)
      if (
        !payload ||
        !belongsToThisTurn(payload) ||
        !agreesWithPreparation(payload, preparation)
      ) {
        return invalid(started.turnId, started.replyId)
      }
      terminal = true
      summary = {
        ...terminalBase(summary, payload.assistantMessageId),
        state: 'failed',
        ...(payload.route ? { route: payload.route } : {}),
        failure: payload.failure,
        terminalSequence: event.sequence,
        terminalAt: event.recordedAt,
      }
      continue
    }
    if (event.type === AGENT_TURN_CANCELLED_EVENT_TYPE) {
      const payload = readAgentTurnCancelledPayload(event.payload)
      if (
        !payload ||
        !belongsToThisTurn(payload) ||
        !agreesWithPreparation(payload, preparation)
      ) {
        return invalid(started.turnId, started.replyId)
      }
      terminal = true
      summary = {
        ...terminalBase(summary, payload.assistantMessageId),
        state: 'cancelled',
        ...(payload.route ? { route: payload.route } : {}),
        terminalSequence: event.sequence,
        terminalAt: event.recordedAt,
      }
      continue
    }
    return invalid(started.turnId, started.replyId)
  }

  return summary
}

/**
 * Whether a failure or cancellation contradicts the preparation before it.
 *
 * Both may legitimately omit a message id and a route — a turn that never
 * prepared a reply has neither — so only a *stated* value is checked, and it
 * is checked only when there is a preparation to check it against.
 */
function agreesWithPreparation(
  payload: {
    readonly assistantMessageId?: string
    readonly route?: AgentTurnRoute
  },
  preparation: AgentTurnPreparedPayload | undefined,
): boolean {
  if (!preparation) {
    return payload.assistantMessageId === undefined
  }
  if (
    payload.assistantMessageId !== undefined &&
    payload.assistantMessageId !== preparation.assistantMessageId
  ) {
    return false
  }
  return payload.route === undefined || payload.route === preparation.route
}

/**
 * The summary a terminal event builds on.
 *
 * Only the terminal's own claim survives. While a turn is `reply_pending` the
 * id shown is the reply it *intended* to store — which is what reconciliation
 * needs — but once a terminal is recorded the field means the reply that is
 * durable, and a turn whose storage failed has none. Carrying the intended id
 * forward would make those two facts indistinguishable.
 */
function terminalBase(
  summary: AgentTurnSummary,
  assistantMessageId: string | undefined,
): AgentTurnSummary {
  const { assistantMessageId: _intended, ...rest } = summary
  return assistantMessageId === undefined
    ? rest
    : { ...rest, assistantMessageId }
}

/**
 * The shape a diagnostic code is allowed to have.
 *
 * `providerKind` and `providerCode` are the only two fields a *provider*
 * controls, and the journal is durable, so an unbounded string here is a
 * channel for prose, an echoed prompt, or a credential. A code that is not a
 * short identifier is dropped rather than stored — the rest of the identity
 * (layer, phase, status, retryability) still answers the operator's question.
 */
const DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

function diagnosticCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return DIAGNOSTIC_CODE_PATTERN.test(trimmed) ? trimmed : undefined
}

/**
 * The shape a provider or model name is allowed to have.
 *
 * Wider than a diagnostic code because these names legitimately carry a colon
 * (`connection:my-gateway`) or a slash (`anthropic/claude-sonnet-4`), and
 * still bounded for the same reason: this app chooses them, but a
 * misconfigured one must not become a way to write prose into a durable file.
 */
const PROVIDER_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i

function providerReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return PROVIDER_REFERENCE_PATTERN.test(trimmed) ? trimmed : undefined
}

function canonicalFailure(
  failure: AgentTurnFailureIdentity,
): CanonicalJsonObject {
  requireMember(failure.layer, AGENT_TURN_FAILURE_LAYERS, 'failure.layer')
  requireMember(failure.phase, AGENT_TURN_FAILURE_PHASES, 'failure.phase')
  requireIdentity(failure.serviceCode, 'failure.serviceCode')
  if (typeof failure.retryable !== 'boolean') {
    throw new AgentTurnPayloadError('failure.retryable must be a boolean')
  }
  if (failure.httpStatus !== undefined) {
    requireOrdinal(failure.httpStatus, 'failure.httpStatus')
  }
  const providerKind = diagnosticCode(failure.providerKind)
  const providerCode = diagnosticCode(failure.providerCode)
  const provider = providerReference(failure.provider)
  const model = providerReference(failure.model)
  return {
    layer: failure.layer,
    phase: failure.phase,
    serviceCode: failure.serviceCode,
    ...(providerKind === undefined ? {} : { providerKind }),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(failure.httpStatus === undefined
      ? {}
      : { httpStatus: failure.httpStatus }),
    ...(exactInstant(failure.resetsAt) === undefined
      ? {}
      : { resetsAt: failure.resetsAt as string }),
    retryable: failure.retryable,
    ...(failure.dispatched === false ? { dispatched: false } : {}),
  }
}

/**
 * A timestamp only if it is already exactly one.
 *
 * Round-tripping through `toISOString` is the whole check: it rejects prose, a
 * bare calendar day, and anything else a reader would have to interpret. What
 * is stored is the instant or nothing.
 */
function exactInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : undefined
}

function whenDefinedInstant(value: unknown): { resetsAt?: string } {
  const instant = exactInstant(value)
  return instant === undefined ? {} : { resetsAt: instant }
}

function readFailureIdentity(value: unknown): AgentTurnFailureIdentity | null {
  const record = asRecord(value)
  if (!record) return null
  const layer = member(record.layer, AGENT_TURN_FAILURE_LAYERS)
  const phase = member(record.phase, AGENT_TURN_FAILURE_PHASES)
  const serviceCode = identity(record.serviceCode)
  if (!layer || !phase || !serviceCode) return null
  if (typeof record.retryable !== 'boolean') return null
  const httpStatus = ordinal(record.httpStatus)
  if (record.httpStatus !== undefined && httpStatus === undefined) return null
  // Validated on read as well as on write: a journal file predating the write
  // rule, or written by another hand, must not hand prose to a reader.
  const providerKind = diagnosticCode(record.providerKind)
  const providerCode = diagnosticCode(record.providerCode)
  const provider = providerReference(record.provider)
  const model = providerReference(record.model)
  return {
    layer,
    phase,
    serviceCode,
    ...(providerKind === undefined ? {} : { providerKind }),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    // Validated on the way out as well as in: a file predating the write rule,
    // or written by another hand, must not hand a reader a date it would have
    // to re-interpret against today's clock.
    ...whenDefinedInstant(record.resetsAt),
    retryable: record.retryable,
    // A positive claim only. Anything that is not exactly `false` reads as
    // unknown, so a malformed or absent value can never authorize a retry.
    ...(record.dispatched === false ? { dispatched: false } : {}),
  }
}

function canonicalUsage(usage: AgentTurnTokenUsage): CanonicalJsonObject {
  requireOrdinal(usage.inputTokens, 'usage.inputTokens')
  requireOrdinal(usage.outputTokens, 'usage.outputTokens')
  requireOrdinal(usage.totalTokens, 'usage.totalTokens')
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  }
}

function readUsage(value: unknown): AgentTurnTokenUsage | null {
  const record = asRecord(value)
  if (!record) return null
  const inputTokens = ordinal(record.inputTokens)
  const outputTokens = ordinal(record.outputTokens)
  const totalTokens = ordinal(record.totalTokens)
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined
  ) {
    return null
  }
  return { inputTokens, outputTokens, totalTokens }
}

function requireIdentity(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentTurnPayloadError(`${field} must be a non-empty string`)
  }
}

function requireOrdinal(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentTurnPayloadError(
      `${field} must be a non-negative safe integer`,
    )
  }
}

function requireMember<TMember extends string>(
  value: unknown,
  members: readonly TMember[],
  field: string,
): void {
  if (member(value, members) === undefined) {
    throw new AgentTurnPayloadError(
      `${field} must be one of ${members.join(', ')}`,
    )
  }
}

/** Membership decided by the union itself, so nothing is asserted into it. */
function member<TMember extends string>(
  value: unknown,
  members: readonly TMember[],
): TMember | undefined {
  if (typeof value !== 'string') return undefined
  return members.find((candidate) => candidate === value)
}

function identity(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined
}

function ordinal(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...value }
    : null
}
