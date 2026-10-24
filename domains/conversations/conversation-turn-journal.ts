/**
 * The `conversation.turn` payload domain.
 *
 * One stream records one user-visible publication: the user asked something and
 * the conversation answered. The journal foundation owns the envelope,
 * sequencing, hashing, and append rules; this module owns only the payloads and
 * how a stream of them reduces to a state.
 *
 * It is deliberately not `agent.turn`. That stream is one selected-agent reply
 * on an assignment and its ADR excludes other operations
 * (docs/adr/2026-08-25-Durable-Agent-Turn-Journal.md:198-203). An ordinary
 * Receptionist turn has no assignment at all, which is the whole reason the
 * conversation scope exists.
 *
 * Two rules differ from that precedent on purpose:
 *
 * - Every payload is measured against a byte budget before it is returned. A
 *   conversation activity journal is bounded (128 events, 1 MiB), so an
 *   unbounded payload would silently spend the whole activity.
 * - A reader rejects an unrecognised field rather than plucking the keys it
 *   knows. The journal boundary is where an unknown fact must fail closed;
 *   ignoring it would let a future writer smuggle content past this contract.
 *
 * Nothing here carries prose. Text lives in the transcript the turn published.
 */
import {
  toCanonicalJsonObject,
  type CanonicalJsonObject,
} from '../../contracts/canonical-json.js'
import {
  MODEL_CALL_OUTCOMES,
  MODEL_CALL_ROUTES,
  MODEL_FAILURE_CODES,
  MODEL_FAILURE_PHASES,
  MODEL_PROVIDER_KINDS,
  STRUCTURED_DECISION_FALLBACKS,
  STRUCTURED_DECISION_REPAIRS,
  STRUCTURED_DECISION_VALIDATIONS,
  isSafeDiagnosticToken,
  isSafeResolverIdentifier,
  normalizeTokenUsage,
  type ModelCallOutcome,
  type ModelCallRoute,
  type ModelFailureCode,
  type ModelFailurePhase,
  type ModelProviderKind,
  type NormalizedTokenUsage,
  type StructuredDecisionDiagnostics,
} from '../../contracts/model-diagnostics.js'

export const CONVERSATION_TURN_STREAM_KIND = 'conversation.turn'
export const CONVERSATION_TURN_PAYLOAD_SCHEMA_VERSION = 1

export const CONVERSATION_TURN_STARTED_EVENT_TYPE = 'conversation.turn.started'
export const CONVERSATION_TURN_PREPARED_EVENT_TYPE = 'conversation.turn.prepared'
export const CONVERSATION_TURN_COMPLETED_EVENT_TYPE = 'conversation.turn.completed'
export const CONVERSATION_TURN_FAILED_EVENT_TYPE = 'conversation.turn.failed'
export const CONVERSATION_TURN_CANCELLED_EVENT_TYPE = 'conversation.turn.cancelled'

/**
 * One activity journal holds one turn, so these bounds are the turn's whole
 * budget rather than a per-conversation quota.
 */
export const CONVERSATION_TURN_MAX_PAYLOAD_BYTES = 32 * 1024
export const CONVERSATION_TURN_MAX_RESPONSES = 16

/**
 * The largest timing this record will keep, in milliseconds.
 *
 * A week. Nothing that reports a longer duration measured anything, and an
 * unbounded number is bytes the activity's budget pays for.
 */
const MAX_TIMING_MS = 7 * 24 * 60 * 60 * 1000

/** Which composer published the turn. Later phases add their own surfaces. */
export const CONVERSATION_SURFACES = [
  'run-receptionist',
  /**
   * One or more selected agents answering in the Run conversation.
   *
   * A separate surface rather than a flag on the Receptionist one, because the
   * two publish differently: a Receptionist turn answers by itself, while this
   * one delegates every reply to an assignment whose `agent.turn` stream stays
   * the authority for what that speaker did.
   */
  'run-selected-agents',
] as const
export type ConversationSurface = (typeof CONVERSATION_SURFACES)[number]

/** Whether the turn identity was minted by the client or by the server. */
export const CONVERSATION_TURN_ORIGINS = ['client', 'server'] as const
export type ConversationTurnOrigin = (typeof CONVERSATION_TURN_ORIGINS)[number]

/**
 * Where a turn stopped. `plan-revision` has no analogue in the selected-agent
 * precedent: an ordinary Receptionist turn persists a revised run plan between
 * the provider answering and the assistant message being written, and that
 * write can legitimately conflict.
 */
export const CONVERSATION_TURN_FAILURE_PHASES = [
  'preparation',
  'plan-revision',
  'provider',
  'publication',
  'terminal',
] as const
export type ConversationTurnFailurePhase =
  (typeof CONVERSATION_TURN_FAILURE_PHASES)[number]

/**
 * A failure reduced to something safe to keep forever.
 *
 * `code` is an allowlisted diagnostic identifier, never a provider message. The
 * display `reason` those adapters build can embed an exception string or a slice
 * of a response body, so it must never reach a payload builder.
 */
export interface ConversationTurnFailureIdentity {
  readonly code: ConversationTurnFailureCode
  readonly phase: ConversationTurnFailurePhase
}

export interface ConversationTurnStartedPayload {
  readonly surface: ConversationSurface
  readonly userMessageId: string
  readonly requestDigest: string
  readonly expectedResponseCount: number
  readonly origin: ConversationTurnOrigin
  /**
   * What the caller asked for, recorded before anything is called.
   *
   * On `started` rather than beside the answer, because a turn that never gets
   * an answer still has to say what it was trying to reach. A cancelled or
   * abandoned turn whose record cannot name its provider is one nobody can
   * investigate.
   */
  readonly requestedProvider?: string
  readonly requestedModel?: string
}

/** Timings a record keeps: whole milliseconds, and only the ones that happened. */
export interface ConversationTurnTiming {
  readonly providerDurationMs: number
  readonly processSpawnMs?: number
  readonly firstProviderEventMs?: number
  readonly firstTextMs?: number
}

/** What a provider failure is reduced to before it is kept forever. */
export interface ConversationTurnProviderFailure {
  readonly code: ModelFailureCode
  readonly phase: ModelFailurePhase
  readonly providerKind?: ModelProviderKind
  readonly providerCode?: string
  readonly httpStatus?: number
  readonly retryable: boolean
}

/** The content-free account of the provider call behind a turn. */
export interface ConversationTurnProviderDiagnostics {
  readonly resolvedProvider: string
  readonly resolvedModel?: string
  readonly route: ModelCallRoute
  readonly outcome: ModelCallOutcome
  readonly failure?: ConversationTurnProviderFailure
  readonly timing?: ConversationTurnTiming
  readonly usage?: NormalizedTokenUsage
}

/**
 * One reply, and the assignment whose journal holds how it was produced.
 *
 * The link exists because a selected-agent turn does not execute anything
 * itself: each reply runs on its own assignment, and that assignment's
 * `agent.turn` stream is the authority for its provider, its tools, and its
 * failure. Without a link the two records share no addressable identity, and
 * an operator reading the conversation has no way to reach the execution.
 *
 * Two identities and nothing else. Anything the assignment recorded is read
 * from the assignment; copying a field of it here would be a second account of
 * the same execution, and nothing would say which to believe.
 */
export interface ConversationTurnAssignmentLink {
  readonly assignmentId: string
  readonly assistantMessageId: string
}

export interface ConversationTurnPreparedPayload {
  readonly assistantMessageIds: readonly string[]
  /**
   * Where each claimed reply is executed, for the turns that delegate.
   *
   * Recorded at preparation rather than on the terminal because that is when
   * the pairing is decided and still true whatever happens next: a turn that
   * prepares two replies and publishes one has two assignments an operator may
   * need to open, and the terminal's `assistantMessageIds` already says which
   * of the two replies survived. Putting the links on the terminal as well
   * would state the same pairing twice.
   *
   * Absent where the speakers run no assignment, such as the generic
   * in-process assistant. Absent is "there is nothing to link", not "the link
   * was lost".
   */
  readonly assignments?: readonly ConversationTurnAssignmentLink[]
  /** How the model's structured answer went. Absent on a Phase 1 record. */
  readonly decision?: StructuredDecisionDiagnostics
  readonly provider?: ConversationTurnProviderDiagnostics
}

export interface ConversationTurnCompletedPayload {
  readonly assistantMessageIds: readonly string[]
}

export interface ConversationTurnFailedPayload {
  readonly failure: ConversationTurnFailureIdentity
  readonly assistantMessageIds?: readonly string[]
  /**
   * The call this turn died on, when one was made.
   *
   * The lifecycle `failure` above says what the *turn* did; this says what the
   * *provider* did. A turn that failed because the provider timed out and one
   * that failed because the provider refused the request read identically
   * without it.
   */
  readonly provider?: ConversationTurnProviderDiagnostics
}

export interface ConversationTurnCancelledPayload {
  readonly phase: ConversationTurnFailurePhase
  /** The call that was withdrawn, when one was in flight. */
  readonly provider?: ConversationTurnProviderDiagnostics
}

/**
 * Three stages, five event types. The terminals collapse into one stage so a
 * turn that tries to end twice collides on its event identity instead of
 * appending a second ending.
 */
export type ConversationTurnEventStage = 'started' | 'prepared' | 'terminal'

export class ConversationTurnPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConversationTurnPayloadError'
  }
}

/**
 * Deterministic within one activity and one turn.
 *
 * The precedent keys only on its scope, which is safe there because a selected
 * agent gets a fresh assignment per reply. A conversation can hold more than
 * one turn, so the turn is part of the identity — without it a second turn
 * would replay the first as `already-accepted`.
 */
export function conversationTurnEventId(
  activityId: string,
  turnId: string,
  stage: ConversationTurnEventStage,
): string {
  return `${activityId}:conversation-turn:${turnId}:${stage}`
}

export function buildConversationTurnStartedPayload(input: {
  readonly surface: string
  readonly userMessageId: string
  readonly requestDigest: string
  readonly expectedResponseCount: number
  readonly origin: string
  readonly requestedProvider?: string | undefined
  readonly requestedModel?: string | undefined
}): CanonicalJsonObject {
  return sealed({
    surface: requireMember(input.surface, CONVERSATION_SURFACES, 'surface'),
    userMessageId: requireMessageId(input.userMessageId, 'userMessageId'),
    requestDigest: requireDigest(input.requestDigest, 'requestDigest'),
    expectedResponseCount: requireOrdinal(
      input.expectedResponseCount,
      'expectedResponseCount',
    ),
    origin: requireMember(input.origin, CONVERSATION_TURN_ORIGINS, 'origin'),
    ...whenPresent(input.requestedProvider, (value) => ({
      requestedProvider: requireRequestIdentifier(value, 'requestedProvider'),
    })),
    ...whenPresent(input.requestedModel, (value) => ({
      requestedModel: requireRequestIdentifier(value, 'requestedModel'),
    })),
  })
}

export function buildConversationTurnPreparedPayload(input: {
  readonly assistantMessageIds: readonly string[]
  readonly assignments?: unknown
  readonly decision?: unknown
  readonly provider?: unknown
}): CanonicalJsonObject {
  const assistantMessageIds = requireIdentityList(
    input.assistantMessageIds,
    'assistantMessageIds',
    1,
  )
  return sealed({
    assistantMessageIds,
    ...whenPresent(input.assignments, (value) => ({
      assignments: requireAssignmentLinks(value, assistantMessageIds),
    })),
    ...whenPresent(input.decision, (value) => ({
      decision: requireDecisionDiagnostics(value),
    })),
    ...whenPresent(input.provider, (value) => ({
      provider: requireProviderDiagnostics(value),
    })),
  })
}

export function buildConversationTurnCompletedPayload(input: {
  readonly assistantMessageIds: readonly string[]
}): CanonicalJsonObject {
  return sealed({
    assistantMessageIds: requireIdentityList(
      input.assistantMessageIds,
      'assistantMessageIds',
      1,
    ),
  })
}

export function buildConversationTurnFailedPayload(input: {
  readonly failure: { readonly code: string; readonly phase: string }
  readonly assistantMessageIds?: readonly string[] | undefined
  readonly provider?: unknown
}): CanonicalJsonObject {
  return sealed({
    failure: requireFailureIdentity(input.failure, 'failure'),
    ...(input.assistantMessageIds === undefined
      ? {}
      : {
          assistantMessageIds: requireIdentityList(
            input.assistantMessageIds,
            'assistantMessageIds',
            0,
          ),
        }),
    ...whenPresent(input.provider, (value) => ({
      provider: requireProviderDiagnostics(value),
    })),
  })
}

export function buildConversationTurnCancelledPayload(input: {
  readonly phase: string
  readonly provider?: unknown
}): CanonicalJsonObject {
  return sealed({
    phase: requireMember(input.phase, CONVERSATION_TURN_FAILURE_PHASES, 'phase'),
    ...whenPresent(input.provider, (value) => ({
      provider: requireProviderDiagnostics(value),
    })),
  })
}

export function readConversationTurnStartedPayload(
  value: unknown,
): ConversationTurnStartedPayload | null {
  const record = exactRecord(value, [
    'surface',
    'userMessageId',
    'requestDigest',
    'expectedResponseCount',
    'origin',
    'requestedProvider',
    'requestedModel',
  ])
  if (!record) return null
  const surface = member(record.surface, CONVERSATION_SURFACES)
  const origin = member(record.origin, CONVERSATION_TURN_ORIGINS)
  const userMessageId = messageId(record.userMessageId)
  const requestDigest = digest(record.requestDigest)
  const expectedResponseCount = ordinal(record.expectedResponseCount)
  const requestedProvider = optional(record.requestedProvider, requestIdentifier)
  const requestedModel = optional(record.requestedModel, requestIdentifier)
  if (
    surface === undefined ||
    origin === undefined ||
    userMessageId === undefined ||
    requestDigest === undefined ||
    expectedResponseCount === undefined ||
    requestedProvider === null ||
    requestedModel === null
  ) {
    return null
  }
  return {
    surface,
    userMessageId,
    requestDigest,
    expectedResponseCount,
    origin,
    ...(requestedProvider === undefined ? {} : { requestedProvider }),
    ...(requestedModel === undefined ? {} : { requestedModel }),
  }
}

export function readConversationTurnPreparedPayload(
  value: unknown,
): ConversationTurnPreparedPayload | null {
  const record = exactRecord(value, [
    'assistantMessageIds',
    'assignments',
    'decision',
    'provider',
  ])
  if (!record) return null
  const assistantMessageIds = identityList(record.assistantMessageIds, 1)
  const decision = optional(record.decision, decisionDiagnostics)
  const provider = readProviderField(record.provider)
  if (assistantMessageIds === undefined || decision === null || provider === null) {
    return null
  }
  const assignments = optional(record.assignments, (candidate) =>
    assignmentLinks(candidate, assistantMessageIds),
  )
  if (assignments === null) return null
  return {
    assistantMessageIds,
    ...(assignments === undefined ? {} : { assignments }),
    ...(decision === undefined ? {} : { decision }),
    ...provider,
  }
}

export function readConversationTurnCompletedPayload(
  value: unknown,
): ConversationTurnCompletedPayload | null {
  const record = exactRecord(value, ['assistantMessageIds'])
  if (!record) return null
  const assistantMessageIds = identityList(record.assistantMessageIds, 1)
  if (assistantMessageIds === undefined) return null
  return { assistantMessageIds }
}

export function readConversationTurnFailedPayload(
  value: unknown,
): ConversationTurnFailedPayload | null {
  const record = exactRecord(value, [
    'failure',
    'assistantMessageIds',
    'provider',
  ])
  if (!record) return null
  const failure = failureIdentity(record.failure)
  if (failure === undefined) return null
  const assistantMessageIds =
    record.assistantMessageIds === undefined
      ? undefined
      : identityList(record.assistantMessageIds, 0)
  if (record.assistantMessageIds !== undefined && assistantMessageIds === undefined) {
    return null
  }
  const provider = readProviderField(record.provider)
  if (provider === null) return null
  return {
    failure,
    ...(assistantMessageIds === undefined ? {} : { assistantMessageIds }),
    ...provider,
  }
}

export function readConversationTurnCancelledPayload(
  value: unknown,
): ConversationTurnCancelledPayload | null {
  const record = exactRecord(value, ['phase', 'provider'])
  if (!record) return null
  const phase = member(record.phase, CONVERSATION_TURN_FAILURE_PHASES)
  if (phase === undefined) return null
  const provider = readProviderField(record.provider)
  if (provider === null) return null
  return { phase, ...provider }
}

/**
 * The provider account as a spreadable field, or `null` for a refusal.
 *
 * Three readers need the same three-way answer — absent, valid, refused — and
 * writing it out at each of them is how one of the three eventually gets the
 * refusal wrong and reads a smuggled block as an empty one.
 */
function readProviderField(
  value: unknown,
): { provider?: ConversationTurnProviderDiagnostics } | null {
  const provider = optional(value, providerDiagnostics)
  if (provider === null) return null
  return provider === undefined ? {} : { provider }
}

export type ConversationTurnState =
  | 'absent'
  | 'started'
  | 'prepared'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'invalid'

export interface ConversationTurnSummary {
  readonly turnId: string
  readonly state: ConversationTurnState
  readonly assistantMessageIds: readonly string[]
  readonly userMessageId?: string
  readonly requestDigest?: string
  readonly surface?: ConversationSurface
  readonly failure?: ConversationTurnFailureIdentity
  /**
   * Who named the turn. A state alone does not explain itself, and these are
   * the facts that do: whether a replay of this identity means anything depends
   * on whether a client chose it or the server did.
   */
  readonly origin?: ConversationTurnOrigin
  /** How many replies were expected, which is how a missing one is noticed. */
  readonly expectedResponseCount?: number
  /**
   * Where a cancellation landed.
   *
   * The difference between a request that was made and wasted and one that
   * never happened, which is the first thing an operator needs to know.
   */
  readonly cancelledPhase?: ConversationTurnFailurePhase
  /** What the caller asked for, from `started`. */
  readonly requestedProvider?: string
  readonly requestedModel?: string
  /**
   * Where each claimed reply was executed, from `prepared`.
   *
   * Every link the preparation recorded, including one whose reply never
   * became durable. That assignment ran and its journal holds the account of
   * why nothing came back, so dropping the link would hide exactly the place
   * an operator has to look.
   */
  readonly assignments?: readonly ConversationTurnAssignmentLink[]
  /** How the model's structured answer went, from `prepared`. */
  readonly decision?: StructuredDecisionDiagnostics
  /**
   * The provider call behind the turn.
   *
   * A terminal's account replaces preparation's, because a turn that prepared a
   * reply and then failed has two calls to describe and the one that decided
   * the outcome is the later one.
   */
  readonly provider?: ConversationTurnProviderDiagnostics
}

export interface ConversationTurnStreamEvent {
  readonly type: string
  readonly payload: unknown
}

/**
 * Reduce one turn's events to what an operator needs.
 *
 * An impossible stream is reported as `invalid`, never thrown. A journal that
 * cannot be understood is a fact about the journal, and inspection has to be
 * able to say so without failing the whole report.
 */
export function reduceConversationTurnStream(
  turnId: string,
  events: readonly ConversationTurnStreamEvent[],
): ConversationTurnSummary {
  let state: ConversationTurnState = 'absent'
  let assistantMessageIds: readonly string[] = []
  let claimedMessageIds: readonly string[] = []
  let userMessageId: string | undefined
  let requestDigest: string | undefined
  let surface: ConversationSurface | undefined
  let failure: ConversationTurnFailureIdentity | undefined
  let origin: ConversationTurnOrigin | undefined
  let expectedResponseCount: number | undefined
  let cancelledPhase: ConversationTurnFailurePhase | undefined
  let assignments: readonly ConversationTurnAssignmentLink[] | undefined
  let requestedProvider: string | undefined
  let requestedModel: string | undefined
  let decision: StructuredDecisionDiagnostics | undefined
  let provider: ConversationTurnProviderDiagnostics | undefined

  const invalid = (): ConversationTurnSummary => ({
    turnId,
    state: 'invalid',
    assistantMessageIds: [],
  })

  for (const event of events) {
    switch (event.type) {
      case CONVERSATION_TURN_STARTED_EVENT_TYPE: {
        if (state !== 'absent') return invalid()
        const payload = readConversationTurnStartedPayload(event.payload)
        if (!payload) return invalid()
        userMessageId = payload.userMessageId
        requestDigest = payload.requestDigest
        surface = payload.surface
        origin = payload.origin
        expectedResponseCount = payload.expectedResponseCount
        requestedProvider = payload.requestedProvider
        requestedModel = payload.requestedModel
        state = 'started'
        break
      }
      case CONVERSATION_TURN_PREPARED_EVENT_TYPE: {
        if (state !== 'started') return invalid()
        const payload = readConversationTurnPreparedPayload(event.payload)
        if (!payload) return invalid()
        // Preparation names exactly what the turn said it expected. Otherwise
        // the expected count is a number nothing has to agree with, and the
        // diagnosis it exists for — this turn is missing a reply — cannot be
        // made from the record.
        if (payload.assistantMessageIds.length !== expectedResponseCount) {
          return invalid()
        }
        // Whether the links are complete is a question only the stream can
        // answer: the payload reader sees one event, and which surface
        // published this turn was recorded by another.
        if (!linksSatisfySurface(surface, payload)) return invalid()
        claimedMessageIds = payload.assistantMessageIds
        // Reported from preparation onward, because the crash window this
        // opens — prepared, but the assistant message never persisted — is
        // diagnosed by looking for exactly these ids. `state` is what says
        // whether they are durable yet.
        assistantMessageIds = payload.assistantMessageIds
        assignments = payload.assignments
        decision = payload.decision
        provider = payload.provider
        state = 'prepared'
        break
      }
      case CONVERSATION_TURN_COMPLETED_EVENT_TYPE: {
        // A completion is only meaningful after preparation named the replies,
        // and it must name exactly those. A terminal that renames them is a
        // different turn's terminal, not this one's completion.
        if (state !== 'prepared') return invalid()
        const payload = readConversationTurnCompletedPayload(event.payload)
        if (!payload) return invalid()
        // In order, not merely the same set. Order pairs a reply with its
        // place, so a completion that renames them in a different order is a
        // different answer to the same turn.
        if (
          payload.assistantMessageIds.length !== claimedMessageIds.length ||
          payload.assistantMessageIds.some(
            (identity, index) => identity !== claimedMessageIds[index],
          )
        ) {
          return invalid()
        }
        assistantMessageIds = payload.assistantMessageIds
        state = 'completed'
        break
      }
      case CONVERSATION_TURN_FAILED_EVENT_TYPE: {
        if (state !== 'started' && state !== 'prepared') return invalid()
        const payload = readConversationTurnFailedPayload(event.payload)
        if (!payload) return invalid()
        // A failed terminal reports which of the claimed replies survived, so
        // it may only name those, in the order they were claimed. Without this
        // the field is not a durability report at all: a terminal could name a
        // reply this turn never prepared — or none it did — and still reduce as
        // if it had said something true.
        if (
          !isOrderedSubsequence(
            payload.assistantMessageIds ?? [],
            claimedMessageIds,
          )
        ) {
          return invalid()
        }
        failure = payload.failure
        assistantMessageIds = payload.assistantMessageIds ?? []
        if (payload.provider) provider = payload.provider
        state = 'failed'
        break
      }
      case CONVERSATION_TURN_CANCELLED_EVENT_TYPE: {
        if (state !== 'started' && state !== 'prepared') return invalid()
        const payload = readConversationTurnCancelledPayload(event.payload)
        if (!payload) return invalid()
        cancelledPhase = payload.phase
        if (payload.provider) provider = payload.provider
        state = 'cancelled'
        break
      }
      default:
        return invalid()
    }
  }

  return {
    turnId,
    state,
    assistantMessageIds,
    ...(userMessageId === undefined ? {} : { userMessageId }),
    ...(requestDigest === undefined ? {} : { requestDigest }),
    ...(surface === undefined ? {} : { surface }),
    ...(failure === undefined ? {} : { failure }),
    ...(origin === undefined ? {} : { origin }),
    ...(expectedResponseCount === undefined ? {} : { expectedResponseCount }),
    ...(cancelledPhase === undefined ? {} : { cancelledPhase }),
    ...(assignments === undefined ? {} : { assignments }),
    ...(requestedProvider === undefined ? {} : { requestedProvider }),
    ...(requestedModel === undefined ? {} : { requestedModel }),
    ...(decision === undefined ? {} : { decision }),
    ...(provider === undefined ? {} : { provider }),
  }
}

/**
 * Spread a property only when the caller supplied a value.
 *
 * `undefined` means "this build had nothing to say", which is a legitimate
 * answer for every diagnostic field: a Phase 1 record has none of them, and a
 * turn that never reached a provider has no call to describe.
 */
function whenPresent<TShape extends object>(
  value: unknown,
  build: (value: unknown) => TShape,
): TShape | Record<string, never> {
  return value === undefined ? {} : build(value)
}

/**
 * Read an optional field three ways: absent, valid, or refused.
 *
 * `null` is the refusal, and it is distinct from `undefined` on purpose. A
 * present-but-invalid diagnostic must fail the whole payload rather than read
 * as an absent one — otherwise a record that smuggled prose into a field would
 * be indistinguishable from a record that never had one.
 */
function optional<TValue>(
  value: unknown,
  read: (value: unknown) => TValue | undefined,
): TValue | undefined | null {
  if (value === undefined) return undefined
  return read(value) ?? null
}

function requireRequestIdentifier(value: unknown, field: string): string {
  const resolved = requestIdentifier(value)
  if (resolved === undefined) {
    throw new ConversationTurnPayloadError(
      `${field} must be a resolver identifier — no whitespace, no prose`,
    )
  }
  return resolved
}

/**
 * A provider or model name, checked against the shared resolver grammar.
 *
 * These are the only caller- and provider-supplied strings a turn journal
 * holds, so a length bound is not enough: a hundred characters of prompt fits
 * inside one. The grammar is what makes the field an identifier rather than a
 * place to put text, and it is shared with the transport so both ends agree on
 * what may be kept.
 */
function requestIdentifier(value: unknown): string | undefined {
  return isSafeResolverIdentifier(value) ? value : undefined
}

function requireDecisionDiagnostics(value: unknown): CanonicalJsonObject {
  const resolved = decisionDiagnostics(value)
  if (resolved === undefined) {
    throw new ConversationTurnPayloadError(
      'decision must name an allowlisted validation, repair, and fallback outcome',
    )
  }
  return toCanonicalJsonObject({ ...resolved })
}

function decisionDiagnostics(
  value: unknown,
): StructuredDecisionDiagnostics | undefined {
  const record = exactRecord(value, [
    'initialValidation',
    'repair',
    'fallback',
  ])
  if (!record) return undefined
  const initialValidation = member(
    record.initialValidation,
    STRUCTURED_DECISION_VALIDATIONS,
  )
  const repair = member(record.repair, STRUCTURED_DECISION_REPAIRS)
  const fallback = member(record.fallback, STRUCTURED_DECISION_FALLBACKS)
  if (
    initialValidation === undefined ||
    repair === undefined ||
    fallback === undefined
  ) {
    return undefined
  }
  return { initialValidation, repair, fallback }
}

function requireProviderDiagnostics(value: unknown): CanonicalJsonObject {
  const resolved = providerDiagnostics(value)
  if (resolved === undefined) {
    throw new ConversationTurnPayloadError(
      'provider must hold only allowlisted route, outcome, failure, timing, and ' +
        'usage facts — never a reason, a body, or a header',
    )
  }
  return toCanonicalJsonObject({ ...resolved })
}

/**
 * The provider account, read strictly.
 *
 * Every enumerated field is checked against its list and every open one against
 * a shape, and an unrecognised key rejects the whole block. That last rule is
 * the one that matters: the tempting fields — the display reason, the response
 * body, the header map — would all arrive as extra keys beside legitimate ones,
 * and a reader that plucked what it knew would keep them.
 */
function providerDiagnostics(
  value: unknown,
): ConversationTurnProviderDiagnostics | undefined {
  const record = exactRecord(value, [
    'resolvedProvider',
    'resolvedModel',
    'route',
    'outcome',
    'failure',
    'timing',
    'usage',
  ])
  if (!record) return undefined
  const resolvedProvider = requestIdentifier(record.resolvedProvider)
  const route = member(record.route, MODEL_CALL_ROUTES)
  const outcome = member(record.outcome, MODEL_CALL_OUTCOMES)
  if (
    resolvedProvider === undefined ||
    route === undefined ||
    outcome === undefined
  ) {
    return undefined
  }
  const resolvedModel = optional(record.resolvedModel, requestIdentifier)
  const failure = optional(record.failure, providerFailure)
  const timing = optional(record.timing, providerTiming)
  const usage = optional(record.usage, providerUsage)
  if (
    resolvedModel === null ||
    failure === null ||
    timing === null ||
    usage === null
  ) {
    return undefined
  }
  return {
    resolvedProvider,
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
    route,
    outcome,
    ...(failure === undefined ? {} : { failure }),
    ...(timing === undefined ? {} : { timing }),
    ...(usage === undefined ? {} : { usage }),
  }
}

function providerFailure(
  value: unknown,
): ConversationTurnProviderFailure | undefined {
  const record = exactRecord(value, [
    'code',
    'phase',
    'providerKind',
    'providerCode',
    'httpStatus',
    'retryable',
  ])
  if (!record) return undefined
  const code = member(record.code, MODEL_FAILURE_CODES)
  const phase = member(record.phase, MODEL_FAILURE_PHASES)
  if (code === undefined || phase === undefined) return undefined
  if (typeof record.retryable !== 'boolean') return undefined
  const providerKind = optional(record.providerKind, (candidate) =>
    member(candidate, MODEL_PROVIDER_KINDS),
  )
  // The one provider-chosen string this record keeps, and the only reason it
  // can be kept: a token bound refuses a sentence, so the display reason cannot
  // arrive here wearing a different field name.
  const providerCode = optional(record.providerCode, (candidate) =>
    isSafeDiagnosticToken(candidate) ? candidate : undefined,
  )
  const httpStatus = optional(record.httpStatus, httpStatusCode)
  if (
    providerKind === null ||
    providerCode === null ||
    httpStatus === null
  ) {
    return undefined
  }
  return {
    code,
    phase,
    ...(providerKind === undefined ? {} : { providerKind }),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    retryable: record.retryable,
  }
}

function httpStatusCode(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined
}

/**
 * Timings, rounded to whole milliseconds and stripped of what never happened.
 *
 * The transport measures with a fractional performance counter and writes
 * `null` for a milestone that did not occur. Neither belongs in a record kept
 * forever: sub-millisecond precision answers no operator question, and `null`
 * spends bytes to say nothing an absent field does not.
 */
function providerTiming(value: unknown): ConversationTurnTiming | undefined {
  const record = exactRecord(value, [
    'providerDurationMs',
    'processSpawnMs',
    'firstProviderEventMs',
    'firstTextMs',
  ])
  if (!record) return undefined
  const providerDurationMs = durationMs(record.providerDurationMs)
  if (providerDurationMs === undefined) return undefined
  // A milestone that is present and is not a measurement refuses the block.
  // Dropping it would read afterwards as "the provider never reported that
  // milestone", and the fact worth knowing — that something wrote a value here
  // that is not a duration — would be the one the record lost.
  const processSpawnMs = optionalDurationMs(record.processSpawnMs)
  const firstProviderEventMs = optionalDurationMs(record.firstProviderEventMs)
  const firstTextMs = optionalDurationMs(record.firstTextMs)
  if (
    processSpawnMs === null ||
    firstProviderEventMs === null ||
    firstTextMs === null
  ) {
    return undefined
  }
  return {
    providerDurationMs,
    ...(processSpawnMs === undefined ? {} : { processSpawnMs }),
    ...(firstProviderEventMs === undefined ? {} : { firstProviderEventMs }),
    ...(firstTextMs === undefined ? {} : { firstTextMs }),
  }
}

/**
 * A milestone, three ways: it did not happen, it did, or the value is not one.
 *
 * `null` is the transport's own word for a milestone that never occurred, so it
 * reads as absent rather than as a refusal. Anything else that is not a
 * duration is the refusal.
 */
function optionalDurationMs(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined
  return durationMs(value) ?? null
}

function durationMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 0 || value > MAX_TIMING_MS) return undefined
  return Math.round(value)
}

/**
 * Usage, re-validated here rather than trusted from the transport.
 *
 * The same rules the provider adapters apply, restated at the boundary that
 * writes them down. A count that contradicts itself is refused rather than
 * corrected, because a record cannot know which of the two numbers was right.
 */
function providerUsage(value: unknown): NormalizedTokenUsage | undefined {
  const record = exactRecord(value, [
    'inputTokens',
    'outputTokens',
    'totalTokens',
  ])
  if (!record) return undefined
  return normalizeTokenUsage({
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    ...(record.totalTokens === undefined
      ? {}
      : { totalTokens: record.totalTokens }),
  })
}

/** Canonicalize, then refuse anything that would overspend the activity. */
function sealed(value: Record<string, unknown>): CanonicalJsonObject {
  const canonical = toCanonicalJsonObject(value)
  const byteLength = Buffer.byteLength(JSON.stringify(canonical), 'utf8')
  if (byteLength > CONVERSATION_TURN_MAX_PAYLOAD_BYTES) {
    throw new ConversationTurnPayloadError(
      `conversation turn payload is ${byteLength} bytes, over the ${CONVERSATION_TURN_MAX_PAYLOAD_BYTES}-byte budget`,
    )
  }
  return canonical
}

function requireMessageId(value: unknown, field: string): string {
  const resolved = messageId(value)
  if (resolved === undefined) {
    throw new ConversationTurnPayloadError(
      `${field} must be a message identity such as '<turnId>:user', never free text`,
    )
  }
  return resolved
}

function messageId(value: unknown): string | undefined {
  return typeof value === 'string' && MESSAGE_ID_PATTERN.test(value)
    ? value
    : undefined
}

function requireIdentity(value: unknown, field: string): string {
  const resolved = identity(value)
  if (resolved === undefined) {
    throw new ConversationTurnPayloadError(`${field} must be a non-empty identity`)
  }
  return resolved
}

function requireDigest(value: unknown, field: string): string {
  const resolved = digest(value)
  if (resolved === undefined) {
    throw new ConversationTurnPayloadError(`${field} must be a sha256 hex digest`)
  }
  return resolved
}

function requireOrdinal(value: unknown, field: string): number {
  const resolved = ordinal(value)
  if (resolved === undefined) {
    throw new ConversationTurnPayloadError(
      `${field} must be a non-negative safe integer`,
    )
  }
  return resolved
}

function requireMember<T extends string>(
  value: unknown,
  members: readonly T[],
  field: string,
): T {
  const resolved = member(value, members)
  if (resolved === undefined) {
    throw new ConversationTurnPayloadError(
      `${field} must be one of ${members.join(', ')}`,
    )
  }
  return resolved
}

function requireIdentityList(
  value: unknown,
  field: string,
  minimum: number,
): readonly string[] {
  const resolved = identityList(value, minimum)
  if (resolved === undefined) {
    throw new ConversationTurnPayloadError(
      `${field} must hold between ${minimum} and ${CONVERSATION_TURN_MAX_RESPONSES} identities`,
    )
  }
  return resolved
}

function requireFailureIdentity(
  value: unknown,
  field: string,
): ConversationTurnFailureIdentity {
  const resolved = failureIdentity(value)
  if (resolved === undefined) {
    throw new ConversationTurnPayloadError(
      `${field} must be an allowlisted diagnostic code and phase, never a provider message`,
    )
  }
  return resolved
}

/** A record whose keys are all recognised. An unknown key rejects the payload. */
function exactRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record: Record<string, unknown> = { ...value }
  const permitted = new Set(allowed)
  for (const key of Object.keys(record)) {
    if (!permitted.has(key)) return null
  }
  return record
}

function member<T extends string>(
  value: unknown,
  members: readonly T[],
): T | undefined {
  return members.find((candidate) => candidate === value)
}

function identity(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function digest(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
    ? value
    : undefined
}

/**
 * How many replies a turn expects: at least one, at most what it may hold.
 *
 * Zero is not a turn. It also makes a `completed` naming no replies agree with
 * its own start, so the count an operator uses to notice a missing reply would
 * never have to be true.
 */
function ordinal(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= CONVERSATION_TURN_MAX_RESPONSES
    ? value
    : undefined
}

function identityList(
  value: unknown,
  minimum: number,
): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length < minimum || value.length > CONVERSATION_TURN_MAX_RESPONSES) {
    return undefined
  }
  const resolved: string[] = []
  const seen = new Set<string>()
  for (const element of value) {
    const single = messageId(element)
    // A malformed element fails the whole list. Filtering would silently
    // publish a turn that claims fewer replies than it produced.
    if (single === undefined) return undefined
    // And the same identity twice is one message counted twice, which makes
    // every count derived from this list wrong.
    if (seen.has(single)) return undefined
    seen.add(single)
    resolved.push(single)
  }
  return resolved
}

/**
 * Every link a preparation claims, or nothing when one of them cannot be read.
 *
 * Checked against the very replies the same payload claims, not merely against
 * a shape. A link is followed — an operator opens the assignment it names to
 * find out how that reply came to be — so one pointing at a reply this turn
 * never claimed leads somewhere, and somewhere is the wrong turn.
 */
function assignmentLinks(
  value: unknown,
  assistantMessageIds: readonly string[],
): readonly ConversationTurnAssignmentLink[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length < 1 || value.length > assistantMessageIds.length) {
    return undefined
  }
  // The replies this same payload claims, already validated as message
  // identities by the list that produced them. Membership is therefore the
  // whole check on this side of a link: a value that is not one of these is
  // refused whether it is a foreign identity or a sentence of prose.
  const claimed = new Set(assistantMessageIds)
  const seenAssignments = new Set<string>()
  const seenReplies = new Set<string>()
  const resolved: ConversationTurnAssignmentLink[] = []
  for (const element of value) {
    const record = exactRecord(element, ['assignmentId', 'assistantMessageId'])
    if (!record) return undefined
    const assignmentId = assignmentIdentity(record.assignmentId)
    if (assignmentId === undefined) return undefined
    const assistantMessageId = record.assistantMessageId
    if (typeof assistantMessageId !== 'string') return undefined
    if (!claimed.has(assistantMessageId)) return undefined
    // The pairing is one-to-one in both directions: one assignment produced
    // one reply, and one reply came from one assignment. A repeat on either
    // side contradicts the assignment journal the link points at.
    if (seenAssignments.has(assignmentId)) return undefined
    if (seenReplies.has(assistantMessageId)) return undefined
    seenAssignments.add(assignmentId)
    seenReplies.add(assistantMessageId)
    resolved.push({ assignmentId, assistantMessageId })
  }
  return resolved
}

function requireAssignmentLinks(
  value: unknown,
  assistantMessageIds: readonly string[],
): readonly ConversationTurnAssignmentLink[] {
  const resolved = assignmentLinks(value, assistantMessageIds)
  if (resolved === undefined) {
    throw new ConversationTurnPayloadError(
      'assignments must pair one assignment identity with one reply this turn claimed',
    )
  }
  return resolved
}

/**
 * An assignment identity, and specifically a UUID.
 *
 * The same reasoning as the message-id shape below. An assignment id is minted
 * by this system, so anything else in that position did not come from it — and
 * accepting any non-empty string would make `assignmentId` a place a caller
 * could put text the journal then keeps forever.
 */
function assignmentIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && ASSIGNMENT_ID_PATTERN.test(value)
    ? value
    : undefined
}

const ASSIGNMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The lifecycle failure codes this build defines.
 *
 * An allowlist, not a shape. A pattern accepts any short word, which means a
 * caller can invent a code — or paste one — and the journal will keep it. These
 * are the outcomes Phase 1 can actually produce, so anything else is a mistake
 * worth failing on.
 */
export const CONVERSATION_TURN_FAILURE_CODES = [
  /** The revised run plan could not be persisted, so no reply will exist. */
  'plan_conflict',
  /** The turn failed before anything was sent to a provider. */
  'preparation_failed',
  /**
   * The turn reached the provider and failed there, before it named a reply.
   *
   * Distinct from `preparation_failed` because the two are different facts
   * about the same turn: one says nothing was ever sent, the other says
   * something was and it did not come back. Neither carries the transport's own
   * words — a caught exception's message is exactly the provider prose this
   * journal exists to hold none of.
   */
  'provider_failed',
  /**
   * The provider call was entered and nobody can say how it ended.
   *
   * Distinct from `provider_failed`, which is a fault somebody observed and
   * described. This is the absence of an observer: the turn ran past its own
   * deadline, or the process holding it went away, and the durable record is
   * all that is left. The difference is what the user is told and what they
   * are offered — a failure has a reason, an interruption has a retry.
   *
   * A build that predates this code reduces the stream as `invalid` rather
   * than misreading it, which keeps the turn's admission slot held instead of
   * releasing one on a terminal it does not understand.
   */
  'provider_interrupted',
  /**
   * Replies were produced and at least one never reached the transcript.
   *
   * A multi-speaker turn can lose one reply and keep the others, which is
   * neither a turn that failed before producing anything nor one that
   * published everything it claimed. The terminal's `assistantMessageIds`
   * says which replies did survive.
   */
  'reply_not_published',
] as const
export type ConversationTurnFailureCode =
  (typeof CONVERSATION_TURN_FAILURE_CODES)[number]

/**
 * The shape of a message identity this phase writes.
 *
 * Deliberately structural, and specifically a UUID. A message id is derived
 * from a turn id and a role, and a turn id is a UUID at the request boundary
 * and when the server mints one — so anything else in that position is not an
 * identity this system produced.
 *
 * The prefix has to be that strict. Allowing any word before the colon accepts
 * `secret:user` and `sk-proj-…:assistant:0`, which is the same leak with a
 * suffix attached. Checking this form is what makes "the journal holds no
 * content" a guarantee rather than a convention.
 */
const MESSAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(user|assistant:\d{1,3})$/i

function failureIdentity(
  value: unknown,
): ConversationTurnFailureIdentity | undefined {
  const record = exactRecord(value, ['code', 'phase'])
  if (!record) return undefined
  const code = member(record.code, CONVERSATION_TURN_FAILURE_CODES)
  const phase = member(record.phase, CONVERSATION_TURN_FAILURE_PHASES)
  if (code === undefined || phase === undefined) return undefined
  return { code, phase }
}

/**
 * Whether a preparation's links say what its surface requires them to say.
 *
 * Scoped to the surface because what a link means is a property of who
 * published the turn. A Receptionist turn answers by itself and has no
 * assignment to name; a selected-agent turn delegates every reply, and the one
 * thing an operator does with the record is follow it.
 *
 * All or nothing, therefore. Absent is the generic in-process assistant, which
 * really did run no assignment. Partial coverage is the case this exists to
 * refuse: a turn that reduces to `completed` while one of its replies leads
 * nowhere is worse than one that reports itself unreadable, because only the
 * second sends anybody looking.
 */
function linksSatisfySurface(
  surface: ConversationSurface | undefined,
  payload: ConversationTurnPreparedPayload,
): boolean {
  if (surface !== 'run-selected-agents') return true
  if (payload.assignments === undefined) return true
  return payload.assignments.length === payload.assistantMessageIds.length
}

/**
 * Whether every element of `subset` appears in `whole`, in that relative order.
 *
 * A subsequence rather than a set test. Order is what pairs a reply with the
 * speaker that produced it, so a list holding the right identities in the wrong
 * order is a different claim about the same turn, not the same claim written
 * differently.
 */
function isOrderedSubsequence(
  subset: readonly string[],
  whole: readonly string[],
): boolean {
  let index = 0
  for (const identity of subset) {
    const found = whole.indexOf(identity, index)
    if (found === -1) return false
    index = found + 1
  }
  return true
}

function sameIdentitySet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false
  const remaining = new Set(right)
  for (const value of left) {
    if (!remaining.delete(value)) return false
  }
  return remaining.size === 0
}
