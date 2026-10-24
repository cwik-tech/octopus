/**
 * The effort vocabulary, and the one place it is written down.
 *
 * A leaf contract on purpose. Every layer needs this list — the agent loader,
 * the request schemas, the provider adapters, and the editor that offers the
 * choice — and a list copied into each of them is a list that stops agreeing
 * with itself. The failure is quiet when it happens: one boundary accepts a
 * level, the next replaces it with a default, and the turn runs at a depth
 * nobody picked.
 *
 * The order is lowest to highest, and it is for presentation only. It is never
 * used to substitute one level for another, because the vendors do not agree on
 * a ladder: Anthropic documents models that accept `max` but not `xhigh`, and a
 * model that refuses `off` refuses it outright rather than meaning the next
 * level up. Which levels a given provider and model accept is answered from
 * what that provider publishes, in `domains/provider/effort-support.ts`.
 */

export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const

/**
 * An explicit request to send no effort setting at all.
 *
 * Distinct from an absent setting, which still means the application default.
 * An agent file that says nothing keeps the level it has always run at; this
 * value is how an author asks for the provider's own default instead, and it is
 * spelled out so that choice cannot be confused with an omission.
 */
export const PROVIDER_DEFAULT_THINKING = 'provider-default'

export type EffortLevel = (typeof THINKING_LEVELS)[number]

export type ThinkingLevel = EffortLevel | typeof PROVIDER_DEFAULT_THINKING

/** Whether a value is one of the levels this application can express. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === PROVIDER_DEFAULT_THINKING ||
    (typeof value === 'string' &&
      (THINKING_LEVELS as readonly string[]).includes(value))
  )
}

/**
 * The level a stored value asks for, or the caller's default.
 *
 * One reader for every surface that reads a `thinking:` key. Each of them used
 * to carry its own three-value check and default quietly, so a level an editor
 * offered could be stored, displayed, and then replaced on the way to the
 * provider without anything saying so. A value outside the vocabulary still
 * falls back, because it is not a level any surface offers; whether a real
 * level is one this provider and model accept is a separate question.
 */
export function readThinkingLevel(
  value: unknown,
  fallback: ThinkingLevel,
): ThinkingLevel {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return isThinkingLevel(trimmed) ? trimmed : fallback
}

/** The vocabulary in the tuple shape `z.enum` needs. */
export const THINKING_REQUEST_VALUES: readonly [ThinkingLevel, ...ThinkingLevel[]] = [
  ...THINKING_LEVELS,
  PROVIDER_DEFAULT_THINKING,
]
