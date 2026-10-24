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
  GENERATE_WORD_TOOL_CONTRACT_VERSION,
  GENERATE_WORD_TOOL_URL_ENV,
  type GenerateWordToolInput,
  type GenerateWordToolResponse,
} from './generate-word-types.js'

const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024

export class GenerateWordToolClientError extends Error {
  constructor(message = 'Parent Generate Word service is unavailable.') {
    super(message)
    this.name = 'GenerateWordToolClientError'
  }
}

export async function callParentGenerateWordTool(params: {
  readonly agentPath: string
  readonly toolCallId: string
  readonly input: GenerateWordToolInput
  readonly signal?: AbortSignal
  readonly environment?: NodeJS.ProcessEnv
}): Promise<GenerateWordToolResponse> {
  const environment = params.environment ?? process.env
  const configuredUrl = environment[GENERATE_WORD_TOOL_URL_ENV]?.trim()
  if (!configuredUrl) throw new GenerateWordToolClientError()
  const response = await fetch(requireLoopbackCapabilityUrl(configuredUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: GENERATE_WORD_TOOL_CONTRACT_VERSION,
      context: generateWordContext(environment, params.agentPath),
      toolCallId: params.toolCallId,
      input: params.input,
    }),
    redirect: 'error',
    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
  }).catch((error) => {
    if (params.signal?.aborted) throw error
    throw new GenerateWordToolClientError()
  })
  if (!response.ok) {
    void response.body?.cancel()
    throw new GenerateWordToolClientError()
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.byteLength > MAX_RESPONSE_BYTES) {
    throw new GenerateWordToolClientError()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString('utf8'))
  } catch {
    throw new GenerateWordToolClientError()
  }
  if (!isGenerateWordToolResponse(parsed)) {
    throw new GenerateWordToolClientError()
  }
  return parsed
}

function generateWordContext(
  environment: NodeJS.ProcessEnv,
  agentPath: string,
): RuntimeCapabilityRequestContext {
  const sessionId = environment[RUNTIME_SESSION_ID_ENV]?.trim()
  const runId = environment[RUNTIME_RUN_ID_ENV]?.trim()
  const assignmentId = environment[RUNTIME_ASSIGNMENT_ID_ENV]?.trim()
  const taskId = environment[RUNTIME_TASK_ID_ENV]?.trim()
  const processIdentity = environment[RUNTIME_PROCESS_IDENTITY_ENV]?.trim()
  if (
    !sessionId ||
    !runId ||
    !assignmentId ||
    !taskId ||
    !processIdentity ||
    !/^agents\/[a-z0-9][a-z0-9-]{0,127}$/.test(agentPath)
  ) {
    throw new GenerateWordToolClientError(
      'Generate Word runtime scope is invalid.',
    )
  }
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: randomUUID(),
    leaseId: `generate-word-${assignmentId}`,
    sessionId,
    runId,
    assignmentId,
    taskId,
    processIdentity,
    agentPath,
  }
}

function requireLoopbackCapabilityUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new GenerateWordToolClientError()
  }
  if (
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname === '/'
  ) {
    throw new GenerateWordToolClientError()
  }
  return url.href
}

function isGenerateWordToolResponse(
  value: unknown,
): value is GenerateWordToolResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.version === GENERATE_WORD_TOOL_CONTRACT_VERSION &&
    Boolean(record.output) &&
    typeof record.output === 'object' &&
    !Array.isArray(record.output)
  )
}
