/**
 * Which of an Agent's settings a given route would actually apply.
 *
 * Needed because §4.3 of the model-selection plan requires provider options to
 * be *re-evaluated* when a user approves running one attempt on the application
 * default, and forbids carrying incompatible ones from the failed Agent's
 * provider. Both halves have teeth. Carrying everything sends one vendor's
 * field to a vendor that has no such field; dropping everything discards
 * settings the new provider applies perfectly well, and does it silently, which
 * a person cannot tell apart from a provider that ignored them.
 *
 * Three things decide the answer, and leaving any of them out gives a wrong
 * one:
 *
 * - **The provider.** The adapters genuinely differ. `providers/openai.ts:87-113`
 *   goes through the Responses API with `max_output_tokens` and a reasoning
 *   flag and applies neither `temperature` nor `top_p`;
 *   `providers/configured-provider.ts:134-138` applies `max_tokens` and
 *   `temperature` and has neither of the others.
 * - **The route.** The same provider reached through the parent MCP tool loop
 *   carries none of an Agent's options. Its body is `model`, `messages`,
 *   `tools`, `tool_choice` and `stream`, plus the turn's resolved
 *   `reasoning_effort` when one is sent and `stream_options` on the streamed
 *   tool-free final request (`buildRequestBody` in
 *   `domains/provider/openai-chat-completions-tool-adapter.ts`). A question
 *   turn (managed, or one that may ask a person) is the exception:
 *   `services/mcp-agent-tool-service.ts` evaluates it as the `direct` route
 *   and sends the model parameters that survive. Calling a setting "kept" on
 *   this route would describe a request that never carries it.
 * - **The value.** An Agent file proves only that a setting is a scalar
 *   (`parsers/load-agent.ts:122-146`). The adapters read numbers through
 *   `numberConfig`, which ignores anything that is not a finite number — so
 *   `max_tokens: 'many'` is not a setting that survives, it is a setting that
 *   silently does nothing.
 *
 * What never travels, whatever the provider reads: anything naming *where* a
 * request goes, *who* it claims to be from, what raw body to merge into it, or
 * what a process may do. `base_url`, `extra_body` and `sandbox` are all real
 * options some adapter honours, and none of them describes how a model should
 * answer. Carrying one across a provider switch would move an endpoint, an
 * identity or a permission that the person approving a *model* never agreed to
 * — and the request is signed with this installation's own credentials.
 */

import { CONFIGURED_PROVIDER_PREFIX } from '../domains/provider/provider-settings.js'
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_MINIMUM_THINKING_BUDGET,
  ANTHROPIC_THINKING_BUDGETS,
} from './anthropic-thinking-defaults.js'

/** How the turn will reach the provider. */
export type ProviderDispatchRoute =
  /** One of the `providers/*.ts` adapters, which read `providerConfig`. */
  | 'direct'
  /** The parent MCP tool loop, whose request body carries no settings. */
  | 'mcp-tool-loop'

export interface ProviderOptionTarget {
  readonly provider: string
  readonly route: ProviderDispatchRoute
  /**
   * The turn's thinking level.
   *
   * Required, not optional. Anthropic fills in both a thinking budget and an
   * answer ceiling from it when the Agent writes neither, so whether an Agent's
   * explicit half still fits cannot be decided from the Agent's settings alone
   * — and an optional field would let a caller skip that check by omission
   * rather than by decision.
   */
  readonly thinking: string
}

export interface RetainedProviderOptions {
  /**
   * The settings that survive, or `undefined` when there were none to consider.
   *
   * "Nothing to re-evaluate" and "everything dropped" are different facts and
   * are reported differently, because only one of them is worth telling a
   * person about.
   */
  readonly kept: Record<string, unknown> | undefined
  /** Every setting that will not apply, by name, sorted. */
  readonly dropped: readonly string[]
}

type ValueCheck = (
  value: unknown,
  options: Readonly<Record<string, unknown>>,
  target: ProviderOptionTarget,
) => boolean

const finiteNumber: ValueCheck = (value) =>
  typeof value === 'number' && Number.isFinite(value)

const booleanFlag: ValueCheck = (value) => typeof value === 'boolean'

/**
 * A whole number above zero.
 *
 * `providers/kimi-cli.ts:135-137` passes `--max-steps-per-turn` only for one of
 * these, so anything else is dropped by the CLI itself — reporting it kept
 * would describe an argument the process never receives.
 */
const positiveInteger: ValueCheck = (value) =>
  // `Number.isSafeInteger`, matching `cliProviderConfig`'s own check
  // (`services/mcp-agent-tool-service.ts`): a value it would refuse is not a
  // setting that survived, whatever this function thinks of it.
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * Anthropic's own bound, stated where the setting is judged.
 *
 * The vendor refuses a budget below 1024, and a budget at or above the answer's
 * own ceiling leaves no room for an answer. `mapHelperProviderOptions`
 * (`domains/provider/model-client.ts:481-495`) already states the same rule for
 * helper calls; this is the dispatch side of it. The ceiling is only compared
 * where the Agent set one — the adapter otherwise picks a default from the
 * thinking level, which is not this function's to predict.
 */
/**
 * A budget the vendor will accept on its own terms.
 *
 * Zero is one of them, and it is not an absence. `providers/anthropic.ts:89-120`
 * resolves the setting with `??`, so a written 0 stays 0 rather than being
 * replaced by the level's default, and the adapter then omits the thinking
 * block entirely. Zero is how an Agent turns thinking off on this provider, and
 * dropping it would turn thinking back on — the opposite of what was asked for.
 *
 * Only the shape and the floor here. Whether a budget fits *under the ceiling*
 * is a question about the pair, and asking it per key gave the wrong answer: a
 * ceiling judged against a budget that was itself refused looks fine, and the
 * adapter then sends its own budget underneath it.
 */
const thinkingBudget: ValueCheck = (value) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  (value === 0 || value >= ANTHROPIC_MINIMUM_THINKING_BUDGET)

/**
 * A ceiling that allows an answer at all.
 *
 * Every one of these APIs refuses a request whose token ceiling is zero or
 * negative, so such a value is not a setting that survives a switch — it is one
 * that turns the attempt into an error.
 */
const tokenCeiling: ValueCheck = positiveInteger

/**
 * Drops overrides that cannot coexist with what the adapter fills in.
 *
 * Run over what survived the per-key checks, because that is what the request
 * will carry. Where the pair does not fit, the *explicit* setting is dropped
 * and named — never clamped to something the person did not write, and never
 * left in place to produce a request the vendor refuses. The budget goes first
 * as the more specialised override; if the ceiling still leaves the adapter's
 * own budget no room, the ceiling goes too.
 */
function dropIncoherentAnthropicPair(
  kept: Record<string, unknown>,
  target: ProviderOptionTarget,
): string[] {
  const implicitBudget = own(ANTHROPIC_THINKING_BUDGETS, target.thinking)
  const implicitCeiling = own(ANTHROPIC_DEFAULT_MAX_TOKENS, target.thinking)
  const dropped: string[] = []
  const written = (key: string): unknown =>
    // Presence, not truthiness. A written `0` is a value on both of these
    // settings, and treating it as absent would compare against a default the
    // Agent deliberately replaced.
    Object.prototype.hasOwnProperty.call(kept, key) ? kept[key] : undefined
  const fits = (): boolean => {
    const budget = Object.prototype.hasOwnProperty.call(kept, 'thinking_budget')
      ? kept.thinking_budget
      : implicitBudget
    const ceiling = Object.prototype.hasOwnProperty.call(kept, 'max_tokens')
      ? kept.max_tokens
      : implicitCeiling
    // An unrecognised thinking level leaves one half unknown, and an unknown
    // half cannot establish that the pair fits.
    if (typeof budget !== 'number' || typeof ceiling !== 'number') return false
    // Thinking off leaves no budget to fit under anything.
    return budget === 0 || budget < ceiling
  }
  for (const key of ['thinking_budget', 'max_tokens']) {
    if (fits()) return dropped
    if (written(key) === undefined) continue
    delete kept[key]
    dropped.push(key)
  }
  // Nothing explicit left to drop. The adapter's own defaults are consistent
  // with each other, so this is as far as re-evaluation can go.
  return dropped
}

/**
 * The behavioural settings each direct adapter reads, and how it reads them.
 *
 * Kept beside the adapters and named per provider rather than as one shared
 * list, because a shared list would be wrong for every provider in it.
 */
const DIRECT_BEHAVIOURAL_OPTIONS: Readonly<
  Record<string, Readonly<Record<string, ValueCheck>>>
> = {
  // providers/openai.ts:87-113
  openai: {
    max_output_tokens: tokenCeiling,
    max_tokens: tokenCeiling,
    reasoning: booleanFlag,
  },
  // providers/anthropic.ts:89-120
  anthropic: {
    max_tokens: tokenCeiling,
    temperature: finiteNumber,
    thinking_budget: thinkingBudget,
  },
  // providers/deepseek.ts and providers/kimi.ts share a shape.
  deepseek: {
    max_output_tokens: tokenCeiling,
    max_tokens: tokenCeiling,
    temperature: finiteNumber,
  },
  kimi: {
    max_output_tokens: tokenCeiling,
    max_tokens: tokenCeiling,
    temperature: finiteNumber,
  },
  // providers/lm-studio.ts and providers/openrouter.ts
  'lm-studio': {
    max_tokens: tokenCeiling,
    temperature: finiteNumber,
  },
  openrouter: {
    max_tokens: tokenCeiling,
    temperature: finiteNumber,
  },
  // providers/xai.ts:61-62,79-80
  xai: {
    max_tokens: tokenCeiling,
    temperature: finiteNumber,
  },
  // providers/kimi-cli.ts is a CLI host, and this is the one setting it reads.
  'kimi-cli': {
    max_steps_per_turn: positiveInteger,
  },
}

/**
 * Own-property lookup, which an allow-list has to be.
 *
 * A plain object answers for `toString` and `__proto__` as readily as for a key
 * somebody meant, and an Agent file may name either — the parser refuses
 * credentials and non-scalars, not inherited property names
 * (`parsers/load-agent.ts:122-146`). An index read would hand back an inherited
 * function and call the setting supported, or hand back something that is not a
 * function and throw. A closed list contains what was put in it and nothing
 * else.
 */
function own<T>(
  table: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined
}

/** providers/configured-provider.ts:134-138, for every configured connection. */
const CONFIGURED_CONNECTION_OPTIONS: Readonly<Record<string, ValueCheck>> = {
  max_tokens: tokenCeiling,
  temperature: finiteNumber,
}

function appliedOptions(
  target: ProviderOptionTarget,
): Readonly<Record<string, ValueCheck>> {
  // The MCP tool loop's request body has no place to put any of them.
  if (target.route === 'mcp-tool-loop') return {}
  const provider = target.provider.trim()
  if (provider.startsWith(CONFIGURED_PROVIDER_PREFIX)) {
    return CONFIGURED_CONNECTION_OPTIONS
  }
  // An unknown provider reads nothing, which is the safe answer: a setting that
  // does not travel shows up in `dropped`, while one invented for a provider
  // nobody has described would be a claim with nothing behind it.
  return own(DIRECT_BEHAVIOURAL_OPTIONS, provider) ?? {}
}

/**
 * Every behavioural setting any route can apply, across every provider.
 *
 * The closed set a request may name. It exists so a boundary that does not yet
 * know which provider will run — the worker turn contract, which is validated
 * before the pair is resolved — can still refuse a key that is not a
 * behavioural setting at all. Deciding whether a *particular* provider applies
 * one is still `retainCompatibleProviderOptions`; this only bounds the
 * vocabulary.
 */
export const BEHAVIOURAL_PROVIDER_OPTION_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(DIRECT_BEHAVIOURAL_OPTIONS).flatMap((entry) =>
    Object.keys(entry),
  ),
  ...Object.keys(CONFIGURED_CONNECTION_OPTIONS),
])

/** The behavioural settings this target applies, by name. */
export function behaviouralProviderOptions(
  target: ProviderOptionTarget,
): ReadonlySet<string> {
  return new Set(Object.keys(appliedOptions(target)))
}

/**
 * Re-evaluates an Agent's settings against the pair that will actually run.
 *
 * A setting survives only if this target reads it *and* the value is one the
 * adapter will use as intended. Everything else is dropped and named, so a
 * person can see that a setting stopped applying rather than wondering whether
 * the provider ignored it.
 */
export function retainCompatibleProviderOptions(
  target: ProviderOptionTarget,
  options: Readonly<Record<string, unknown>> | undefined,
): RetainedProviderOptions {
  if (options === undefined) return { kept: undefined, dropped: [] }
  const applied = appliedOptions(target)
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(options)) {
    const check = own(applied, key)
    if (check && check(value, options, target)) kept[key] = value
    else dropped.push(key)
  }
  if (target.route === 'direct' && target.provider.trim() === 'anthropic') {
    dropped.push(...dropIncoherentAnthropicPair(kept, target))
  }
  return { kept, dropped: dropped.sort() }
}
