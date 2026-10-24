import type * as http from 'node:http'
import type { URL } from 'node:url'

import * as z from 'zod/v4'

import { McpResourceClientError } from '../../domains/mcp/mcp-resource-client-service.js'
import { McpResourceImportStoreError } from '../../domains/mcp/mcp-resource-import-store.js'
import {
  McpResourceImportServiceError,
  type McpResourceImportService,
} from '../../services/mcp-resource-import-service.js'
import { isValidSessionId } from '../../contracts/sessions.js'
import { decodeSafePathSegment } from '../../core/path-safety.js'
import { ApiRequestError, createRequestAbort, readJsonBody, writeJson } from '../http.js'

const MAX_SERVER_ID_LENGTH = 160
const MAX_URI_LENGTH = 4_096
const MAX_CURSOR_LENGTH = 1_024
const MAX_INPUT_BASE_NAME_LENGTH = 200

const importResourceSchema = z.object({
  serverId: z.string().min(1).max(MAX_SERVER_ID_LENGTH),
  uri: z.string().min(1).max(MAX_URI_LENGTH),
  requestedInputBaseName: z.string().min(1).max(MAX_INPUT_BASE_NAME_LENGTH).optional(),
}).strict()

export async function handleMcpResourceRoutes(params: {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  service?: McpResourceImportService
}): Promise<boolean> {
  const route = decodeRoute(params.url)
  if (!route) return false
  params.res.setHeader('cache-control', 'no-store')

  if (!params.service) {
    writeJson(params.res, 501, {
      error: 'MCP resource imports are not configured on this server',
    })
    return true
  }

  try {
    if (route.tail.length === 1 && route.tail[0] === 'mcp-resources') {
      if (params.req.method !== 'GET') {
        return methodNotAllowed(params.res, ['GET'])
      }
      const serverId = optionalQuery(params.url, 'serverId', MAX_SERVER_ID_LENGTH)
      const cursor = optionalQuery(params.url, 'cursor', MAX_CURSOR_LENGTH)
      const limit = parseLimit(params.url.searchParams.get('limit'))
      const result = await params.service.listResources(
        route.sessionId,
        {
          ...(serverId ? { serverId } : {}),
          ...(cursor ? { cursor } : {}),
          ...(limit === undefined ? {} : { limit }),
        },
      )
      writeJson(params.res, 200, result)
      return true
    }

    if (
      route.tail.length === 2
      && route.tail[0] === 'mcp-resources'
      && route.tail[1] === 'imports'
    ) {
      if (params.req.method === 'GET') {
        const imports = await params.service.listImports(route.sessionId)
        writeJson(params.res, 200, { imports })
        return true
      }
      if (params.req.method === 'POST') {
        const body = importResourceSchema.safeParse(await readJsonBody(params.req))
        if (!body.success) {
          throw new ApiRequestError('Invalid MCP resource import request body', 400)
        }
        const requestAbort = createRequestAbort(params.req, params.res)
        try {
          const imported = await params.service.importResource({
            sessionId: route.sessionId,
            serverId: body.data.serverId,
            uri: body.data.uri,
            ...(body.data.requestedInputBaseName
              ? { requestedInputBaseName: body.data.requestedInputBaseName }
              : {}),
            signal: requestAbort.signal,
          })
          writeJson(params.res, 201, imported)
        } finally {
          requestAbort.dispose()
        }
        return true
      }
      return methodNotAllowed(params.res, ['GET', 'POST'])
    }

    return false
  } catch (error) {
    if (
      error instanceof McpResourceClientError
      || error instanceof McpResourceImportStoreError
      || error instanceof McpResourceImportServiceError
    ) {
      writeJson(params.res, statusCodeForResourceError(error), {
        error: error.message,
        code: error.code,
        retryable: error instanceof McpResourceClientError
          ? error.retryable
          : false,
      })
      return true
    }
    throw error
  }
}

function decodeRoute(url: URL): { sessionId: string; tail: string[] } | null {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'sessions' || !parts[1] || parts[2] !== 'mcp-resources') {
    return null
  }
  const sessionId = decodeSafePathSegment(parts[1])
  const tail = parts.slice(2).map((part) => decodeSafePathSegment(part))
  if (!sessionId || !isValidSessionId(sessionId) || tail.some((part) => !part)) {
    throw new ApiRequestError('Invalid MCP resource route', 400)
  }
  return { sessionId, tail: tail as string[] }
}

function optionalQuery(url: URL, key: string, maximumLength: number): string | undefined {
  const values = url.searchParams.getAll(key)
  if (values.length === 0) return undefined
  if (values.length !== 1) {
    throw new ApiRequestError(`Query parameter ${key} must occur once`, 400)
  }
  const value = values[0]
  if (!value || value.length > maximumLength || value.trim() !== value) {
    throw new ApiRequestError(`Invalid query parameter ${key}`, 400)
  }
  return value
}

function parseLimit(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^[1-9][0-9]{0,2}$/.test(value)) {
    throw new ApiRequestError('Invalid query parameter limit', 400)
  }
  const parsed = Number(value)
  if (parsed > 100) throw new ApiRequestError('Invalid query parameter limit', 400)
  return parsed
}

function methodNotAllowed(
  res: http.ServerResponse,
  methods: readonly string[],
): true {
  res.setHeader('allow', methods.join(', '))
  writeJson(res, 405, { error: 'Method not allowed' })
  return true
}

function statusCodeForResourceError(
  error: McpResourceClientError | McpResourceImportStoreError | McpResourceImportServiceError,
): number {
  switch (error.code) {
    case 'invalid_request':
    case 'configuration_invalid':
      return 400
    case 'not_found':
      return 404
    case 'server_disabled':
    case 'server_revoked':
    case 'conflict':
      return 409
    case 'result_too_large':
      return 413
    case 'cancelled':
      return 408
    case 'timeout':
      return 504
    case 'connection_failed':
    case 'protocol_error':
    case 'parse_failed':
      return 502
    default:
      return 500
  }
}
