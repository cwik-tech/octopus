import type * as http from 'node:http'
import type { URL } from 'node:url'

import * as z from 'zod/v4'

import { decodeSafePathSegment } from '../../core/path-safety.js'
import {
  McpInteractionServiceError,
  type McpInteractionService,
} from '../../services/mcp-interaction-service.js'
import type { SessionStore } from '../../domains/sessions/session-store.js'
import { isValidSessionId } from '../../contracts/sessions.js'
import { ApiRequestError, readJsonBody, writeJson } from '../http.js'

const MAX_INTERACTION_ID_LENGTH = 512

const formValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
])

const responseSchema = z.discriminatedUnion('kind', [
  z.discriminatedUnion('decision', [
    z.object({
      kind: z.literal('approval'),
      decision: z.literal('approve'),
      scope: z.enum(['once', 'run']),
    }).strict(),
    z.object({
      kind: z.literal('approval'),
      decision: z.literal('deny'),
    }).strict(),
  ]),
  z.discriminatedUnion('action', [
    z.object({
      kind: z.literal('elicitation'),
      action: z.literal('accept'),
      values: z.record(z.string(), formValueSchema).optional(),
    }).strict(),
    z.object({
      kind: z.literal('elicitation'),
      action: z.enum(['decline', 'cancel']),
    }).strict(),
  ]),
])

export async function handleMcpInteractionRoutes(params: {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  service?: McpInteractionService
  sessionStore?: SessionStore
}): Promise<boolean> {
  const route = decodeRoute(params.url)
  if (!route) return false
  params.res.setHeader('cache-control', 'no-store')

  if (!params.service || !params.sessionStore) {
    writeJson(params.res, 501, {
      error: 'MCP interactions are not configured on this server',
    })
    return true
  }
  if (!await params.sessionStore.getSession(route.sessionId)) {
    writeJson(params.res, 404, { error: 'Session not found' })
    return true
  }

  try {
    if (
      route.tail.length === 1 &&
      route.tail[0] === 'mcp-interactions'
    ) {
      if (params.req.method !== 'GET') {
        return methodNotAllowed(params.res, ['GET'])
      }
      const includeResolved = parseIncludeResolved(params.url)
      const limit = parseLimit(params.url.searchParams.get('limit'))
      const result = await params.service.listSession(route.sessionId, {
        includeResolved,
        ...(limit ? { limit } : {}),
      })
      writeJson(params.res, 200, result)
      return true
    }

    if (
      route.tail.length === 3 &&
      route.tail[0] === 'mcp-interactions' &&
      route.tail[2] === 'respond'
    ) {
      if (params.req.method !== 'POST') {
        return methodNotAllowed(params.res, ['POST'])
      }
      const interactionId = route.tail[1]
      if (interactionId === undefined) {
        throw new Error('MCP interaction respond route is missing its interaction id after the length check.')
      }
      if (interactionId.length > MAX_INTERACTION_ID_LENGTH) {
        throw new ApiRequestError('Invalid MCP interaction id', 400)
      }
      const parsed = responseSchema.safeParse(await readJsonBody(params.req))
      if (!parsed.success) {
        throw new ApiRequestError('Invalid MCP interaction response body', 400)
      }
      const interaction = await params.service.respond(
        route.sessionId,
        interactionId,
        parsed.data,
      )
      writeJson(params.res, 200, { interaction })
      return true
    }

    return false
  } catch (error) {
    if (error instanceof McpInteractionServiceError) {
      writeJson(params.res, statusForInteractionError(error), {
        error: error.message,
        code: error.code,
      })
      return true
    }
    throw error
  }
}

function decodeRoute(url: URL): { sessionId: string; tail: string[] } | null {
  const parts = url.pathname.split('/').filter(Boolean)
  if (
    parts[0] !== 'sessions' ||
    !parts[1] ||
    parts[2] !== 'mcp-interactions'
  ) {
    return null
  }
  const sessionId = decodeSafePathSegment(parts[1])
  const tail = parts.slice(2).map((part) => decodeSafePathSegment(part))
  if (!sessionId || !isValidSessionId(sessionId) || tail.some((part) => !part)) {
    throw new ApiRequestError('Invalid MCP interaction route', 400)
  }
  return { sessionId, tail: tail as string[] }
}

function parseIncludeResolved(url: URL): boolean {
  const values = url.searchParams.getAll('includeResolved')
  if (values.length === 0) return false
  if (values.length !== 1 || (values[0] !== '0' && values[0] !== '1')) {
    throw new ApiRequestError('Invalid includeResolved query parameter', 400)
  }
  return values[0] === '1'
}

function parseLimit(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^[1-9][0-9]{0,2}$/.test(value)) {
    throw new ApiRequestError('Invalid limit query parameter', 400)
  }
  const parsed = Number(value)
  if (parsed > 1_000) {
    throw new ApiRequestError('Invalid limit query parameter', 400)
  }
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

function statusForInteractionError(error: McpInteractionServiceError): number {
  switch (error.code) {
    case 'invalid_request':
      return 400
    case 'not_found':
      return 404
    case 'conflict':
      return 409
    case 'capacity_exceeded':
      return 429
    default:
      return 500
  }
}
