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
  GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
  GENERATE_EXCEL_TOOL_URL_ENV,
  type GenerateExcelToolInput,
  type GenerateExcelToolResponse,
} from './generate-excel-types.js'

const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024

export class GenerateExcelToolClientError extends Error {
  constructor(message = 'Parent Generate Excel service is unavailable.') {
    super(message)
    this.name = 'GenerateExcelToolClientError'
  }
}

export async function callParentGenerateExcelTool(params: {
  readonly agentPath: string
  readonly toolCallId: string
  readonly input: GenerateExcelToolInput
  readonly signal?: AbortSignal
  readonly environment?: NodeJS.ProcessEnv
}): Promise<GenerateExcelToolResponse> {
  const environment = params.environment ?? process.env
  const configuredUrl = environment[GENERATE_EXCEL_TOOL_URL_ENV]?.trim()
  if (!configuredUrl) throw new GenerateExcelToolClientError()
  const response = await fetch(requireLoopbackCapabilityUrl(configuredUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
      context: generateExcelContext(environment, params.agentPath),
      toolCallId: params.toolCallId,
      input: params.input,
    }),
    redirect: 'error',
    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
  }).catch((error) => {
    if (params.signal?.aborted) throw error
    throw new GenerateExcelToolClientError()
  })
  if (!response.ok) {
    void response.body?.cancel()
    throw new GenerateExcelToolClientError()
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.byteLength > MAX_RESPONSE_BYTES) {
    throw new GenerateExcelToolClientError()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString('utf8'))
  } catch {
    throw new GenerateExcelToolClientError()
  }
  if (!isGenerateExcelToolResponse(parsed)) {
    throw new GenerateExcelToolClientError()
  }
  return parsed
}

function generateExcelContext(
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
    throw new GenerateExcelToolClientError(
      'Generate Excel runtime scope is invalid.',
    )
  }
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: randomUUID(),
    leaseId: `generate-excel-${assignmentId}`,
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
    throw new GenerateExcelToolClientError()
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
    throw new GenerateExcelToolClientError()
  }
  return url.href
}

function isGenerateExcelToolResponse(
  value: unknown,
): value is GenerateExcelToolResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.version === GENERATE_EXCEL_TOOL_CONTRACT_VERSION &&
    Boolean(record.output) &&
    typeof record.output === 'object' &&
    !Array.isArray(record.output)
  )
}
