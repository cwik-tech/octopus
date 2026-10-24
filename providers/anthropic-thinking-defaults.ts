/**
 * What Anthropic requests carry when an Agent names only part of the pair.
 *
 * Two readers need these numbers and must not disagree: the adapter that builds
 * the request (`providers/anthropic.ts`), and the check that decides whether an
 * Agent's own settings still fit after an approved provider switch
 * (`providers/provider-option-support.ts`). Kept here as data, so the second
 * reader does not have to import a module that opens network connections to
 * find out what a default is.
 *
 * The pair is coupled: a request whose thinking budget is at or above its
 * answer ceiling leaves no room for an answer, and the vendor refuses it. That
 * is why a setting cannot be judged on its own — the other half may be one of
 * these defaults rather than anything the Agent wrote.
 */

/** The vendor's floor. A budget below this is refused outright. */
export const ANTHROPIC_MINIMUM_THINKING_BUDGET = 1_024

export const ANTHROPIC_THINKING_BUDGETS: Readonly<Record<string, number>> = {
  high: 8_192,
  medium: 4_096,
  low: 1_024,
}

export const ANTHROPIC_DEFAULT_MAX_TOKENS: Readonly<Record<string, number>> = {
  high: 12_288,
  medium: 8_192,
  low: 4_096,
}
