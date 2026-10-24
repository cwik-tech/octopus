/**
 * Shared pieces for reading a streamed provider response.
 *
 * Three protocols are streamed — Chat Completions, the OpenAI Responses API and
 * the Anthropic Messages API — and they disagree about almost everything except
 * two things: inbound frames are untrusted, and a stream that stops short must
 * never be returned as a finished answer. Those two rules live here so all
 * three readers state them identically.
 */

import {
  ProviderError,
  classifyProviderError,
} from '../domains/provider/provider-error.js'

/**
 * A stream that stopped short of a terminal event.
 *
 * Retryable: the request itself was well formed, so repeating it is the only
 * way to learn whether the cut was transient. The message says the answer is
 * incomplete rather than naming a cause, because from the reader's position a
 * dropped socket, a proxy timeout and a provider bug are indistinguishable.
 */
export function incompleteProviderStream(
  provider: string,
  reason: string,
): ProviderError {
  return new ProviderError({
    provider,
    message: `streaming response was incomplete: ${reason}.`,
    retryable: true,
  })
}

/**
 * An error delivered inside an otherwise successful HTTP response.
 *
 * Every streamed protocol can do this: the headers say 200, the body starts
 * arriving, and then a frame reports a failure. Raising is what keeps the text
 * already accumulated from being handed on as an answer.
 */
export function streamedProviderError(
  provider: string,
  payload: Record<string, unknown>,
): ProviderError {
  const message =
    typeof payload.message === 'string' && payload.message.trim()
      ? payload.message
      : 'the provider reported an error mid-stream'
  const code =
    typeof payload.code === 'string'
      ? payload.code
      : typeof payload.type === 'string'
        ? payload.type
        : undefined
  const classification = classifyProviderError({
    provider,
    message,
    ...(code === undefined ? {} : { code }),
  })
  return new ProviderError({
    provider,
    message,
    ...(code === undefined ? {} : { code }),
    retryable: classification.retryable,
    ...(classification.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: classification.retryAfterMs }),
  })
}

/** Narrow an untrusted value to a plain object, copied rather than aliased. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  return { ...value }
}

/** Build a property only when the untrusted value really is a string. */
export function whenString<T>(
  value: unknown,
  build: (value: string) => T,
): T | Record<string, never> {
  return typeof value === 'string' ? build(value) : {}
}

/** Build a property only when the untrusted value really is a finite number. */
export function whenNumber<T>(
  value: unknown,
  build: (value: number) => T,
): T | Record<string, never> {
  return typeof value === 'number' && Number.isFinite(value) ? build(value) : {}
}
