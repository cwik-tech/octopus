import type * as http from 'node:http'

import {
  RESEARCH_WEB_SERVER_ID,
  RESEARCH_WEB_TOOL_CONTRACT_VERSION,
} from '../../domains/acquisition/acquisition-types.js'
import {
  createBrokerToolRequestSchema,
  researchWebToolInputRequestSchema,
  runtimeCapabilityActivityScopeSchema,
} from '../../contracts/schemas/tool-requests.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { toMcpJsonObject } from '../../contracts/mcp.js'
import type { RuntimeCapabilityAuthorityPort } from '../../contracts/runtime-capability-authority.js'
import { isSafePathSegment } from '../../core/path-safety.js'
import { normalizeMcpAgentPath } from '../../domains/mcp/mcp-settings.js'
import { parseResearchWebToolInput } from '../../services/research-web-tool-service.js'
import {
  RESEARCH_WEB_CAPABILITY_ID,
  type ResearchWebCapabilityDispatchInvoker,
} from '../../services/research-web-capability-adapter.js'
import {
  statusForRuntimeCapabilityAuthorityError,
} from '../../services/runtime-capability-authority.js'
import { readJsonBody, writeJson } from '../http.js'

const MAX_REQUEST_BYTES = 256 * 1_024
const researchWebToolRequestSchema = createBrokerToolRequestSchema({
  runtimeContractVersion: MCP_RUNTIME_CONTRACT_VERSION,
  toolContractVersion: RESEARCH_WEB_TOOL_CONTRACT_VERSION,
  inputSchema: researchWebToolInputRequestSchema,
  normalizeAgentPath: normalizeMcpAgentPath,
}).extend({
  activityScopeId: runtimeCapabilityActivityScopeSchema
    .refine(isSafePathSegment)
    .optional(),
})

export async function handleResearchWebToolRoute(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly invoker: ResearchWebCapabilityDispatchInvoker
  readonly authority: RuntimeCapabilityAuthorityPort
}): Promise<void> {
  const { req, res } = params
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    writeJson(res, 405, { error: 'Method not allowed' })
    return
  }
  if (req.headers.origin !== undefined) {
    writeJson(res, 403, { error: 'Origin not allowed' })
    return
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once('aborted', abort)
  try {
    const parsed = researchWebToolRequestSchema.safeParse(
      await readJsonBody(req, MAX_REQUEST_BYTES),
    )
    if (!parsed.success) invalid()
    const request = {
      ...parsed.data,
      input: parseResearchWebToolInput(parsed.data.input),
    }
    const initialAuthorityEvidence = await params.authority.authorize(
      request.context,
      { kind: 'issue-evidence' },
    )
    const output = await params.invoker.execute({
      context: {
        ...request.context,
        activityScopeId:
          request.activityScopeId ?? request.context.assignmentId,
      },
      authority: {
        kind: 'parent-capability',
        endpointId: RESEARCH_WEB_CAPABILITY_ID,
        processIdentity: request.context.processIdentity,
      },
      source: {
        kind: 'builtin',
        id: RESEARCH_WEB_SERVER_ID,
        version: String(RESEARCH_WEB_TOOL_CONTRACT_VERSION),
      },
      toolCallId: request.toolCallId,
      input: toMcpJsonObject(request.input),
      initialAuthorityEvidence,
      signal: controller.signal,
    })
    if (!res.destroyed) {
      writeJson(res, 200, {
        version: RESEARCH_WEB_TOOL_CONTRACT_VERSION,
        output,
      })
    }
  } catch (error) {
    if (!res.destroyed) {
      writeJson(
        res,
        statusForRuntimeCapabilityAuthorityError(error) ?? 400,
        { error: 'Research web tool request is invalid' },
      )
    }
  } finally {
    req.off('aborted', abort)
  }
}

function invalid(): never {
  throw new Error('invalid research web request')
}
