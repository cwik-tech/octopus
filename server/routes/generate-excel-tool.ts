import type * as http from 'node:http'

import {
  createBrokerToolRequestSchema,
  generateExcelToolInputRequestSchema,
} from '../../contracts/schemas/tool-requests.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
} from '../../domains/mcp/mcp-runtime.js'
import { toMcpJsonObject } from '../../contracts/mcp.js'
import type { RuntimeCapabilityAuthorityPort } from '../../contracts/runtime-capability-authority.js'
import { normalizeMcpAgentPath } from '../../domains/mcp/mcp-settings.js'
import {
  GENERATE_EXCEL_BUILTIN_SOURCE,
  GENERATE_EXCEL_CAPABILITY_ID,
  type GenerateExcelCapabilityDispatchInvoker,
} from '../../services/generate-excel-capability-adapter.js'
import {
  GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
} from '../../domains/excel-generation/generate-excel-types.js'
import { serveBrokerToolRoute } from '../capability-route-transport.js'
import type { ToolRouteFailureReporter } from '../tool-route-failure.js'

const generateExcelToolRequestSchema = createBrokerToolRequestSchema({
  runtimeContractVersion: MCP_RUNTIME_CONTRACT_VERSION,
  toolContractVersion: GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
  inputSchema: generateExcelToolInputRequestSchema,
  normalizeAgentPath: normalizeMcpAgentPath,
})

export async function handleGenerateExcelToolRoute(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly invoker: GenerateExcelCapabilityDispatchInvoker
  readonly authority: RuntimeCapabilityAuthorityPort
  /** Where an unexpected failure is recorded. Defaults to one JSON line on stderr. */
  readonly reportFailure?: ToolRouteFailureReporter
}): Promise<void> {
  const { req, res } = params
  await serveBrokerToolRoute(req, res, {
    tool: 'generate-excel',
    maxRequestBytes: 64 * 1_024,
    schema: generateExcelToolRequestSchema,
    messages: {
      invalid: 'Generate Excel tool request is invalid',
      denied: 'Generate Excel capability authority was denied',
      failed: 'Generate Excel tool failed',
    },
    version: GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
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
          endpointId: GENERATE_EXCEL_CAPABILITY_ID,
          processIdentity: request.context.processIdentity,
        },
        source: GENERATE_EXCEL_BUILTIN_SOURCE,
        toolCallId: request.toolCallId,
        input: toMcpJsonObject(request.input),
        initialAuthorityEvidence,
        signal,
      })
    },
    reportFailure: params.reportFailure,
  })
}
