import { whenDefined } from '../core/optional-properties.js'
import type { ProviderExecuteOptions, ProviderResult } from './types.js'
import type { ProviderEvent } from '../core/types.js'
import { logProviderEvent } from '../domains/runtime/logger.js'
import { appendProviderLifecycleTranscriptEvent } from '../domains/runtime/transcript.js'

export function logProviderLifecycle(
  options: ProviderExecuteOptions,
  provider: string,
  event: Omit<ProviderEvent, 'timestamp' | 'provider' | 'model' | 'agent_name' | 'session_id' | 'root_session_id' | 'assignment_path'>,
): void {
  if (!options.outputPath) return
  const providerEvent: ProviderEvent = {
    timestamp: new Date().toISOString(),
    provider,
    model: options.model,
    ...whenDefined(options.agentName, (agent_name) => ({ agent_name })),
    ...whenDefined(options.sessionId, (session_id) => ({ session_id })),
    ...whenDefined(options.rootSessionId, (root_session_id) => ({ root_session_id })),
    assignment_path: options.outputPath,
    ...event,
  }
  logProviderEvent(options.outputPath, providerEvent)
  appendProviderLifecycleTranscriptEvent(options.outputPath, providerEvent)
}

export function logProviderStart(
  options: ProviderExecuteOptions,
  provider: string,
  detail?: string,
): void {
  logProviderLifecycle(options, provider, {
    event: 'request.start',
    status: 'started',
    ...whenDefined(detail, (definedValue) => ({ detail: definedValue })),
  })
}

export function logProviderSuccess(
  options: ProviderExecuteOptions,
  provider: string,
  result: ProviderResult,
  detail?: string,
): void {
  logProviderLifecycle(options, provider, {
    event: 'request.end',
    status: 'completed',
    detail: detail ?? buildResultDetail(result),
    raw: {
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      context_tokens: result.contextTokens,
      cost: result.cost,
      duration_ms: result.durationMs,
      result_model: result.model,
      text_preview: previewText(result.text),
      text_length: result.text.length,
    },
  })
}

export function logProviderFailure(
  options: ProviderExecuteOptions,
  provider: string,
  detail: string,
  raw?: Record<string, unknown>,
): void {
  logProviderLifecycle(options, provider, {
    event: 'request.fail',
    status: 'failed',
    detail,
    ...whenDefined(raw, (definedValue) => ({ raw: definedValue })),
  })
}

/**
 * Report a provider that has gone silent mid-turn, and the end of that
 * silence. Without these the run emits nothing between `request.start` and
 * `request.end`, so an upstream stall is indistinguishable from work.
 */
export function logProviderStall(
  options: ProviderExecuteOptions,
  provider: string,
  phase: 'stalled' | 'resumed' | 'aborted',
  idleMs: number,
): void {
  const detail =
    phase === 'stalled'
      ? 'no protocol event for'
      : phase === 'resumed'
        ? 'resumed after'
        : 'aborted after'
  logProviderLifecycle(options, provider, {
    event: `request.${phase}`,
    status: 'streaming',
    detail: `${detail} ${Math.round(idleMs / 1000)}s`,
    raw: { idle_ms: idleMs },
  })
}

export function buildResultDetail(result: ProviderResult): string {
  return `completed in ${result.durationMs}ms; input=${result.inputTokens}; output=${result.outputTokens}; text_length=${result.text.length}`
}

export function previewText(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized
}
