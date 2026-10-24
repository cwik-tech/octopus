import type { AgentProgressUpdate } from './agent-progress.js'

export type ProviderProtocolEventKind =
  | 'progress'
  | 'lifecycle'
  | 'text'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'usage'
  | 'error'
  | 'complete'

export interface ProviderProtocolEvent {
  kind: ProviderProtocolEventKind
  progress?: AgentProgressUpdate
  provider: string
  timestamp?: string
  text?: string
  model?: string
  cost?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  rawType?: string
  raw?: Record<string, unknown>
}

/**
 * The failure kinds a provider call can end in.
 *
 * A closed list, shared rather than duplicated, because three layers have to
 * agree on it: the provider transport that classifies a failure, the worker
 * transport that carries the classification between processes, and the chat UI
 * that turns it back into a sentence. A provider's own prose never travels that
 * path — it can hold an account identifier, a file path, or a slice of the
 * request — so the kind is the whole of what crosses, and the copy below is
 * this build's, not the provider's.
 */
export const PROVIDER_ERROR_KINDS = [
  'session_limit',
  'usage_limit',
  'rate_limit',
  'authentication',
  'permission',
  'billing',
  'not_found',
  'context_limit',
  'invalid_request',
  'request_too_large',
  'timeout',
  'overloaded',
  'unavailable',
  'server_error',
  'cancelled',
  'configuration',
  'process_failed',
  'unknown',
] as const

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number]

/**
 * What a person is told when a provider call ends in each kind.
 *
 * Short, and every line either names something the reader can change or says
 * plainly that waiting is the only move. Rendered from the kind alone, so it is
 * safe on any surface that must not show provider text.
 */
export const PROVIDER_FAILURE_USER_MESSAGES: Readonly<
  Record<ProviderErrorKind, string>
> = {
  session_limit: "You've hit your session limit. Try again after it resets.",
  usage_limit: "You've hit your provider usage limit. Try again after it resets.",
  rate_limit: 'Too many requests. Try again shortly.',
  authentication: 'Authentication failed. Reconnect the provider and try again.',
  permission: 'This account cannot access the requested model or resource.',
  billing: 'This provider account has no remaining quota or credits. Check billing.',
  not_found: 'The requested model or endpoint was not found. Check provider settings.',
  context_limit: 'This conversation is too long for the selected model. Shorten it or start a new chat.',
  invalid_request: 'The provider rejected the request. Check the model and request settings.',
  request_too_large: 'The request is too large. Remove attachments or shorten the content.',
  timeout: 'The provider timed out. Try again.',
  overloaded: 'The provider is temporarily overloaded. Try again shortly.',
  unavailable: 'The provider is temporarily unavailable. Try again shortly.',
  server_error: 'The provider had an internal error. Try again.',
  cancelled: 'The request was cancelled.',
  configuration: 'The provider is not configured correctly. Check provider settings.',
  process_failed: 'The provider process could not complete the response.',
  unknown: 'The provider could not complete the response. Try again.',
}

/** Whether a value is one of the kinds this build defines. */
export function isProviderErrorKind(value: unknown): value is ProviderErrorKind {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PROVIDER_FAILURE_USER_MESSAGES, value)
}
