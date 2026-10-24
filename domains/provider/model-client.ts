/**
 * Provider/model transport for architect and intake model calls.
 *
 * All API URLs, version headers, token budgets, environment names, and HTTP
 * wire formats live here. Callers depend only on `readApiKey` and `callModel`.
 */

import { whenDefined } from '../../core/optional-properties.js'
import { modelImagesSchema, type ModelImage } from '../../contracts/model-image.js'
import { anthropicImageBlocks } from '../../providers/image-content.js'
import {
  PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
  combineAbortSignals,
} from '../../core/timeout-manager.js'
import { executeProvider, getProvider } from '../../providers/index.js'
import { getConfiguredProviderConnection } from '../../providers/configured-provider.js'
import {
  extractChatCompletionsText,
  normalizeChatCompletionsUsage,
  readChatCompletionsBody,
  readChatCompletionsErrorIdentity,
  readChatCompletionsStream,
  type ChatCompletionsBody,
} from '../../providers/chat-completions-stream.js'
import {
  extractAnthropicMessagesText,
  normalizeAnthropicMessagesUsage,
  readAnthropicMessagesBody,
  readAnthropicMessagesErrorIdentity,
  readMessagesStream,
  type AnthropicMessagesBody,
} from '../../providers/messages-stream.js'
import { isConfiguredProviderName } from './provider-settings.js'
import {
  ProviderError,
  boundedProviderCode,
  classifyProviderError,
} from './provider-error.js'
import { normalizeProviderResultUsage } from '../../providers/types.js'
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGETS,
} from '../../providers/anthropic-thinking-defaults.js'
import {
  effortUnderReasoningSuppressor,
  openAiEffortValue,
  suppressedEffortConflictMessage,
} from './effort-support.js'
import { PROVIDER_DEFAULT_THINKING } from '../../core/types.js'
import { getRuntimeDefaultEffort } from './default-effort-selection.js'
import type { ThinkingLevel } from '../../core/types.js'
import type { ProviderProtocolEvent } from '../../contracts/provider.js'
import { isSafeResolverIdentifier } from '../../contracts/model-diagnostics.js'
import type {
  ModelCallDiagnostics,
  ModelCallOutcome,
  ModelCallRoute,
  ModelCallTiming,
  ModelProviderKind,
  NormalizedTokenUsage,
  SanitizedModelFailureIdentity,
} from '../../contracts/model-diagnostics.js'

export const API_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
}

const KIMI_FALLBACK_ENV = 'KIMI_API_KEY'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_API_VERSION = '2023-06-01'
// Kimi Code endpoint — backed by the user's kimi.com subscription quota,
// NOT the platform.moonshot.ai developer API (which has separate billing).
// Generate a key at https://www.kimi.com/code/console.
const KIMI_API_URL = 'https://api.kimi.com/coding/v1/chat/completions'
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions'
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const XAI_API_URL = 'https://api.x.ai/v1/chat/completions'
const DEFAULT_MAX_TOKENS = 6000

const ENV_API_URL_OVERRIDE = 'WORKFLOW_GENERATOR_API_URL'
const ENV_ANTHROPIC_VERSION_OVERRIDE = 'WORKFLOW_GENERATOR_ANTHROPIC_VERSION'
const ENV_KIMI_API_URL_OVERRIDE = 'WORKFLOW_GENERATOR_KIMI_API_URL'
const ENV_DEEPSEEK_API_URL_OVERRIDE = 'WORKFLOW_GENERATOR_DEEPSEEK_API_URL'
const ENV_OPENAI_API_URL_OVERRIDE = 'WORKFLOW_GENERATOR_OPENAI_API_URL'
const ENV_OPENROUTER_API_URL_OVERRIDE = 'WORKFLOW_GENERATOR_OPENROUTER_API_URL'
const ENV_XAI_API_URL_OVERRIDE = 'WORKFLOW_GENERATOR_XAI_API_URL'
const ENV_MAX_TOKENS_OVERRIDE = 'WORKFLOW_GENERATOR_MAX_TOKENS'
const CLI_PROVIDER_NAMES = new Set(['codex', 'claude', 'gemini', 'kimi-cli', 'qwen', 'pi'])
const LOCAL_CLI_SENTINEL = '__local_cli__'

export interface ModelMessage {
  role: 'user' | 'assistant'
  content: string
  images?: readonly ModelImage[]
}

/**
 * Agent-owned provider settings a helper turn may carry.
 *
 * Mapped onto the field the transport actually uses, never spread into the
 * request body: the loader restricts values to scalars but not keys, so a
 * spread could overwrite `model`, `messages` or `stream` with whatever an Agent
 * file happened to name.
 */
export type HelperProviderOptions = Readonly<Record<string, string | number | boolean>>

export interface ModelCallParams {
  provider: string
  model: string
  systemPrompt: string
  messages: ModelMessage[]
  thinking?: ThinkingLevel
  outputSchema?: Readonly<Record<string, unknown>>
  /** The Agent's own settings for the pair this call runs on. */
  providerOptions?: HelperProviderOptions
  /** Caller-owned silence budget for a CLI turn that authors a full package. */
  cliStallAbortMs?: number
  signal?: AbortSignal
  /**
   * Display-only observer for streamed answer text, called with each new
   * suffix as it arrives — never the running total.
   *
   * Nothing here is persisted: the returned `text` remains the authority, and
   * a caller that shows these suffixes is showing a preview of it. The
   * observer is called on the model's hot path, so it must stay cheap, and a
   * throw from it never fails the turn.
   */
  onTextDelta?: (text: string) => void
  /**
   * Observer for the call's content-free account of itself.
   *
   * A returned result covers the calls that return. An abort does not: the
   * caller withdrew, the exception is rethrown so the turn is classified as
   * cancellation rather than failure, and without this the only record of a
   * cancelled provider call would be that it was never mentioned. The observer
   * is called exactly once per call, on every path.
   */
  onDiagnostics?: (diagnostics: ModelCallDiagnostics) => void
}

export type { ModelCallTiming } from '../../contracts/model-diagnostics.js'

type ModelCallPayload =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: string }

/**
 * What one attempt observed about itself, beside what it will display.
 *
 * Kept separate from the payload because the two answer different questions
 * and have different lifetimes: `reason` and `text` are shown once and
 * discarded, and these are written down.
 */
interface ModelCallObservation {
  readonly outcome: ModelCallOutcome
  readonly failure?: SanitizedModelFailureIdentity
  readonly usage?: NormalizedTokenUsage
  /** What the provider said it used, when it answered at all. */
  readonly resolvedModel?: string
}

type ModelCallAttempt = ModelCallPayload & ModelCallObservation

export type ModelCallResult = ModelCallPayload & {
  timing: ModelCallTiming
  diagnostics: ModelCallDiagnostics
}

/** How a provider name resolves, decided once and used by every path. */
interface ModelRoute {
  readonly route: ModelCallRoute
  readonly providerKind: ModelProviderKind
  readonly resolvedProvider: string
}

/**
 * Resolve a provider name to a transport.
 *
 * The same order `dispatchModelCall` dispatches in, and its single source of
 * truth: a route decided twice is a route that can disagree with itself, and
 * the disagreement would show up as a record naming a transport that never ran.
 */
function resolveModelRoute(provider: string): ModelRoute {
  const lower = provider.toLowerCase()
  if (CLI_PROVIDER_NAMES.has(lower)) {
    return { route: 'cli', providerKind: 'cli', resolvedProvider: lower }
  }
  if (isConfiguredProviderName(provider)) {
    return {
      route: 'configured-http',
      providerKind: 'chat-completions',
      resolvedProvider: provider,
    }
  }
  if (lower === 'anthropic') {
    return {
      route: 'http',
      providerKind: 'anthropic-messages',
      resolvedProvider: lower,
    }
  }
  if (Object.prototype.hasOwnProperty.call(API_KEY_ENV, lower)) {
    return {
      route: 'http',
      providerKind: 'chat-completions',
      resolvedProvider: lower,
    }
  }
  return {
    route: 'fallback',
    providerKind: 'unsupported',
    resolvedProvider: lower,
  }
}

/** A successful attempt, with whatever the provider reported about itself. */
function answered(input: {
  readonly text: string
  readonly model: string
  readonly usage?: NormalizedTokenUsage | undefined
}): ModelCallAttempt {
  return {
    ok: true,
    text: input.text,
    model: input.model,
    outcome: 'success',
    // The display `model` above is whatever the provider said. The diagnostic
    // one is kept only when it is an identifier: a record holds it forever, so
    // a provider that answers with a sentence in that field must leave the
    // record saying nothing rather than saying that.
    ...(isSafeResolverIdentifier(input.model)
      ? { resolvedModel: input.model }
      : {}),
    ...whenDefined(input.usage, (usage) => ({ usage })),
  }
}

/** A failed attempt: one display reason, one allowlisted identity. */
/**
 * A call refused before anything was sent, because a setting it carried cannot
 * be carried.
 *
 * At the transport rather than in one caller: a caller that had written no
 * check of its own would otherwise lose every setting it declared, silently.
 */
function refusedProviderOptions(
  mapped:
    | { readonly ok: false; readonly unsupported: string }
    | { readonly ok: false; readonly invalid: string; readonly expected: string }
    // Two settings that are each valid alone. Named as a sentence of its own,
    // because neither one is "the wrong value" and prefixing it with a
    // `provider_options.` key would blame a setting that may not be there.
    | { readonly ok: false; readonly conflict: string },
  providerKind: ModelProviderKind,
): ModelCallAttempt {
  return unanswered(
    'conflict' in mapped
      ? mapped.conflict
      : 'unsupported' in mapped
      ? `'provider_options.${mapped.unsupported}' is not a setting this provider request can carry.`
      : `'provider_options.${mapped.invalid}' must be ${mapped.expected}.`,
    'provider_failure',
    {
      code: 'provider_options_unsupported',
      phase: 'configuration',
      providerKind,
      retryable: false,
    },
  )
}

function unanswered(
  reason: string,
  outcome: Exclude<ModelCallOutcome, 'success'>,
  failure: SanitizedModelFailureIdentity,
): ModelCallAttempt {
  return { ok: false, reason, outcome, failure }
}

/**
 * A response the endpoint refused, reduced to an identity.
 *
 * `408` is singled out because it is the endpoint saying a wait elapsed, which
 * is the same fact a local timeout reports and leads to the same advice. Every
 * other non-success status is a refusal: a gateway's own `504` included, since
 * that describes the gateway rather than the model's wait.
 */
function refusedResponse(input: {
  readonly reason: string
  readonly status: number
  readonly providerKind: ModelProviderKind
  readonly providerCode?: string
  readonly provider: string
}): ModelCallAttempt {
  const { retryable } = classifyProviderError({
    provider: input.provider,
    statusCode: input.status,
    ...whenDefined(input.providerCode, (code) => ({ code })),
    // Deliberately empty. The provider's own words classify nothing here that
    // the status and the code do not, and passing them in would make the
    // retry decision depend on prose this module refuses to keep.
    message: '',
  })
  return unanswered(
    input.reason,
    input.status === 408 ? 'timeout' : 'provider_failure',
    {
      code: input.status === 408 ? 'timeout' : 'http_status',
      phase: 'response',
      providerKind: input.providerKind,
      ...whenDefined(input.providerCode, (providerCode) => ({ providerCode })),
      httpStatus: input.status,
      retryable,
    },
  )
}

/**
 * A request that never produced a response.
 *
 * A timeout and a dropped connection are told apart because they lead
 * somewhere different, and neither keeps the transport's own message.
 */
function unreachable(input: {
  readonly reason: string
  readonly error: unknown
  readonly providerKind: ModelProviderKind
}): ModelCallAttempt {
  return isTimeoutLike(input.error)
    ? unanswered(input.reason, 'timeout', {
        code: 'timeout',
        phase: 'request',
        providerKind: input.providerKind,
        retryable: true,
      })
    : unanswered(input.reason, 'provider_failure', {
        code: 'network_error',
        phase: 'request',
        providerKind: input.providerKind,
        retryable: true,
      })
}

/** A response that arrived and could not be turned into an answer. */
function undecodable(input: {
  readonly reason: string
  readonly error?: unknown
  readonly providerKind: ModelProviderKind
}): ModelCallAttempt {
  const providerError =
    input.error instanceof ProviderError ? input.error : undefined
  const providerCode = boundedProviderCode(providerError?.code)
  return unanswered(input.reason, 'provider_failure', {
    code: 'response_unreadable',
    phase: 'decode',
    providerKind: input.providerKind,
    ...whenDefined(providerCode, (code) => ({ providerCode: code })),
    retryable: providerError?.retryable ?? false,
  })
}

type ModelObservedEvent = 'process_spawned' | 'provider_event' | 'provider_text'

/**
 * Bridge the provider protocol onto the caller's display observer.
 *
 * Only committed answer text is forwarded. A reasoning, refusal or tool-input
 * delta is excluded by the readers themselves, so what arrives here is already
 * the answer and nothing else. A throwing observer is contained: showing text
 * is a display concern and must never change the turn's outcome.
 */
function streamTextObserver(
  params: ModelCallParams,
  onEvent: (kind: ModelObservedEvent) => void,
): (event: ProviderProtocolEvent) => void {
  return (event: ProviderProtocolEvent) => {
    if (event.kind !== 'text' || !event.text) return
    onEvent('provider_text')
    const observer = params.onTextDelta
    if (!observer) return
    try {
      observer(event.text)
    } catch {
      // Intentionally swallowed.
    }
  }
}

/**
 * `stream: true` is a request, not a guarantee. An endpoint that answers with
 * an ordinary completion is read as one, decided by its own content type.
 */
function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes(
    'text/event-stream',
  )
}

function readFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Looks up the API key env var for the given provider. Returns the key if
 * present and non-empty, or `null` (with the env var name) otherwise.
 */
export function readApiKey(provider: string): { apiKey: string } | { apiKey: null; envVar: string } {
  const lower = provider.toLowerCase()
  if (CLI_PROVIDER_NAMES.has(lower)) {
    return { apiKey: LOCAL_CLI_SENTINEL }
  }
  if (isConfiguredProviderName(provider)) {
    const connection = getConfiguredProviderConnection(provider)
    if (!connection) {
      return { apiKey: null, envVar: `configured provider '${provider}'` }
    }
    return { apiKey: connection.apiKey ?? '' }
  }
  const envVar = API_KEY_ENV[lower] ?? ''
  if (!envVar) {
    return { apiKey: null, envVar: `(no API key env var registered for provider '${provider}')` }
  }
  const value =
    process.env[envVar]?.trim() ||
    (lower === 'kimi' ? process.env[KIMI_FALLBACK_ENV]?.trim() : undefined)
  if (!value) {
    return {
      apiKey: null,
      envVar: lower === 'kimi' ? `${envVar} (or ${KIMI_FALLBACK_ENV})` : envVar,
    }
  }
  return { apiKey: value }
}

/** Dispatches a model call by provider name. */
/**
 * How one transport carries an Agent's own provider settings.
 *
 * Named by the transport rather than inferred from the provider, because the
 * two are not the same question: the helper's OpenAI path is Chat Completions
 * with `max_completion_tokens`, every other Chat Completions endpoint here uses
 * `max_tokens`, and Anthropic carries its version in a header. Deciding from
 * "not Anthropic" alone sent Kimi, DeepSeek and configured connections a field
 * they do not read, alongside the default they do.
 */
export interface HelperProviderOptionTransport {
  readonly kind: 'chat-completions' | 'anthropic-messages'
  /** Chat Completions only: what this endpoint calls its token limit. */
  readonly tokenParameter?: 'max_tokens' | 'max_completion_tokens'
  /** The answer limit this request will carry when the Agent names none. */
  readonly maxTokens?: number
  /**
   * The level the Agent declared, set only where this transport can carry it —
   * an Anthropic request, or an OpenAI Chat Completions model that takes one.
   *
   * Not a `provider_options` key: an Agent's `thinking` is vendor-neutral and
   * travels with the Agent, so a transport that can express it should, and one
   * that cannot leaves it alone.
   */
  readonly thinking?: ThinkingLevel
  /** Where `maxTokens` came from, so a refusal can say what to change. */
  readonly maxTokensLabel?: string
  /** The model that will run, so a refusal can name it. */
  readonly model?: string
  /**
   * Chat Completions only: this model takes a reasoning effort here.
   *
   * Separate from `thinking`, which says what to send. Whether it reasons with
   * no effort sent depends on the model: some default to none, and those keep
   * their sampling settings once the effort is off.
   */
  readonly reasoningModel?: boolean
  /** Chat Completions only: this endpoint does not serve this model at all. */
  readonly unservedModel?: boolean
}

/**
 * The settings a transport actually applies, mapped onto the fields it uses.
 *
 * An option this transport does not apply is refused by name rather than
 * dropped: a setting that silently does nothing cannot be told apart from one
 * the provider ignores, and only a refusal can be acted on. Values are checked
 * here too — the file parser proves a value is a scalar, which is not the same
 * as proving it is a token count or a temperature.
 */
export function mapHelperProviderOptions(
  transport: HelperProviderOptionTransport,
  options: HelperProviderOptions | undefined,
):
  | { readonly ok: true; readonly body: Record<string, unknown>; readonly headers: Record<string, string> }
  | { readonly ok: false; readonly unsupported: string }
  | { readonly ok: false; readonly invalid: string; readonly expected: string }
  | { readonly ok: false; readonly conflict: string } {
  const body: Record<string, unknown> = {}
  const headers: Record<string, string> = {}
  const anthropic = transport.kind === 'anthropic-messages'
  // Set by an explicit `reasoning: false` alone. Presence of the key is not
  // enough: `reasoning: true` asks for the opposite.
  let reasoningOff = false
  // First, because nothing else matters if the request cannot be made. Omitting
  // a parameter would not rescue a model this endpoint does not serve.
  if (transport.unservedModel) {
    return {
      ok: false,
      conflict:
        `'${transport.model ?? 'this model'}' is a Responses API model and is not ` +
        'served by this Chat Completions endpoint. Choose a model this route ' +
        'serves, or run it on the provider route that does.',
    }
  }
  const positiveInteger = (value: unknown): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value > 0
  const unitRange = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2
  for (const [key, value] of Object.entries(options ?? {})) {
    if (key === 'max_tokens') {
      if (!positiveInteger(value)) {
        return { ok: false, invalid: key, expected: 'a positive whole number of tokens' }
      }
      body[anthropic ? 'max_tokens' : transport.tokenParameter ?? 'max_tokens'] = value
      continue
    }
    if (key === 'temperature' || key === 'top_p') {
      if (!unitRange(value)) {
        return { ok: false, invalid: key, expected: 'a number between 0 and 2' }
      }
      body[key] = value
      continue
    }
    if (!anthropic && key === 'reasoning') {
      // Accepted for this transport whatever model runs, because
      // `providers/openai.ts:86` applies it with no model restriction —
      // refusing it on a model that takes no effort anyway would stop a turn
      // the native route runs without complaint. It says omit the parameter,
      // which is a decision even where it is also what would have happened.
      if (!isOpenAiChatCompletions(transport.tokenParameter)) {
        return { ok: false, unsupported: key }
      }
      if (typeof value !== 'boolean') {
        return { ok: false, invalid: key, expected: 'true or false' }
      }
      // Read the way `providers/openai.ts:86` reads it, so one agent file means
      // one thing on both routes: `false` omits the parameter, and `true` is
      // an explicit request to keep the level. Neither writes a field of its
      // own — the effort below is the only thing this setting decides.
      reasoningOff = value === false
      continue
    }
    if (anthropic && key === 'thinking_budget') {
      // The provider's own bounds, checked here so the refusal names the
      // setting rather than arriving as a rejected request. A budget at or
      // above the answer's own limit leaves no room for an answer.
      const limit = typeof options?.max_tokens === 'number'
        ? options.max_tokens
        : transport.maxTokens
      // Zero is a value, not a budget below the floor. `providers/anthropic.ts`
      // resolves this setting with `??` and then omits the thinking block for
      // anything that is not above zero, so a written 0 is how an Agent turns
      // extended thinking off. Refusing it here made the same valid agent file
      // stop a helper turn while running fine everywhere else — and there is no
      // budget for a ceiling to accommodate, so no bound applies.
      if (value === 0) continue
      if (!positiveInteger(value) || (value as number) < 1024) {
        return { ok: false, invalid: key, expected: 'a whole number of tokens, at least 1024' }
      }
      const budget = value as number
      if (limit !== undefined && budget >= limit) {
        return {
          ok: false,
          invalid: key,
          expected: `fewer tokens than max_tokens (${limit})`,
        }
      }
      // An explicit `off` is the newer instruction and wins over a budget the
      // file still carries, exactly as it does in `providers/anthropic.ts`.
      if (transport.thinking === 'off') continue
      body.thinking = { type: 'enabled', budget_tokens: budget }
      continue
    }
    if (anthropic && key === 'api_version') {
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, invalid: key, expected: 'a non-empty version string' }
      }
      headers['anthropic-version'] = value
      continue
    }
    return { ok: false, unsupported: key }
  }
  // Last, because it defers to everything above it. A written `thinking_budget`
  // is the Agent's own answer to this question — including a written `0`, which
  // is how thinking is turned off and which leaves no budget for a ceiling to
  // accommodate — so a level only decides where nothing was written.
  // `provider-default` is a request for no setting, so it cannot be one of the
  // levels that "sends" one. Treating it as a level would put the literal words
  // in the request body, where no vendor knows them.
  // `reasoning: false` suppresses the field; it does not decide what a level
  // meant. `off` is still sent, because omitting it lets the vendor think; a
  // level from the widened vocabulary stops the turn rather than vanishing; and
  // the three legacy levels stay suppressed, as they always were.
  const suppressed =
    reasoningOff &&
    transport.thinking !== undefined &&
    transport.thinking !== PROVIDER_DEFAULT_THINKING
      ? effortUnderReasoningSuppressor(transport.thinking)
      : 'send'
  if (
    !anthropic &&
    suppressed === 'conflict' &&
    transport.thinking !== undefined &&
    transport.thinking !== PROVIDER_DEFAULT_THINKING
  ) {
    return {
      ok: false,
      conflict: suppressedEffortConflictMessage(
        transport.model ?? 'this model',
        transport.thinking,
      ),
    }
  }
  const sendsEffort =
    Boolean(transport.thinking) &&
    transport.thinking !== PROVIDER_DEFAULT_THINKING &&
    suppressed === 'send'
  // Whether the request will *effectively* reason, which is not the same as
  // whether it names a level. Omitting `reasoning_effort` stops the reasoning
  // only where the model's own default is none; elsewhere it keeps thinking and
  // keeps refusing sampling settings, so the opt-out is no escape and is not
  // offered as one.
  const reasonsRegardless =
    Boolean(transport.reasoningModel) && !reasonsOnlyWhenAsked(transport.model)
  if (!anthropic && transport.reasoningModel && (sendsEffort || reasonsRegardless)) {
    const sampling = ['temperature', 'top_p'].filter((key) => key in body)
    if (sampling.length > 0) {
      return {
        ok: false,
        conflict:
          `'provider_options.${sampling[0]}' cannot be sent to ` +
          `'${transport.model ?? 'this model'}' on this endpoint: it reasons ` +
          'here, and refuses sampling settings while it does. Remove that ' +
          'setting, or choose a model that takes it.',
      }
    }
  }
  if (!anthropic && transport.reasoningModel && sendsEffort && transport.thinking) {
    // Translated once, here, into the spelling this endpoint uses: `off` is
    // `none` on an OpenAI-compatible body and `off` everywhere this
    // application writes it.
    body.reasoning_effort = openAiEffortValue(
      transport.thinking as Exclude<ThinkingLevel, typeof PROVIDER_DEFAULT_THINKING>,
    )
  }
  const wroteBudget = Object.prototype.hasOwnProperty.call(
    options ?? {},
    'thinking_budget',
  )
  if (
    anthropic &&
    transport.thinking &&
    transport.thinking !== PROVIDER_DEFAULT_THINKING &&
    !wroteBudget
  ) {
    const budget = ANTHROPIC_THINKING_BUDGETS[transport.thinking]
    // A level with no budget in that table is a level this endpoint cannot
    // express. Sending the request anyway would answer at whatever depth the
    // vendor defaults to, which is a different turn from the one that was
    // asked for and looks identical afterwards.
    if (budget === undefined && transport.thinking !== 'off') {
      return {
        ok: false,
        conflict:
          `A thinking level of '${transport.thinking}' cannot be sent to this ` +
          'endpoint, which expresses depth as a thinking budget. Choose off, ' +
          'low, medium or high, or the provider default.',
      }
    }
    const ceiling =
      typeof body.max_tokens === 'number' ? body.max_tokens : transport.maxTokens
    const ceilingLabel =
      typeof body.max_tokens === 'number'
        ? 'provider_options.max_tokens'
        : transport.maxTokensLabel ?? 'the request limit'
    if (budget !== undefined && budget > 0) {
      // Refused, not quietly resolved. Raising the ceiling would spend tokens
      // nobody authorised; dropping the level would answer at a depth the Agent
      // did not ask for, and neither would appear anywhere a person could see.
      if (ceiling !== undefined && budget >= ceiling) {
        return {
          ok: false,
          conflict:
            `A thinking level of '${transport.thinking}' needs a budget of ${budget} tokens, ` +
            `which does not fit under max_tokens (${ceiling}) from ${ceilingLabel}. ` +
            'Raise that limit or lower the level.',
        }
      }
      body.thinking = { type: 'enabled', budget_tokens: budget }
    }
  }
  return { ok: true, body, headers }
}

/**
 * The transport a provider's helper call will actually use, or nothing when it
 * is not one that carries settings at all — a CLI turn has no request body to
 * write them into, so approving one would be a claim with nothing behind it.
 */
/**
 * Models this endpoint does not serve at all.
 *
 * `gpt-5-pro` is a Responses API model. Leaving `reasoning_effort` off would
 * not make it work here — the request would still go to an endpoint that model
 * does not serve — so the turn stops instead. Matched by prefix, because a
 * dated snapshot of it is the same model.
 */
const CHAT_COMPLETIONS_RESPONSES_ONLY_MODELS = ['gpt-5-pro'] as const

/**
 * Models documented as taking `reasoning_effort` here that no family shape
 * below would otherwise match.
 */
const CHAT_COMPLETIONS_REASONING_EFFORT_MODELS = ['gpt-6-astra'] as const

/**
 * Models documented as reasoning *only when asked*.
 *
 * Their default effort is none, and sampling settings are supported there — so
 * for these, and only these, turning the effort off makes a temperature valid
 * again. Everything else in the set above reasons whatever is sent: one
 * defaults to a middle level, another accepts no "none" at all.
 */
const CHAT_COMPLETIONS_DEFAULT_NONE_MODELS = ['gpt-5.1', 'gpt-5.2', 'gpt-5.4'] as const

function reasonsOnlyWhenAsked(model: string | undefined): boolean {
  return model !== undefined && namesModel(model, CHAT_COMPLETIONS_DEFAULT_NONE_MODELS)
}

/** A dated snapshot suffix, which is the only thing that may follow a base id. */
const MODEL_SNAPSHOT_SUFFIX = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whether this id names one of these models.
 *
 * Exact id, or a dated snapshot of it. Not a prefix: `gpt-5.2-pro` and
 * `gpt-5.20` are different models, and applying one model's documented
 * behaviour to another because their names share a beginning is how a setting
 * ends up sent on evidence that was never about it.
 */
function namesModel(model: string, baseIds: readonly string[]): boolean {
  return baseIds.some((base) => {
    if (model === base) return true
    if (!model.startsWith(`${base}-`)) return false
    return MODEL_SNAPSHOT_SUFFIX.test(model.slice(base.length + 1))
  })
}

/** True where this route is OpenAI's own Chat Completions endpoint. */
function isOpenAiChatCompletions(
  tokenParameter: 'max_tokens' | 'max_completion_tokens' | undefined,
): boolean {
  return tokenParameter === 'max_completion_tokens'
}

function isResponsesOnlyModel(model: string | undefined): boolean {
  return model !== undefined && namesModel(model, CHAT_COMPLETIONS_RESPONSES_ONLY_MODELS)
}

/**
 * Whether this model reasons on this endpoint, and so takes an effort here.
 *
 * This transport's own judgement, deliberately *not*
 * `openAiHostSupportsReasoningEffort`. That predicate answers a question about
 * the Responses host, and borrowing it as certification here is wrong in both
 * directions: it accepts `gpt-5-pro`, which this endpoint does not serve, and
 * it misses `gpt-6-astra`, which documents the parameter here. What remains is
 * a family shape for models this codebase has no better evidence about, with
 * both known exceptions named — correctable model by model, and not a claim to
 * certify every future name.
 */
function chatCompletionsModelTakesReasoningEffort(model: string): boolean {
  if (isResponsesOnlyModel(model)) return false
  if (namesModel(model, CHAT_COMPLETIONS_REASONING_EFFORT_MODELS)) return true
  return /^(gpt-5|o1|o3|o4)/.test(model)
}

/**
 * Whether this Chat Completions route will carry a reasoning effort.
 *
 * Only OpenAI's own endpoint documents the parameter — the same function serves
 * DeepSeek, OpenRouter, xAI and every configured connection, and compatible in
 * shape is not the same as accepting this field.
 */
function chatCompletionsCarriesReasoningEffort(
  tokenParameter: 'max_tokens' | 'max_completion_tokens' | undefined,
  model: string | undefined,
): boolean {
  return (
    isOpenAiChatCompletions(tokenParameter) &&
    model !== undefined &&
    chatCompletionsModelTakesReasoningEffort(model)
  )
}

/**
 * The Chat Completions transport, decided once.
 *
 * The check that refuses a turn before dispatch and the call that builds the
 * request must reach the same answer about which model this endpoint serves,
 * whether it reasons here, and whether a level may be sent. Written twice they
 * were free to disagree — and did, which is how a preflight came to validate a
 * level the request was not going to carry.
 */
function chatCompletionsHelperTransport(
  tokenParameter: 'max_tokens' | 'max_completion_tokens' | undefined,
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
): HelperProviderOptionTransport {
  const reasoningModel = chatCompletionsCarriesReasoningEffort(tokenParameter, model)
  return {
    kind: 'chat-completions',
    ...whenDefined(tokenParameter, (parameter) => ({ tokenParameter: parameter })),
    ...whenDefined(model, (name) => ({ model: name })),
    ...(isOpenAiChatCompletions(tokenParameter) && isResponsesOnlyModel(model)
      ? { unservedModel: true }
      : {}),
    ...(reasoningModel
      ? { reasoningModel, ...whenDefined(thinking, (level) => ({ thinking: level })) }
      : {}),
  }
}

/**
 * The Anthropic transport, with its answer ceiling resolved.
 *
 * One resolver, because two would be free to disagree: the check that refuses
 * a turn before dispatch and the call that builds the request must decide the
 * same ceiling, or a turn could pass the check and then be refused by the
 * request it was cleared to make.
 */
function anthropicHelperTransport(
  thinking?: ThinkingLevel,
): HelperProviderOptionTransport {
  // In priority order, and the order matters. The Agent's own `max_tokens`
  // wins and is applied by the mapper. Then the operator's override, which is
  // a decision and stands whatever a level would prefer. Only where neither
  // exists does a declared level bring its own ceiling — the same number
  // `providers/anthropic.ts` uses, because a budget with no room for an answer
  // is a request the vendor refuses.
  const environmentCeiling = readMaxTokensOverride()
  const levelCeiling = thinking ? ANTHROPIC_DEFAULT_MAX_TOKENS[thinking] : undefined
  return {
    kind: 'anthropic-messages',
    maxTokens: environmentCeiling ?? levelCeiling ?? DEFAULT_MAX_TOKENS,
    maxTokensLabel:
      environmentCeiling !== undefined
        ? ENV_MAX_TOKENS_OVERRIDE
        : levelCeiling !== undefined
          ? `this provider's default for that level`
          : 'the request limit',
    ...whenDefined(thinking, (level) => ({ thinking: level })),
  }
}

export function helperProviderOptionTransport(
  provider: string,
  /** The level the Agent declared, where the caller knows it. */
  thinking?: ThinkingLevel,
  /** The model that will run, which decides whether an effort can be carried. */
  model?: string,
): HelperProviderOptionTransport | undefined {
  const route = resolveModelRoute(provider)
  if (route.providerKind === 'anthropic-messages') {
    return anthropicHelperTransport(thinking)
  }
  if (route.providerKind !== 'chat-completions') return undefined
  // Only the helper's own OpenAI endpoint is Chat Completions with the newer
  // token field; every other endpoint on this route uses `max_tokens`.
  const tokenParameter =
    route.resolvedProvider === 'openai' ? 'max_completion_tokens' : 'max_tokens'
  return chatCompletionsHelperTransport(tokenParameter, model, thinking)
}

export async function callModel(
  apiKey: string,
  params: ModelCallParams,
): Promise<ModelCallResult> {
  const startedAt = performance.now()
  let firstProviderEventMs: number | null = null
  let firstTextMs: number | null = null
  let processSpawnMs: number | null = null
  const elapsed = (): ModelCallTiming => ({
    providerDurationMs: performance.now() - startedAt,
    processSpawnMs,
    firstProviderEventMs,
    firstTextMs,
  })
  const route = resolveModelRoute(params.provider)


  let attempt: ModelCallAttempt
  try {
    attempt = await dispatchModelCall(apiKey, params, (kind) => {
      const timing = performance.now() - startedAt
      if ((kind === 'provider_event' || kind === 'provider_text') && firstProviderEventMs === null) {
        firstProviderEventMs = timing
      }
      if (kind === 'provider_text' && firstTextMs === null) firstTextMs = timing
      if (kind === 'process_spawned' && processSpawnMs === null) processSpawnMs = timing
    })
  } catch (error) {
    // An abort leaves by exception so the caller can tell a withdrawn turn from
    // a failed one. It is still a call that happened, and this is the only
    // place that can say what it was.
    report(params, route, elapsed(), abortedAttempt(params, error, route))
    throw error
  }

  // Measured once, exactly as before: an answer that streamed no text is
  // credited with the whole call, and the timing the caller sees is the timing
  // the record keeps.
  const providerDurationMs = performance.now() - startedAt
  if (attempt.ok && firstTextMs === null) firstTextMs = providerDurationMs
  const timing: ModelCallTiming = {
    providerDurationMs,
    processSpawnMs,
    firstProviderEventMs,
    firstTextMs,
  }
  const diagnostics = describeCall(params, route, timing, attempt)
  reportOnce(params, diagnostics)
  const {
    outcome: _outcome,
    failure: _failure,
    usage: _usage,
    resolvedModel: _resolvedModel,
    ...payload
  } = attempt
  return { ...payload, timing, diagnostics }
}

/** Which end a rethrown abort came from. Intent first; a bound is not intent. */
function abortedAttempt(
  params: ModelCallParams,
  error: unknown,
  route: ModelRoute,
): ModelCallAttempt {
  if (params.signal?.aborted) {
    return unanswered('the caller cancelled the request', 'cancelled', {
      code: 'cancelled',
      phase: 'request',
      providerKind: route.providerKind,
      // Nothing to retry. The request was withdrawn, not lost.
      retryable: false,
    })
  }
  return unreachable({
    reason: 'the request was aborted',
    error,
    providerKind: route.providerKind,
  })
}

function describeCall(
  params: ModelCallParams,
  route: ModelRoute,
  timing: ModelCallTiming,
  attempt: ModelCallAttempt,
): ModelCallDiagnostics {
  return {
    requestedProvider: params.provider,
    requestedModel: params.model,
    resolvedProvider: route.resolvedProvider,
    ...whenDefined(attempt.resolvedModel, (resolvedModel) => ({ resolvedModel })),
    route: route.route,
    outcome: attempt.outcome,
    ...whenDefined(attempt.failure, (failure) => ({ failure })),
    timing,
    ...whenDefined(attempt.usage, (usage) => ({ usage })),
  }
}

function report(
  params: ModelCallParams,
  route: ModelRoute,
  timing: ModelCallTiming,
  attempt: ModelCallAttempt,
): void {
  reportOnce(params, describeCall(params, route, timing, attempt))
}

/**
 * Hand the account to the caller without letting it change the outcome.
 *
 * Observing is a bookkeeping concern. A throwing observer must not turn an
 * answered call into a failed one, and on the abort path must not replace the
 * cancellation the caller is waiting to see.
 */
function reportOnce(
  params: ModelCallParams,
  diagnostics: ModelCallDiagnostics,
): void {
  try {
    params.onDiagnostics?.(diagnostics)
  } catch {
    // Intentionally swallowed.
  }
}

async function dispatchModelCall(
  apiKey: string,
  params: ModelCallParams,
  onEvent: (kind: ModelObservedEvent) => void,
): Promise<ModelCallAttempt> {
  modelImagesSchema.parse(params.messages.flatMap((message) => message.images ?? []))
  const provider = params.provider.toLowerCase()
  if (CLI_PROVIDER_NAMES.has(provider)) {
    return callCliProvider(params, onEvent)
  }
  if (isConfiguredProviderName(params.provider)) {
    const connection = getConfiguredProviderConnection(params.provider)
    if (!connection) {
      return unanswered(
        `Configured provider '${params.provider}' is unavailable. Revalidate it in Settings.`,
        'provider_failure',
        {
          code: 'provider_unavailable',
          phase: 'request',
          providerKind: 'chat-completions',
          retryable: false,
        },
      )
    }
    return callOpenAICompatible(
      connection.apiKey ?? '',
      params,
      {
        label: connection.name,
        url: configuredChatUrl(connection.baseUrl),
      },
      onEvent,
    )
  }
  if (provider === 'anthropic') {
    return callAnthropic(apiKey, params, onEvent)
  }
  if (provider === 'kimi') {
    return callKimi(apiKey, params, onEvent)
  }
  if (provider === 'deepseek') {
    return callOpenAICompatible(
      apiKey,
      params,
      {
        label: 'DeepSeek',
        url: process.env[ENV_DEEPSEEK_API_URL_OVERRIDE] ?? DEEPSEEK_API_URL,
      },
      onEvent,
    )
  }
  if (provider === 'openai') {
    return callOpenAICompatible(
      apiKey,
      params,
      {
        label: 'OpenAI',
        url: process.env[ENV_OPENAI_API_URL_OVERRIDE] ?? OPENAI_API_URL,
        tokenParameter: 'max_completion_tokens',
      },
      onEvent,
    )
  }
  if (provider === 'openrouter') {
    return callOpenAICompatible(
      apiKey,
      params,
      {
        label: 'OpenRouter',
        url: process.env[ENV_OPENROUTER_API_URL_OVERRIDE] ?? OPENROUTER_API_URL,
      },
      onEvent,
    )
  }
  if (provider === 'xai') {
    return callOpenAICompatible(
      apiKey,
      params,
      {
        label: 'xAI',
        url: process.env[ENV_XAI_API_URL_OVERRIDE] ?? XAI_API_URL,
      },
      onEvent,
    )
  }
  return unanswered(
    `Provider '${params.provider}' is not yet supported for chat (supported: ${Object.keys(API_KEY_ENV).join(', ')}).`,
    'provider_failure',
    {
      code: 'provider_unsupported',
      phase: 'request',
      providerKind: 'unsupported',
      retryable: false,
    },
  )
}

async function callCliProvider(
  params: ModelCallParams,
  onEvent: (kind: ModelObservedEvent) => void,
): Promise<ModelCallAttempt> {
  const reportText = streamTextObserver(params, onEvent)
  try {
    const images = params.messages.flatMap((message) => message.images ?? [])
    if (images.length > 0 && params.provider.toLowerCase() !== 'claude') {
      return unanswered(`Image inputs are not supported by the ${params.provider} helper transport. Choose Claude Code or a vision-capable API model.`, 'provider_failure', { code: 'provider_unsupported', phase: 'request', providerKind: 'cli', retryable: false })
    }
    const provider = getProvider(params.provider.toLowerCase())
    const history = params.messages
      .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
      .join('\n\n')
    const result = await executeProvider(provider, {
      systemPrompt: params.systemPrompt,
      userMessage: history,
      ...(images.length > 0 ? { images } : {}),
      model: params.model || 'default',
      thinking: params.thinking ?? getRuntimeDefaultEffort(),
      tools: [],
      ...whenDefined(params.cliStallAbortMs, (abortIdleMs) => ({
        stallWatchdog: { abortIdleMs },
      })),
      // A CLI turn has no request body, but the adapters already read settings
      // from `providerConfig` — kimi's `max_steps_per_turn` becomes
      // `--max-steps-per-turn`. Refusing them wholesale would take away a
      // capability that exists, so they are passed to the adapter that knows
      // what it can use.
      ...whenDefined(params.providerOptions, (providerConfig) => ({ providerConfig })),
      ...whenDefined(params.outputSchema, (definedValue) => ({ outputSchema: definedValue })),
      ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
      onProcessStarted: () => onEvent('process_spawned'),
      // Whole-message delivery, not token growth: the CLI adapters that report
      // text at all report a completed message. Showing that beats showing
      // nothing, and it is the only preview these models can offer today.
      onProtocolEvent: reportText,
    }, (event) => {
      // Timing only. `executeProvider` composes this observer with the options
      // callback above and calls both for the same event, so reporting text
      // here as well would show it twice.
      //
      // Provider stream wrappers emit synthetic request.start/request.end
      // events; only provider-originated events are protocol milestones.
      if (event.rawType === 'request.start' || event.rawType === 'request.end') return
      onEvent(event.kind === 'text' ? 'provider_text' : 'provider_event')
    })
    return answered({
      text: result.text,
      model: result.model,
      usage: normalizeProviderResultUsage(result),
    })
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : undefined
    const providerCode = boundedProviderCode(providerError?.code)
    return unanswered(
      error instanceof Error ? error.message : String(error),
      'provider_failure',
      {
        code: 'cli_failed',
        phase: 'request',
        providerKind: 'cli',
        ...whenDefined(providerCode, (code) => ({ providerCode: code })),
        ...whenDefined(providerError?.statusCode, (httpStatus) => ({ httpStatus })),
        retryable: providerError?.retryable ?? false,
      },
    )
  }
}

function configuredChatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

async function callAnthropic(
  apiKey: string,
  params: ModelCallParams,
  onEvent: (kind: ModelObservedEvent) => void,
): Promise<ModelCallAttempt> {
  const apiUrl = process.env[ENV_API_URL_OVERRIDE] ?? ANTHROPIC_API_URL
  const apiVersion = process.env[ENV_ANTHROPIC_VERSION_OVERRIDE] ?? ANTHROPIC_API_VERSION
  const transport = anthropicHelperTransport(params.thinking)
  const maxTokens = transport.maxTokens ?? DEFAULT_MAX_TOKENS
  const mapped = mapHelperProviderOptions(transport, params.providerOptions)
  if (!mapped.ok) return refusedProviderOptions(mapped, 'anthropic-messages')
  const body = {
    model: params.model,
    system: params.systemPrompt,
    max_tokens: maxTokens,
    // Streamed so partial answer text can reach the caller's display observer
    // while the model is still generating.
    stream: true,
    messages: params.messages.map((message) => ({ role: message.role, content: message.images?.length ? anthropicImageBlocks(message.content, message.images) : message.content })),
    // Last, and only the fields this transport named for itself. A mapper that
    // approves a setting the transport then drops is worse than a refusal.
    ...(mapped.ok ? mapped.body : {}),
  }

  let response: Response
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': apiVersion,
        ...(mapped.ok ? mapped.headers : {}),
      },
      body: JSON.stringify(body),
      // Bounded across the whole streamed read, composed with the caller's
      // signal so a cancelled turn still cancels the request.
      signal: combineAbortSignals(
        AbortSignal.timeout(PROVIDER_HTTP_REQUEST_TIMEOUT_MS),
        params.signal,
      ),
    })
  } catch (error) {
    if (isAbortLike(error) || params.signal?.aborted) {
      throw error
    }
    return unreachable({
      reason: `network error: ${error instanceof Error ? error.message : String(error)}`,
      error,
      providerKind: 'anthropic-messages',
    })
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return refusedResponse({
      reason: `Anthropic ${response.status} ${response.statusText} ${detail.slice(0, 200)}`,
      status: response.status,
      providerKind: 'anthropic-messages',
      ...readAnthropicMessagesErrorIdentity(detail),
      provider: 'anthropic',
    })
  }

  let payload: AnthropicMessagesBody | null
  try {
    payload = isEventStream(response)
      ? (
          await readMessagesStream({
            response,
            provider: 'Anthropic',
            fallbackModel: params.model,
            onProtocolEvent: streamTextObserver(params, onEvent),
          })
        ).body
      : await readAnthropicMessagesBody(response)
  } catch (error) {
    if (isAbortLike(error) || params.signal?.aborted) throw error
    return undecodable({
      reason: `failed to read Anthropic response: ${readFailureReason(error)}`,
      error,
      providerKind: 'anthropic-messages',
    })
  }

  if (!payload) {
    return undecodable({
      reason:
        'failed to parse Anthropic response: the body could not be read as JSON',
      providerKind: 'anthropic-messages',
    })
  }

  const text = extractAnthropicMessagesText(payload)

  if (!text.trim()) {
    return unanswered('Anthropic returned an empty response', 'provider_failure', {
      code: 'empty_response',
      phase: 'decode',
      providerKind: 'anthropic-messages',
      retryable: false,
    })
  }

  return answered({
    text,
    model: payload.model || params.model,
    usage: normalizeAnthropicMessagesUsage(payload.usage),
  })
}

function callKimi(
  apiKey: string,
  params: ModelCallParams,
  onEvent: (kind: ModelObservedEvent) => void,
): Promise<ModelCallAttempt> {
  return callOpenAICompatible(
    apiKey,
    params,
    {
      label: 'Kimi',
      url: process.env[ENV_KIMI_API_URL_OVERRIDE] ?? KIMI_API_URL,
    },
    onEvent,
  )
}

/**
 * Shared transport for OpenAI-compatible chat-completions providers
 * (Kimi, DeepSeek, and any future provider with the same wire shape).
 */
async function callOpenAICompatible(
  apiKey: string,
  params: ModelCallParams,
  endpoint: {
    label: string
    url: string
    tokenParameter?: 'max_tokens' | 'max_completion_tokens'
  },
  onEvent: (kind: ModelObservedEvent) => void,
): Promise<ModelCallAttempt> {
  const maxTokens = readMaxTokens()
  const tokenParameter = endpoint.tokenParameter ?? 'max_tokens'
  const mapped = mapHelperProviderOptions(
    chatCompletionsHelperTransport(
      endpoint.tokenParameter,
      params.model,
      params.thinking,
    ),
    params.providerOptions,
  )
  if (!mapped.ok) return refusedProviderOptions(mapped, 'chat-completions')
  const body = {
    model: params.model,
    [tokenParameter]: maxTokens,
    // Streamed so partial answer text can reach the caller's display observer
    // while the model is still generating.
    stream: true,
    messages: [
      { role: 'system', content: params.systemPrompt },
      ...params.messages.map((message) => ({ role: message.role, content: message.images?.length ? [
        { type: 'text', text: message.content },
        ...message.images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } })),
      ] : message.content })),
    ],
    // Last, and only the fields this transport named for itself. The request's
    // own identity — model, messages, stream — is written above and an Agent's
    // options cannot reach those keys.
    ...(mapped.ok ? mapped.body : {}),
  }

  let response: Response
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      // A streamed body outlives the response headers, so the bound must cover
      // the whole read. It composes with the caller's signal rather than
      // replacing it: cancelling a turn still cancels the request.
      signal: combineAbortSignals(
        AbortSignal.timeout(PROVIDER_HTTP_REQUEST_TIMEOUT_MS),
        params.signal,
      ),
    })
  } catch (error) {
    if (isAbortLike(error) || params.signal?.aborted) {
      throw error
    }
    return unreachable({
      reason: `network error: ${error instanceof Error ? error.message : String(error)}`,
      error,
      providerKind: 'chat-completions',
    })
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return refusedResponse({
      reason: `${endpoint.label} ${response.status} ${response.statusText} ${detail.slice(0, 200)}`,
      status: response.status,
      providerKind: 'chat-completions',
      ...readChatCompletionsErrorIdentity(detail),
      provider: endpoint.label,
    })
  }

  // Both transports are rebuilt into the one body shape, so text extraction,
  // model reporting and every downstream rule run against a single
  // representation rather than gaining a streaming-only copy.
  let payload: ChatCompletionsBody | null
  try {
    payload = isEventStream(response)
      ? (
          await readChatCompletionsStream({
            response,
            provider: endpoint.label,
            fallbackModel: params.model,
            onProtocolEvent: streamTextObserver(params, onEvent),
          })
        ).body
      : await readChatCompletionsBody(response)
  } catch (error) {
    if (isAbortLike(error) || params.signal?.aborted) throw error
    return undecodable({
      reason: `failed to read ${endpoint.label} response: ${readFailureReason(error)}`,
      error,
      providerKind: 'chat-completions',
    })
  }

  // A body nobody could read is a different operational problem from a reply
  // that came back empty, so the two are reported apart.
  if (!payload) {
    return undecodable({
      reason: `failed to parse ${endpoint.label} response: the body could not be read as JSON`,
      providerKind: 'chat-completions',
    })
  }

  const text = extractChatCompletionsText(payload.choices?.[0]?.message?.content)

  if (!text.trim()) {
    return unanswered(
      `${endpoint.label} returned an empty response`,
      'provider_failure',
      {
        code: 'empty_response',
        phase: 'decode',
        providerKind: 'chat-completions',
        retryable: false,
      },
    )
  }

  return answered({
    text,
    model: payload.model || params.model,
    usage: normalizeChatCompletionsUsage(payload.usage),
  })
}

interface OpenAICompatibleResponseShape {
  model?: string
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null
    }
  }>
}

/**
 * The operator's own answer ceiling, or nothing where they set none.
 *
 * Kept apart from the fallback below because the two are not the same kind of
 * number: one is a decision, and a decision is never quietly raised to make
 * another setting fit.
 */
function readMaxTokensOverride(): number | undefined {
  const raw = process.env[ENV_MAX_TOKENS_OVERRIDE]
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function readMaxTokens(): number {
  return readMaxTokensOverride() ?? DEFAULT_MAX_TOKENS
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Whether the request bound elapsed.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError`, which is deliberately
 * not an `AbortError`: the caller did not withdraw anything, the wait ran out.
 * Reading the name is how the two stay apart on a path that sees only the
 * rejection.
 */
function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}
