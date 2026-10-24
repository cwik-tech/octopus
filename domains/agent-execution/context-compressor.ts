/**
 * Team Runtime — Context Compressor
 *
 * Compresses conversation history into a concise summary on the one
 * application default, or mechanically when there is no usable default and no
 * run to disclose it to. Returns a string summary instead of writing a file
 * (unlike minutes.ts).
 *
 * Pattern adapted from this domain's minutes module:
 * - buildCompressionPrompt()  ← minutes.ts:buildSummaryPrompt()
 * - compressConversation()    ← minutes.ts:summarizeWithLLM()
 * - truncateToFirstParagraph() ← minutes.ts:truncateToFirstParagraph()
 */

import { whenDefined } from '../../core/optional-properties.js'
import type {
  ConversationMessage,
  RateLimiterInterface,
} from '../../core/types.js'
import { MINUTES_THINKING } from '../../core/constants.js'
import { estimateContextTokens } from '../../core/context-tokens.js'
import {
  recordHelperModelSelection,
  reportHelperFallback,
  resolveHelperModelSelection,
  type HelperRunIdentity,
} from '../provider/helper-model-selection.js'
import { runAgent } from './agent-runner.js'

// ─── Exported Interfaces ──────────────────────────────────────────────────────

export interface CompressionInput {
  messages: ConversationMessage[]
  teamName: string
  levelId: string
  currentRound: number
  /** Prior compressed summary to prepend (for incremental rolling summaries). */
  existingSummary?: string
  /** If provided, the summarizing call goes through the rate limiter. */
  rateLimiter?: RateLimiterInterface
  /** Shutdown signal — an aborted compression rethrows instead of falling back. */
  signal?: AbortSignal
  /** Bounded wait for the compression call. */
  timeoutMinutes?: number
  /**
   * The run this compression belongs to, when it has one.
   *
   * Compression is the application's own work and owns no Agent, so it runs on
   * the application default and discloses that through the run that caused it.
   * Absent for a caller with no assignment, which records nothing rather than
   * refusing to compress.
   */
  runIdentity?: HelperRunIdentity
}

export interface CompressionResult {
  summary: string
  compressedUpToRound: number
  inputTokensEstimate: number
  cost: number
}

// ─── Token Estimation ─────────────────────────────────────────────────────────

/**
 * The token estimate reported alongside a compression.
 *
 * Delegates to the system's one estimator. It used to divide `text.length` by
 * four, which counts UTF-16 code units and so read a CJK transcript as a
 * fraction of what it actually costs on the wire. This is a reported number
 * rather than a gate, so the change moves what is recorded, not what happens.
 */
export function estimateTokens(text: string): number {
  return estimateContextTokens(text)
}

// ─── Prompt Building ─────────────────────────────────────────────────────────

/**
 * Format messages as markdown sections grouped by round.
 * Truncates individual messages to 500 chars (same as minutes.ts:buildSummaryPrompt).
 */
export function buildCompressionPrompt(messages: ConversationMessage[]): string {
  const sections: string[] = []
  let currentRound = -1

  for (const msg of messages) {
    if (msg.round !== currentRound) {
      currentRound = msg.round
      sections.push(`\n### Round ${msg.round}`)
    }
    const toStr = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to
    // Pre-truncate very long messages to stay within context limits
    const truncated =
      msg.message.length > 500 ? msg.message.slice(0, 500) + '...' : msg.message
    sections.push(`**${msg.from} → ${toStr}:** ${truncated}`)
  }

  return sections.join('\n')
}

// ─── Mechanical Fallback ─────────────────────────────────────────────────────

/**
 * Truncate text to the first paragraph, at a word boundary.
 * Mirrors minutes.ts:truncateToFirstParagraph().
 */
function truncateToFirstParagraph(text: string, maxChars = 200): string {
  // Strip leading markdown headers
  const stripped = text.replace(/^#+\s+.*\n+/, '')
  // Take first paragraph
  const firstPara = stripped.split(/\n\n/)[0] || stripped
  if (firstPara.length <= maxChars) return firstPara.trim()
  // Truncate at word boundary
  const truncated = firstPara.slice(0, maxChars)
  const lastSpace = truncated.lastIndexOf(' ')
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '...'
}

/**
 * Mechanical fallback when LLM call fails: truncate first 200 chars per message.
 * Mirrors minutes.ts:buildMechanicalMinutes() approach.
 */
function buildMechanicalSummary(messages: ConversationMessage[]): string {
  return messages
    .map((m) => {
      const toStr = Array.isArray(m.to) ? m.to.join(', ') : m.to
      const truncated = truncateToFirstParagraph(m.message)
      return `[Round ${m.round}] ${m.from} → ${toStr}: ${truncated}`
    })
    .join('\n')
}

// ─── Compression System Prompt ────────────────────────────────────────────────

const COMPRESSION_SYSTEM_PROMPT = `You are a conversation compressor. Summarize the discussion history into a concise briefing.

PRESERVE (these are critical):
- Key decisions made and their rationale
- Action items assigned to specific agents
- Unresolved disagreements or open questions
- Factual data points, numbers, and constraints mentioned

OMIT:
- Pleasantries and process discussion
- Repeated information across rounds
- Verbose explanations when a short summary suffices

Output ONLY the compressed summary. No preamble, no headers, no metadata.
Keep it under 500 words.`

// ─── Main Compression Function ────────────────────────────────────────────────

export async function compressConversation(
  input: CompressionInput,
): Promise<CompressionResult> {
  const formattedMessages = buildCompressionPrompt(input.messages)

  // Prepend prior summary when doing incremental rolling compression
  const userMessage = input.existingSummary
    ? `Prior summary:\n${input.existingSummary}\n\nNew messages to incorporate:\n${formattedMessages}`
    : formattedMessages

  const inputTokensEstimate = estimateTokens(userMessage)

  /** The summary this returns when no model is asked for one. */
  const mechanical = (): CompressionResult => ({
    summary: buildMechanicalSummary(input.messages),
    compressedUpToRound: input.currentRound - 1,
    inputTokensEstimate,
    cost: 0,
  })

  // Nothing is asked for a round nobody is waiting for, and an aborted round
  // still rethrows rather than being answered mechanically.
  if (input.signal?.aborted) {
    throw new Error('Compression was cancelled before it started.')
  }

  // The one application default, whole. A pair that cannot run is not a licence
  // to pick another one: with nothing usable, this compresses mechanically and
  // asks no model anything.
  const selection = resolveHelperModelSelection('compression')
  if (!selection) return mechanical()
  // The same answer with no run to disclose to. Using a model that nothing can
  // record would be the disclosure rule with an escape hatch in it.
  const identity = input.runIdentity
  if (!identity) return mechanical()

  const doRun = async () => {
    // Recorded here rather than before the limiter, because between those two
    // points this call may never happen. A round cancelled while it queued
    // would otherwise leave a durable notice saying the application default was
    // used for work that was never dispatched.
    if (input.signal?.aborted) {
      throw new Error('Compression was cancelled before it was dispatched.')
    }
    if (!recordHelperModelSelection(identity, 'compression', selection)) {
      throw new Error('The model selected for this compression could not be recorded.')
    }
    return runAgent({
      systemPrompt: COMPRESSION_SYSTEM_PROMPT,
      userMessage,
      model: selection.model,
      provider: selection.provider,
      thinking: MINUTES_THINKING,
      outputPath: identity.outputPath,
      sessionId: identity.sessionId,
      ...whenDefined(identity.rootSessionId, (rootSessionId) => ({ rootSessionId })),
      ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
      ...whenDefined(input.timeoutMinutes, (definedValue) => ({ timeoutMinutes: definedValue })),
    })
  }

  try {
    const result = input.rateLimiter
      ? await input.rateLimiter.run(doRun)
      : await doRun()

    return {
      summary: result.text,
      compressedUpToRound: input.currentRound - 1,
      inputTokensEstimate,
      cost: result.cost,
    }
  } catch (err) {
    // Shutdown must propagate — never replace an aborted round with a
    // mechanical summary.
    if (input.signal?.aborted) throw err
    // And the round says it fell back, for the same reason minutes do: a helper
    // that quietly produces its mechanical output leaves nobody able to find
    // out what was unavailable. Both helpers share the disclosure rule, so they
    // share this one.
    reportHelperFallback('compression', {
      sessionId: identity.sessionId,
      ...whenDefined(identity.rootSessionId, (rootSessionId) => ({ rootSessionId })),
      ...whenDefined(input.teamName, (team) => ({ team })),
    })
    // Mechanical fallback: truncate first paragraph per message — never crash the round
    return mechanical()
  }
}
