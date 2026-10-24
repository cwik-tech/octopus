import type * as http from 'node:http'

import {
  createBrokerToolRequestSchema,
  youtubeToolInputRequestSchema,
} from '../../contracts/schemas/tool-requests.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
} from '../../domains/mcp/mcp-runtime.js'
import { toMcpJsonObject } from '../../contracts/mcp.js'
import type { RuntimeCapabilityAuthorityPort } from '../../contracts/runtime-capability-authority.js'
import { normalizeMcpAgentPath } from '../../domains/mcp/mcp-settings.js'
import {
  YOUTUBE_BUILTIN_SOURCE,
  YOUTUBE_CAPABILITY_ID,
  type YoutubeCapabilityDispatchInvoker,
} from '../../services/youtube-capability-adapter.js'
import {
  YOUTUBE_TOOL_CONTRACT_VERSION,
} from '../../domains/youtube/youtube-types.js'
import { serveBrokerToolRoute } from '../capability-route-transport.js'
import type { ToolRouteFailureReporter } from '../tool-route-failure.js'

const youtubeToolRequestSchema = createBrokerToolRequestSchema({
  runtimeContractVersion: MCP_RUNTIME_CONTRACT_VERSION,
  toolContractVersion: YOUTUBE_TOOL_CONTRACT_VERSION,
  inputSchema: youtubeToolInputRequestSchema,
  normalizeAgentPath: normalizeMcpAgentPath,
})

export async function handleYoutubeToolRoute(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly invoker: YoutubeCapabilityDispatchInvoker
  readonly authority: RuntimeCapabilityAuthorityPort
  /** Where an unexpected failure is recorded. Defaults to one JSON line on stderr. */
  readonly reportFailure?: ToolRouteFailureReporter
}): Promise<void> {
  const { req, res } = params
  await serveBrokerToolRoute(req, res, {
    tool: 'youtube',
    maxRequestBytes: 512 * 1_024,
    schema: youtubeToolRequestSchema,
    messages: {
      invalid: 'YouTube tool request is invalid',
      denied: 'YouTube capability authority was denied',
      failed: 'YouTube tool failed',
    },
    version: YOUTUBE_TOOL_CONTRACT_VERSION,
    correlate: (request) => ({
      requestId: request.context.requestId,
      toolCallId: request.toolCallId,
    }),
    run: async (request, signal) => {
      const initialAuthorityEvidence = await params.authority.authorize(
        request.context,
        { kind: 'issue-evidence' },
      )
      return params.invoker.execute({
        context: request.context,
        authority: {
          kind: 'parent-capability',
          endpointId: YOUTUBE_CAPABILITY_ID,
          processIdentity: request.context.processIdentity,
        },
        source: YOUTUBE_BUILTIN_SOURCE,
        toolCallId: request.toolCallId,
        input: toMcpJsonObject(request.input),
        initialAuthorityEvidence,
        signal,
      })
    },
    reportFailure: params.reportFailure,
  })
}
