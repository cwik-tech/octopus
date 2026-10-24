import { whenDefined } from '../../core/optional-properties.js'
import { randomUUID } from 'node:crypto'

import {
  BROWSER_TOOL_CONTRACT_VERSION,
  BROWSER_TOOL_URL_ENV,
  type BrowserToolInput,
  type BrowserToolResponse,
} from './browser-types.js'
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
} from '../../domains/runtime/runtime-paths.js'

const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024

export class BrowserToolClientError extends Error {
  constructor(message = 'Parent browser service is unavailable.') {
    super(message)
    this.name = 'BrowserToolClientError'
  }
}

export async function callParentBrowserTool(params: {
  readonly agentPath: string
  readonly toolCallId: string
  readonly input: BrowserToolInput
  readonly signal?: AbortSignal
  readonly environment?: NodeJS.ProcessEnv
}): Promise<BrowserToolResponse> {
  const environment = params.environment ?? process.env
  const configuredUrl = environment[BROWSER_TOOL_URL_ENV]?.trim()
  if (!configuredUrl) throw new BrowserToolClientError()
  const context = browserContext(environment, params.agentPath)
  const response = await fetch(requireLoopbackCapabilityUrl(configuredUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: BROWSER_TOOL_CONTRACT_VERSION,
      context,
      toolCallId: params.toolCallId,
      input: params.input,
    }),
    redirect: 'error',
    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
  }).catch((error) => {
    if (params.signal?.aborted) throw error
    throw new BrowserToolClientError()
  })
  if (!response.ok) {
    void response.body?.cancel()
    throw new BrowserToolClientError()
  }
  const text = await readBoundedResponse(response)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BrowserToolClientError()
  }
  if (!isBrowserToolResponse(parsed)) throw new BrowserToolClientError()
  return parsed
}

function browserContext(
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
    throw new BrowserToolClientError('Browser runtime scope is invalid.')
  }
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: randomUUID(),
    leaseId: `browser-${assignmentId}`,
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
    throw new BrowserToolClientError()
  }
  if (
    url.protocol !== 'http:' || url.username || url.password || url.search || url.hash ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname === '/'
  ) {
    throw new BrowserToolClientError()
  }
  return url.href
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new BrowserToolClientError()
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new BrowserToolClientError()
  return buffer.toString('utf8')
}

function isBrowserToolResponse(value: unknown): value is BrowserToolResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === BROWSER_TOOL_CONTRACT_VERSION &&
    Boolean(record.output) && typeof record.output === 'object' && !Array.isArray(record.output)
}
