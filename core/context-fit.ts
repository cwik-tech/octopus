/**
 * Core — fitting what we would like to send into what the model can read.
 *
 * Pure arithmetic over typed items, and deliberately at layer 0 so that
 * `engines/`, `services/`, `providers/` and `domains/` can all reach it. That
 * placement is forced rather than chosen: a single assembler that gathered
 * transcript, files and project context would have to sit at layer 5, and the
 * layer policy would then forbid `model-client.ts` and the engines from ever
 * calling it. Enforcement can be central; gathering cannot. So this module is
 * handed items that somebody else collected, and knows nothing about where
 * they came from.
 *
 * **Shares are ceilings, not allocations.** Each class may take up to its share
 * of the budget, and whatever it does not use is offered to the rest. That is
 * what lets one policy serve a 32k local model and a 1M-token hosted one: a
 * turn with no attached files spends that room on its transcript instead of
 * leaving it empty.
 *
 * **An item is shortened while that still leaves an excerpt, and dropped once
 * it would not.** The threshold is `item.minimumTokens`. Below it a truncation
 * stops being an excerpt and becomes a fragment the model reads as complete,
 * which is the failure already present in the context compressor: it cut every
 * message to 500 characters and then summarized the wreckage. Above it,
 * shortening is what keeps the newest turn of a long conversation present on a
 * small window instead of vanishing. Every shortened item carries a marker, so
 * nothing that was cut is passed off as whole.
 *
 * **A class that must be cut still spends what it was given.** An earlier draft
 * halved the allowance whenever demand exceeded it, meaning to buy prefix
 * stability: trim deeper than necessary so the boundary does not move again
 * next turn. Measured, that was not hysteresis but waste — on a 32k window a
 * 120-message conversation rendered 22 messages and left half the admissible
 * budget unspent, carrying less than the fixed forty-message slice it replaced.
 *
 * Real hysteresis needs to know where the boundary sat last turn, and this
 * function is pure and sees one turn. So it fills the budget it was given, and
 * the stability question belongs with prompt caching, which is the only thing
 * that makes the answer measurable.
 *
 * **Refusal is rare and only for pinned content.** Everything else degrades.
 * If the persona and the current question together exceed the window there is
 * no prompt to send, and shortening the question would answer something the
 * user did not ask — so that case, and only that case, refuses.
 */

import { contextLimit, type ContextLimitName } from './context-limits.js'
import { estimateContextTokens } from './context-tokens.js'

/**
 * What kind of content an item is, which decides what it competes with.
 *
 * `pinned` is everything a turn cannot be answered without: the persona, the
 * rules, the question being asked. It is never trimmed.
 */
export type ContextItemClass =
  | 'pinned'
  | 'history'
  | 'reference'
  | 'carry'
  | 'toolResult'

export interface ContextItem {
  readonly id: string
  readonly itemClass: ContextItemClass
  readonly text: string
  /** Within a class, lower goes first when something has to go. */
  readonly rank?: number
}

export type ContextCutReason =
  /** The class was over its share of the budget and this item went. */
  | 'class-over-share'
  /** What remained would have been a fragment rather than an excerpt. */
  | 'below-minimum'
  /** The item was kept but shortened to what the budget allowed. */
  | 'shortened'

export interface ContextCut {
  readonly id: string
  readonly itemClass: ContextItemClass
  readonly droppedTokens: number
  readonly reason: ContextCutReason
}

export interface FittedContext {
  /** The items to send, in the order they were given. */
  readonly kept: readonly ContextItem[]
  /** What was left out, with its size, so a receipt can name it. */
  readonly cuts: readonly ContextCut[]
  readonly estimatedInputTokens: number
  readonly admissibleTokens: number
  readonly outputReserveTokens: number
  /** True when pinned content alone did not fit. Nothing else refuses. */
  readonly refused: boolean
  readonly refusalReason?: string
}

/**
 * The order classes are offered room in, most important first.
 *
 * Carry leads because a carried result is a conclusion somebody already
 * distilled; tool results trail because they are the most reproducible — an
 * agent can call the tool again, but it cannot re-read a turn that was dropped.
 */
const CLASS_ORDER = ['carry', 'reference', 'history', 'toolResult'] as const

/** Every class that competes for the budget. `pinned` does not; it is spent first. */
type BudgetedClass = Exclude<ContextItemClass, 'pinned'>

const CLASS_SHARE: Readonly<Record<Exclude<ContextItemClass, 'pinned'>, ContextLimitName>> = {
  history: 'share.history',
  reference: 'share.reference',
  carry: 'share.carry',
  toolResult: 'share.toolResult',
}

/**
 * How many input tokens a window actually offers.
 *
 * Exported because more than one caller needs it, and two expressions of the
 * same arithmetic would drift: the answer's reserve comes off first, then the
 * safety margin that covers the gap between a byte estimate and a real
 * tokenizer, then the share of what remains we choose to fill.
 */
export function admissibleInputTokens(
  windowTokens: number,
  maxOutputTokens?: number | undefined,
): number {
  const outputReserveTokens = resolveOutputReserve(windowTokens, maxOutputTokens)
  return Math.max(
    0,
    Math.floor(
      (windowTokens - outputReserveTokens) *
        contextLimit('budget.inputSafetyFraction') *
        contextLimit('budget.inputFillFraction'),
    ),
  )
}

export function fitContext(input: {
  readonly items: readonly ContextItem[]
  /** The receiving model's context window, from `resolveContextWindow`. */
  readonly windowTokens: number
  /** The route's stated answer ceiling, where it has one. */
  readonly maxOutputTokens?: number | undefined
}): FittedContext {
  const outputReserveTokens = resolveOutputReserve(input.windowTokens, input.maxOutputTokens)
  const admissibleTokens = admissibleInputTokens(input.windowTokens, input.maxOutputTokens)

  const sized = input.items.map((item) => ({
    item,
    tokens: estimateContextTokens(item.text),
  }))

  const pinnedTokens = sized
    .filter((entry) => entry.item.itemClass === 'pinned')
    .reduce((sum, entry) => sum + entry.tokens, 0)

  if (pinnedTokens > admissibleTokens) {
    // Reported rather than thrown: the caller owns what a refusal means for it,
    // and on a window we only assumed it must trim instead. See
    // `contextWindowMayRefuse`.
    return {
      kept: input.items.filter((item) => item.itemClass === 'pinned'),
      // Everything that is not pinned is cut, and says so. A refusal receipt
      // that recorded no cuts broke the invariant every other path holds —
      // kept plus cut equals offered — and would have under-reported what the
      // turn actually lost.
      cuts: sized
        .filter((entry) => entry.item.itemClass !== 'pinned')
        .map((entry) => ({
          id: entry.item.id,
          itemClass: entry.item.itemClass,
          droppedTokens: entry.tokens,
          reason: 'class-over-share' as const,
        })),
      estimatedInputTokens: pinnedTokens,
      admissibleTokens,
      outputReserveTokens,
      refused: true,
      refusalReason:
        `pinned content alone needs ${pinnedTokens} tokens of the ` +
        `${admissibleTokens} admissible`,
    }
  }

  const dropped = new Set<string>()
  const shortenedText = new Map<string, string>()
  const cuts: ContextCut[] = []
  let spent = pinnedTokens

  // Room is allocated in two passes, because a share is a ceiling and not an
  // allocation. One pass would cap every class at its own share for ever, so a
  // transcript on a million-token window could spend only its own 40% of it
  // however empty the other classes were — which is how a budget meant to carry
  // more than a forty-message window ended up carrying less.
  const byClass = new Map<BudgetedClass, typeof sized>()
  for (const itemClass of CLASS_ORDER) {
    const entries = sized
      .filter((entry) => entry.item.itemClass === itemClass)
      .sort((left, right) => rankOf(left.item) - rankOf(right.item))
    if (entries.length > 0) byClass.set(itemClass, entries)
  }

  const budget = admissibleTokens - pinnedTokens
  const demand = new Map<BudgetedClass, number>()
  const allowanceOf = new Map<BudgetedClass, number>()
  for (const [itemClass, entries] of byClass) {
    demand.set(itemClass, entries.reduce((sum, entry) => sum + entry.tokens, 0))
  }

  // Pass one: nobody takes more than their share, more than they want, or more
  // than the budget still holds.
  //
  // That last clamp is not redundant. The shares sum above 1 on purpose, so if
  // enough classes saturate at once their shares add up past the budget and the
  // fitter spends more than it admitted — 15% more with all four contending,
  // turning a declared fill fraction of 0.5 into 0.575 with nothing reporting
  // it. The clamp makes CLASS_ORDER load-bearing under contention: the classes
  // served first get their full share and the last absorbs the shortfall. That
  // is the intended reading of "most important first", and it is why the order
  // is stated rather than incidental.
  let allocated = 0
  for (const [itemClass] of byClass) {
    const share = Math.floor(budget * contextLimit(CLASS_SHARE[itemClass]))
    const take = Math.min(demand.get(itemClass) ?? 0, share, budget - allocated)
    allowanceOf.set(itemClass, take)
    allocated += take
  }

  // Pass two: whatever nobody claimed is offered to the classes still short of
  // what they wanted, in priority order.
  let spare = budget - allocated
  for (const [itemClass] of byClass) {
    if (spare <= 0) break
    const short = (demand.get(itemClass) ?? 0) - (allowanceOf.get(itemClass) ?? 0)
    if (short <= 0) continue
    const give = Math.min(short, spare)
    allowanceOf.set(itemClass, (allowanceOf.get(itemClass) ?? 0) + give)
    spare -= give
  }

  for (const [itemClass, entries] of byClass) {
    let allowance = allowanceOf.get(itemClass) ?? 0


    // Newest first: when something has to go, the oldest goes.
    let classSpent = 0
    for (const entry of [...entries].reverse()) {
      const room = allowance - classSpent
      if (entry.tokens <= room) {
        classSpent += entry.tokens
        continue
      }
      // It does not fit whole. Shorten it rather than lose it, so long as what
      // survives is still an excerpt: the newest turn of a conversation is
      // exactly the thing a small window must not silently drop. Below the
      // minimum there is nothing worth sending, and a fragment the model reads
      // as complete is worse than an honest absence.
      if (room >= contextLimit('item.minimumTokens')) {
        const shortened = truncateToTokens(entry.item.text, room)
        const keptTokens = estimateContextTokens(shortened)
        shortenedText.set(entry.item.id, shortened)
        cuts.push({
          id: entry.item.id,
          itemClass,
          droppedTokens: entry.tokens - keptTokens,
          reason: 'shortened',
        })
        classSpent += keptTokens
        continue
      }
      dropped.add(entry.item.id)
      cuts.push({
        id: entry.item.id,
        itemClass,
        droppedTokens: entry.tokens,
        reason: room > 0 ? 'below-minimum' : 'class-over-share',
      })
    }
    spent += classSpent
  }

  const kept = input.items
    .filter((item) => !dropped.has(item.id))
    .map((item) => {
      const shortened = shortenedText.get(item.id)
      return shortened === undefined ? item : { ...item, text: shortened }
    })
  return {
    kept,
    cuts,
    estimatedInputTokens: spent,
    admissibleTokens,
    outputReserveTokens,
    refused: false,
  }
}

/**
 * The tokens a window holds back for the answer.
 *
 * Exported so admission and the fitter subtract the same reserve.
 */
export function resolveOutputReserve(
  windowTokens: number,
  maxOutputTokens: number | undefined,
): number {
  const fromWindow = Math.floor(
    windowTokens * contextLimit('budget.outputReserveFraction'),
  )
  const capped = Math.min(fromWindow, contextLimit('budget.outputReserveMaxTokens'))
  // A route's own ceiling wins outright. Sending a derived `max_tokens` above
  // what the route accepts is refused by the provider, not trimmed by it.
  return maxOutputTokens === undefined ? capped : Math.min(capped, maxOutputTokens)
}

function rankOf(item: ContextItem): number {
  return item.rank ?? 0
}

/** Said to the model, so a shortened item is never read as a whole one. */
const TRUNCATION_MARKER = '\n[... shortened to fit the context budget ...]'

/**
 * Shorten `text` so its estimate lands at or under `maxTokens`, marker included.
 *
 * Estimates count bytes while slicing counts characters, and the two differ on
 * any non-ASCII input, so the result is measured and shrunk again rather than
 * computed once and trusted.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  const markerTokens = estimateContextTokens(TRUNCATION_MARKER)
  const budget = maxTokens - markerTokens
  if (budget <= 0) return TRUNCATION_MARKER

  let characters = Math.max(1, Math.floor(budget * contextLimit('estimator.bytesPerToken')))
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = text.slice(0, characters)
    if (estimateContextTokens(candidate) <= budget) {
      return `${candidate}${TRUNCATION_MARKER}`
    }
    characters = Math.floor(characters * 0.8)
    if (characters <= 0) break
  }
  return TRUNCATION_MARKER
}
