/**
 * Core — how much of a model's window a piece of text will cost.
 *
 * One estimator, because the system had three and they disagreed in two
 * different ways. `domains/provider/provider-request-budget.ts` divided bytes by
 * 3.5, `domains/deep-research/deep-research-prompt-budget.ts` divided bytes by
 * 4, and `domains/agent-execution/context-compressor.ts` divided
 * `text.length` — UTF-16 code units — by 4, which reads a CJK string as a
 * fraction of what it actually costs on the wire. Three answers to one
 * arithmetic question is two answers too many, and the disagreement was
 * invisible because nothing ever compared them.
 *
 * Bytes rather than characters, so the estimate does not drift by script.
 *
 * The ratio is deliberately below the roughly four bytes per token that English
 * prose averages against current tokenizers. Admission must not be the
 * optimistic party: an estimate that runs slightly high refuses a request that
 * would have just fit, while an estimate that runs low readmits exactly the
 * overflow the boundary exists to prevent. Move it down when measurement
 * justifies it; never up.
 *
 * This is an estimate and the code that depends on it must behave like it. The
 * ground truth is the input-token count a provider reports back, and a window
 * learned from a provider's own refusal beats anything computed here.
 */

import { contextLimit } from './context-limits.js'

/** The estimated token cost of `value` for any model in this system. */
export function estimateContextTokens(value: string): number {
  if (!value) return 0
  return Math.ceil(
    Buffer.byteLength(value, 'utf8') / contextLimit('estimator.bytesPerToken'),
  )
}

/**
 * How far an estimate sat from what the provider actually charged.
 *
 * Above 1 means the estimate ran high, which is the safe direction. Recorded
 * per turn so the ratio can be measured before any number here is changed —
 * the calibration that phase C of the plan exists to gather.
 */
export function contextEstimateAccuracy(input: {
  readonly estimatedTokens: number
  readonly reportedInputTokens: number
}): number | undefined {
  if (input.reportedInputTokens <= 0) return undefined
  return input.estimatedTokens / input.reportedInputTokens
}
