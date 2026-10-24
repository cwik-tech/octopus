import { whenDefined } from '../../core/optional-properties.js'
import { randomUUID } from 'node:crypto'

import {
  RESEARCH_WEB_TOOL_CONTRACT_VERSION,
  RESEARCH_WEB_TOOL_URL_ENV,
  type ResearchWebToolInput,
  type ResearchWebToolResponse,
} from './acquisition-types.js'
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
  MCP_WORKER_ACTIVITY_SCOPE_ID_ENV,
  MCP_WORKER_AGENT_DISPLAY_NAME_ENV,
} from '../mcp/mcp-worker-turn.js'

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024

export class ResearchWebToolClientError extends Error {
  constructor(message = 'Parent research web service is unavailable.') {
    super(message)
    this.name = 'ResearchWebToolClientError'
  }
}

export async function callParentResearchWebTool(params: {
  readonly agentPath: string
  readonly toolCallId: string
  readonly input: ResearchWebToolInput
  readonly signal?: AbortSignal
  readonly environment?: NodeJS.ProcessEnv
}): Promise<ResearchWebToolResponse> {
  const environment = params.environment ?? process.env
  const configuredUrl = environment[RESEARCH_WEB_TOOL_URL_ENV]?.trim()
  if (!configuredUrl) throw new ResearchWebToolClientError()
  const activityScopeId = runtimeActivityScopeId(environment)
  const response = await fetch(requireLoopbackCapabilityUrl(configuredUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: RESEARCH_WEB_TOOL_CONTRACT_VERSION,
      context: runtimeContext(environment, params.agentPath),
      ...(activityScopeId ? { activityScopeId } : {}),
      toolCallId: params.toolCallId,
      input: params.input,
    }),
    redirect: 'error',
    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
  }).catch((error) => {
    if (params.signal?.aborted) throw error
    throw new ResearchWebToolClientError()
  })
  if (!response.ok) {
    void response.body?.cancel()
    throw new ResearchWebToolClientError()
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ResearchWebToolClientError()
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new ResearchWebToolClientError()
  let parsed: unknown
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new ResearchWebToolClientError()
  }
  if (!isResponse(parsed)) throw new ResearchWebToolClientError()
  return parsed
}

function runtimeActivityScopeId(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const value = environment[MCP_WORKER_ACTIVITY_SCOPE_ID_ENV]?.trim()
  if (!value) return undefined
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)) {
    throw new ResearchWebToolClientError('Research web activity scope is invalid.')
  }
  return value
}

function runtimeContext(
  environment: NodeJS.ProcessEnv,
  agentPath: string,
): RuntimeCapabilityRequestContext {
  const sessionId = environment[RUNTIME_SESSION_ID_ENV]?.trim()
  const runId = environment[RUNTIME_RUN_ID_ENV]?.trim()
  const assignmentId = environment[RUNTIME_ASSIGNMENT_ID_ENV]?.trim()
  const taskId = environment[RUNTIME_TASK_ID_ENV]?.trim()
  const processIdentity = environment[RUNTIME_PROCESS_IDENTITY_ENV]?.trim()
  const activityScopeId = runtimeActivityScopeId(environment)
  const agentDisplayName =
    environment[MCP_WORKER_AGENT_DISPLAY_NAME_ENV]?.trim()
  if (
    !sessionId ||
    !runId ||
    !assignmentId ||
    !taskId ||
    !processIdentity ||
    !/^agents\/[a-z0-9][a-z0-9-]{0,127}$/u.test(agentPath)
  ) {
    throw new ResearchWebToolClientError('Research web runtime scope is invalid.')
  }
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: randomUUID(),
    leaseId: `research-web-${assignmentId}`,
    sessionId,
    runId,
    assignmentId,
    taskId,
    processIdentity,
    agentPath,
    ...(activityScopeId
      ? {
          agentId: activityScopeId,
          activityScopeId,
        }
      : {}),
    ...(agentDisplayName ? { agentDisplayName } : {}),
  }
}

function requireLoopbackCapabilityUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ResearchWebToolClientError()
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
    throw new ResearchWebToolClientError()
  }
  return url.href
}

function isResponse(value: unknown): value is ResearchWebToolResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === RESEARCH_WEB_TOOL_CONTRACT_VERSION &&
    Boolean(record.output) &&
    typeof record.output === 'object' &&
    !Array.isArray(record.output)
}
