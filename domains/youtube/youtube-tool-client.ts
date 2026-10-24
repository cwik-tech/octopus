import { whenDefined } from '../../core/optional-properties.js'
import { randomUUID } from 'node:crypto'

import {
  MCP_RUNTIME_CONTRACT_VERSION,
} from '../../contracts/mcp.js'
import {
  RUNTIME_PROCESS_IDENTITY_ENV,
  RUNTIME_TASK_ID_ENV,
  type RuntimeCapabilityRequestContext,
} from '../../contracts/runtime-capability-authority.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_SESSION_ID_ENV,
} from '../runtime/runtime-paths.js'
import {
  YOUTUBE_TOOL_CONTRACT_VERSION,
  YOUTUBE_EXTRACTOR_AGENT_PATH,
  YOUTUBE_TOOL_URL_ENV,
  type YoutubeToolInput,
  type YoutubeToolResponse,
} from './youtube-types.js'

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024

export class YoutubeToolClientError extends Error {
  constructor(message = 'Parent YouTube service is unavailable.') {
    super(message)
    this.name = 'YoutubeToolClientError'
  }
}

export async function callParentYoutubeTool(params: {
  readonly agentPath: string
  readonly toolCallId: string
  readonly input: YoutubeToolInput
  readonly signal?: AbortSignal
  readonly environment?: NodeJS.ProcessEnv
}): Promise<YoutubeToolResponse> {
  const environment = params.environment ?? process.env
  const configuredUrl = environment[YOUTUBE_TOOL_URL_ENV]?.trim()
  if (!configuredUrl) throw new YoutubeToolClientError()
  const response = await fetch(requireLoopbackCapabilityUrl(configuredUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: YOUTUBE_TOOL_CONTRACT_VERSION,
      context: youtubeContext(environment, params.agentPath),
      toolCallId: params.toolCallId,
      input: params.input,
    }),
    redirect: 'error',
    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
  }).catch((error) => {
    if (params.signal?.aborted) throw error
    throw new YoutubeToolClientError()
  })
  if (!response.ok) {
    void response.body?.cancel()
    throw new YoutubeToolClientError()
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new YoutubeToolClientError()
  let parsed: unknown
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new YoutubeToolClientError()
  }
  if (!isYoutubeToolResponse(parsed)) throw new YoutubeToolClientError()
  return parsed
}

function youtubeContext(
  environment: NodeJS.ProcessEnv,
  agentPath: string,
): RuntimeCapabilityRequestContext {
  const sessionId = environment[RUNTIME_SESSION_ID_ENV]?.trim()
  const runId = environment[RUNTIME_RUN_ID_ENV]?.trim()
  const assignmentId = environment[RUNTIME_ASSIGNMENT_ID_ENV]?.trim()
  const taskId = environment[RUNTIME_TASK_ID_ENV]?.trim()
  const processIdentity = environment[RUNTIME_PROCESS_IDENTITY_ENV]?.trim()
  if (
    !sessionId || !runId || !assignmentId || !taskId || !processIdentity ||
    agentPath !== YOUTUBE_EXTRACTOR_AGENT_PATH
  ) throw new YoutubeToolClientError('YouTube runtime scope is invalid.')
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: randomUUID(),
    leaseId: `youtube-${assignmentId}`,
    sessionId,
    runId,
    assignmentId,
    taskId,
    processIdentity,
    agentPath,
  }
}

export function requireLoopbackCapabilityUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new YoutubeToolClientError()
  }
  if (
    url.protocol !== 'http:' || url.username || url.password || url.search || url.hash ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname === '/'
  ) throw new YoutubeToolClientError()
  return url.href
}

function isYoutubeToolResponse(value: unknown): value is YoutubeToolResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === YOUTUBE_TOOL_CONTRACT_VERSION &&
    Boolean(record.output) && typeof record.output === 'object' && !Array.isArray(record.output)
}
