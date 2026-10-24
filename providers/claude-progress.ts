import { AGENT_PROGRESS_MAX_ATTEMPT, type AgentProgressUpdate } from '../contracts/agent-progress.js'
import { readCliDiagnostic } from './cli-diagnostics.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read activity metadata, never the provider's reasoning, answer or tool arguments. */
export function readClaudeProgress(value: unknown): AgentProgressUpdate | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === 'rate_limit_event') {
    return isRecord(value.rate_limit_info) && value.rate_limit_info.status === 'rejected'
      ? { kind: 'observed', phase: 'rate_limited' } : undefined
  }
  if (value.type === 'system' && value.subtype === 'api_retry') {
    const diagnostic = readCliDiagnostic(value, 'stdout')
    return {
      kind: 'observed', phase: 'retry',
      // The diagnostic bound is wider than the display contract; an unshown count beats an invalid snapshot.
      ...(diagnostic?.attempt === undefined || diagnostic.attempt === 0 || diagnostic.attempt > AGENT_PROGRESS_MAX_ATTEMPT ? {} : { attempt: diagnostic.attempt }),
      ...(diagnostic?.retryDelayMs === undefined ? {} : { retryDelayMs: diagnostic.retryDelayMs }),
    }
  }
  if (value.type === 'system' && value.subtype === 'init') return { kind: 'observed', phase: 'starting' }
  if (value.type !== 'stream_event' || !isRecord(value.event)) return undefined
  const event = value.event
  const block = event.type === 'content_block_start' ? event.content_block : event.type === 'content_block_delta' ? event.delta : undefined
  if (!isRecord(block)) return undefined
  if (block.type === 'thinking' || block.type === 'thinking_delta') return { kind: 'observed', phase: 'thinking' }
  if (block.type === 'text_delta') return { kind: 'observed', phase: 'answering' }
  return undefined
}
