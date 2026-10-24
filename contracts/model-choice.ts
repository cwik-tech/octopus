/**
 * When a failed explicit model may be offered one new attempt on the app
 * default, and what an approval of that offer is allowed to say.
 *
 * Pure by construction. Failing is not permission to substitute a model: this
 * decides only whether the user may be *asked*, and the answer is no unless a
 * fresh attempt is provably safe. Missing evidence is refused rather than
 * assumed harmless, because the cost of being wrong is repeating a side effect
 * nobody can see.
 */

import {
  resolveAgentModelChoice,
  resolveApprovedDefaultRetry,
  type AgentModelChoice,
  type AppDefaultModelState,
  type ModelSelection,
  type ModelSelectionResult,
  type ProviderModelPair,
} from './agent-model-selection.js'

export type ModelChoiceEligibleReason =
  | 'missing-credential'
  | 'unknown-model'
  | 'provider-rejected'

export type ModelChoiceIneligibleReason =
  | 'same-model-retry-remains'
  | 'failure-not-model-specific'
  | 'unsafe-to-repeat'
  | 'no-app-default'
  | 'default-equals-failed-choice'

export type ModelChoiceEligibility =
  | {
      readonly eligible: true
      readonly reason: ModelChoiceEligibleReason
      readonly proposedDefault: ProviderModelPair
    }
  | { readonly eligible: false; readonly reason: ModelChoiceIneligibleReason }

/**
 * What is known about tool side effects across the *whole* affected logical
 * invocation, including earlier provider rounds and retries.
 *
 * `none-observed` is a positive statement that durable evidence covers the
 * invocation and recorded no dispatch. `unknown` is the honest answer whenever
 * that evidence is absent, incomplete, or unreadable.
 */
export type ToolEffectEvidence =
  | 'none-observed'
  | 'dispatch-started'
  | 'unknown'

export interface ModelChoiceEligibilityInput {
  readonly failedChoice: ProviderModelPair
  /** The provider failure taxonomy kind for the terminal attempt. */
  readonly failureKind: string
  /** Same-model attempts the existing failure policy would still make. */
  readonly remainingSameModelRetries: number
  readonly toolEffectEvidence: ToolEffectEvidence
  readonly appDefault: AppDefaultModelState
}

/**
 * Failures where the chosen model itself is what cannot serve the request, so
 * a different model is a real answer rather than a retry in disguise.
 */
const MODEL_SPECIFIC_FAILURES: Readonly<
  Record<string, ModelChoiceEligibleReason>
> = {
  authentication: 'missing-credential',
  permission: 'missing-credential',
  billing: 'missing-credential',
  configuration: 'missing-credential',
  not_found: 'unknown-model',
  invalid_request: 'provider-rejected',
  request_too_large: 'provider-rejected',
  context_limit: 'provider-rejected',
  // The durable conversation record uses its own failure vocabulary. Only the
  // codes that name the selection itself appear here; `http_status`,
  // `network_error`, `timeout` and `cancelled` deliberately do not, because a
  // status code alone does not say the model is what went wrong.
  credential_missing: 'missing-credential',
  provider_unavailable: 'missing-credential',
  provider_unsupported: 'unknown-model',
}

export function evaluateModelChoiceEligibility(
  input: ModelChoiceEligibilityInput,
): ModelChoiceEligibility {
  // The existing policy's own attempts at the chosen model come first. Asking
  // the user to change models while the chosen one would still be retried
  // takes the decision away for a failure that may not recur.
  if (input.remainingSameModelRetries > 0) {
    return { eligible: false, reason: 'same-model-retry-remains' }
  }
  const reason = MODEL_SPECIFIC_FAILURES[input.failureKind]
  if (!reason) return { eligible: false, reason: 'failure-not-model-specific' }
  // Anything but proven absence of tool dispatch blocks the offer. A rejected
  // final request does not prove that no tool ran earlier in the invocation.
  if (input.toolEffectEvidence !== 'none-observed') {
    return { eligible: false, reason: 'unsafe-to-repeat' }
  }
  if (input.appDefault.status !== 'available') {
    return { eligible: false, reason: 'no-app-default' }
  }
  if (
    input.appDefault.provider === input.failedChoice.provider &&
    input.appDefault.model === input.failedChoice.model
  ) {
    // Offering this would describe running the same pair again as switching
    // models, which is not what would happen.
    return { eligible: false, reason: 'default-equals-failed-choice' }
  }
  return {
    eligible: true,
    reason,
    proposedDefault: {
      provider: input.appDefault.provider,
      model: input.appDefault.model,
    },
  }
}

// ─── Offering and approving one new attempt ─────────────────────────────────

/** What the offer is about, so an approval cannot be replayed elsewhere. */
export type ModelChoiceScope =
  | { readonly kind: 'chat'; readonly sessionId: string; readonly turnId: string }
  | { readonly kind: 'task'; readonly sessionId: string; readonly taskId: string }

export interface ModelChoiceOffer {
  readonly offerId: string
  readonly scope: ModelChoiceScope
  /** The agent whose attempt failed. Other members are unaffected. */
  readonly agentName: string
  /** The logical step, stable across retries, when the caller has one. */
  readonly logicalInvocationId?: string
  /** The owning state's revision when the offer was computed. */
  readonly expectedRevision: string
  readonly failedChoice: ProviderModelPair
  /** Exactly the pair the user was shown. */
  readonly proposedDefault: ProviderModelPair
  readonly reason: ModelChoiceEligibleReason
}

/**
 * What an approval is allowed to say: which offer, and once.
 *
 * Deliberately carries no provider or model. An approval means "yes, the pair
 * you showed me"; letting it name one would turn consent into an arbitrary
 * model-override API.
 */
export interface ModelChoiceAcceptance {
  readonly offerId: string
  readonly idempotencyKey: string
}

export type ModelChoiceRejectionCode =
  | 'offer-not-found'
  | 'stale-revision'
  | 'default-changed'
  | 'no-longer-eligible'
  | 'already-accepted'
  /**
   * Nothing durable can claim this offer exclusively, so one approval could
   * not be told from two. Refused rather than run unprotected.
   */
  | 'claim-unavailable'

export interface ModelChoiceRejection {
  readonly code: ModelChoiceRejectionCode
  readonly message: string
}

export type ModelChoiceDecision =
  | { readonly ok: true; readonly selection: ModelSelection }
  | { readonly ok: false; readonly error: ModelChoiceRejection }

/**
 * Reads an untrusted acceptance payload.
 *
 * Refuses anything carrying fields beyond the offer identity and the
 * idempotency key, so a caller cannot append a model of its own.
 */
export function readModelChoiceAcceptance(
  value: unknown,
): ModelChoiceAcceptance | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const allowed = new Set(['offerId', 'idempotencyKey'])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return undefined
  }
  const offerId = record.offerId
  const idempotencyKey = record.idempotencyKey
  if (
    typeof offerId !== 'string' ||
    offerId.length === 0 ||
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length === 0
  ) {
    return undefined
  }
  return { offerId, idempotencyKey }
}

/**
 * Whether one approval authorizes one new attempt, revalidated at approval
 * time rather than trusted from when the offer was made.
 *
 * Everything that could have moved between showing the offer and accepting it
 * is checked again: the owning state, the application default, and the
 * eligibility of the failure itself. A duplicate acceptance authorizes
 * nothing, which is what stops a double click or a retransmitted request from
 * starting a second attempt.
 */
export function decideModelChoice(input: {
  readonly offer: ModelChoiceOffer | undefined
  readonly acceptance: ModelChoiceAcceptance
  readonly currentRevision: string
  readonly appDefault: AppDefaultModelState
  readonly eligibility: ModelChoiceEligibility
  readonly acceptedIdempotencyKeys: readonly string[]
}): ModelChoiceDecision {
  const { offer, acceptance } = input
  if (!offer || offer.offerId !== acceptance.offerId) {
    return {
      ok: false,
      error: {
        code: 'offer-not-found',
        message: 'That model choice is no longer available.',
      },
    }
  }
  if (input.acceptedIdempotencyKeys.includes(acceptance.idempotencyKey)) {
    return {
      ok: false,
      error: {
        code: 'already-accepted',
        message: 'This approval has already started an attempt.',
      },
    }
  }
  if (offer.expectedRevision !== input.currentRevision) {
    return {
      ok: false,
      error: {
        code: 'stale-revision',
        message: 'This conversation has moved on. Reopen it and try again.',
      },
    }
  }
  if (!input.eligibility.eligible) {
    return {
      ok: false,
      error: {
        code: 'no-longer-eligible',
        message: 'This attempt can no longer be safely retried.',
      },
    }
  }
  if (
    input.appDefault.status !== 'available' ||
    input.appDefault.provider !== offer.proposedDefault.provider ||
    input.appDefault.model !== offer.proposedDefault.model
  ) {
    // Running a pair the user was never shown is the thing consent exists to
    // prevent, so a changed default needs a fresh offer rather than a guess.
    return {
      ok: false,
      error: {
        code: 'default-changed',
        message:
          'The application default changed after this was offered. Review the new one and try again.',
      },
    }
  }
  return {
    ok: true,
    selection: {
      provider: offer.proposedDefault.provider,
      model: offer.proposedDefault.model,
      source: 'app-default',
      reason: 'user-approved-retry',
      originalChoice: offer.failedChoice,
    },
  }
}

// ─── Reading the durable chat record ────────────────────────────────────────

/**
 * What the durable conversation record proves about tool side effects.
 *
 * Only one phase proves anything: `credential` means the request could not
 * even be built, so nothing was sent and nothing could have run. Every other
 * phase leaves the question open, and an assignment that executed leaves it
 * open regardless of phase. Open questions answer `unknown`, which blocks the
 * offer — this function never guesses that a repeat would be harmless.
 */
export function deriveToolEffectEvidence(input: {
  readonly failurePhase?: 'credential' | 'request' | 'response' | 'decode'
  readonly assignmentCount: number
}): ToolEffectEvidence {
  if (input.assignmentCount > 0) return 'unknown'
  return input.failurePhase === 'credential' ? 'none-observed' : 'unknown'
}

/**
 * The same question, answered from the assignment's own execution record.
 *
 * A selected-agent reply always runs on an assignment, so the conversation
 * record alone can never prove anything here — the execution journal is where
 * a tool dispatch would have been written. `provider-resolution` is the one
 * phase that proves nothing was sent: the turn could not even choose a
 * provider. `tool-execution` proves the opposite. Everything else, including a
 * request that was in flight, leaves the question open and answers `unknown`.
 */
export function deriveExecutionToolEffectEvidence(input: {
  readonly failurePhase?:
    | 'provider-resolution'
    | 'tool-discovery'
    | 'provider-request'
    | 'tool-execution'
    | 'artifact-publication'
    | 'assistant-persistence'
  readonly executedToolCallCount?: number
  /**
   * Whether the attempt had sent anything when it failed.
   *
   * `false` is the one positive fact about effects this build has, and only
   * the adapter that failed can state it: it means the request was refused
   * before it was made. Everything else is `undefined` — unknown — and unknown
   * refuses a retry.
   *
   * Nothing else in the system can stand in for this. A failure *phase*
   * derived from an error category is not observed progress. A persona's tool
   * list is not either: the tool policy reads an unspecified list as every
   * registered tool, several CLIs enable their own regardless, and the MCP
   * worker route chooses its own grants and can run a native tool loop
   * whatever the persona declares.
   */
  readonly dispatched?: boolean
}): ToolEffectEvidence {
  if ((input.executedToolCallCount ?? 0) > 0) return 'dispatch-started'
  if (input.failurePhase === 'tool-execution') return 'dispatch-started'
  return input.dispatched === false ? 'none-observed' : 'unknown'
}

/**
 * A deterministic identity for one offer.
 *
 * Derived rather than stored, so there is no second place for an offer to go
 * stale. It binds every fact the user was shown: change the agent, the turn,
 * the state revision, or the proposed pair and this is a different offer that
 * an old approval cannot accept.
 */
export function modelChoiceOfferId(input: {
  readonly scope: ModelChoiceScope
  readonly agentName: string
  readonly expectedRevision: string
  readonly proposedDefault: ProviderModelPair
}): string {
  const scope =
    input.scope.kind === 'chat'
      ? `chat:${input.scope.sessionId}:${input.scope.turnId}`
      : `task:${input.scope.sessionId}:${input.scope.taskId}`
  return [
    scope,
    input.agentName,
    input.expectedRevision,
    input.proposedDefault.provider,
    input.proposedDefault.model,
  ]
    .map((part) => encodeURIComponent(part))
    .join('|')
}

/**
 * Which phase a direct-provider failure belongs to.
 *
 * The phase is what later proves whether anything was sent. A credential,
 * configuration or billing problem stops the call before a request can be
 * built, so filing it under `provider-request` would make an unsent request
 * look like a sent one — and that is the difference between an offer that is
 * safe and one that might repeat a side effect.
 */
export function modelFailurePhaseFor(
  providerKind: string,
): 'provider-resolution' | 'provider-request' {
  return providerKind === 'authentication' ||
    providerKind === 'permission' ||
    providerKind === 'billing' ||
    providerKind === 'configuration'
    ? 'provider-resolution'
    : 'provider-request'
}

// ─── One-shot authorization ─────────────────────────────────────────────────

/**
 * A user's approval, in the form the process that dispatches the agent reads.
 *
 * Deliberately *not* a configuration. It names one offer, one agent and the
 * exact pair the user was shown, and nothing merges it into a team config or a
 * roster entry — which is what keeps it distinguishable from the member-level
 * override this rule exists to remove. It applies to one invocation, and only
 * while all three facts still describe the situation the user approved.
 */
export interface ApprovedModelChoiceAuthorization {
  readonly offerId: string
  readonly agentName: string
  /**
   * The one invocation this permission covers.
   *
   * Consent is per attempt, not per agent. A step where the same agent speaks
   * more than once would otherwise have one approval cover every one of its
   * attempts, including ones the user was never asked about.
   *
   * Absent only where the caller genuinely has one invocation to speak of — a
   * chat approval addresses one turn and one speaker — and a dispatch that
   * cannot say which invocation it belongs to is never covered by an
   * authorization that names one.
   */
  readonly logicalInvocationId?: string
  /** The pair that failed. Consent was given for this failing, not another. */
  readonly failedChoice: ProviderModelPair
  /** Exactly the pair the user was shown and approved. */
  readonly proposedDefault: ProviderModelPair
}

/**
 * The pair one agent runs on, given whatever the user has authorized.
 *
 * Every case that is not exactly the approved situation falls through to the
 * ordinary two-choice rule rather than erroring, because an authorization that
 * does not apply is not a failure — the agent simply runs the way it always
 * would. The one refusal is a default that moved after the approval: running on
 * whatever the default happens to be now would execute a model the user was
 * never shown.
 */
export function resolveAuthorizedAgentModelChoice(input: {
  readonly agentName: string
  /** The invocation this dispatch belongs to, when the caller knows it. */
  readonly logicalInvocationId?: string
  readonly agentChoice: AgentModelChoice | undefined
  readonly authorization?: ApprovedModelChoiceAuthorization | undefined
  readonly appDefault: AppDefaultModelState
  readonly requiredCapability?: string
}): ModelSelectionResult {
  const choice = input.agentChoice ?? { mode: 'app-default' as const }
  const options = input.requiredCapability === undefined
    ? undefined
    : { requiredCapability: input.requiredCapability }
  const authorization = input.authorization
  if (
    !authorization ||
    authorization.agentName !== input.agentName ||
    // An authorization that names an invocation covers that one and no other,
    // including a dispatch that cannot say which invocation it belongs to.
    (authorization.logicalInvocationId !== undefined &&
      authorization.logicalInvocationId !== input.logicalInvocationId) ||
    choice.mode !== 'explicit' ||
    choice.provider !== authorization.failedChoice.provider ||
    choice.model !== authorization.failedChoice.model
  ) {
    return resolveAgentModelChoice(choice, input.appDefault, options)
  }
  if (
    input.appDefault.status !== 'available' ||
    input.appDefault.provider !== authorization.proposedDefault.provider ||
    input.appDefault.model !== authorization.proposedDefault.model
  ) {
    return {
      ok: false,
      error: {
        code: 'stale-approval',
        message:
          'The application default changed after this retry was approved. Approve a refreshed offer.',
        provider: authorization.proposedDefault.provider,
        model: authorization.proposedDefault.model,
      },
    }
  }
  return resolveApprovedDefaultRetry(
    authorization.failedChoice,
    input.appDefault,
    options,
  )
}

/**
 * Reads an authorization that arrived from outside this process.
 *
 * Refused whole rather than in part: a half-read authorization would either
 * dispatch a model the user never approved or silently stop applying, and both
 * are worse than the agent running on its own failing pair again.
 */
export function readApprovedModelChoiceAuthorization(
  value: unknown,
): ApprovedModelChoiceAuthorization | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const offerId = nonEmptyString(record.offerId)
  const agentName = nonEmptyString(record.agentName)
  const failedChoice = readPair(record.failedChoice)
  const proposedDefault = readPair(record.proposedDefault)
  if (!offerId || !agentName || !failedChoice || !proposedDefault) {
    return undefined
  }
  // A present-but-unreadable scope is refused rather than dropped: silently
  // widening an invocation-scoped permission to the whole agent is exactly the
  // failure this field exists to prevent.
  if (
    record.logicalInvocationId !== undefined &&
    !nonEmptyString(record.logicalInvocationId)
  ) {
    return undefined
  }
  const logicalInvocationId = nonEmptyString(record.logicalInvocationId)
  return {
    offerId,
    agentName,
    failedChoice,
    proposedDefault,
    ...(logicalInvocationId ? { logicalInvocationId } : {}),
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readPair(value: unknown): ProviderModelPair | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const provider = nonEmptyString(record.provider)
  const model = nonEmptyString(record.model)
  return provider && model ? { provider, model } : undefined
}
