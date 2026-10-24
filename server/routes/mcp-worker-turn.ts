import { Buffer } from 'node:buffer'
import type * as http from 'node:http'

import { isValidSessionId } from '../../contracts/sessions.js'
import {
  createMcpWorkerTurnRequestSchema,
} from '../../contracts/schemas/tool-requests.js'
import {
  MCP_WORKER_TURN_CONTRACT_VERSION,
  McpWorkerTurnContractError,
} from '../../domains/mcp/mcp-worker-turn.js'
import { normalizeMcpAgentPath } from '../../domains/mcp/mcp-settings.js'
import { isSafePathSegment } from '../../core/path-safety.js'
import {
  McpWorkerTurnService,
  McpWorkerTurnServiceError,
} from '../../services/mcp-worker-turn-service.js'
import { ApiRequestError, readJsonBody, writeJson } from '../http.js'
import { BEHAVIOURAL_PROVIDER_OPTION_NAMES } from '../../providers/provider-option-support.js'

const MAX_WORKER_REQUEST_BYTES = 5 * 1_024 * 1_024
const mcpWorkerTurnRequestSchema = createMcpWorkerTurnRequestSchema({
  contractVersion: MCP_WORKER_TURN_CONTRACT_VERSION,
  isSessionId: isValidSessionId,
  isSafePathSegment,
  normalizeAgentPath: normalizeMcpAgentPath,
  utf8ByteLength: (value) => Buffer.byteLength(value, 'utf8'),
  behaviouralProviderOptions: BEHAVIOURAL_PROVIDER_OPTION_NAMES,
})

export async function handleMcpWorkerTurnRoute(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly service: Pick<McpWorkerTurnService, 'runTurn'>
  readonly onActiveController?: (
    controller: AbortController,
    scope: { readonly sessionId: string; readonly taskId: string },
  ) => void
  readonly onSettledController?: (controller: AbortController) => void
}): Promise<void> {
  const { req, res } = params
  // The route carries provider prompts and tool results. Never permit an
  // intermediary or browser cache to retain either successful or error bodies.
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
  res.once('close', abortIfUnfinished)
  try {
    const parsed = mcpWorkerTurnRequestSchema.safeParse(
      await readJsonBody(req, MAX_WORKER_REQUEST_BYTES),
    )
    if (!parsed.success) {
      throw new ApiRequestError('MCP worker request is invalid', 400)
    }
    const request = parsed.data
    params.onActiveController?.(controller, {
      sessionId: request.sessionId,
      taskId: request.taskId,
    })
    const result = await params.service.runTurn(request, controller.signal)
    if (res.destroyed) return
    if (controller.signal.aborted) {
      writeCancelled(res)
      return
    }
    writeJson(res, 200, result)
  } catch (error) {
    if (res.destroyed) return
    if (error instanceof ApiRequestError) {
      writeJson(res, error.statusCode, { error: 'MCP worker request is invalid' })
      return
    }
    if (error instanceof McpWorkerTurnContractError) {
      writeJson(res, 400, { error: 'MCP worker request is invalid' })
      return
    }
    if (controller.signal.aborted) {
      writeCancelled(res)
      return
    }
    if (error instanceof McpWorkerTurnServiceError) {
      writeJson(res, statusForServiceError(error), {
        error: 'MCP worker turn failed',
        code: error.code,
        retryable: error.retryable,
        ...(error.providerCode ? { providerCode: error.providerCode } : {}),
        // The one field a person can act on. It is a closed union, so sending
        // it adds no provider text to the response the worker will log.
        ...(error.providerKind ? { providerKind: error.providerKind } : {}),
        ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}),
        // The machine-readable half of the same fact. A rendered date cannot
        // be compared with a clock on the other side, and this is what the
        // child's failure record expires on.
        ...(error.resetsAtInstant
          ? { resetsAtInstant: error.resetsAtInstant }
          : {}),
        // A boolean the child reads only as a positive claim of absence. It
        // adds no provider text, and without it a refusal the parent's adapter
        // proved was never sent arrives at the child as unknown — which is the
        // answer that refuses the offer this evidence exists to produce.
        ...(error.dispatched === false ? { dispatched: false } : {}),
      })
      return
    }
    writeJson(res, 500, { error: 'MCP worker turn failed' })
  } finally {
    req.off('aborted', abort)
    res.off('close', abortIfUnfinished)
    params.onSettledController?.(controller)
  }

  function abortIfUnfinished(): void {
    if (!res.writableEnded) abort()
  }
}

function writeCancelled(res: http.ServerResponse): void {
  writeJson(res, 409, {
    error: 'MCP worker turn was cancelled',
    code: 'cancelled',
    retryable: false,
  })
}

function statusForServiceError(error: McpWorkerTurnServiceError): number {
  switch (error.code) {
    case 'unauthorized':
      return 403
    case 'inactive_task':
      return 409
    case 'resolution_invalid':
      return 409
    case 'execution_failed':
      return 502
  }
}
