import type { Diagnostic, DiagnosticSubject } from '../../contracts/health.js'

/**
 * How much of a provider's allowance is already gone.
 *
 * Health asks "is the binary installed and the model enabled", which is the
 * wrong question for an account that has run out: everything is installed,
 * everything is enabled, and nothing works. This is the missing half, and it
 * is the one thing a badge cannot learn by looking at the local machine's
 * configuration.
 *
 * Every reading is evidence from a past moment. Nothing here presents one as
 * the state now; the reading carries when it was taken and the rules below
 * decide what can still be concluded from it.
 */
/** One allowance window, exactly as the provider stated it. */
export interface ProviderUsageWindow {
  /** How much of this window was spent, 0-100, as the provider stated it. */
  readonly usedPercent: number
  /** The window's length, for wording it as weekly, five-hourly, and so on. */
  readonly windowMinutes?: number | undefined
  /** When this window rolls over, which is when it stops being true. */
  readonly resetsAt?: string | undefined
}

export interface ProviderUsageReading {
  readonly provider: string
  /** When this reading was taken. Never assumed to be now. */
  readonly observedAt: string
  /**
   * Whether `observedAt` is when the provider stated this, or only the latest
   * moment at which it could have been stated.
   *
   * An upper bound is enough to say how much of an allowance is gone, and it
   * is not enough to place the reading *after* anything else. Only an exactly
   * dated reading may retire a failure a run hit, because "this happened
   * later" is the whole of that argument.
   */
  readonly observedAtIsUpperBound?: boolean | undefined
  /**
   * Every window the provider stated at that moment.
   *
   * More than one, because a provider commonly caps a short window and a long
   * one at the same time and either can be the binding constraint. They are
   * kept apart rather than reduced to the worst of them: the worst one expires
   * first as often as not, and a reading collapsed to it would report an
   * account as free the moment that window rolled over, while a weekly cap it
   * had discarded was still entirely spent.
   */
  readonly windows: readonly ProviderUsageWindow[]
}

/**
 * What obtaining a reading costs.
 *
 * The difference that matters is not how a source works but what asking it
 * spends. Reading what a CLI already wrote down is free and may happen on
 * every sidebar render; asking a provider directly costs a call against the
 * very allowance being measured, and must not happen because someone scrolled
 * a list. Sources state their price, callers state their budget.
 */
export type ProviderUsageCost = 'free' | 'billable'

export interface ProviderUsageSource {
  readonly provider: string
  readonly cost: ProviderUsageCost
  read(): Promise<ProviderUsageReading | undefined>
}

const COST_ORDER: Readonly<Record<ProviderUsageCost, number>> = {
  free: 0,
  billable: 1,
}

/**
 * Above this, the allowance is close enough to spent to be worth saying.
 *
 * A reading is a floor rather than a measurement — usage only rose after it
 * was taken — so the number shown is the least that has been spent.
 */
const USAGE_WARNING_PERCENT = 80

/**
 * The cheapest source that can answer, or nothing.
 *
 * Cheapest first, so adding a paid probe later never makes the free answer
 * more expensive: the probe is reached only when nothing free could answer and
 * the caller said it would pay. A source that throws is treated as a source
 * that knows nothing — this is an optional improvement to a badge, and it must
 * not be able to fail a health check that worked without it.
 */
export async function readProviderUsage(input: {
  readonly provider: string
  readonly maxCost?: ProviderUsageCost
  readonly sources: readonly ProviderUsageSource[]
}): Promise<ProviderUsageReading | undefined> {
  const ceiling = COST_ORDER[input.maxCost ?? 'free']
  const affordable = input.sources
    .filter(
      (source) =>
        source.provider === input.provider && COST_ORDER[source.cost] <= ceiling,
    )
    .sort((left, right) => COST_ORDER[left.cost] - COST_ORDER[right.cost])

  for (const source of affordable) {
    try {
      const reading = await source.read()
      if (reading) return reading
    } catch {
      // A source that cannot answer is not a fault in the thing being asked about.
    }
  }
  return undefined
}

/**
 * What a reading is still worth saying, if anything.
 *
 * Three rules, all following from the one fact that usage cannot fall inside a
 * window:
 *
 * - past its reset, the window it describes is gone and it means nothing;
 * - at full inside its window it is not stale, it is still true, so it blocks;
 * - anywhere else it is a warning, stated as of the day it was read.
 *
 * A reading with no stated reset never rises above a warning: there is no
 * moment at which it stops being true, which is exactly the same as there
 * being no moment at which it can be trusted to still be true.
 */
export function providerUsageDiagnostic(
  reading: ProviderUsageReading,
  subject: DiagnosticSubject,
  now: Date,
): Diagnostic | undefined {
  const binding = bindingWindow(liveUsageWindows(reading, now))
  if (!binding) return undefined
  if (binding.usedPercent < USAGE_WARNING_PERCENT) return undefined

  const spent = blocksWork(binding)
  const window = describeWindow(binding.windowMinutes)
  const until = binding.resetsAt
    ? ` It comes back on ${isoDay(binding.resetsAt)}.`
    : ''
  const asOf = ` Read from the provider on ${isoDay(reading.observedAt)}.`
  const who =
    subject.agentName !== undefined
      ? `Agent '${subject.agentName}'`
      : subject.teamName !== undefined
        ? `Team '${subject.teamName}'`
        : 'This provider'

  return {
    severity: spent ? 'error' : 'warning',
    kind: 'usage_limit',
    message: spent
      ? `${who} (${reading.provider}): the ${window} allowance is spent.${until}${asOf}`
      : `${who} (${reading.provider}): ${binding.usedPercent}% of the ${window} allowance is used.${until}${asOf}`,
    subject: { ...subject, provider: reading.provider },
  }
}

/**
 * Whether a window has nothing left in it.
 *
 * The plain fact, with no view about what follows from it. Two rules read it
 * and they want opposite things from a missing reset, so neither of them may
 * own this.
 */
function isSpent(window: ProviderUsageWindow): boolean {
  return window.usedPercent >= 100
}

/**
 * Whether a window is spent in the way that stops work.
 *
 * Full and due to come back. Full with no stated reset is not the same thing:
 * nothing says when it stops being true, so it can only ever be a warning —
 * treating it as blocking would strand an agent on evidence that cannot expire.
 *
 * This is a rule about what may be *displayed*, and it is deliberately not the
 * rule `readingRetiresUsageLimit` applies. Clearing a limit a run actually hit
 * asks for evidence of headroom, and a full window is evidence against it
 * whether or not it says when it ends; requiring a reset there would turn the
 * least informative reading into the one that clears the most.
 */
function blocksWork(window: ProviderUsageWindow): boolean {
  return isSpent(window) && window.resetsAt !== undefined
}

/**
 * The windows this reading still describes at `now`.
 *
 * A window past its reset describes a period that is gone. Dropping it can
 * only reveal a longer cap underneath, never hide one. A window with no stated
 * reset never expires here: nothing says when it stopped being true, so it
 * keeps counting, which is the answer that leaves a cap visible.
 */
function liveUsageWindows(
  reading: ProviderUsageReading,
  now: Date,
): readonly ProviderUsageWindow[] {
  return reading.windows.filter((window) => {
    if (window.resetsAt === undefined) return true
    const resetsAt = Date.parse(window.resetsAt)
    return !Number.isFinite(resetsAt) || resetsAt > now.getTime()
  })
}

/**
 * The window to answer from: the strongest thing that can be said, not merely
 * the largest number.
 *
 * Ranked by whether it blocks work first, because two windows can both be full
 * while only one of them is ever coming back, and the one that is coming back
 * is the one that can be reported as an error. Percentage, then window length,
 * then the order the provider stated them, settle the rest — so the same
 * reading always produces the same sentence.
 */
function bindingWindow(
  windows: readonly ProviderUsageWindow[],
): ProviderUsageWindow | undefined {
  return windows.reduce<ProviderUsageWindow | undefined>((worst, candidate) => {
    if (worst === undefined) return candidate
    if (blocksWork(candidate) !== blocksWork(worst)) {
      return blocksWork(candidate) ? candidate : worst
    }
    if (candidate.usedPercent !== worst.usedPercent) {
      return candidate.usedPercent > worst.usedPercent ? candidate : worst
    }
    return (candidate.windowMinutes ?? -1) > (worst.windowMinutes ?? -1)
      ? candidate
      : worst
  }, undefined)
}

/**
 * Whether this reading is fit to retire a usage limit a run actually hit.
 *
 * Three things have to hold, and each is a way the argument fails without it:
 *
 * - it must be dated by the provider's own answer, because an upper bound
 *   cannot place the reading after the failure, which is the entire claim;
 * - it must have been taken after the failure, for the same reason;
 * - no window it still describes may be spent, because an account can hold a
 *   fresh short window and an exhausted long one at once, and the short one
 *   proves nothing about the long one. A full window counts here even when it
 *   states no reset: it cannot be displayed as blocking, and it is still the
 *   opposite of the headroom this rule is looking for.
 *
 * Only a usage limit is answerable this way. A reading measures windows, so it
 * is not evidence about a key, a plan, or a permission, and it may never be
 * read as clearing one.
 */
export function readingRetiresUsageLimit(input: {
  readonly reading: ProviderUsageReading | undefined
  readonly failedAt: string
  readonly now: Date
}): boolean {
  const { reading } = input
  if (!reading || reading.observedAtIsUpperBound === true) return false

  const readAt = Date.parse(reading.observedAt)
  const failedAt = Date.parse(input.failedAt)
  if (!Number.isFinite(readAt) || !Number.isFinite(failedAt)) return false
  if (readAt <= failedAt) return false

  return !liveUsageWindows(reading, input.now).some(isSpent)
}

function describeWindow(windowMinutes: number | undefined): string {
  if (windowMinutes === undefined) return 'provider'
  if (windowMinutes >= 10080) return 'weekly'
  if (windowMinutes >= 1440) return 'daily'
  const hours = Math.round(windowMinutes / 60)
  return hours >= 1 ? `${hours}-hourly` : 'provider'
}

/** The day, not the minute: a reading is never precise enough to imply one. */
function isoDay(timestamp: string): string {
  return timestamp.slice(0, 10)
}
