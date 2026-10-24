/**
 * Which effort level a provider and model will actually accept.
 *
 * Three things decide the answer, and leaving any of them out gives a wrong
 * one. The **provider**, because the adapters differ in what they can express
 * at all: `providers/claude.ts` writes a `--effort` flag the binary parses,
 * `providers/gemini.ts` has nowhere to put the setting. The **model**, because
 * vendors publish per-model ranges that do not agree with each other — `codex
 * debug models` reports `ultra` for one model and stops at `xhigh` for
 * another. The **route**, because the chat-completions tool loop sends a body
 * with no room for the setting at all
 * (`domains/provider/openai-chat-completions-tool-adapter.ts`).
 *
 * The rule this module enforces: a chosen level is sent, or the turn is
 * refused. It is never exchanged for a neighbouring level. Two documented
 * facts make substitution wrong rather than merely impolite:
 *
 * - The levels are not one ladder. Anthropic states that not every model
 *   supporting `max` supports `xhigh`, so "the next one down" is not a
 *   well-defined operation across models.
 * - `off` is a state, not a floor. The Pi runtime this application executes
 *   rounds an unsupported `off` *upward* into enabled thinking
 *   (`clampThinkingLevel` in `@earendil-works/pi-ai`), which turns "do not
 *   think" into "think a little". Refusing before the spawn is the only place
 *   this application can stop that.
 */

import {
  PROVIDER_DEFAULT_THINKING,
  type EffortLevel,
  type ThinkingLevel,
} from '../../core/types.js'
import { CONFIGURED_PROVIDER_PREFIX } from './provider-settings.js'
import { ProviderError } from './provider-error.js'
import { documentedEffortLevels } from './documented-effort-support.js'

export interface ModelEffortSupport {
  readonly provider: string
  readonly model: string
  readonly levels: readonly EffortLevel[]
  readonly defaultLevel?: EffortLevel
}

export type EffortDecision =
  /** Send this level, in whatever form the adapter writes it. */
  | { readonly kind: 'send'; readonly level: EffortLevel }
  /** Send no effort setting, and say why when a person asks. */
  | { readonly kind: 'omit'; readonly because: 'provider-default' | 'not-carried' }
  /** Do not dispatch. The message names the level and what the pair accepts. */
  | { readonly kind: 'refuse'; readonly message: string }

/**
 * The three levels every agent file could already write.
 *
 * They keep working everywhere, including on the adapters that have nowhere to
 * put them, because they have always run there — widening the vocabulary must
 * not retire an agent that was working yesterday.
 */
export const LEGACY_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high']

/**
 * What each adapter can express when the vendor publishes no per-model range.
 *
 * Conservative on purpose. Where a CLI's own `--help` states the values it
 * parses, that set is here, because the binary refusing an unknown value is a
 * fact about the binary. Where nothing is established, the entry is the three
 * legacy levels and nothing more: inventing a range for a provider nobody has
 * described would be the silent guess this module exists to remove.
 */
const ADAPTER_EXPRESSIBLE_LEVELS: Readonly<Record<string, readonly EffortLevel[]>> = {
  // `claude --help` (2.1.278): "Effort level for the current session
  // (low, medium, high, xhigh, max)". The binary refuses anything else, so
  // this is a fact about the executable rather than a guess.
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  // `pi --help`, on both the CLI on PATH (0.80.6) and the bundled runtime the
  // desktop application actually executes (0.84.1): "off, minimal, low,
  // medium, high, xhigh, max".
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  // `model_reasoning_effort` is a free-form configuration value, so the CLI
  // itself does not bound it. These are the levels `codex debug models` has
  // been observed to publish; the per-model range comes from that same payload
  // whenever the catalogue has been built.
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  // `providers/kimi-cli.ts` writes a thinking flag or its negation, so `off` is
  // expressible and nothing between is.
  'kimi-cli': ['off', 'low', 'medium', 'high'],
  // developers.openai.com/api/docs/guides/reasoning lists these, with support
  // varying by model — which is what a published per-model range is for.
  openai: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  // `providers/anthropic.ts` still expresses depth as a thinking budget, and
  // that table has three entries plus zero. Moving it to
  // `output_config.effort` is a separate migration; until then the levels above
  // `high` are refused here rather than silently dropped on the floor.
  anthropic: ['off', 'low', 'medium', 'high'],
  // An OpenAI-compatible body this application writes, so the field fits.
  openrouter: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
}

/**
 * Providers whose expressible set above is a statement about the adapter.
 *
 * For anything not named here the fallback is the three legacy levels, which
 * is a statement about this application's ignorance instead — so a published
 * range is taken whole rather than being narrowed to it.
 */
const PROVIDERS_WITH_KNOWN_GRAMMAR: ReadonlySet<string> = new Set(
  Object.keys(ADAPTER_EXPRESSIBLE_LEVELS),
)

/**
 * Adapters with nowhere to put the setting.
 *
 * Not the same as "unknown range". These read `options.thinking` nowhere at
 * all, so a level cannot travel however well the vendor supports it.
 */
const ADAPTERS_THAT_CANNOT_CARRY: ReadonlySet<string> = new Set([
  'gemini',
  'qwen',
  'lm-studio',
  'xai',
  'deepseek',
  'kimi',
])

let runtimeSupport: ReadonlyMap<string, ModelEffortSupport> = new Map()

function key(provider: string, model: string): string {
  return `${provider.trim()}\u0000${model.trim()}`
}

/**
 * Publish what the providers said, for the layers that cannot ask them.
 *
 * The catalogue is built in `services/provider-settings-service.ts`, several
 * layers above the adapters that need the answer. This follows the pattern
 * `domains/provider/default-model-selection.ts` already uses for the
 * application default: the service states it once, and everything below reads
 * it without reaching upwards.
 */
export function setRuntimeEffortSupport(
  entries: readonly ModelEffortSupport[],
): void {
  const next = new Map<string, ModelEffortSupport>()
  for (const entry of entries) {
    if (entry.levels.length === 0) continue
    next.set(key(entry.provider, entry.model), entry)
  }
  runtimeSupport = next
}

export function clearRuntimeEffortSupport(): void {
  runtimeSupport = new Map()
}

/** What a pair publishes, or nothing when it publishes nothing. */
export function publishedEffortSupport(
  provider: string,
  model: string | undefined,
): ModelEffortSupport | undefined {
  if (!model) return undefined
  return runtimeSupport.get(key(provider, model))
}

function adapterLevels(provider: string): {
  readonly levels: readonly EffortLevel[]
  readonly grammarKnown: boolean
} {
  const name = provider.trim()
  if (name.startsWith(CONFIGURED_PROVIDER_PREFIX)) {
    // A configured connection speaks an OpenAI-compatible body, so the field
    // fits whatever the connection is. Which levels the model behind it
    // accepts is the catalogue's answer, not ours.
    return { levels: LEGACY_EFFORT_LEVELS, grammarKnown: false }
  }
  const levels = ADAPTER_EXPRESSIBLE_LEVELS[name]
  return levels
    ? { levels, grammarKnown: PROVIDERS_WITH_KNOWN_GRAMMAR.has(name) }
    : { levels: LEGACY_EFFORT_LEVELS, grammarKnown: false }
}

function carries(provider: string): boolean {
  return !ADAPTERS_THAT_CANNOT_CARRY.has(provider.trim())
}

/** Every level a person may choose for this pair, for a menu to offer. */
export function effortLevelsFor(params: {
  readonly provider: string
  readonly model?: string
  /**
   * What the executable itself reports for this model, where an adapter can
   * ask it directly.
   *
   * Takes precedence over the catalogue registry, and works when the registry
   * is empty — which it is in any process that has not built a provider
   * catalogue, such as a freshly started worker. Pi is the case that needs it:
   * its runtime answers an unsupported level by choosing another one, so a
   * cold process that assumed support would turn `off` into thinking.
   */
  readonly supported?: readonly EffortLevel[]
}): readonly EffortLevel[] {
  const adapter = adapterLevels(params.provider)
  if (params.supported) {
    return adapter.grammarKnown
      ? params.supported.filter((level) => adapter.levels.includes(level))
      : params.supported
  }
  const published = publishedEffortSupport(params.provider, params.model)
  if (!published) return adapter.levels
  // The published set is what the vendor accepts; the adapter set is what this
  // application can write. A level needs both — unless the adapter set is the
  // legacy fallback, which says only that nobody has described this adapter.
  if (!adapter.grammarKnown) return published.levels
  return published.levels.filter((level) => adapter.levels.includes(level))
}

function describe(levels: readonly EffortLevel[]): string {
  return levels.length > 0 ? levels.join(', ') : 'none'
}

/**
 * What this turn should do with the level it was given.
 *
 * Pure, and callable from an adapter: the decision has to be made before a
 * process is spawned or a request is sent, because afterwards the only
 * remaining options are a vendor error or a silent substitution.
 */
export function resolveEffort(params: {
  readonly provider: string
  readonly model?: string
  readonly requested: ThinkingLevel
  readonly supported?: readonly EffortLevel[]
}): EffortDecision {
  if (params.requested === PROVIDER_DEFAULT_THINKING) {
    return { kind: 'omit', because: 'provider-default' }
  }
  const requested = params.requested

  if (!carries(params.provider)) {
    // Kept running, because it always has. The setting is not applied and the
    // caller is told which of the two happened.
    if (LEGACY_EFFORT_LEVELS.includes(requested)) {
      return { kind: 'omit', because: 'not-carried' }
    }
    return {
      kind: 'refuse',
      message:
        `Effort '${requested}' cannot be applied: the '${params.provider}' ` +
        'adapter has nowhere to put an effort setting. ' +
        `Choose one of ${describe(LEGACY_EFFORT_LEVELS)}, or the provider default.`,
    }
  }

  const levels = effortLevelsFor({
    provider: params.provider,
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.supported === undefined ? {} : { supported: params.supported }),
  })
  if (levels.includes(requested)) return { kind: 'send', level: requested }

  const published = params.supported ?? publishedEffortSupport(params.provider, params.model)
  const origin = published
    ? `'${params.model}' on '${params.provider}' reports that it accepts`
    : `'${params.provider}' can send`
  return {
    kind: 'refuse',
    message:
      `Effort '${requested}' is not available here. ${origin} ${describe(levels)}. ` +
      'Choose one of those, or the provider default.',
  }
}

/**
 * The level this adapter should write, or nothing when it should write none.
 *
 * Throws before the adapter does any work when the pair cannot honour the
 * choice. That timing is the point: after a process is spawned or a request is
 * sent, the only remaining options are a vendor error nobody asked for or a
 * substitution nobody sees.
 */
export function effortForTurn(params: {
  readonly provider: string
  readonly model?: string
  readonly requested: ThinkingLevel
  readonly supported?: readonly EffortLevel[]
}): EffortLevel | undefined {
  const decision = resolveEffort(params)
  if (decision.kind === 'send') return decision.level
  if (decision.kind === 'omit') return undefined
  throw new ProviderError({
    provider: params.provider,
    message: decision.message,
    kind: 'configuration',
    retryable: false,
    dispatched: false,
  })
}

/**
 * How an OpenAI-compatible body spells a level.
 *
 * Only `off` differs: that wire format calls it `none`. Everything else is the
 * same word, and translating it twice would be a place for the two spellings
 * to drift apart.
 */
export function openAiEffortValue(level: EffortLevel): string {
  return level === 'off' ? 'none' : level
}

/**
 * The levels a menu may offer for this pair.
 *
 * Narrower than `effortLevelsFor`, and deliberately so. Dispatch has to keep
 * running the levels agent files already contain, including on pairs nobody
 * has described; a menu that offered those same levels would be inviting a
 * choice nothing has established. Where no range is known, the only honest
 * offers are the application default and the provider's own default, which is
 * what an empty list means here.
 */
export function offerableEffortLevels(params: {
  readonly provider: string
  readonly model?: string
  readonly supported?: readonly EffortLevel[]
}): readonly EffortLevel[] {
  if (params.supported) return effortLevelsFor(params)
  const published = publishedEffortSupport(params.provider, params.model)
  if (published) return effortLevelsFor(params)
  // Nothing published. Two of this application's providers never publish —
  // Claude Code prints no per-model list, and the OpenAI API describes none in
  // any response made here — so their documented ranges stand in, transcribed
  // with their source in `documented-effort-support.ts`. A pair neither
  // publishes nor documents still offers nothing.
  return documentedEffortLevels(params.provider, params.model)
}

/**
 * What to do when a level meets an older setting that suppresses the field.
 *
 * `reasoning: false` predates this vocabulary and means "send no reasoning
 * field". A level says something else, and the two can disagree:
 *
 * - **`off` wins.** Omitting the field does not turn thinking off; it lets the
 *   vendor choose, and a reasoning model chooses to think. Sending the level is
 *   the only spelling that produces what was asked for.
 * - **A widened level conflicts.** `minimal`, `xhigh`, `max` and `ultra` can
 *   only have been chosen deliberately, from a menu that offered them. Dropping
 *   one silently is the failure this whole feature exists to remove, and no
 *   substitution is available, so the turn stops and names both settings.
 * - **The three legacy levels stay suppressed.** They are what every agent file
 *   has always carried — including by default — so honouring them here would
 *   change how existing agents run without anyone editing them. The carve-out
 *   is deliberate and stated rather than silent.
 */
export type SuppressedEffortOutcome = 'send' | 'omit' | 'conflict'

export function effortUnderReasoningSuppressor(
  level: EffortLevel,
): SuppressedEffortOutcome {
  if (level === 'off') return 'send'
  return LEGACY_EFFORT_LEVELS.includes(level) ? 'omit' : 'conflict'
}

export function suppressedEffortConflictMessage(
  provider: string,
  level: EffortLevel,
): string {
  return (
    `Effort '${level}' cannot be applied on '${provider}' while ` +
    "'provider_options.reasoning' is false: that setting sends no reasoning " +
    'field at all. Remove the setting, or choose the provider default, which ' +
    'is the way to ask for no effort setting.'
  )
}
