/**
 * Provider domain — how much a given model can actually read.
 *
 * The number every context decision in this system needs, and the one nothing
 * asked for. `ProviderModelInfo.contextLength` has been populated for a long
 * time and read by exactly two React components, to render a label. No prompt
 * builder, no engine and no dispatch path has ever consulted it. Every one of
 * the catalogued context limits is, in effect, a guess standing in for this
 * function.
 *
 * **Why a checked-in table rather than the catalog alone.** The catalog cannot
 * answer for the routes that carry most of the traffic. `contextLength` is
 * populated only for two hardcoded CLI aliases, the codex and pi CLI catalogs,
 * and the four connection kinds (`openrouter`, `openai-compatible`, `ollama`,
 * `lm-studio`). The first-party HTTP routes in `model-client.ts` — anthropic,
 * openai, deepseek, xai, kimi — are hardcoded URLs with no catalog behind them,
 * and `claude/fable`, `claude/haiku` and the gemini aliases carry no window
 * either. A resolver that trusted the catalog would return "assumed" on the
 * single most important route, and an admission check built on that would be
 * refusing turns on a guess.
 *
 * So the table is the floor of coverage. It is not a claim to know better than
 * the running system, which is why a live catalog value overrides it and a
 * number the provider itself stated overrides both.
 *
 * **Precedence**, most to least authoritative:
 *
 * 1. `provider-error` — the provider told us its own limit while refusing a
 *    request. Ground truth; nothing beats being told.
 * 2. `catalog` — the connection reported a window for the model actually
 *    chosen. Live and model-specific.
 * 3. `table` — checked in here, per route, with a per-model row where the
 *    routes differ meaningfully.
 * 4. `assumed` — nothing knew. This source may never refuse a turn.
 *
 * **Why the source travels with the number.** Today nothing outside Deep
 * Research refuses a request; every other path degrades silently. Turning an
 * assumed window into a hard pre-dispatch refusal would be a new user-visible
 * failure resting on two guesses at once — an unknown window and a byte-ratio
 * token estimate. A caller that wants to refuse has to ask
 * `contextWindowMayRefuse` first, and on an assumed window it must trim and
 * record instead.
 *
 * The table's values are transcribed from each vendor's published figures. They
 * are not imported from any package: the model catalog shipped inside `pi-ai`
 * is not resolvable from this repository's root, so there is nothing to read.
 * A row is added only for a route or model whose provider does not report a
 * window itself.
 */

import { contextLimit } from '../../core/context-limits.js'
import { CONFIGURED_PROVIDER_PREFIX } from './provider-settings.js'

/** Where a resolved window came from, and therefore how much it may be trusted. */
export type ContextWindowSource = 'provider-error' | 'catalog' | 'table' | 'assumed'

export interface ResolvedContextWindow {
  /** The model's total context window, in tokens. */
  readonly tokens: number
  /** The most the route will accept as an answer, where it states one. */
  readonly maxOutputTokens?: number
  readonly source: ContextWindowSource
}

interface ModelRow {
  readonly tokens: number
  /** The lowest model generation this window applies to. */
  readonly minGeneration?: number
}

interface ContextWindowEntry {
  /** Used for any model this route serves that has no row of its own. */
  readonly defaultTokens: number
  /** The route's answer ceiling, where it publishes one. */
  readonly maxOutputTokens?: number
  /**
   * Windows for specific models, where they differ from the route default.
   *
   * A row may require a minimum generation. Model families keep their names
   * across generations while their windows change — `claude-3-5-sonnet` holds
   * 200k where `claude-sonnet-5` holds a million — so matching on the family
   * alone hands an old model the newest window. That is an over-promise, and
   * over-promising is the one direction this module must not fail in: it sends
   * a request the provider refuses outright, where under-promising only trims
   * a prompt that would have fitted.
   *
   * A model id with no generation in it is a bare alias naming whatever is
   * current, so it keeps the row.
   */
  readonly models?: Readonly<Record<string, number | ModelRow>>
}

/**
 * A window per route, and per model where a route serves several sizes.
 *
 * Conservative by design. Where a route serves a range of models and we cannot
 * know which, the default is the smaller plausible window: under-promising
 * trims a prompt that would have fitted, while over-promising sends a request
 * the provider refuses outright.
 */
export const CONTEXT_WINDOW_TABLE: Readonly<Record<string, ContextWindowEntry>> = {
  // Claude models via the direct Messages API. The 1M-token windows are the
  // same figures cli-models.ts already hardcodes for the CLI aliases.
  anthropic: {
    defaultTokens: 200_000,
    maxOutputTokens: 64_000,
    models: {
      opus: { tokens: 1_000_000, minGeneration: 4 },
      sonnet: { tokens: 1_000_000, minGeneration: 4 },
      fable: { tokens: 1_000_000, minGeneration: 4 },
      haiku: 200_000,
    },
  },
  // The Claude CLI. Same models, same windows, different transport.
  claude: {
    defaultTokens: 200_000,
    maxOutputTokens: 64_000,
    models: {
      opus: { tokens: 1_000_000, minGeneration: 4 },
      sonnet: { tokens: 1_000_000, minGeneration: 4 },
      fable: { tokens: 1_000_000, minGeneration: 4 },
      haiku: 200_000,
    },
  },
  openai: { defaultTokens: 128_000, maxOutputTokens: 32_000 },
  // The codex CLI reports its own window through parseCodexModelCatalog, so
  // this is only the floor for a model the catalog did not describe.
  codex: { defaultTokens: 200_000, maxOutputTokens: 32_000 },
  // The repo's host provider names, which is what `normalizeRepoHostProvider`
  // rewrites 'anthropic', 'openai' and 'codex' into before dispatch. A table
  // keyed only on the short names would never match a real speaker.
  'anthropic-api': {
    defaultTokens: 200_000,
    maxOutputTokens: 64_000,
    models: {
      opus: { tokens: 1_000_000, minGeneration: 4 },
      sonnet: { tokens: 1_000_000, minGeneration: 4 },
      fable: { tokens: 1_000_000, minGeneration: 4 },
      haiku: 200_000,
    },
  },
  // The team runtime already hardcodes exactly these two numbers for its
  // OpenAI host model (team-runtime/index.ts). Recorded here so there is one
  // place to correct rather than two.
  'openai-responses-api': { defaultTokens: 400_000, maxOutputTokens: 32_768 },
  'openai-codex': { defaultTokens: 200_000, maxOutputTokens: 32_000 },
  openrouter: { defaultTokens: 128_000, maxOutputTokens: 32_000 },
  deepseek: { defaultTokens: 128_000, maxOutputTokens: 8_000 },
  xai: { defaultTokens: 128_000, maxOutputTokens: 32_000 },
  kimi: { defaultTokens: 200_000, maxOutputTokens: 32_000 },
  'kimi-cli': { defaultTokens: 200_000, maxOutputTokens: 32_000 },
  qwen: { defaultTokens: 128_000, maxOutputTokens: 32_000 },
  gemini: {
    defaultTokens: 1_000_000,
    maxOutputTokens: 64_000,
    models: { 'flash-lite': 1_000_000, flash: 1_000_000, pro: 1_000_000 },
  },
  // Locally hosted models, which range from tiny to very large. Deliberately
  // the smallest default in the table: these are the only routes where
  // over-promising means an overflow the user cannot do anything about.
  'lm-studio': { defaultTokens: 32_000, maxOutputTokens: 8_000 },
  ollama: { defaultTokens: 32_000, maxOutputTokens: 8_000 },
  // Connections report their own windows; these are the floors.
  'openai-compatible': { defaultTokens: 128_000, maxOutputTokens: 32_000 },
  // Pi carries its own catalog and manages its own context internally.
  pi: { defaultTokens: 200_000, maxOutputTokens: 32_000 },
}

/**
 * The smallest window worth believing from a catalog.
 *
 * A connection that reports a handful of tokens is misconfigured or is
 * reporting something other than a context window. Trusting it would refuse
 * every turn on that route.
 */
const MINIMUM_CREDIBLE_WINDOW_TOKENS = 1_024

export function resolveContextWindow(input: {
  readonly provider: string
  readonly model: string
  /**
   * For a `connection:<id>` provider, the kind of connection it routes to.
   *
   * The id says nothing about the model behind it, and without this every
   * connection-routed speaker resolved to the assumed window — which may never
   * refuse, so admission was silently off for that whole route.
   */
  readonly connectionKind?: string | undefined
  /** `ProviderModelInfo.contextLength`, where the running system reported one. */
  readonly catalogContextLength?: number | undefined
  /** A limit the provider stated while refusing an earlier request. */
  readonly learnedContextLength?: number | undefined
  /** A route's answer ceiling, where the caller knows better than the table. */
  readonly catalogMaxOutputTokens?: number | undefined
}): ResolvedContextWindow {
  const entry = CONTEXT_WINDOW_TABLE[resolveTableKey(input.provider, input.connectionKind)]
  const maxOutputTokens = credible(input.catalogMaxOutputTokens, 1)
    ?? entry?.maxOutputTokens

  const learned = credible(input.learnedContextLength)
  if (learned !== undefined) {
    return withCeiling({ tokens: learned, source: 'provider-error' }, maxOutputTokens)
  }

  const catalog = credible(input.catalogContextLength)
  if (catalog !== undefined) {
    return withCeiling({ tokens: catalog, source: 'catalog' }, maxOutputTokens)
  }

  if (entry) {
    const tokens = matchModelRow(entry, input.model) ?? entry.defaultTokens
    return withCeiling({ tokens, source: 'table' }, maxOutputTokens)
  }

  return withCeiling(
    { tokens: contextLimit('window.assumedTokens'), source: 'assumed' },
    maxOutputTokens,
  )
}

/**
 * Whether a window resolved this way may end a turn before it is dispatched.
 *
 * False for an assumed window. A caller holding one must trim to it and record
 * what it cut, never refuse: the cost of trimming a prompt that would have fit
 * is a slightly shorter answer, while the cost of refusing a turn that would
 * have succeeded is the product not working.
 */
export function contextWindowMayRefuse(source: ContextWindowSource): boolean {
  return source !== 'assumed'
}

/**
 * Which table row a provider name means.
 *
 * A configured connection arrives as `connection:<id>`. The id is not a
 * provider, so it resolves to the connection's kind where the caller knows it.
 *
 * Where the caller does not, it resolves to the **smallest** window any
 * connection kind claims, not the generic one. A connection is as likely to be
 * a local model as a hosted endpoint, and the two differ by four times; guessing
 * the larger over-promises exactly the users who cannot absorb it, because a
 * local model that overflows fails outright while a hosted one merely receives
 * a shorter prompt than it could have read.
 */
function resolveTableKey(provider: string, connectionKind: string | undefined): string {
  if (!provider.startsWith(CONFIGURED_PROVIDER_PREFIX)) return provider
  if (connectionKind && Object.hasOwn(CONTEXT_WINDOW_TABLE, connectionKind)) {
    return connectionKind
  }
  return smallestConnectionKind()
}

/**
 * Every kind a `connection:<id>` provider can route to.
 *
 * Mirrors `ProviderConnectionKind`. Listed here rather than imported because
 * this module sits below the settings layer that owns that type; the unit test
 * pins the two together.
 */
export const CONNECTION_KINDS = [
  'openrouter',
  'openai-compatible',
  'ollama',
  'lm-studio',
] as const

/**
 * The connection kind with the least room, used when the kind is unknown.
 *
 * Computed rather than named, so a kind added later with a smaller window
 * becomes the fallback automatically instead of silently breaking the
 * "smallest" this function promises.
 */
function smallestConnectionKind(): string {
  let smallest: string = CONNECTION_KINDS[0]
  for (const kind of CONNECTION_KINDS) {
    const entry = CONTEXT_WINDOW_TABLE[kind]
    const current = CONTEXT_WINDOW_TABLE[smallest]
    if (entry && current && entry.defaultTokens < current.defaultTokens) {
      smallest = kind
    }
  }
  return smallest
}

/**
 * The window for a specific model, where the route publishes several sizes.
 *
 * Matched on a name segment rather than the whole string, because the table is
 * keyed on the short names people say — `opus`, `sonnet` — while a configured
 * model is `claude-opus-4-6` or `claude-opus-4-1-20250805`. Exact matching made
 * every per-model row unreachable from real configuration, so a million-token
 * model was budgeted as a 200k one.
 *
 * Segment-bounded rather than a bare substring, so a short key cannot match the
 * middle of an unrelated word.
 */
function matchModelRow(entry: ContextWindowEntry, model: string): number | undefined {
  const models = entry.models
  if (!models) return undefined
  const exact = models[model]
  if (exact !== undefined) return rowTokens(exact, model)
  const segments = new Set(model.toLowerCase().split(/[-_./:\s]+/))
  for (const [key, row] of Object.entries(models)) {
    if (segments.has(key.toLowerCase())) return rowTokens(row, model)
  }
  return undefined
}

/** The row's window, or nothing when the id names an older generation. */
function rowTokens(row: number | ModelRow, model: string): number | undefined {
  if (typeof row === 'number') return row
  if (row.minGeneration === undefined) return row.tokens
  const generation = readModelGeneration(model)
  if (generation === undefined) return row.tokens
  return generation >= row.minGeneration ? row.tokens : undefined
}

/**
 * The generation number in a model id, if it states one.
 *
 * Only one- and two-digit segments count, which is what excludes the date
 * stamps these ids also carry: `claude-3-5-sonnet-20241022` reads as generation
 * 3, not as the year.
 */
function readModelGeneration(model: string): number | undefined {
  for (const segment of model.toLowerCase().split(/[-_./:\s]+/)) {
    if (/^\d{1,2}$/.test(segment)) return Number(segment)
  }
  return undefined
}

function credible(
  value: number | undefined,
  minimum = MINIMUM_CREDIBLE_WINDOW_TOKENS,
): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < minimum) return undefined
  return Math.floor(value)
}

function withCeiling(
  resolved: { tokens: number; source: ContextWindowSource },
  maxOutputTokens: number | undefined,
): ResolvedContextWindow {
  // A ceiling at or above the whole window is not a ceiling, and reserving that
  // much would leave nothing for the prompt it is meant to answer.
  const ceiling = maxOutputTokens !== undefined && maxOutputTokens < resolved.tokens
    ? maxOutputTokens
    : undefined
  return ceiling === undefined
    ? { tokens: resolved.tokens, source: resolved.source }
    : { tokens: resolved.tokens, source: resolved.source, maxOutputTokens: ceiling }
}
