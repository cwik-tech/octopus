/**
 * What a model call may say about itself, without saying what was said.
 *
 * A provider call produces two different things. One is the answer, which is
 * content: it belongs to the transcript, and a durable execution record must
 * never hold it. The other is the account of the call — which provider and
 * model were asked for, which ones answered, how the request was routed, how it
 * ended, how long it took, and how many tokens it billed. That half is safe to
 * keep forever, and it is what this contract describes.
 *
 * Everything here is closed. Routes, outcomes, failure codes, phases and
 * provider kinds are fixed lists rather than free strings, so a value that
 * reaches a journal is one this build defines rather than one a provider chose.
 * The single field that does come from a provider — `providerCode` — is bounded
 * to the shape of an identifier, because a code is worth keeping and an
 * unbounded string in a permanent record is a channel for prose, an echoed
 * prompt, or a credential.
 *
 * The same file also describes how a structured decision went, because that is
 * the other half of the same question: whether the model's output could be used
 * is a fact about the call, and a record holding one without the other cannot
 * say whether a bad answer came from the provider or from the model.
 *
 * It lives in `contracts/` because two layers have to agree on it: the provider
 * transport and the Receptionist that produce it, and the conversation journal
 * that validates it before writing it down. None of them may import the others.
 */

/** How the call reached a model. */
export const MODEL_CALL_ROUTES = [
  /** A built-in provider with an API-key environment variable. */
  'http',
  /** An operator-configured OpenAI-compatible connection. */
  'configured-http',
  /** A local CLI provider run as a child process. */
  'cli',
  /**
   * No route was taken. The provider name resolved to nothing this build can
   * call, so the failure happened before any transport was chosen.
   */
  'fallback',
] as const
export type ModelCallRoute = (typeof MODEL_CALL_ROUTES)[number]

/** How the call ended. */
export const MODEL_CALL_OUTCOMES = [
  'success',
  'provider_failure',
  /** The caller withdrew the request. Never a failure of the provider. */
  'cancelled',
  /**
   * A wait elapsed with no answer.
   *
   * Kept apart from `provider_failure` because the two lead somewhere
   * different: an elapsed wait says try again, a refused request says fix the
   * request. Collapsing them loses the only advice the record could give.
   */
  'timeout',
] as const
export type ModelCallOutcome = (typeof MODEL_CALL_OUTCOMES)[number]

/** Which wire protocol was spoken, which is what makes a code interpretable. */
export const MODEL_PROVIDER_KINDS = [
  'chat-completions',
  'anthropic-messages',
  'cli',
  'unsupported',
] as const
export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number]

/** Where in the call the failure happened. */
export const MODEL_FAILURE_PHASES = [
  /** Before a request could be built: no credential, no such provider. */
  'credential',
  /** The request was in flight and never came back. */
  'request',
  /** A response arrived and refused the request. */
  'response',
  /** A response arrived and could not be turned into an answer. */
  'decode',
  /**
   * Before a request could be built, because the call itself asked for
   * something this build cannot carry. Distinct from `credential`: nothing is
   * missing from the environment, the request as described cannot be made.
   */
  'configuration',
] as const
export type ModelFailurePhase = (typeof MODEL_FAILURE_PHASES)[number]

/**
 * The failure kinds this build defines.
 *
 * An allowlist rather than a pattern. A pattern accepts any short word, which
 * means an adapter can invent a code — or paste one — and a permanent record
 * will keep it.
 */
export const MODEL_FAILURE_CODES = [
  /** No API key is configured for the requested provider. */
  'credential_missing',
  /** The provider name is not one this build can call. */
  'provider_unsupported',
  /** A configured connection was named but is no longer available. */
  'provider_unavailable',
  /** The endpoint answered with a non-success status. */
  'http_status',
  /** The request never reached a response. */
  'network_error',
  /** A response arrived but its body could not be read. */
  'response_unreadable',
  /** The provider answered with no usable text. */
  'empty_response',
  /** A CLI provider process failed. */
  'cli_failed',
  'timeout',
  'cancelled',
  /**
   * A provider setting this transport cannot carry, or one whose value is not
   * the kind of value that setting takes. Refused rather than dropped: a
   * setting that silently does nothing cannot be told apart from one the
   * provider ignores.
   */
  'provider_options_unsupported',
] as const
export type ModelFailureCode = (typeof MODEL_FAILURE_CODES)[number]

/**
 * A failure reduced to something safe to keep forever.
 *
 * `code` says what kind of failure it was, `phase` says where, and the optional
 * fields say what the transport observed. The provider's message is absent by
 * construction: it can embed a slice of a request body, a path, or a key, and
 * there is no bound that makes free prose safe in a permanent record.
 */
export interface SanitizedModelFailureIdentity {
  readonly code: ModelFailureCode
  readonly phase: ModelFailurePhase
  readonly providerKind?: ModelProviderKind
  /** The provider's own short code, only when it really is a code. */
  readonly providerCode?: string
  readonly httpStatus?: number
  /** Whether repeating the same request could plausibly succeed. */
  readonly retryable: boolean
}

/** Where a call spent its time. `null` means the milestone never happened. */
export interface ModelCallTiming {
  providerDurationMs: number
  processSpawnMs: number | null
  firstProviderEventMs: number | null
  firstTextMs: number | null
}

/** Token counts a provider reported, after validation. */
export interface NormalizedTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

/** The content-free account of one model call. */
export interface ModelCallDiagnostics {
  readonly requestedProvider: string
  readonly requestedModel: string
  readonly resolvedProvider: string
  /** What the provider said it used. Absent when it never answered. */
  readonly resolvedModel?: string
  readonly route: ModelCallRoute
  readonly outcome: ModelCallOutcome
  readonly failure?: SanitizedModelFailureIdentity
  readonly timing: ModelCallTiming
  readonly usage?: NormalizedTokenUsage
}

/**
 * The shape of a diagnostic token: a short identifier, and nothing else.
 *
 * No whitespace, so a sentence cannot pass. Bounded, so a body cannot. This is
 * the one rule that lets a provider-chosen string be kept at all.
 */
export const MODEL_DIAGNOSTIC_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export function isSafeDiagnosticToken(value: unknown): value is string {
  return typeof value === 'string' && MODEL_DIAGNOSTIC_TOKEN_PATTERN.test(value)
}

/** The longest provider or model identifier a record will keep. */
export const MODEL_RESOLVER_IDENTIFIER_MAX_LENGTH = 128

/**
 * The shape of a provider or model identifier.
 *
 * Deliberately a grammar and not just a length. A length bound alone lets a
 * hundred and twenty-eight characters of prompt, of an error message, or of a
 * key sit in a field whose only justification is that it names a resolver — and
 * these two strings are the one place caller-supplied and provider-supplied
 * text reaches a durable record at all.
 *
 * Wider than a diagnostic token because real identifiers are wider: a model
 * slug carries slashes (`anthropic/claude-opus-4`), a bedrock id carries dots
 * and a colon suffix, a fine-tune carries doubled colons, and a configured
 * provider is `connection:` followed by a UUID. What none of them carry is
 * whitespace, quotes, or punctuation that only appears in sentences, so that is
 * what the grammar refuses.
 */
export const MODEL_RESOLVER_IDENTIFIER_PATTERN =
  /^[a-z0-9][a-z0-9._:\/+@-]{0,127}$/i

export function isSafeResolverIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MODEL_RESOLVER_IDENTIFIER_MAX_LENGTH &&
    MODEL_RESOLVER_IDENTIFIER_PATTERN.test(value)
  )
}

/**
 * Validate reported token counts, or report nothing.
 *
 * Three rules, all of them refusals:
 *
 * - Input and output must both be non-negative safe integers. A provider that
 *   reports only one of them has produced an incomplete measurement, and half a
 *   usage record prices a turn wrongly.
 * - A stated total must agree with the parts. Providers disagree with
 *   themselves — a cached-token count folded into one field and not the other
 *   is the usual way — and a record that keeps both sides of a contradiction is
 *   worse than one that keeps neither.
 * - A total that was not stated is the sum, which is arithmetic over validated
 *   numbers rather than an estimate.
 *
 * Anything else is omitted. Nothing here is inferred, defaulted or rounded up:
 * an absent usage record is an honest "the provider did not say", and an
 * operator can see that. A fabricated one looks exactly like a real one.
 */
export function normalizeTokenUsage(input: {
  readonly inputTokens?: unknown
  readonly outputTokens?: unknown
  readonly totalTokens?: unknown
}): NormalizedTokenUsage | undefined {
  const inputTokens = tokenCount(input.inputTokens)
  const outputTokens = tokenCount(input.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const sum = inputTokens + outputTokens
  if (!Number.isSafeInteger(sum)) return undefined
  if (input.totalTokens === undefined) {
    return { inputTokens, outputTokens, totalTokens: sum }
  }
  const totalTokens = tokenCount(input.totalTokens)
  if (totalTokens === undefined || totalTokens !== sum) return undefined
  return { inputTokens, outputTokens, totalTokens }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

/**
 * Whether the model's first structured answer could be used.
 *
 * `invalid` and `provider_failed` are the distinction that matters: one says
 * the model answered and its answer did not meet the contract, the other says
 * nothing came back. They send an operator to different systems.
 */
export const STRUCTURED_DECISION_VALIDATIONS = [
  'valid',
  'invalid',
  'provider_failed',
] as const
export type StructuredDecisionValidation =
  (typeof STRUCTURED_DECISION_VALIDATIONS)[number]

/** How the second attempt went, including never having been made. */
export const STRUCTURED_DECISION_REPAIRS = [
  'not_needed',
  'valid',
  'invalid',
  'provider_failed',
] as const
export type StructuredDecisionRepair =
  (typeof STRUCTURED_DECISION_REPAIRS)[number]

/**
 * Why the reply the user is reading was written by the server.
 *
 * `none` is a real value rather than an absent field: "no fallback happened" is
 * a fact the record states, and leaving it out would make it indistinguishable
 * from a build that never looked.
 */
export const STRUCTURED_DECISION_FALLBACKS = [
  'none',
  /** No credential was configured, so nothing was ever asked. */
  'credential_missing',
  /** The provider did not answer, on the first attempt or the repair. */
  'provider_failed',
  /** The provider answered twice and neither answer met the contract. */
  'invalid_decision',
  /**
   * No provider/model pair was selected, so nothing was ever asked. Distinct
   * from `credential_missing`: a credential is missing for a model that was
   * chosen, while this says no model was chosen at all.
   */
  'model_unselected',
] as const
export type StructuredDecisionFallback =
  (typeof STRUCTURED_DECISION_FALLBACKS)[number]

/** How one structured-decision turn went, in codes rather than prose. */
export interface StructuredDecisionDiagnostics {
  readonly initialValidation: StructuredDecisionValidation
  readonly repair: StructuredDecisionRepair
  readonly fallback: StructuredDecisionFallback
}
