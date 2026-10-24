import { ProviderError } from './provider-error.js'

/**
 * Stable identity for a response the model stopped emitting because it hit a
 * token ceiling.
 *
 * It has to survive `services/mcp-agent-tool-service.ts`, which replaces a
 * `ProviderError` with its own error on the worker lane and maps every code it
 * does not recognise to `provider_failed`. Without the code crossing that
 * boundary, a truncation is indistinguishable from any other worker failure.
 */
export const PROVIDER_TRUNCATED_CODE = 'provider_truncated' as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a truncation signal out of an unvalidated provider response body.
 *
 * Deliberately a focused guard over `unknown` rather than another field on each
 * provider's response interface: these bodies are external input, and the
 * interfaces describe what the code hopes to find rather than what arrived.
 *
 * Three wire shapes are recognised, and they do not overlap:
 *
 * - OpenAI Responses API — `status: 'incomplete'` with
 *   `incomplete_details.reason: 'max_output_tokens'`. Note this is *not* the
 *   chat-completions `finish_reason`; `providers/openai.ts` posts to
 *   `/v1/responses`.
 * - Anthropic Messages API — `stop_reason: 'max_tokens'`.
 * - OpenAI-compatible chat completions (DeepSeek, OpenRouter, Kimi, xAI) —
 *   a choice with `finish_reason: 'length'`.
 *
 * Returns a human-readable reason, or `undefined` when the response is whole.
 * Other incomplete reasons, `content_filter` among them, are deliberately not
 * reported here: they are different failures and need their own contract.
 */
export function detectProviderTruncation(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined

  if (body.status === 'incomplete') {
    const details = body.incomplete_details
    const reason = isRecord(details) && typeof details.reason === 'string'
      ? details.reason
      : undefined
    // Both spellings appear in the wild for the same ceiling: the request field
    // is `max_output_tokens`, but some Responses-API deployments report the
    // reason as `max_tokens`. Accepting only one of them would let a truncated
    // answer through under the other.
    if (reason === 'max_output_tokens' || reason === 'max_tokens') {
      return `the response stopped at ${reason}`
    }
  }

  if (body.stop_reason === 'max_tokens') {
    return 'the response stopped at max_tokens'
  }

  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (isRecord(choice) && choice.finish_reason === 'length') {
        return 'the response stopped at its token limit (finish_reason: length)'
      }
    }
  }

  return undefined
}

/**
 * The failure a truncated response becomes.
 *
 * Not retryable: the attempt loop would repeat the same prompt against the same
 * ceiling and reproduce the truncation, spending a turn to learn nothing. A
 * retry only makes sense alongside a change to the request — a larger ceiling,
 * a continuation, or an instruction to answer more briefly — which is a
 * separate design.
 */
export function truncatedProviderError(
  provider: string,
  reason: string,
): ProviderError {
  return new ProviderError({
    provider,
    message:
      `returned a truncated response: ${reason}. The partial text was ` +
      `discarded rather than handed on as a finished result. Raise the ` +
      `output token limit for this agent, or ask it for a shorter answer.`,
    kind: 'process_failed',
    code: PROVIDER_TRUNCATED_CODE,
    retryable: false,
  })
}
