import type * as http from 'node:http'

import {
  createBrokerToolRequestSchema,
  generateWordToolInputRequestSchema,
} from '../../contracts/schemas/tool-requests.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
} from '../../domains/mcp/mcp-runtime.js'
import { toMcpJsonObject } from '../../contracts/mcp.js'
import type { RuntimeCapabilityAuthorityPort } from '../../contracts/runtime-capability-authority.js'
import { normalizeMcpAgentPath } from '../../domains/mcp/mcp-settings.js'
import {
  GENERATE_WORD_BUILTIN_SOURCE,
  GENERATE_WORD_CAPABILITY_ID,
  type GenerateWordCapabilityDispatchInvoker,
} from '../../services/generate-word-capability-adapter.js'
import {
  GENERATE_WORD_TOOL_CONTRACT_VERSION,
} from '../../domains/word-generation/generate-word-types.js'
import { serveBrokerToolRoute } from '../capability-route-transport.js'
import type { ToolRouteFailureReporter } from '../tool-route-failure.js'

const generateWordToolRequestSchema = createBrokerToolRequestSchema({
  runtimeContractVersion: MCP_RUNTIME_CONTRACT_VERSION,
  toolContractVersion: GENERATE_WORD_TOOL_CONTRACT_VERSION,
  inputSchema: generateWordToolInputRequestSchema,
  normalizeAgentPath: normalizeMcpAgentPath,
})

export async function handleGenerateWordToolRoute(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly invoker: GenerateWordCapabilityDispatchInvoker
  readonly authority: RuntimeCapabilityAuthorityPort
  /** Where an unexpected failure is recorded. Defaults to one JSON line on stderr. */
  readonly reportFailure?: ToolRouteFailureReporter
}): Promise<void> {
  const { req, res } = params
  await serveBrokerToolRoute(req, res, {
    tool: 'generate-word',
    maxRequestBytes: 10 * 1_024 * 1_024 + 64 * 1_024,
    schema: generateWordToolRequestSchema,
    messages: {
      invalid: 'Generate Word tool request is invalid',
      denied: 'Generate Word capability authority was denied',
      failed: 'Generate Word tool failed',
    },
    version: GENERATE_WORD_TOOL_CONTRACT_VERSION,
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
          endpointId: GENERATE_WORD_CAPABILITY_ID,
          processIdentity: request.context.processIdentity,
        },
        source: GENERATE_WORD_BUILTIN_SOURCE,
        toolCallId: request.toolCallId,
        input: toMcpJsonObject(request.input),
        initialAuthorityEvidence,
        signal,
      })
    },
    reportFailure: params.reportFailure,
  })
}
