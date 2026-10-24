/**
 * Sessions — rendering a conversation into the room a model actually has.
 *
 * This replaces `.slice(-40)`, which was the single most scale-blind cut in the
 * system: forty messages whether the reader held a 32k window or a million-token
 * one, with no marker either way. On a large model it threw away material the
 * model had ample room for; on a small one it did not prevent an overflow,
 * because forty messages have no fixed size and nothing else on the path was
 * counting.
 *
 * The rule now is the receiving model's window, through the shared fitter, so
 * the same session renders differently for a 1M-token agent and a small local
 * one — which is the entire point.
 *
 * Newest-first survival is deliberate and is enforced by the fitter's ranking:
 * when a conversation does not fit, the oldest exchanges go and the most recent
 * one always reaches the model. An agent that has lost the thread of the
 * immediately preceding message cannot answer at all, whereas one that has lost
 * an exchange from an hour ago usually can.
 */

import {
  admissibleInputTokens,
  fitContext,
  type ContextItem,
} from '../core/context-fit.js'
import { contextLimit } from '../core/context-limits.js'
import { resolveContextWindow } from '../domains/provider/context-window.js'
import type { ChatMessage } from '../contracts/sessions.js'

/** How a message is labelled to the model. */
function speakerLabel(message: ChatMessage, ownSpeakerId?: string): string {
  if (message.role === 'user') return 'User'
  const name = message.speaker?.name ?? 'Assistant'
  return ownSpeakerId !== undefined && message.speaker?.id === ownSpeakerId
    ? `${name} (you)`
    : name
}

function renderMessage(message: ChatMessage, ownSpeakerId?: string): string {
  const cutOff = message.cutOff === undefined ? '' : ' [cut off]'
  return `${speakerLabel(message, ownSpeakerId)}: ${message.text}${cutOff}`
}


/** Character budgets for the file and project blocks a turn renders once. */
export interface ChatAttachmentBudget {
  readonly perFileMaxChars: number
  readonly totalMaxChars: number
  /**
   * The same budget in the unit it was derived in.
   *
   * The character forms are a convenience for a consumer that slices; they are
   * only equal to this for ASCII. The builder spends the token form.
   */
  readonly perFileMaxTokens: number
  readonly totalMaxTokens: number
}

/**
 * How much attached material this turn may render, in characters.
 *
 * Sized against the **smallest** window in the roster, because the file block is
 * rendered once and every speaker in the turn reads the same copy. Budgeting it
 * against the largest reader would overflow the smallest; rendering it per
 * speaker would cost the work of re-reading every file to no purpose.
 *
 * Returned in both units. Tokens are what the budget is derived in and what the
 * builder spends; the character forms are a convenience for a consumer that
 * slices, and they agree with the token forms only for ASCII — one CJK
 * character is three bytes, so a character budget computed from a token budget
 * and then spent by string length lands at three times what was intended.
 */
export function resolveChatFileBudget(
  roster: readonly {
    provider: string
    model: string
    connectionKind?: string | undefined
  }[],
): ChatAttachmentBudget {
  const windows = roster.map((speaker) =>
    resolveContextWindow({
      provider: speaker.provider,
      model: speaker.model,
      ...(speaker.connectionKind === undefined
        ? {}
        : { connectionKind: speaker.connectionKind }),
    }))

  // The smallest window in the roster, and that same route's own answer
  // ceiling. Taking the minimum ceiling across the roster instead would
  // subtract a reserve belonging to a different model from this model's window.
  const narrowest = windows.length === 0 ? undefined : windows.reduce(
    (smallestSoFar, candidate) =>
      candidate.tokens < smallestSoFar.tokens ? candidate : smallestSoFar,
  )

  // An empty roster still gets a budget, but the smallest one in the table
  // rather than the assumed window: a turn whose speaker did not resolve is the
  // case we know least about, and the assumed 128k would hand it four times
  // what a local model gets.
  const windowTokens = narrowest?.tokens ?? SMALLEST_TABLE_WINDOW_TOKENS
  const maxOutputTokens = narrowest?.maxOutputTokens

  // Derived the same way the fitter derives it, output reserve included. Two
  // expressions of "admissible" that disagreed would mean this block was sized
  // against a budget nothing else believed in.
  const admissibleTokens = admissibleInputTokens(windowTokens, maxOutputTokens)
  const totalTokens = Math.max(
    contextLimit('item.minimumTokens'),
    Math.floor(admissibleTokens * contextLimit('share.reference')),
  )
  const perFileTokens = Math.max(
    contextLimit('item.minimumTokens'),
    Math.floor(totalTokens * contextLimit('share.perAttachment')),
  )
  const totalMaxChars = Math.floor(
    totalTokens * contextLimit('estimator.bytesPerToken'),
  )
  // One file may not take the whole block. HEAD allowed 24,000 characters per
  // file within a 60,000 total, and that ratio was doing real work: without it
  // a single large upload starves every other attachment in the same turn.
  return {
    perFileMaxChars: Math.floor(
      perFileTokens * contextLimit('estimator.bytesPerToken'),
    ),
    totalMaxChars,
    perFileMaxTokens: perFileTokens,
    totalMaxTokens: totalTokens,
  }
}

/**
 * The smallest window any route in the table claims.
 *
 * Used only when no speaker resolved. Conservative on purpose: an unresolved
 * speaker is the case we know least about, and assuming the generic window
 * would hand it several times what a local model is given.
 */
const SMALLEST_TABLE_WINDOW_TOKENS = 32_000




/**
 * One speaker's prompt, fitted to that speaker's window as a whole.
 *
 * The blocks a turn sends were each sized by their own rule, or by none: the
 * transcript against the window, the attachment block against its own share of
 * the same window, and the project references, carried results and catalog
 * against nothing at all. Concatenated, they could exceed the window every one
 * of them was individually "budgeted" against. Fitting the transcript alone
 * made that worse rather than better, because unclaimed room spilled into
 * history that the attachment block was about to claim again.
 *
 * So the whole turn is fitted once. Pinned content — who is speaking, the
 * question, the instruction to answer — is never trimmed, because a turn
 * without them is not the turn the user asked for. Everything else competes.
 */
export function assembleSpeakerPrompt(input: {
  readonly speakerName: string
  readonly ownSpeakerId?: string
  readonly latestUserText: string
  readonly history: readonly ChatMessage[]
  readonly fileContext?: string | undefined
  readonly projectContext?: string | undefined
  readonly documentContext?: string | undefined
  /** The attached-folder map: structure only, already sized to its share. */
  readonly folderContext?: string | undefined
  readonly continuation?: string | undefined
  readonly catalog?: string | undefined
  readonly windowTokens: number
  readonly maxOutputTokens?: number | undefined
}): string {
  const visible = input.history.filter((message) => message.role !== 'system')

  const items: ContextItem[] = [
    { id: 'speaker', itemClass: 'pinned', text: `Current speaker: ${input.speakerName}` },
    { id: 'question', itemClass: 'pinned', text: input.latestUserText },
    { id: 'instruction', itemClass: 'pinned', text: `Reply now as ${input.speakerName}.` },
    ...(input.documentContext
      ? [{ id: 'documents', itemClass: 'pinned' as const, text: input.documentContext }]
      : []),
    ...(input.catalog === undefined
      ? []
      : [{ id: 'catalog', itemClass: 'pinned' as const, text: input.catalog }]),
    ...(input.continuation === undefined
      ? []
      : [{ id: 'carry', itemClass: 'carry' as const, text: input.continuation }]),
    // Uploads outrank project references when the two compete, and the fitter
    // keeps the higher rank. An upload is an act taken for this turn; a project
    // selection is a standing scope that will still be there next turn and can
    // be re-read then. So if one of them has to go, it is the recoverable one.
    ...(input.projectContext
      ? [{ id: 'project', itemClass: 'reference' as const, text: input.projectContext, rank: 0 }]
      : []),
    ...(input.fileContext
      ? [{ id: 'files', itemClass: 'reference' as const, text: input.fileContext, rank: 1 }]
      : []),
    // The folder map outranks both: it is small, already fitted to its share,
    // and without it the agent cannot name a folder to its tools at all.
    ...(input.folderContext
      ? [{ id: 'folders', itemClass: 'reference' as const, text: input.folderContext, rank: 2 }]
      : []),
    ...visible.map((message, index) => ({
      id: `history:${message.id}`,
      itemClass: 'history' as const,
      text: renderMessage(message, input.ownSpeakerId),
      rank: index,
    })),
  ]

  const fitted = fitContext({
    items,
    windowTokens: input.windowTokens,
    ...(input.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.maxOutputTokens }),
  })
  if (fitted.refused) {
    // Pinned content alone did not fit. The turn is still sent, because a
    // refusal here would be a new failure on a path that has only ever
    // degraded, but it is said out loud rather than shipped silently.
    console.warn(
      `[context] ${fitted.refusalReason ?? 'pinned content exceeds the budget'}; ` +
        `sending ${fitted.estimatedInputTokens} tokens against ` +
        `${fitted.admissibleTokens} admissible`,
    )
  }
  const kept = new Map(fitted.kept.map((item) => [item.id, item.text]))
  const keptHistory = fitted.kept.filter((item) => item.itemClass === 'history')
  const droppedHistory = fitted.cuts.filter(
    (cut) => cut.itemClass === 'history' && cut.reason !== 'shortened',
  ).length

  const historyBlock = keptHistory.length === 0
    ? visible.length === 0
      ? '(none)'
      : `[all ${visible.length} earlier message${visible.length === 1 ? '' : 's'} omitted: none fit the context budget]`
    : [
        ...(droppedHistory === 0
          ? []
          : [
              `[${droppedHistory} earlier message${droppedHistory === 1 ? '' : 's'} omitted to fit the context budget]`,
              '',
            ]),
        keptHistory.map((item) => item.text).join('\n\n'),
      ].join('\n')

  return [
    kept.get('speaker') ?? `Current speaker: ${input.speakerName}`,
    '',
    ...(kept.has('catalog') ? [kept.get('catalog') ?? '', ''] : []),
    ...(kept.has('documents') ? [kept.get('documents') ?? '', ''] : []),
    // A dropped carry says so, like every other block. It was chosen for this
    // turn, and a reader told nothing at all cannot ask about what it is
    // missing.
    ...(input.continuation === undefined
      ? []
      : [
          kept.get('carry') ??
            '(results were carried into this turn, but omitted to fit the context budget)',
          '',
        ]),
    'Latest user message:',
    kept.get('question') ?? input.latestUserText,
    '',
    'Uploaded session files:',
    renderReferenceBlock(kept.get('files'), input.fileContext),
    '',
    'Explicitly selected project references:',
    renderReferenceBlock(kept.get('project'), input.projectContext),
    '',
    ...(input.folderContext
      ? ['Attached folders:', renderReferenceBlock(kept.get('folders'), input.folderContext), '']
      : []),
    'Conversation so far:',
    historyBlock,
    '',
    kept.get('instruction') ?? `Reply now as ${input.speakerName}.`,
  ].join('\n')
}

/**
 * A reference section, saying which of three things happened.
 *
 * `(none)` has to mean nothing was selected. Rendering it for content that was
 * selected and then dropped tells the model the user chose nothing, which is a
 * different fact and a worse one: it cannot ask about what it is not told
 * exists.
 */
function renderReferenceBlock(
  kept: string | undefined,
  offered: string | undefined,
): string {
  if (kept !== undefined) return kept
  if (!offered) return '(none)'
  return '(selected, but omitted to fit the context budget)'
}
