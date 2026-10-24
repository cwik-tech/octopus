/**
 * Effort ranges for pairs a vendor documents but does not publish over the
 * wire.
 *
 * Two of this application's providers answer for themselves: `codex debug
 * models` reports `supported_reasoning_levels` per model, and an
 * OpenAI-compatible `/models` listing carries a `reasoning` block. Two do not.
 * Claude Code prints no per-model list, and the OpenAI API does not describe
 * its models' effort support in any response this application makes. For those,
 * an Agent had a fully documented range and an empty menu.
 *
 * So the vendor's documentation is transcribed here, with its source and the
 * date it was read, and nothing else is. This is not a statement about what a
 * CLI flag or a request body will *accept* — `domains/provider/effort-support.ts`
 * answers that, and it is deliberately more permissive so that Agent files
 * written before any of this keep running. This table decides only what a menu
 * may offer, which is why a model the vendor does not list offers nothing at
 * all rather than the levels its sibling models take.
 *
 * Sources, read 20 September 2026:
 *
 * - Claude Code: `https://code.claude.com/docs/en/model-config#adjust-effort-level`.
 *   "Fable 5.1 and Fable 5", "Opus 5, Sonnet 5, Opus 4.8, and Opus 4.7" take
 *   `low, medium, high, xhigh, max`; "Opus 4.6 and Sonnet 4.6" take
 *   `low, medium, high, max`; and "Models not listed in the table above do not
 *   support effort levels."
 * - OpenAI native API: `https://developers.openai.com/api/docs/models` and the
 *   per-model page `.../models/gpt-5.6-sol`. GPT-5.6 Sol, Terra and Luna take
 *   `none, low, medium, high, xhigh, max` with `medium` as the default; GPT-6
 *   Astra takes `low, medium, high, xhigh, max`.
 *
 * `none` is the vendor's word for our `off`. `ultracode` on the Claude Code
 * page is a Claude Code setting rather than an effort level, and is not one of
 * ours.
 */

import type { EffortLevel } from '../../core/types.js'

/** The five levels the current Claude and GPT flagships share. */
const FULL_RANGE: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Claude Opus 4.6 and Sonnet 4.6: `max` without `xhigh`. */
const MAX_WITHOUT_XHIGH: readonly EffortLevel[] = ['low', 'medium', 'high', 'max']

/** The GPT-5.6 family, which can also be asked not to reason at all. */
const FULL_RANGE_WITH_OFF: readonly EffortLevel[] = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/**
 * Canonical model ids, per vendor documentation.
 *
 * Keyed by the id a person would write. Aliases are resolved first, so this
 * table never has to repeat itself.
 */
const CLAUDE_CODE_MODELS: Readonly<Record<string, readonly EffortLevel[]>> = {
  'claude-fable-5-1': FULL_RANGE,
  'claude-fable-5': FULL_RANGE,
  'claude-opus-5': FULL_RANGE,
  'claude-sonnet-5': FULL_RANGE,
  'claude-opus-4-8': FULL_RANGE,
  'claude-opus-4-7': FULL_RANGE,
  'claude-opus-4-6': MAX_WITHOUT_XHIGH,
  'claude-sonnet-4-6': MAX_WITHOUT_XHIGH,
}

/**
 * What this application's Claude Code aliases actually select.
 *
 * `domains/provider/cli-models.ts` offers these four names and labels them with
 * the model each one runs, so the range has to follow the label rather than the
 * word: `opus` is Claude Opus 4.8 today, not "whatever Opus means".
 */
const CLAUDE_CODE_ALIASES: Readonly<Record<string, string>> = {
  opus: 'claude-opus-4-8',
  fable: 'claude-fable-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
}

const OPENAI_NATIVE_MODELS: Readonly<Record<string, readonly EffortLevel[]>> = {
  'gpt-6-astra': FULL_RANGE,
  'gpt-5.6-sol': FULL_RANGE_WITH_OFF,
  'gpt-5.6-terra': FULL_RANGE_WITH_OFF,
  'gpt-5.6-luna': FULL_RANGE_WITH_OFF,
}

/**
 * Names the vendor documents as routing to one of the models above.
 *
 * The GPT-5.6 Sol page states that `gpt-5.6` routes to Sol, so a persona naming
 * the family is naming Sol. Only names a page actually states are here; a
 * family name nobody documents is not assumed to route anywhere.
 */
const OPENAI_NATIVE_ALIASES: Readonly<Record<string, string>> = {
  'gpt-5.6': 'gpt-5.6-sol',
}

/**
 * Exact ids only.
 *
 * An earlier version also accepted a dated suffix, on the theory that
 * `<model>-20260101` is the same model. That was a guess in two ways: it
 * assumed such a snapshot exists, and it answered for ids the capability list
 * never published — and the editor matches that list exactly, so the lookup
 * recognised names the menu could never show. Everything answered for here is
 * something `documentedEffortCapabilities` also emits.
 */
function lookup(
  table: Readonly<Record<string, readonly EffortLevel[]>>,
  model: string,
): readonly EffortLevel[] {
  return Object.prototype.hasOwnProperty.call(table, model)
    ? table[model] ?? []
    : []
}

/**
 * What the vendor's own documentation says this pair accepts.
 *
 * Empty when the vendor has not described it, which a menu shows as no levels
 * rather than as a guess.
 */
export function documentedEffortLevels(
  provider: string,
  model: string | undefined,
): readonly EffortLevel[] {
  if (!model) return []
  const name = provider.trim()
  const id = model.trim()
  if (name === 'claude') {
    const resolved = Object.prototype.hasOwnProperty.call(CLAUDE_CODE_ALIASES, id)
      ? CLAUDE_CODE_ALIASES[id] ?? id
      : id
    return lookup(CLAUDE_CODE_MODELS, resolved)
  }
  if (name === 'openai') {
    const resolved = Object.prototype.hasOwnProperty.call(OPENAI_NATIVE_ALIASES, id)
      ? OPENAI_NATIVE_ALIASES[id] ?? id
      : id
    return lookup(OPENAI_NATIVE_MODELS, resolved)
  }
  // Codex publishes its own range per model through `codex debug models`, and
  // that route's levels are not this one's. Anthropic's direct adapter still
  // expresses depth as a thinking budget, so its menu comes from what that
  // adapter can express rather than from the effort documentation.
  return []
}

/** Every pair this table describes, for a snapshot to carry to the editor. */
export function documentedEffortCapabilities(): readonly {
  readonly provider: string
  readonly model: string
  readonly levels: readonly EffortLevel[]
}[] {
  const entries: { provider: string; model: string; levels: readonly EffortLevel[] }[] = []
  for (const [model, levels] of Object.entries(CLAUDE_CODE_MODELS)) {
    entries.push({ provider: 'claude', model, levels })
  }
  for (const [alias, canonical] of Object.entries(CLAUDE_CODE_ALIASES)) {
    const levels = lookup(CLAUDE_CODE_MODELS, canonical)
    if (levels.length > 0) entries.push({ provider: 'claude', model: alias, levels })
  }
  for (const [model, levels] of Object.entries(OPENAI_NATIVE_MODELS)) {
    entries.push({ provider: 'openai', model, levels })
  }
  for (const [alias, canonical] of Object.entries(OPENAI_NATIVE_ALIASES)) {
    const levels = lookup(OPENAI_NATIVE_MODELS, canonical)
    if (levels.length > 0) entries.push({ provider: 'openai', model: alias, levels })
  }
  return entries
}

/**
 * The vendor whose documentation applies to a configured connection.
 *
 * A connection is identified by its own id, not by a provider name, so nothing
 * about `connection:<uuid>` says whose models it serves. Its endpoint does: a
 * connection pointed at the vendor's own API host is talking to that vendor,
 * and the vendor's documented ranges are as true there as they are on the
 * built-in adapter.
 *
 * Only the official host counts. An OpenAI-compatible server is a server that
 * speaks the same protocol, which says nothing about which models it runs or
 * what they accept — lending it OpenAI's ranges because it answers the same
 * shapes would be a claim about somebody else's machine.
 */
const DOCUMENTED_VENDOR_HOSTNAMES: Readonly<Record<string, string>> = {
  'api.openai.com': 'openai',
}

export function documentedVendorForBaseUrl(
  baseUrl: string | undefined,
): string | undefined {
  if (!baseUrl) return undefined
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  const host = url.hostname.toLowerCase()
  return Object.prototype.hasOwnProperty.call(DOCUMENTED_VENDOR_HOSTNAMES, host)
    ? DOCUMENTED_VENDOR_HOSTNAMES[host]
    : undefined
}
