/**
 * Effort ranges, read from what providers already tell this application.
 *
 * Two calls this application makes anyway carry the answer, and both used to
 * throw it away: `codex debug models`, which publishes
 * `supported_reasoning_levels` per model, and an OpenAI-compatible `/models`
 * listing, which on OpenRouter carries a `reasoning` block per model. Reading
 * them is what lets a menu offer the range a model actually has instead of the
 * three levels this application used to assume everywhere.
 *
 * Absence is preserved rather than filled in. A listing that says nothing
 * returns nothing, and a model that merely accepts a `reasoning_effort`
 * parameter has told us it takes the setting, not which values it takes.
 */

import { THINKING_LEVELS, type EffortLevel } from '../../core/types.js'

export interface PublishedEffort {
  /** The levels the provider named, in its own order. */
  levels?: EffortLevel[]
  /** The level it says it uses when a request names none. */
  defaultLevel?: EffortLevel
}

/**
 * The vendor spelling of "do not think" is `none`; ours is `off`.
 *
 * One name for one state, chosen because `off` is what the Pi CLI and the Kimi
 * CLI call it, and translated back at each adapter that needs the other word.
 */
const VENDOR_LEVEL_ALIASES: Readonly<Record<string, EffortLevel>> = {
  none: 'off',
  disabled: 'off',
}

export function effortLevel(value: unknown): EffortLevel | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  const aliased = VENDOR_LEVEL_ALIASES[trimmed]
  if (aliased) return aliased
  return (THINKING_LEVELS as readonly string[]).includes(trimmed)
    ? (trimmed as EffortLevel)
    : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Levels from a list of names, in order, without repeats. */
export function effortLevelList(value: unknown): EffortLevel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const levels: EffortLevel[] = []
  for (const entry of value) {
    const level = effortLevel(entry)
    if (level && !levels.includes(level)) levels.push(level)
  }
  return levels.length > 0 ? levels : undefined
}

/**
 * What one entry of a `/models` listing says about effort.
 *
 * `mandatory` is honoured by removing `off` rather than by carrying a separate
 * flag: a model that may not stop thinking is exactly a model whose accepted
 * levels do not include `off`, and one representation cannot then disagree
 * with the other.
 */
export function readPublishedEffort(model: unknown): PublishedEffort {
  const record = asRecord(model)
  const reasoning = asRecord(record?.reasoning)
  if (!reasoning) return {}
  const levels = effortLevelList(
    reasoning.supported_efforts ?? reasoning.supportedEfforts,
  )
  const defaultLevel = effortLevel(
    reasoning.default_effort ?? reasoning.defaultEffort,
  )
  const mandatory = reasoning.mandatory === true
  const usable = mandatory ? levels?.filter((level) => level !== 'off') : levels
  return {
    ...(usable && usable.length > 0 ? { levels: usable } : {}),
    ...(defaultLevel && !(mandatory && defaultLevel === 'off')
      ? { defaultLevel }
      : {}),
  }
}
