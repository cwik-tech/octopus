import type * as http from 'node:http'

import {
  browserToolInputRequestSchema,
  createBrokerToolRequestSchema,
} from '../../contracts/schemas/tool-requests.js'
import {
  BROWSER_SERVER_ID,
  BROWSER_TOOL_CONTRACT_VERSION,
} from '../../domains/browser/browser-types.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
} from '../../domains/mcp/mcp-runtime.js'
import { toMcpJsonObject } from '../../contracts/mcp.js'
import type { RuntimeCapabilityAuthorityPort } from '../../contracts/runtime-capability-authority.js'
import { normalizeMcpAgentPath } from '../../domains/mcp/mcp-settings.js'
import type { BrowserCapabilityDispatchInvoker } from '../../services/browser-capability-adapter.js'
import { BROWSER_CAPABILITY_ID } from '../../services/browser-capability-adapter.js'
import { serveBrokerToolRoute } from '../capability-route-transport.js'
import type { ToolRouteFailureReporter } from '../tool-route-failure.js'

const browserToolRequestSchema = createBrokerToolRequestSchema({
  runtimeContractVersion: MCP_RUNTIME_CONTRACT_VERSION,
  toolContractVersion: BROWSER_TOOL_CONTRACT_VERSION,
  inputSchema: browserToolInputRequestSchema,
  normalizeAgentPath: normalizeMcpAgentPath,
})

export async function handleBrowserToolRoute(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly invoker: BrowserCapabilityDispatchInvoker
  readonly authority: RuntimeCapabilityAuthorityPort
  /** Where an unexpected failure is recorded. Defaults to one JSON line on stderr. */
  readonly reportFailure?: ToolRouteFailureReporter
}): Promise<void> {
  const { req, res } = params
  await serveBrokerToolRoute(req, res, {
    tool: 'browser',
    maxRequestBytes: 256 * 1_024,
    schema: browserToolRequestSchema,
    messages: {
      invalid: 'Browser tool request is invalid',
      denied: 'Browser capability authority was denied',
      failed: 'Browser tool failed',
    },
    version: BROWSER_TOOL_CONTRACT_VERSION,
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
          endpointId: BROWSER_CAPABILITY_ID,
          processIdentity: request.context.processIdentity,
        },
        source: {
          kind: 'builtin',
          id: BROWSER_SERVER_ID,
          version: String(BROWSER_TOOL_CONTRACT_VERSION),
        },
        toolCallId: request.toolCallId,
        input: toMcpJsonObject(request.input),
        initialAuthorityEvidence,
        signal,
      })
    },
    reportFailure: params.reportFailure,
  })
}
