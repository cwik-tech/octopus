import type * as http from 'node:http'
import type { URL } from 'node:url'

import * as z from 'zod/v4'

import { decodeSafePathSegment, isSafePathSegment } from '../../core/path-safety.js'
import {
  McpAgentGrantsServiceError,
  type McpAgentGrantsService,
} from '../../services/mcp-agent-grants-service.js'
import { McpSettingsServiceError } from '../../services/mcp-settings-service.js'
import { ApiRequestError, readJsonBody, writeJson } from '../http.js'

const setGrantSchema = z.object({
  serverId: z.string().min(1).max(256),
  enabled: z.boolean(),
}).strict()

export async function handleMcpAgentGrantRoutes(params: {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  service: McpAgentGrantsService
}): Promise<boolean> {
  const match = params.url.pathname.match(
    /^\/create\/agents\/([^/]+)\/mcp-grants$/,
  )
  if (!match) return false
  params.res.setHeader('cache-control', 'no-store')

  try {
    const agentName = parseAgentName(match[1])
    if (params.req.method === 'GET') {
      writeJson(params.res, 200, {
        servers: await params.service.listServers(agentName),
      })
      return true
    }
    if (params.req.method === 'PATCH') {
      const body = setGrantSchema.safeParse(await readJsonBody(params.req))
      if (!body.success || !isSafePathSegment(body.data.serverId)) {
        throw new ApiRequestError('Invalid MCP grant request body', 400)
      }
      writeJson(
        params.res,
        200,
        await params.service.setGrant(
          agentName,
          body.data.serverId,
          body.data.enabled,
        ),
      )
      return true
    }
    params.res.setHeader('allow', 'GET, PATCH')
    writeJson(params.res, 405, { error: 'Method not allowed' })
    return true
  } catch (error) {
    if (
      error instanceof McpAgentGrantsServiceError ||
      error instanceof McpSettingsServiceError
    ) {
      writeJson(params.res, statusCodeForGrantError(error.code), {
        error: error.message,
      })
      return true
    }
    throw error
  }
}

function parseAgentName(encodedName: string | undefined): string {
  const agentName = encodedName ? decodeSafePathSegment(encodedName) : null
  if (!agentName) throw new ApiRequestError('Invalid agent name', 400)
  return agentName
}

function statusCodeForGrantError(code: string): 400 | 404 | 409 | 502 {
  switch (code) {
    case 'invalid_request':
    case 'configuration_invalid':
      return 400
    case 'not_found':
      return 404
    case 'provider_unsupported':
    case 'server_disabled':
    case 'server_revoked':
    case 'connection_failed':
      return 409
    default:
      return 502
  }
}
